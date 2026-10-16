// Matériaux vendus par ROULEAU, COURONNE, BOBINE ou BARRE entière (tuyau PEHD en rouleau de 50 ou 100 m, câble, grillage,
// profilés en barre de 6 m…) : la bibliothèque garde le prix du rouleau entier. Pour une ligne de devis en mètres (ml) ou en m²,
// on en déduit en mémoire une fiche « virtuelle » au mètre, qui se souvient de la taille du rouleau et de son prix.
// La bibliothèque n'est JAMAIS modifiée. Le prix du devis tient compte du fait qu'on n'achète que des rouleaux ENTIERS
// (voir effectivePrice dans library-lookup.ts) et, entre plusieurs fiches, on prend la moins chère.

type Row = Record<string, unknown>;

const PACK_UNITS = new Set(["rouleau", "rouleaux", "couronne", "couronnes", "bobine", "bobines", "touret", "tourets", "barre", "barres"]);

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function savedPrice(row: Row) {
  return positive(row.prix_entreprise) ?? positive(row.prix_retenu) ?? positive(row.prix_actuel) ?? positive(row.prix_ia);
}

/** « 100 m », « 50m », « 25 ml », « 48 mm », « 0,5 m » → mètres. Sans unité : mètres. */
function metres(text: string): number | null {
  const found = plain(text).replace(/,/g, ".").match(/(\d+(?:\.\d+)?)\s*(mm|cm|ml|metres?|m)?\b/);
  if (!found) return null;
  const value = Number(found[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = found[2] ?? "m";
  return unit === "mm" ? value / 1000 : unit === "cm" ? value / 100 : value;
}

function characteristic(row: Row, pattern: RegExp): string | null {
  const list = Array.isArray(row.caracteristiques) ? (row.caracteristiques as Array<Record<string, unknown>>) : [];
  const item = list.find((entry) => pattern.test(plain(String(entry?.label ?? ""))) && String(entry?.valeur ?? "").trim());
  return item ? String(item.valeur) : null;
}

/** Longueur (m) et largeur (m, ou null) d'un rouleau ou d'une barre, lues dans la fiche. null = longueur inconnue. */
export function packSize(row: Row): { length: number; width: number | null } | null {
  const lengthText = characteristic(row, /^longueur/);
  const widthText = characteristic(row, /^largeur/);
  let length = lengthText ? metres(lengthText) : null;
  let width = widthText ? metres(widthText) : null;
  if (length === null) {
    // « Dimension : 12x1 m » ou « Asfalsdan 12x1m » : longueur x largeur.
    const dims = plain(`${characteristic(row, /^dimension/) ?? ""} ${String(row.designation ?? "")}`).replace(/,/g, ".").match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(m|cm|mm)?\b/);
    if (dims && dims[3] === "m") { length = Number(dims[1]); width = Number(dims[2]); }
  }
  if (length === null) {
    // « rouleau de 50 m », « couronne 100m », « barre de 6 ml » écrit dans le nom.
    const named = plain(String(row.designation ?? "")).replace(/,/g, ".").match(/\b(?:rouleau|couronne|bobine|touret|barre|rlx|x)\s*(?:de\s*)?(\d+(?:\.\d+)?)\s*(?:ml|m|metres?)\b/);
    if (named) length = Number(named[1]);
  }
  if (length === null || !Number.isFinite(length) || length <= 0) return null;
  return { length, width };
}

export function isPackUnit(unit: unknown) {
  return PACK_UNITS.has(plain(String(unit ?? "")).trim());
}

/**
 * Ajoute, EN MÉMOIRE seulement, une fiche au mètre (ou au m² pour un rouleau de grande largeur) pour chaque fiche vendue au
 * rouleau / à la couronne / à la bobine / à la barre dont la longueur est connue. La fiche d'origine reste inchangée.
 */
export function expandPackRows<T extends Row>(rows: T[]): T[] {
  const extra: T[] = [];
  for (const row of rows) {
    if (!isPackUnit(row.unite)) continue;
    const price = savedPrice(row);
    const size = packSize(row);
    if (!price || !size) continue;
    // Un rouleau large (membrane, géotextile, grillage…) se compte au m² ; un tuyau, un câble, un ruban ou une barre au mètre.
    const byArea = size.width !== null && size.width >= 0.3;
    const quantity = byArea ? Math.round(size.length * (size.width as number) * 100) / 100 : size.length;
    const unitPrice = Math.round((price / quantity) * 100) / 100;
    // La pression (PN10, PN16…) est souvent seulement dans les caractéristiques : on la rajoute au nom de la fiche au mètre, pour qu'un
    // tuyau « série 12,5 bar » ne reprenne jamais le prix d'un tuyau PN10 (moins résistant).
    const pressure = characteristic(row, /^pression/);
    const name = String(row.designation ?? "");
    const designation = pressure && !/\bpn\s?\d/.test(plain(name)) ? `${name} ${/^pn/i.test(pressure.trim()) ? pressure.trim() : `PN${pressure.trim()}`}` : name;
    extra.push({
      ...row,
      designation,
      unite: byArea ? "m2" : "ml",
      prix_entreprise: unitPrice,
      prix_retenu: unitPrice,
      prix_actuel: null,
      prix_ia: null,
      quantite_par_unite_achat: quantity,
      prix_unite_achat: price,
      __pack: true,
    });
  }
  return extra.length > 0 ? [...rows, ...extra] : rows;
}
