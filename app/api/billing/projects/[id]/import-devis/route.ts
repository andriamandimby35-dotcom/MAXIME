import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractDevisFromPdf } from "@/lib/projects/extract-devis-pdf";
import { matchTaskForItem, type PlanningTask } from "@/lib/billing/task-matching";

// Prix du devis d'un chantier DÉJÀ créé (réservé à l'administrateur), pour les
// chantiers dont les prix n'ont pas été lus (ou lus incomplètement) à la
// création. Rien n'est enregistré sans relecture :
// - GET  : renvoie les lignes déjà enregistrées + les tâches du planning
//          (pour compléter à la main, sans appel à l'IA) ;
// - POST : lit le PDF avec l'IA et renvoie les lignes (aperçu, rien enregistré) ;
// - PUT  : enregistre les lignes relues (remplace l'ancien devis du chantier) et,
//          si demandé, ajoute au planning les lignes qui n'avaient pas de tâche.

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return { error: NextResponse.json({ error: "Non autorisé." }, { status: 401 }) };
  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return { error: NextResponse.json({ error: "Organisation introuvable." }, { status: 403 }) };
  if (member.role !== "admin" && member.role !== "owner") {
    return { error: NextResponse.json({ error: "Seul l'administrateur peut importer les prix du devis." }, { status: 403 }) };
  }
  return { organizationId: member.organization_id as string };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const base = "designation,unit,quantity,unit_price,external_unit_price,created_at";
  let items: Array<Record<string, unknown>> | null = null;
  for (const columns of [`${base},category,subcategory,task_id`, `${base},category,subcategory`, base]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true });
    if (!result.error) { items = result.data as unknown as Array<Record<string, unknown>>; break; }
  }
  const { data: tasks } = await supabase.from("project_tasks").select("id,title,progress_percent").eq("project_id", id);
  const price_lines = (items ?? []).map((item) => ({
    category: String(item.category ?? ""),
    subcategory: String(item.subcategory ?? ""),
    designation: String(item.designation ?? ""),
    unit: String(item.unit ?? ""),
    quantity: Number(item.quantity) || 1,
    unit_price: Number(item.external_unit_price) > 0 ? Number(item.external_unit_price) : Number(item.unit_price) || 0,
    task_id: item.task_id ? String(item.task_id) : undefined,
  }));
  return NextResponse.json({ price_lines, devis_total: null, tasks: tasks ?? [] });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return auth.error;

  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) return NextResponse.json({ error: "Fichier PDF manquant." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });

  const result = await extractDevisFromPdf(file);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  if (result.data.price_lines.length === 0) {
    return NextResponse.json({ error: "Aucun prix n'a été trouvé dans ce PDF. Vérifie que c'est bien le devis chiffré." }, { status: 422 });
  }
  const { data: tasks } = await supabase.from("project_tasks").select("id,title,progress_percent").eq("project_id", id);
  return NextResponse.json({ price_lines: result.data.price_lines, devis_total: result.data.devis_total, tasks: tasks ?? [] });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return auth.error;

  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  const body = await request.json().catch(() => ({})) as {
    price_lines?: Array<{ category?: string; subcategory?: string; designation?: string; unit?: string; quantity?: number; unit_price?: number; task_id?: string }>;
    create_missing_tasks?: boolean;
  };
  const priceLines = (body.price_lines ?? []).filter((line) => String(line.designation ?? "").trim() && Number(line.unit_price) > 0);
  if (priceLines.length === 0) return NextResponse.json({ error: "Aucune ligne chiffrée à enregistrer." }, { status: 400 });

  // Chaque ligne est reliée à la tâche du planning qui lui ressemble le plus
  // (titre, sinon sous-catégorie, sinon catégorie) ; les lignes sans tâche
  // pourront être reliées ou ajoutées au planning depuis l'écran de facture.
  const { data: tasksData } = await supabase.from("project_tasks").select("id,title,progress_percent,dao_sequence").eq("project_id", id);
  const tasks = (tasksData ?? []) as unknown as Array<PlanningTask & { dao_sequence?: number | null }>;
  const taskIds = new Set(tasks.map((task) => String(task.id)));
  // Anciennes lignes du devis (remplacées par celles-ci une fois les nouvelles enregistrées).
  const { data: oldItems } = await supabase.from("project_price_items").select("id").eq("project_id", id).eq("is_internal", false);

  // Tâche de chaque ligne : lien déjà connu, sinon la plus ressemblante ;
  // sinon, si demandé, une nouvelle tâche est ajoutée au planning (à 0 %).
  const resolved = priceLines.map((line) => {
    const known = line.task_id && taskIds.has(String(line.task_id)) ? String(line.task_id) : null;
    return known ?? matchTaskForItem({ designation: String(line.designation), subcategory: line.subcategory, category: line.category }, tasks)?.id ?? null;
  });
  let createdTasks = 0;
  if (body.create_missing_tasks) {
    let nextSequence = tasks.reduce((max, task) => Math.max(max, Number(task.dao_sequence) || 0), 0);
    const missing = resolved.map((taskId, index) => (taskId ? -1 : index)).filter((index) => index >= 0);
    if (missing.length > 0) {
      const { data: created, error: createError } = await supabase
        .from("project_tasks")
        .insert(missing.map((index) => ({ organization_id: auth.organizationId, project_id: id, title: String(priceLines[index].designation).trim(), dao_sequence: ++nextSequence, is_dao_task: false })))
        .select("id");
      if (createError) return NextResponse.json({ error: createError.message }, { status: 400 });
      (created ?? []).forEach((task, position) => { resolved[missing[position]] = String(task.id); });
      createdTasks = created?.length ?? 0;
    }
  }

  // created_at croissant d'une milliseconde par ligne : garde l'ordre du devis.
  const baseTime = Date.now();
  let unmatched = 0;
  const rows = priceLines.map((line, index) => {
    const quantity = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
    const unitPrice = Number(line.unit_price);
    const matchedTaskId = resolved[index];
    if (!matchedTaskId) unmatched += 1;
    return {
      organization_id: auth.organizationId,
      project_id: id,
      position: String(index + 1),
      designation: String(line.designation).trim(),
      unit: String(line.unit ?? "").trim() || null,
      quantity,
      unit_price: null,
      external_unit_price: unitPrice,
      total: Math.round(quantity * unitPrice * 100) / 100,
      is_internal: false,
      created_at: new Date(baseTime + index).toISOString(),
      category: String(line.category ?? "").trim() || null,
      subcategory: String(line.subcategory ?? "").trim() || null,
      task_id: matchedTaskId,
    };
  });
  // Colonnes ajoutées par des fichiers SQL : si elles manquent encore, on
  // enregistre quand même les prix (sans titres et/ou sans lien de tâche).
  let { error } = await supabase.from("project_price_items").insert(rows);
  if (error && /task_id/.test(error.message)) {
    ({ error } = await supabase.from("project_price_items").insert(rows.map(({ task_id: _t, ...rest }) => rest)));
  }
  if (error && /category|subcategory/.test(error.message)) {
    ({ error } = await supabase.from("project_price_items").insert(rows.map(({ task_id: _t, category: _c, subcategory: _s, ...rest }) => rest)));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Les anciennes lignes sont retirées seulement maintenant que les nouvelles
  // sont bien enregistrées.
  const oldIds = (oldItems ?? []).map((item) => item.id);
  if (oldIds.length > 0) await supabase.from("project_price_items").delete().in("id", oldIds);

  // Le devis chiffré devient le prix du chantier : on retire un éventuel prix
  // / marge saisis à la main avant, pour qu'il n'y ait qu'une seule source.
  await supabase
    .from("projects")
    .update({ contract_amount: null, expected_margin_percent: null, expected_margin_amount: null })
    .eq("id", id)
    .eq("organization_id", auth.organizationId);

  return NextResponse.json({ success: true, count: rows.length, unmatched, createdTasks });
}
