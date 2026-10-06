import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { isLaborLine } from "@/lib/compositions/labor";

// Prix INTERNES (coûts) d'un devis déjà enregistré dans le bordereau du chantier.
// - GET   : lignes dont le prix interne manque (à remplir par la recherche de prix) ;
// - PATCH : enregistre les prix internes trouvés ({ updates: [{ id, unit_price }] }).

async function ownProject(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: string, id: string) {
  const { data } = await supabase.from("projects").select("id,name,location").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  return data as { id: string; name: string; location: string | null } | null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const project = await ownProject(supabase, auth.organizationId, id);
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  let rows: Array<Record<string, unknown>> | null = null;
  for (const columns of ["id,designation,unit,quantity,unit_price,category,subcategory", "id,designation,unit,quantity,unit_price"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true });
    if (!result.error) { rows = result.data as unknown as Array<Record<string, unknown>>; break; }
  }
  const missing = (rows ?? [])
    .filter((row) => !(Number(row.unit_price) > 0) && !isLaborLine(String(row.designation ?? "")))
    .map((row) => ({
      id: String(row.id),
      designation: String(row.designation ?? ""),
      unit: String(row.unit ?? ""),
      quantity: Number(row.quantity) || 1,
      category: String(row.category ?? ""),
    }));
  return NextResponse.json({ project: { id: project.id, name: project.name, location: project.location ?? "" }, missing });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const project = await ownProject(supabase, auth.organizationId, id);
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as { updates?: Array<{ id?: string; unit_price?: number }> };
  const updates = (body.updates ?? []).filter((update) => update.id && Number(update.unit_price) > 0);
  if (updates.length === 0) return NextResponse.json({ error: "Aucun prix à enregistrer." }, { status: 400 });
  let saved = 0;
  for (const update of updates) {
    const { error } = await supabase
      .from("project_price_items")
      .update({ unit_price: Number(update.unit_price) })
      .eq("id", update.id as string)
      .eq("project_id", id);
    if (error) return NextResponse.json({ error: error.message, saved }, { status: 400 });
    saved += 1;
  }
  return NextResponse.json({ ok: true, saved });
}
