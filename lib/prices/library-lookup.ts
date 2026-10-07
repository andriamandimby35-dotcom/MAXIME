import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalMaterialKey, canonicalUnit, materialFamily } from "@/lib/material-normalization";
import { cheapestOf, priceSearchableText, usefulTokens } from "@/lib/price-engine/search-price";
import { btpTokens, stripLineReference, unitGroup } from "@/lib/prices/synonyms";

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
  // Le numéro de ligne du DAO ou du devis (« 6,13 », « 9.01 »…) ne compte jamais dans la recherche.
  items = items.map((item) => ({ ...item, designation: stripLineReference(item.designation) }));
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
const LOOSE_ACTIONS = ["reparation", "remplacement", "depose", "demolition", "curage", "reprise", "remise", "ajustage", "nettoyage", "traitement", "decapage", "rebouchage", "repose", "renovation", "rehabilitation", "refection"];
// Vocabulaire du bâtiment (parpaing = agglo, fer HA10 = Ø10 = acier 10 mm, dosage 350 = Q350…) : voir synonyms.ts.
const LOOSE_EXTRA: Record<string, string> = { ventail: "vantail", ventaux: "vantail", vantaux: "vantail", ventails: "vantail", metallique: "metal", metalliques: "metal", metalliq: "metal", bahu: "bahut", bahuts: "bahut", exterieure: "exterieur", exterieures: "exterieur", interieure: "interieur", interieures: "interieur" };

function looseSignature(text: string) {
  const words = btpTokens(text).map((word) => LOOSE_EXTRA[word] ?? word);
  const actions = new Set(words.filter((word) => LOOSE_ACTIONS.some((action) => word.startsWith(action.slice(0, 6)))));
  const digits = new Set(words.filter((word) => /\d/.test(word)));
  const content = new Set(words.filter((word) => !actions.has(word) && !/\d/.test(word)));
  return { actions, digits, content };
}
// Objets : « Portes métalliques » ne prend jamais le prix d'une « Armoire métallique à 2 portes », ni « Chaises du maître »
// celui d'un « Bureau du maître avec chaise » : si la fiche cite un objet que la ligne ne cite pas, ce n'est pas la même chose.
const OBJECT_WORDS = new Set(["armoire", "bureau", "table", "chaise", "banc", "tabouret", "etagere", "lit", "porte", "fenetre", "portail", "grille", "placard", "tuyau", "robinet", "gouttiere", "descente", "faitiere", "solin", "lavabo", "wc", "evier", "dalle", "citerne", "puisard", "cunette", "escalier", "main", "garde", "poteau", "poutre", "panne", "lierne", "echantignole", "cornier", "ferme", "chevron", "liteau", "volige", "lattis", "plafond", "cloison", "barre", "couvercle", "tole", "carreau", "brique", "parpaing", "moellon", "puits", "rigole", "cantine", "armature", "mecanisee"]);
const objectWordsDiffer = (target: Set<string>, library: Set<string>) => {
  // Le « mot principal » (le premier) de l'un ne doit jamais manquer chez l'autre quand c'est un objet.
  const headOf = (words: Set<string>) => [...words][0];
  const libraryHead = headOf(library);
  const targetHead = headOf(target);
  return (OBJECT_WORDS.has(libraryHead) && !target.has(libraryHead)) || (OBJECT_WORDS.has(targetHead) && !library.has(targetHead));
};
const sameLooseSet = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every((word) => right.has(word));
// Une fiche de main-d'œuvre n'est jamais reprise pour une fourniture (et inversement).
const isLabourText = (text: string) => /main[\s'’-]*d[\s'’-]*(?:oe|œ)uvre|\bsalaire\b|\bjour[\s-]*personne\b/i.test(text.normalize("NFD").replace(/[̀-ͯ]/g, ""));
const sameUnitLoose = (left: string, right: string) => {
  const a = unitGroup(left);
  return Boolean(a) && a === unitGroup(right);
};

export type LooseHit = { price: number; matched: string; score: number };

