import { canonicalUnit } from "@/lib/material-normalization";
import { priceSearchableText } from "@/lib/price-engine/search-price";
import { canonicalMaterialKey } from "@/lib/material-normalization";
import { compositionFor, type CompositionComponent, type MatchSpec } from "@/lib/compositions/works";

type PriceRow = Record<string, unknown>;

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const savedPrice = (row: PriceRow) =>
  positive(row.prix_entreprise) ?? positive(row.prix_retenu) ?? positive(row.prix_actuel) ?? positive(row.prix_ia);

function matches(row: PriceRow, spec: MatchSpec) {
  const text = priceSearchableText(row);
  const tokens = text.split(" ");
  // Le matériau doit être le NOM de la fiche : « Mortier bâtard 5 kg » (qui cite « ciment » dans ses caractéristiques) n'est pas du
  // ciment, ni « Maçonnerie de brique » du sable. Seuls les autres critères (dimension, dosage…) peuvent venir des caractéristiques.
  const ownTokens = canonicalMaterialKey(String(row.designation ?? "")).split(" ");
  const nouns = spec.any && spec.any.length > 0 ? spec.any : spec.all.slice(0, 1);
  if (nouns.length > 0 && !nouns.some((word) => ownTokens.some((token) => token === word || token.startsWith(word)))) return false;
  // Un nombre (épaisseur 15) doit être le début exact d'un mot (« 15 », « 15cm », « 15x20x40 », pas « 150 »).
  const has = (word: string) => /\d/.test(word)
    ? tokens.some((token) => new RegExp(`^${word}(?!\\d)`).test(token))
    : tokens.some((token) => token === word || token.startsWith(word));
  if (!spec.all.every(has)) return false;
  if (spec.any && spec.any.length > 0 && !spec.any.some(has)) return false;
  if (spec.exclude?.some(has)) return false;
  return true;
}

// Prix de la bibliothèque ramené à l'unité demandée (sac de ciment → kg, m³ → L…).
function priceInUnit(row: PriceRow, targetUnit: string, isCement: boolean) {
  const price = savedPrice(row);
  if (!price) return null;
  const rowUnit = canonicalUnit(String(row.unite ?? ""));
  if (rowUnit === targetUnit) return price;
  if (targetUnit === "kg") {
    // Sac de ciment : 50 kg sauf si la fiche annonce un autre poids (« sac de 25 kg »).
    const stated = String(row.designation ?? "").match(/(\d+(?:[.,]\d+)?)\s*kg\b/i);
    const bagKg = stated ? Number(stated[1].replace(",", ".")) : 50;
    const soldAsBag = rowUnit.includes("sac") || rowUnit.includes("bag") || (["u", "unite", "piece"].includes(rowUnit) && /\bsac\b/i.test(String(row.designation ?? "")) && Boolean(stated));
    if (isCement && soldAsBag) return price / (bagKg > 0 ? bagKg : 50);
    if (rowUnit === "t") return price / 1000;
  }
  if (targetUnit === "l" && rowUnit === "m3") return price / 1000;
  return null;
}

export type ComponentPrice = { unitPrice: number; matched: string } | null;

/**
 * Écarte les prix visiblement faux parmi des fiches équivalentes : une fiche « Moellon » à 600 Ar le m³ à côté de fiches à 70 000-85 000
 * ne doit jamais devenir « le moins cher ». Avec 3 prix ou plus, un prix inférieur à 40 % de la médiane est écarté ; avec 2 prix,
 * un prix inférieur à 5 % du plus haut. Sans aberration, rien n'est écarté.
 */
export function withoutLowPriceOutliers<T>(items: T[], valueOf: (item: T) => number): T[] {
  const values = items.map(valueOf).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (values.length < 2) return items;
  const reference = values.length >= 3 ? values[Math.floor(values.length / 2)] : values[values.length - 1];
  const floor = values.length >= 3 ? reference * 0.4 : reference * 0.05;
  const kept = items.filter((item) => valueOf(item) >= floor);
  return kept.length > 0 ? kept : items;
}

/** Prix du matériau dans la bibliothèque : parmi les correspondances (hors prix aberrants), le moins cher. */
export function bestComponentPrice(library: PriceRow[], component: CompositionComponent): ComponentPrice {
  const targetUnit = canonicalUnit(component.unit);
  const isCement = component.match.all.includes("ciment");
  const candidates: Array<{ price: number; row: PriceRow }> = [];
  for (const row of library) {
    if (!matches(row, component.match)) continue;
    const price = priceInUnit(row, targetUnit, isCement);
    if (price !== null) candidates.push({ price, row });
  }
  const sane = withoutLowPriceOutliers(candidates, (candidate) => candidate.price);
  const best = sane.reduce<{ price: number; row: PriceRow } | null>((low, candidate) => (!low || candidate.price < low.price ? candidate : low), null);
  return best ? { unitPrice: best.price, matched: String(best.row.designation ?? "") } : null;
}

export type ComputedPart = {
  designation: string;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  matched: string;
  optional: boolean;
};

export type ComputedLine = {
  ruleId: string;
  title: string;
  notes: string[];
  parts: ComputedPart[];
  /** Prix unitaire de l'ouvrage (matériaux seulement) ; null si un matériau obligatoire n'a pas de prix. */
  price: number | null;
  /** Matériaux obligatoires sans prix en bibliothèque. */
  missing: Array<{ designation: string; search: string; unit: string }>;
};

/** Calcule le prix interne d'un ouvrage à partir de ses matériaux (main-d'œuvre non comptée). */
export function computeLineFromComposition(library: PriceRow[], designation: string, unit: string): ComputedLine | null {
  const composition = compositionFor(designation, unit);
  if (!composition) return null;
  const parts: ComputedPart[] = [];
  const missing: ComputedLine["missing"] = [];
  let total = 0;
  for (const component of composition.components) {
    const found = bestComponentPrice(library, component);
    const optional = Boolean(component.optional);
    if (!found && !optional) missing.push({ designation: component.designation, search: component.search, unit: component.unit });
    const amount = found ? component.quantity * found.unitPrice : 0;
    total += amount;
    parts.push({
      designation: component.designation,
      unit: component.unit,
      quantity: component.quantity,
      unitPrice: found?.unitPrice ?? null,
      amount: Math.round(amount * 100) / 100,
      matched: found?.matched ?? "",
      optional,
    });
  }
  return {
    ruleId: composition.ruleId,
    title: composition.title,
    notes: composition.notes,
    parts,
    price: missing.length === 0 ? Math.round(total * 100) / 100 : null,
    missing,
  };
}

