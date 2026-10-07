import type { SupabaseClient } from "@supabase/supabase-js";
import { computeLineFromComposition } from "@/lib/compositions/prices";
import { approxLibraryMatch, loadPriceLibrary, lookupLibraryPrices, looseLibraryMatch, roleSalaryMatch, whyNoMatch } from "@/lib/prices/library-lookup";
import { stripLineReference } from "@/lib/prices/synonyms";

// Prix GRATUITS (aucun crédit IA, aucun internet) pour plusieurs lignes d'un coup : bibliothèque (nom exact),
// catalogue partagé, titre voisin, puis composition de matériaux. Même logique que le calcul gratuit des
// devis ajoutés par PDF. Ne modifie jamais la bibliothèque.
export type FreePriceItem = { id: string; designation: string; unit: string; quantity: number };
export type FreePriceHit = { id: string; price: number; source: string; approximate?: boolean };
export type FreePriceMiss = { id: string; reason: string };

export async function freePrices(supabase: SupabaseClient, organizationId: string, items: FreePriceItem[]): Promise<{ hits: FreePriceHit[]; misses: FreePriceMiss[] }> {
  // Le numéro du poste (« 6,13 », « 9.01 ») est retiré : il ne fait pas partie du nom du matériau.
  const clean = items.map((item) => ({ ...item, designation: stripLineReference(item.designation) })).filter((item) => item.designation.trim() && item.unit.trim());
  if (clean.length === 0) return { hits: [], misses: [] };
  const library = await loadPriceLibrary(supabase, organizationId);
  const known = await lookupLibraryPrices(supabase, organizationId, clean, library);
  const knownById = new Map(known.map((hit) => [hit.id, hit]));
  const hits: FreePriceHit[] = [];
  const misses: FreePriceMiss[] = [];
  for (const item of clean) {
    const hit = knownById.get(item.id);
    if (hit) { hits.push({ id: item.id, price: hit.price, source: `Bibliothèque : ${hit.matched}` }); continue; }
    const salary = roleSalaryMatch(library, { designation: item.designation, unit: item.unit });
    if (salary) { hits.push({ id: item.id, price: salary.price, source: `Salaire de la bibliothèque : ${salary.matched}` }); continue; }
    const composition = computeLineFromComposition(library, item.designation, item.unit);
    if (composition && composition.price !== null && composition.price > 0) { hits.push({ id: item.id, price: composition.price, source: `Composition de matériaux : ${composition.title ?? item.designation}` }); continue; }
    const loose = composition ? null : looseLibraryMatch(library, { designation: item.designation, unit: item.unit });
    if (loose) { hits.push({ id: item.id, price: loose.price, source: `Bibliothèque (titre voisin) : ${loose.matched}` }); continue; }
    // 3e niveau : fiche la plus proche, prix rempli mais marqué « à vérifier ».
    const near = approxLibraryMatch(library, { designation: item.designation, unit: item.unit });
    if (near) { hits.push({ id: item.id, price: near.price, source: `À vérifier — prix de la fiche voisine « ${near.matched} »`, approximate: true }); continue; }
    misses.push({ id: item.id, reason: whyNoMatch(library, { designation: item.designation, unit: item.unit }) });
  }
  return { hits, misses };
}
