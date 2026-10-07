import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { computeLineFromComposition } from "@/lib/compositions/prices";
import { loadPriceLibrary, lookupLibraryPrices, looseLibraryMatch } from "@/lib/prices/library-lookup";

// « Détail du prix » d'une ligne : d'où vient (ou viendrait) son prix interne — matériau de la bibliothèque
// ou composition (ciment + sable + eau…). Lecture seule : rien n'est enregistré. La bibliothèque n'est lue
// que quand tu cliques sur « Détail du prix ».
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  const { id, lineId } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  const { data: line } = await supabase.from("project_price_items").select("id,designation,unit,quantity,unit_price,external_unit_price").eq("id", lineId).eq("project_id", id).maybeSingle();
  if (!line) return NextResponse.json({ error: "Ligne introuvable." }, { status: 404 });

  const designation = String(line.designation ?? "");
  const unit = String(line.unit ?? "");
  const library = await loadPriceLibrary(supabase, auth.organizationId);
  const known = await lookupLibraryPrices(supabase, auth.organizationId, [{ id: lineId, designation, unit, quantity: Number(line.quantity) || 1 }], library);
  const hit = known[0];
  if (hit) return NextResponse.json({ ok: true, current: Number(line.unit_price) || null, status: "bibliothèque", price: hit.price, title: `Matériau trouvé (${hit.source}) : ${hit.matched}`, parts: [], notes: [], missing: [] });
  const composition = computeLineFromComposition(library, designation, unit);
  if (composition) {
    return NextResponse.json({
      ok: true, current: Number(line.unit_price) || null,
      status: composition.price !== null && composition.price > 0 ? "composition" : "matériau manquant",
      price: composition.price, title: composition.title, parts: composition.parts, notes: composition.notes, missing: composition.missing.map((item) => item.search),
    });
  }
  const loose = looseLibraryMatch(library, { designation, unit });
  if (loose) return NextResponse.json({ ok: true, current: Number(line.unit_price) || null, status: "bibliothèque", price: loose.price, title: `Matériau voisin trouvé : ${loose.matched}`, parts: [], notes: [], missing: [] });
  return NextResponse.json({ ok: true, current: Number(line.unit_price) || null, status: "sans composition", price: null, title: "", parts: [], notes: [], missing: [] });
}
