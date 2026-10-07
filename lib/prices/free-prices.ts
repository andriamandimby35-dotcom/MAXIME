import type { SupabaseClient } from "@supabase/supabase-js";
import { computeLineFromComposition } from "@/lib/compositions/prices";
import { loadPriceLibrary, lookupLibraryPrices, looseLibraryMatch } from "@/lib/prices/library-lookup";

// Prix GRATUITS (aucun crédit IA, aucun internet) pour plusieurs lignes d'un coup : bibliothèque (nom exact),
// catalogue partagé, titre voisin, puis composition de matériaux. Même logique que le calcul gratuit des
// devis ajoutés par PDF. Ne modifie jamais la bibliothèque.
export type FreePriceItem = { id: string; designation: string; unit: string; quantity: number };
export type FreePriceHit = { id: string; price: number; source: string };

export async function freePrices(supabase: SupabaseClient, organizationId: string, items: FreePriceItem[]): Promise<FreePriceHit[]> {
  const clean = items.filter((item) => item.designation.trim() && item.unit.trim());
  if (clean.length === 0) return [];
  const library = await loadPriceLibrary(supabase, organizationId);
  const known = await lookupLibraryPrices(supabase, organizationId, clean, library);
  const knownById = new Map(known.map((hit) => [hit.id, hit]));
  const hits: FreePriceHit[] = [];
  for (const item of clean) {
    const hit = knownById.get(item.id);
    if (hit) { hits.push({ id: item.id, price: hit.price, source: `Bibliothèque : ${hit.matched}` }); continue; }
    const composition = computeLineFromComposition(library, item.designation, item.unit);
    if (composition && composition.price !== null && composition.price > 0) { hits.push({ id: item.id, price: composition.price, source: `Composition de matériaux : ${composition.title ?? item.designation}` }); continue; }
    if (!composition) {
      const loose = looseLibraryMatch(library, { designation: item.designation, unit: item.unit });
      if (loose) hits.push({ id: item.id, price: loose.price, source: `Bibliothèque (titre voisin) : ${loose.matched}` });
    }
  }
  return hits;
}