/** Meilleur prix de la bibliothèque pour une ligne, par comparaison souple des mots. null = rien de sûr. */
export function looseLibraryMatch(library: PriceLibraryRow[], item: { designation: string; unit: string }): LooseHit | null {
  if (!item.unit.trim() || !item.designation.trim()) return null;
  const target = looseSignature(stripLineReference(item.designation));
  if (target.content.size === 0) return null;
  let best: (LooseHit & { shared: number }) | null = null;
  for (const row of library) {
    if (!sameUnitLoose(item.unit, String(row.unite ?? ""))) continue;
    const price = savedPrice(row);
    if (!price) continue;
    const other = looseSignature(String(row.designation ?? ""));
    if (other.content.size === 0 || !sameLooseSet(target.actions, other.actions)) continue;
    if (isLabourText(String(row.designation ?? "")) !== isLabourText(item.designation)) continue;
    // Dimensions : identiques des deux côtés ; ou toutes celles de la fiche se retrouvent dans la ligne du DAO (la ligne en
    // donne plus : dosage, épaisseur…) ; ou la ligne n'en cite aucune et la fiche n'en a qu'une (« Gouttière PVC Ø100 »).
    // Une fiche à plusieurs dimensions n'est jamais reprise pour une ligne qui n'en cite pas.
    const digitsOk = sameLooseSet(target.digits, other.digits)
      || (other.digits.size > 0 && [...other.digits].every((word) => target.digits.has(word)))
      || (target.digits.size === 0 && other.digits.size <= 1);
    if (!digitsOk) continue;
    const shared = [...target.content].filter((word) => other.content.has(word)).length;
    if (shared === 0) continue;
    if (objectWordsDiffer(target.content, other.content)) continue;
    const smaller = Math.min(target.content.size, other.content.size);
    const union = new Set([...target.content, ...other.content]).size;
    const nearSame = shared >= 4 && shared / union >= 0.7; // textes presque identiques, un ou deux mots différents (« antirouille » / « protection »)
    if (shared < smaller && !nearSame) continue;
    const libraryInside = other.content.size === shared;
    // La fiche est plus courte que le texte technique du DAO : tous ses mots s'y retrouvent (une fiche d'un seul mot
    // n'est reprise que pour un texte court). Sinon (DAO plus court) : pas plus de 3 mots d'écart.
    if (libraryInside) { if (other.content.size < 2 && target.content.size > 3) continue; }
    else if (!nearSame && union - shared > 3) continue;
    const score = shared / union;
    if (!libraryInside && !nearSame && score < 0.4) continue;
    if (!best || shared > best.shared || (shared === best.shared && (score > best.score || (score === best.score && price < best.price)))) best = { price: Math.round(price * 100) / 100, matched: String(row.designation ?? ""), score, shared };
  }
  return best ? { price: best.price, matched: best.matched, score: best.score } : null;
}

// ─── 3e niveau : prix « voisin » (à vérifier) ──────────────────────────────────
// Quand ni le nom, ni la composition, ni la comparaison prudente ne trouvent un prix, on prend la fiche la plus proche
// de la bibliothèque (même unité, même objet principal, au moins la moitié des mots en commun). Le prix est rempli
// pour ne pas laisser de trou, mais marqué « à vérifier » dans le devis. Rien n'est enregistré dans la bibliothèque.
export function approxLibraryMatch(library: PriceLibraryRow[], item: { designation: string; unit: string }): LooseHit | null {
  if (!item.unit.trim() || !item.designation.trim()) return null;
  const target = looseSignature(stripLineReference(item.designation));
  if (target.content.size === 0) return null;
  const targetHead = [...target.content][0];
  let best: LooseHit | null = null;
  for (const row of library) {
    if (!sameUnitLoose(item.unit, String(row.unite ?? ""))) continue;
    const price = savedPrice(row);
    if (!price) continue;
    const other = looseSignature(String(row.designation ?? ""));
    if (other.content.size === 0 || !sameLooseSet(target.actions, other.actions)) continue;
    if (isLabourText(String(row.designation ?? "")) !== isLabourText(item.designation)) continue;
    if (objectWordsDiffer(target.content, other.content)) continue;
    // Deux dimensions différentes (fer 8 / fer 12, dosage 250 / 350) = deux produits : jamais de prix voisin.
    const targetNumbers = [...target.digits].filter((word) => !word.includes("x"));
    const otherNumbers = [...other.digits].filter((word) => !word.includes("x"));
    if (targetNumbers.length > 0 && otherNumbers.length > 0 && !otherNumbers.every((word) => target.digits.has(word)) && !targetNumbers.every((word) => other.digits.has(word))) continue;
    const shared = [...target.content].filter((word) => other.content.has(word)).length;
    if (shared === 0) continue;
    const union = new Set([...target.content, ...other.content]).size;
    const score = shared / union;
    if (shared < Math.min(2, target.content.size, other.content.size) || score < 0.45) continue;
    if (!other.content.has(targetHead) && !target.content.has([...other.content][0])) continue;
    if (!best || score > best.score || (score === best.score && price < best.price)) best = { price: Math.round(price * 100) / 100, matched: String(row.designation ?? ""), score };
  }
  return best;
}

