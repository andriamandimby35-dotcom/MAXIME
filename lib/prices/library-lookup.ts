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

// ─── Reconnaissance « souple » ────────────────────────────────────────────────
// Un devis relu (ou un devis dont les titres sont plus complets que ceux déjà gardés
// dans la bibliothèque) ne retrouve plus ses prix : « Prises escalier » ≠ « Fourniture et
// pose de prises de courant - Escalier ». Cette recherche, utilisée seulement pour les
// lignes qui n'ont trouvé ni prix exact ni composition, compare les MOTS importants :
// - même unité, mêmes dimensions/nombres (410x196, 1,5 mm²…) ;
// - même verbe d'action (réparation, dépose, remplacement…) des deux côtés : un prix de
//   matériel NEUF n'est jamais repris pour une « réparation » ;
// - les mots de l'un doivent tous se retrouver dans l'autre (quelques mots d'écart permis).
const LOOSE_STOP = new Set(["de", "des", "du", "la", "le", "les", "l", "d", "et", "en", "a", "au", "aux", "sur", "pour", "avec", "un", "une", "fourniture", "fournitures", "pose", "mise", "place", "travaux", "y", "compris", "ens", "ensemble"]);
const LOOSE_ACTIONS = ["reparation", "remplacement", "depose", "demolition", "curage", "reprise", "remise", "ajustage", "nettoyage", "traitement", "decapage", "rebouchage", "repose", "renovation", "rehabilitation", "refection"];
const LOOSE_SYNONYMS: Record<string, string> = { ventail: "vantail", ventaux: "vantail", vantaux: "vantail", vantail: "vantail", ventails: "vantail", metallique: "metal", metalliques: "metal", metalliq: "metal", carrelage: "carreau", carrelages: "carreau" };

function looseSignature(text: string) {
  const words = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, " ").split(/[^a-z0-9]+/).filter(Boolean)
    .map((word) => LOOSE_SYNONYMS[word] ?? (/\d/.test(word) || word.length <= 3 ? word : word.replace(/(s|x)$/, "")));
  const actions = new Set(words.filter((word) => LOOSE_ACTIONS.some((action) => word.startsWith(action.slice(0, 6)))));
  const digits = new Set(words.filter((word) => /\d/.test(word)));
  const content = new Set(words.filter((word) => !LOOSE_STOP.has(word) && !actions.has(word) && !/\d/.test(word)));
  return { actions, digits, content };
}
const sameLooseSet = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every((word) => right.has(word));

export type LooseHit = { price: number; matched: string; score: number };

/** Meilleur prix de la bibliothèque pour une ligne, par comparaison souple des mots. null = rien de sûr. */
export function looseLibraryMatch(library: PriceLibraryRow[], item: { designation: string; unit: string }): LooseHit | null {
  const unit = canonicalUnit(item.unit);
  if (!unit || !item.designation.trim()) return null;
  const target = looseSignature(item.designation);
  if (target.content.size === 0) return null;
  let best: LooseHit | null = null;
  for (const row of library) {
    if (canonicalUnit(String(row.unite ?? "")) !== unit) continue;
    const price = savedPrice(row);
    if (!price) continue;
    const other = looseSignature(String(row.designation ?? ""));
    if (other.content.size === 0 || !sameLooseSet(target.actions, other.actions)) continue;
    // Dimensions : identiques des deux côtés. Seule exception : la ligne n'en cite aucune et la fiche n'en a qu'une
    // (ex. « Gouttière PVC Ø100 », « Plaque de plâtre BA13 ») ; une fiche à plusieurs dimensions (« Portillon 120x70 ») n'est jamais reprise pour une ligne sans dimension.
    if (!(sameLooseSet(target.digits, other.digits) || (target.digits.size === 0 && other.digits.size <= 1))) continue;
    const shared = [...target.content].filter((word) => other.content.has(word)).length;
    if (shared === 0) continue;
    const smaller = Math.min(target.content.size, other.content.size);
    const union = new Set([...target.content, ...other.content]).size;
    // Tous les mots du plus court se retrouvent dans l'autre, et pas plus de 3 mots d'écart.
    if (shared < smaller || union - shared > 3) continue;
    const score = shared / union;
    if (score < 0.4) continue;
    if (!best || score > best.score || (score === best.score && price < best.price)) best = { price: Math.round(price * 100) / 100, matched: String(row.designation ?? ""), score };
  }
  return best;
}
