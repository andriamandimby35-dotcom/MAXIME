import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractDevisFromPdf } from "@/lib/projects/extract-devis-pdf";

// Import des prix du devis (PDF) sur un chantier DÉJÀ créé (réservé à
// l'administrateur), pour les chantiers dont les prix n'ont pas été lus à la
// création. En deux temps, pour que rien ne soit enregistré sans relecture :
// - POST : lit le PDF avec l'IA et renvoie les lignes (aperçu, rien enregistré) ;
// - PUT  : enregistre les lignes relues dans le bordereau du chantier.
// Le planning du chantier n'est jamais modifié.

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

async function projectHasExternalItems(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string) {
  const { count } = await supabase
    .from("project_price_items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("is_internal", false);
  return (count ?? 0) > 0;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return auth.error;

  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  if (await projectHasExternalItems(supabase, id)) {
    return NextResponse.json({ error: "Ce chantier a déjà des prix de devis." }, { status: 409 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) return NextResponse.json({ error: "Fichier PDF manquant." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });

  const result = await extractDevisFromPdf(file);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  if (result.data.price_lines.length === 0) {
    return NextResponse.json({ error: "Aucun prix n'a été trouvé dans ce PDF. Vérifie que c'est bien le devis chiffré." }, { status: 422 });
  }
  return NextResponse.json({ price_lines: result.data.price_lines, devis_total: result.data.devis_total });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return auth.error;

  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  if (await projectHasExternalItems(supabase, id)) {
    return NextResponse.json({ error: "Ce chantier a déjà des prix de devis." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({})) as { price_lines?: Array<{ category?: string; subcategory?: string; designation?: string; unit?: string; quantity?: number; unit_price?: number }> };
  const priceLines = (body.price_lines ?? []).filter((line) => String(line.designation ?? "").trim() && Number(line.unit_price) > 0);
  if (priceLines.length === 0) return NextResponse.json({ error: "Aucune ligne chiffrée à enregistrer." }, { status: 400 });

  // created_at croissant d'une milliseconde par ligne : garde l'ordre du devis.
  const baseTime = Date.now();
  const rows = priceLines.map((line, index) => {
    const quantity = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
    const unitPrice = Number(line.unit_price);
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
    };
  });
  let { error } = await supabase.from("project_price_items").insert(rows);
  if (error && /category|subcategory/.test(error.message)) {
    ({ error } = await supabase.from("project_price_items").insert(rows.map(({ category: _c, subcategory: _s, ...rest }) => rest)));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Le devis chiffré devient le prix du chantier : on retire un éventuel prix
  // / marge saisis à la main avant, pour qu'il n'y ait qu'une seule source.
  await supabase
    .from("projects")
    .update({ contract_amount: null, expected_margin_percent: null, expected_margin_amount: null })
    .eq("id", id)
    .eq("organization_id", auth.organizationId);

  return NextResponse.json({ success: true, count: rows.length });
}
