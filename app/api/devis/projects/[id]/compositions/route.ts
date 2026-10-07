import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { isLaborLine } from "@/lib/compositions/labor";
import { computeLineFromComposition, type ComputedPart } from "@/lib/compositions/prices";
import { approxLibraryMatch, loadPriceLibrary, lookupLibraryPrices, looseLibraryMatch, whyNoMatch } from "@/lib/prices/library-lookup";
import { designationWithParent } from "@/lib/prices/synonyms";

// Calcul GRATUIT des prix internes manquants d'un devis (aucun crédit IA,
// aucun internet). Pour chaque ligne sans prix interne :
// 1. ligne de main-d'œuvre / chantier → coût 0 (déjà dans les salaires) ;
// 2. prix déjà enregistré pour cet ouvrage (bibliothèque, catalogue partagé) ;
// 3. sinon, composition de l'ouvrage (ciment + sable + eau…) : prix = somme des
//    matériaux au prix de la bibliothèque (le moins cher), main-d'œuvre exclue.
// Les matériaux sans prix sont listés pour la recherche internet (étape suivante).
type Detail = {
  id: string;
  designation: string;
  unit: string;
  status: "bibliothèque" | "composition" | "matériau manquant" | "sans composition";
  price: number | null;
  title?: string;
  notes?: string[];
  parts?: ComputedPart[];
  missing?: string[];
};

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id,name,location").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Devis introuvable." }, { status: 404 });

  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const page = await supabase.from("project_price_items").select("id,designation,unit,quantity,unit_price")
      .eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true }).range(from, from + 999);
    if (page.error) return NextResponse.json({ error: page.error.message }, { status: 400 });
    rows.push(...((page.data ?? []) as Array<Record<string, unknown>>));
    if (!page.data || page.data.length < 1000) break;
  }
  // Texte de recherche d'une ligne : sa désignation, complétée du texte de la ligne parente pour les sous-lignes « 6.02a … ».
  const allTexts = rows.map((row) => String(row.designation ?? ""));
  const searchTextById = new Map(rows.map((row, position) => [String(row.id), designationWithParent(allTexts, position)]));
  const todo = rows.filter((row) => !(Number(row.unit_price) > 0));
  const laborLines = todo.filter((row) => isLaborLine(String(row.designation ?? ""))).length;
  const missing = todo.filter((row) => !isLaborLine(String(row.designation ?? "")));

  const library = await loadPriceLibrary(supabase, auth.organizationId);
  const known = await lookupLibraryPrices(supabase, auth.organizationId, missing.map((row) => ({
    id: String(row.id),
    designation: searchTextById.get(String(row.id)) ?? String(row.designation ?? ""),
    unit: String(row.unit ?? ""),
    quantity: Number(row.quantity) || 1,
  })), library);
  const knownById = new Map(known.map((hit) => [hit.id, hit]));

  const details: Detail[] = [];
  const updates: Array<{ id: string; unit_price: number }> = [];
  const materials = new Map<string, { designation: string; search: string; unit: string; lines: number }>();
  let fromLibrary = 0; let fromShared = 0; let computed = 0;

  for (const row of missing) {
    const lineId = String(row.id);
    const designation = String(row.designation ?? "");
    const unit = String(row.unit ?? "");
    const hit = knownById.get(lineId);
    if (hit) {
      updates.push({ id: lineId, unit_price: hit.price });
      if (hit.source === "bibliothèque") fromLibrary += 1; else fromShared += 1;
      details.push({ id: lineId, designation, unit, status: "bibliothèque", price: hit.price, title: `Prix déjà enregistré (${hit.source}) : ${hit.matched}` });
      continue;
    }
    const searchText = searchTextById.get(lineId) ?? designation;
    const line = computeLineFromComposition(library, searchText, unit);
    if (!line) {
      // Dernier recours gratuit : un prix de la bibliothèque rangé sous un titre voisin (mêmes mots, mêmes dimensions, même verbe).
      const loose = looseLibraryMatch(library, { designation: searchText, unit });
      if (loose) {
        updates.push({ id: lineId, unit_price: loose.price });
        fromLibrary += 1;
        details.push({ id: lineId, designation, unit, status: "bibliothèque", price: loose.price, title: `Prix déjà enregistré (titre voisin) : ${loose.matched}` });
        continue;
      }
      // 3e niveau : fiche voisine la plus proche, prix rempli mais « à vérifier ».
      const near = approxLibraryMatch(library, { designation: searchText, unit });
      if (near) {
        updates.push({ id: lineId, unit_price: near.price });
        fromLibrary += 1;
        details.push({ id: lineId, designation, unit, status: "bibliothèque", price: near.price, title: `À vérifier — prix de la fiche voisine : ${near.matched}` });
        continue;
      }
      details.push({ id: lineId, designation, unit, status: "sans composition", price: null, title: whyNoMatch(library, { designation: searchText, unit }) });
      continue;
    }
    if (line.price !== null && line.price > 0) {
      updates.push({ id: lineId, unit_price: line.price });
      computed += 1;
      details.push({ id: lineId, designation, unit, status: "composition", price: line.price, title: line.title, notes: line.notes, parts: line.parts });
      continue;
    }
    for (const material of line.missing) {
      const key = `${material.search}|${material.unit}`;
      const current = materials.get(key);
      if (current) current.lines += 1; else materials.set(key, { ...material, lines: 1 });
    }
    details.push({ id: lineId, designation, unit, status: "matériau manquant", price: null, title: line.title, notes: line.notes, parts: line.parts, missing: line.missing.map((item) => item.search) });
  }

  let saved = 0;
  for (const update of updates) {
    const { error } = await supabase.from("project_price_items").update({ unit_price: update.unit_price }).eq("id", update.id).eq("project_id", id);
    if (error) return NextResponse.json({ error: error.message, saved }, { status: 400 });
    saved += 1;
  }

  return NextResponse.json({
    ok: true,
    checked: missing.length,
    saved,
    computed,
    fromLibrary,
    fromShared,
    laborLines,
    updates,
    details,
    missingMaterials: [...materials.values()],
    noCompositionIds: details.filter((item) => item.status === "sans composition").map((item) => item.id),
    location: String((project as { location?: string | null }).location ?? ""),
  });
}
