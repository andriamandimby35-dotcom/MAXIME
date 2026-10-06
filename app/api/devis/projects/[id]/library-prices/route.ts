import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { lookupLibraryPrices } from "@/lib/prices/library-lookup";

// Étape GRATUITE du remplissage des prix internes : reprend les prix déjà
// connus (bibliothèque de l'entreprise, catalogue partagé) pour les lignes du
// devis dont le prix interne manque. Aucun crédit IA, aucun internet : les
// lignes introuvables sont simplement renvoyées pour que l'administrateur
// choisisse (les saisir lui-même ou lancer la recherche internet).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id,name,location").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Devis introuvable." }, { status: 404 });

  let rows: Array<Record<string, unknown>> | null = null;
  for (const columns of ["id,designation,unit,quantity,unit_price,category", "id,designation,unit,quantity,unit_price"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true }).range(0, 4999);
    if (!result.error) { rows = result.data as unknown as Array<Record<string, unknown>>; break; }
  }
  const missing = (rows ?? []).filter((row) => !(Number(row.unit_price) > 0));
  const hits = await lookupLibraryPrices(supabase, auth.organizationId, missing.map((row) => ({
    id: String(row.id),
    designation: String(row.designation ?? ""),
    unit: String(row.unit ?? ""),
    quantity: Number(row.quantity) || 1,
  })));

  let saved = 0;
  const savedIds = new Set<string>();
  for (const hit of hits) {
    const { error } = await supabase.from("project_price_items").update({ unit_price: hit.price }).eq("id", hit.id).eq("project_id", id);
    if (error) return NextResponse.json({ error: error.message, saved }, { status: 400 });
    saved += 1;
    savedIds.add(hit.id);
  }
  const remaining = missing.filter((row) => !savedIds.has(String(row.id))).map((row) => ({
    id: String(row.id),
    designation: String(row.designation ?? ""),
    unit: String(row.unit ?? ""),
    quantity: Number(row.quantity) || 1,
    category: String(row.category ?? ""),
  }));
  return NextResponse.json({
    ok: true,
    checked: missing.length,
    saved,
    fromLibrary: hits.filter((hit) => hit.source === "bibliothèque").length,
    fromShared: hits.filter((hit) => hit.source === "catalogue partagé").length,
    updates: hits.map((hit) => ({ id: hit.id, unit_price: hit.price })),
    remaining,
    location: String((project as { location?: string | null }).location ?? ""),
  });
}