/** Pourquoi une ligne n'a pas trouvé de prix : la fiche la plus proche de la bibliothèque et ce qui l'écarte (pour le rapport). */
export function whyNoMatch(library: PriceLibraryRow[], item: { designation: string; unit: string }): string {
  const target = looseSignature(stripLineReference(item.designation));
  if (target.content.size === 0) return "texte trop court ou sans mot reconnu";
  let best: { row: PriceRow; shared: number; score: number } | null = null;
  for (const row of library) {
    const other = looseSignature(String(row.designation ?? ""));
    const shared = [...target.content].filter((word) => other.content.has(word)).length;
    if (shared === 0) continue;
    const score = shared / new Set([...target.content, ...other.content]).size;
    if (!best || score > best.score) best = { row, shared, score };
  }
  if (!best) return "aucune fiche de la bibliothèque ne partage un mot : à ajouter (SQL)";
  const other = looseSignature(String(best.row.designation ?? ""));
  const name = `« ${String(best.row.designation ?? "")} » (${String(best.row.unite ?? "?")})`;
  if (!sameUnitLoose(item.unit, String(best.row.unite ?? ""))) return `fiche proche ${name} mais l'unité est différente (${item.unit})`;
  if (!savedPrice(best.row)) return `fiche proche ${name} mais sans prix`;
  if (!sameLooseSet(target.actions, other.actions)) return `fiche proche ${name} mais l'action diffère (réparation/dépose/neuf)`;
  if (objectWordsDiffer(target.content, other.content)) return `fiche proche ${name} mais l'objet principal diffère`;
  return `fiche proche ${name} mais seulement ${best.shared} mot(s) en commun ou dimensions différentes : à ajouter (SQL)`;
}

// ─── Salaires journaliers par poste ───────────────────────────────────────────
// « Chef de chantier BT/Bac technique GC », « Maçon qualifié », « Aide-maçon »… : le salaire (JOUR-PERSONNE) se retrouve par le
// poste, pas par le texte entier. Les salaires saisis dans la bibliothèque (nourriture comprise) servent pour tous les devis.
const SALARY_ROLES: Array<[RegExp, string]> = [
  [/\b(ingenieur|responsable technique|ingenieurs)\b/, "ingenieur"],
  [/\bconducteur\b/, "conducteur"],
  [/\bchef\b/, "chef"],
  [/\b(aide|aides|manoeuvre|manoeuvres)\b/, "ouvrier"],
  [/\bmacon/, "macon"],
  [/\b(ouvrier|ouvriers|main d oeuvre|homme|manutentionnaire)\b/, "ouvrier"],
];
export function roleSalaryMatch(library: PriceLibraryRow[], item: { designation: string; unit: string }): LooseHit | null {
  if (unitGroup(item.unit) !== "j") return null;
  const text = stripLineReference(item.designation).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[œ]/g, "oe").replace(/[’'-]/g, " ");
  const role = SALARY_ROLES.find(([pattern]) => pattern.test(text))?.[1];
  if (!role) return null;
  let best: LooseHit | null = null;
  for (const row of library) {
    if (unitGroup(String(row.unite ?? "")) !== "j") continue;
    const price = savedPrice(row);
    if (!price) continue;
    const name = String(row.designation ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[œ]/g, "oe").replace(/[’'-]/g, " ");
    const rowRole = SALARY_ROLES.find(([pattern]) => pattern.test(name))?.[1];
    if (rowRole !== role) continue;
    // Les salaires saisis par l'entreprise (« … journée avec nourriture comprise ») passent avant toute autre fiche du même poste.
    const own = /^(ouvriers et aides|macons qualifies|chef de chantier|conducteur de travaux|ingenieur ou responsable technique)\b/.test(name) ? 2 : name.includes("nourriture comprise") ? 1 : 0;
    if (!best || own > best.score || (own === best.score && price < best.price)) best = { price: Math.round(price * 100) / 100, matched: String(row.designation ?? ""), score: own };
  }
  return best;
}
