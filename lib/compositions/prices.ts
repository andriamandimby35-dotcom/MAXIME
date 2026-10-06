import { canonicalUnit } from "@/lib/material-normalization";
import { priceSearchableText } from "@/lib/price-engine/search-price";
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
    if (isCement && (rowUnit.includes("sac") || rowUnit.includes("bag"))) return price / 50;
    if (rowUnit === "t") return price / 1000;
  }
  if (targetUnit === "l" && rowUnit === "m3") return price / 1000;
  return null;
}

export type ComponentPrice = { unitPrice: number; matched: string } | null;

/** Prix du matériau dans la bibliothèque : parmi les correspondances, le moins cher. */
export function bestComponentPrice(library: PriceRow[], component: CompositionComponent): ComponentPrice {
  const targetUnit = canonicalUnit(component.unit);
  const isCement = component.match.all.includes("ciment");
  let best: { price: number; row: PriceRow } | null = null;
  for (const row of library) {
    if (!matches(row, component.match)) continue;
    const price = priceInUnit(row, targetUnit, isCement);
    if (price !== null && (!best || price < best.price)) best = { price, row };
  }
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

