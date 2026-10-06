import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { externalPricesFromInternal } from "@/lib/devis/pricing";
import { resolveItemTasks, type PlanningTask } from "@/lib/billing/task-matching";

// Étape 2 de « Ajouter un devis » : crée le chantier, son planning et son
// bordereau de prix à partir des lignes lues (et relues à l'écran).
// - kind "external" : les prix du PDF sont les prix du client (facture). Le prix
//   interne reste vide : il sera rempli ensuite (bibliothèque / internet).
// - kind "internal" : les prix du PDF sont les coûts. Avec prix, la marge donnée
//   fabrique les prix externes ; sans prix, tout reste à remplir.
export const maxDuration = 120;

type InLine = { category?: string; subcategory?: string; designation?: string; unit?: string; quantity?: number; unit_price?: number };

export async function POST(request: Request) {
  const supabase = await createServerClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    kind?: string; name?: string; location?: string; works?: string[]; lines?: InLine[]; margin_percent?: number | string | null;
  };
  const kind = body.kind === "internal" ? "internal" : "external";
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Le nom du chantier est obligatoire." }, { status: 400 });
  const lines = (body.lines ?? []).filter((line) => String(line.designation ?? "").trim());
  if (lines.length === 0) return NextResponse.json({ error: "Aucune ligne dans ce devis." }, { status: 400 });

  const hasPrices = lines.some((line) => Number(line.unit_price) > 0);
  let margin: number | null = null;
  if (kind === "internal" && hasPrices) {
    const raw = String(body.margin_percent ?? "").replace(/\s/g, "").replace(",", ".");
    const parsed = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= -100) return NextResponse.json({ error: "Indique la marge à appliquer (en %) pour fabriquer le devis externe." }, { status: 400 });
    margin = parsed;
  }

  // 1. Chantier (identifiant choisi à l'avance, comme à la création manuelle).
  const projectId = randomUUID();
  const { error: projectError } = await supabase.from("projects").insert({
    id: projectId,
    organization_id: auth.organizationId,
    name,
    location: String(body.location ?? "").trim() || null,
    status: "planned",
  });
  if (projectError) return NextResponse.json({ error: projectError.message }, { status: 400 });

  // 2. Planning : les travaux dans l'ordre d'exécution (lus par l'IA), puis une
  // tâche pour chaque ligne qui n'en a trouvé aucune (texte, ou lignes voisines).
  const titles = (body.works ?? []).map((title) => String(title).trim()).filter(Boolean);
  const taskTitles = titles.length > 0 ? titles : lines.map((line) => String(line.designation).trim());
  const { data: createdTasks, error: tasksError } = await supabase
    .from("project_tasks")
    .insert(taskTitles.map((title, index) => ({ organization_id: auth.organizationId, project_id: projectId, title, dao_sequence: index + 1, is_dao_task: false })))
    .select("id,title,progress_percent");
  if (tasksError) return NextResponse.json({ error: `Chantier créé, planning impossible : ${tasksError.message}`, projectId }, { status: 400 });
  const tasks: PlanningTask[] = (createdTasks ?? []).map((task) => ({ id: String(task.id), title: String(task.title), progress_percent: Number(task.progress_percent) || 0 }));

  const matches = resolveItemTasks(lines.map((line) => ({ designation: String(line.designation), subcategory: line.subcategory, category: line.category })), tasks);
  const taskIdByLine: Array<string | null> = matches.map((match) => match?.id ?? null);
  const missing = taskIdByLine.map((id, index) => (id ? -1 : index)).filter((index) => index >= 0);
  let addedTasks = 0;
  if (missing.length > 0) {
    let sequence = taskTitles.length;
    const { data: extra } = await supabase
      .from("project_tasks")
      .insert(missing.map((index) => ({ organization_id: auth.organizationId, project_id: projectId, title: String(lines[index].designation).trim(), dao_sequence: ++sequence, is_dao_task: false })))
      .select("id");
    (extra ?? []).forEach((task, position) => { taskIdByLine[missing[position]] = String(task.id); });
    addedTasks = extra?.length ?? 0;
  }

  // 3. Bordereau de prix (créé_at croissant : garde l'ordre du devis).
  const quantities = lines.map((line) => (Number(line.quantity) > 0 ? Number(line.quantity) : 1));
  const prices = lines.map((line) => (Number(line.unit_price) > 0 ? Number(line.unit_price) : 0));
  const externalFromInternal = kind === "internal" && margin !== null
    ? externalPricesFromInternal(lines.map((_, index) => ({ quantity: quantities[index], unit_price: prices[index] })), margin)
    : null;
  const baseTime = Date.now();
  const rows = lines.map((line, index) => {
    const internal = kind === "internal" && prices[index] > 0 ? prices[index] : null;
    const external = kind === "external"
      ? (prices[index] > 0 ? prices[index] : null)
      : (externalFromInternal && externalFromInternal[index] > 0 ? externalFromInternal[index] : null);
    return {
      organization_id: auth.organizationId,
      project_id: projectId,
      position: String(index + 1),
      designation: String(line.designation).trim(),
      unit: String(line.unit ?? "").trim() || null,
      quantity: quantities[index],
      unit_price: internal,
      external_unit_price: external,
      total: Math.round(quantities[index] * (external ?? internal ?? 0) * 100) / 100 || null,
      is_internal: false,
      created_at: new Date(baseTime + index).toISOString(),
      category: String(line.category ?? "").trim() || null,
      subcategory: String(line.subcategory ?? "").trim() || null,
      task_id: taskIdByLine[index],
    };
  });
  let { error } = await supabase.from("project_price_items").insert(rows);
  if (error && /task_id/.test(error.message)) ({ error } = await supabase.from("project_price_items").insert(rows.map(({ task_id: _t, ...rest }) => rest)));
  if (error && /category|subcategory/.test(error.message)) ({ error } = await supabase.from("project_price_items").insert(rows.map(({ task_id: _t, category: _c, subcategory: _s, ...rest }) => rest)));
  if (error) return NextResponse.json({ error: `Chantier créé, mais le devis n'a pas pu être enregistré : ${error.message}`, projectId }, { status: 400 });

  // 4. Marge connue dès maintenant (devis interne avec prix) : retenue sur le chantier.
  let warning: string | undefined;
  if (margin !== null) {
    const { error: marginError } = await supabase.from("projects").update({ expected_margin_percent: margin }).eq("id", projectId);
    if (marginError) warning = "La marge n'a pas pu être retenue (fichier SQL « 20261006_project_pricing.sql » pas encore exécuté).";
  }

  return NextResponse.json({
    ok: true,
    projectId,
    count: rows.length,
    addedTasks,
    needsInternalPrices: rows.filter((row) => !(Number(row.unit_price) > 0)).length,
    warning,
  });
}
