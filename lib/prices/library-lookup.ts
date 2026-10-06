import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalMaterialKey, canonicalUnit, materialFamily } from "@/lib/material-normalization";
import { cheapestOf, priceSearchableText, usefulTokens } from "@/lib/price-engine/search-price";

// Recherche GRATUITE de prix dans la bibliothèque (aucun appel à l'IA, aucun
// internet) pour plusieurs lignes d'un coup : la bibliothèque de l'entreprise
// et le catalogue partagé ne sont lues qu'UNE fois pour tout le devis (au lieu
// d'une lecture par ligne). Même logique de reconnaissance que la recherche de
// prix du devis, mais plus prudente : on ne reprend un prix que si le nom, ou
// la famille ET les mots techniques, correspondent et que l'unité est la même.
// Le reste est laissé à la recherche internet (choix de l'administrateur).

export type LookupItem = { id: string; designation: string; unit: string; quantity: number };
export type LookupHit = { id: string; price: number; source: "bibliothèque" | "catalogue partagé"; matched: string };

type PriceRow = Record<string, unknown>;

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

function savedPrice(row: PriceRow) {
  return positive(row.prix_entreprise) ?? positive(row.prix_retenu) ?? positive(row.prix_actuel) ?? positive(row.prix_ia);
}

export type PriceLibraryRow = PriceRow;

// Bibliothèque lue UNE seule fois, page par page (Supabase ne renvoie jamais
// plus de 1000 lignes d'un coup), avec seulement les colonnes utiles.
export async function loadPriceLibrary(supabase: SupabaseClient, organizationId: string): Promise<PriceLibraryRow[]> {
  const library: PriceRow[] = [];
  for (let from = 0; ; from += 1000) {
    let page = await supabase.from("price_library")
      .select("id,designation,unite,caracteristiques,prix_entreprise,prix_retenu,prix_actuel,prix_ia,quantite_par_unite_achat,prix_unite_achat")
      .eq("organization_id", organizationId).range(from, from + 999);
    // Colonne absente dans une ancienne base : lecture complète.
    if (page.error) page = await supabase.from("price_library").select("*").eq("organization_id", organizationId).range(from, from + 999);
    if (page.error || !page.data || page.data.length === 0) break;
    library.push(...(page.data as PriceRow[]));
    if (page.data.length < 1000) break;
  }
  return library;
}

export async function lookupLibraryPrices(supabase: SupabaseClient, organizationId: string, items: LookupItem[], preloaded?: PriceLibraryRow[]): Promise<LookupHit[]> {
  if (items.length === 0) return [];
  const library = preloaded ?? await loadPriceLibrary(supabase, organizationId);

  // Catalogue partagé : une seule requête pour toutes les désignations du devis.
  const keys = [...new Set(items.map((item) => canonicalMaterialKey(item.designation)).filter(Boolean))];
  const shared: PriceRow[] = [];
  for (let from = 0; from < keys.length; from += 100) {
    const { data } = await supabase.from("shared_material_prices").select("designation_key,designation,unite,prix_unitaire").in("designation_key", keys.slice(from, from + 100));
    shared.push(...((data ?? []) as PriceRow[]));
  }

  const hits: LookupHit[] = [];
  for (const item of items) {
    const unit = canonicalUnit(item.unit);
    if (!item.designation.trim() || !unit) continue;
    const key = canonicalMaterialKey(item.designation);
    const family = materialFamily(item.designation);
    const tokens = usefulTokens(item.designation);
    const sameUnit = (row: PriceRow) => canonicalUnit(String(row.unite ?? "")) === unit;

    const exact = library.filter((row) => canonicalMaterialKey(String(row.designation ?? "")) === key && sameUnit(row));
    const familyAndDetail = tokens.length > 0
      ? library.filter((row) => sameUnit(row) && materialFamily(String(row.designation ?? "")) === family && tokens.every((word) => priceSearchableText(row).includes(word)))
      : [];
    const detail = tokens.length > 0
      ? library.filter((row) => sameUnit(row) && tokens.every((word) => priceSearchableText(row).includes(word)))
      : [];
    const found = exact.length > 0 ? cheapestOf(exact) : familyAndDetail.length > 0 ? cheapestOf(familyAndDetail) : detail.length > 0 ? cheapestOf(detail) : null;

    if (found) {
      // Matériau vendu par pièce entière : prix ramené à l'unité du devis.
      const purchaseQty = positive(found.quantite_par_unite_achat);
      const purchasePrice = positive(found.prix_unite_achat);
      let price = savedPrice(found);
      if (purchaseQty && purchasePrice && item.quantity > 0) price = (Math.ceil(item.quantity / purchaseQty) * purchasePrice) / item.quantity;
      if (price) { hits.push({ id: item.id, price: Math.round(price * 100) / 100, source: "bibliothèque", matched: String(found.designation ?? "") }); continue; }
    }
    const sharedMatches = shared.filter((row) => String(row.designation_key ?? "") === key && sameUnit(row) && positive(row.prix_unitaire));
    if (sharedMatches.length > 0) {
      const best = sharedMatches.reduce((low, row) => (Number(row.prix_unitaire) < Number(low.prix_unitaire) ? row : low));
      hits.push({ id: item.id, price: Number(best.prix_unitaire), source: "catalogue partagé", matched: String(best.designation ?? "") });
    }
  }
  return hits;
}
