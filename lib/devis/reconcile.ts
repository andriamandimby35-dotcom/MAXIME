// Contrôle de cohérence d'une ligne de devis lue par l'IA : quantité × prix unitaire = montant.
// Sert pour TOUS les PDF ajoutés : quand l'IA mélange la quantité et le prix unitaire (ou lit la
// mauvaise colonne), le montant écrit dans le PDF permet de le voir et, si possible, de corriger.

export type LineCheck = {
  quantity: number;
  unit_price: number;
  /** ok = cohérent · fixed = corrigé automatiquement · warning = à vérifier à l'écran · unchecked = pas de montant lu. */
  status: "ok" | "fixed" | "warning" | "unchecked";
  note?: string;
};

const FORFAIT_UNITS = new Set(["fft", "ft", "ff", "fg", "ens", "ensemble", "forfait", "lot", "u"]);
const near = (a: number, b: number, tolerance = 0.005) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * tolerance);
const clean = (value: number) => Number.isFinite(value) && value > 0 && Math.abs(value - Math.round(value * 100) / 100) < 0.0005;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function reconcileLine(input: { quantity: number; unit_price: number; amount?: number | null; unit?: string }): LineCheck {
  let quantity = Number(input.quantity) > 0 ? Number(input.quantity) : 1;
  let price = Number(input.unit_price) > 0 ? Number(input.unit_price) : 0;
  const amount = Number(input.amount) > 0 ? Number(input.amount) : 0;
  const unit = String(input.unit ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!(price > 0)) return { quantity, unit_price: 0, status: "unchecked" };

  // 1. Forfait ou pièce dont la quantité est énorme et le prix de 1 : colonnes inversées.
  if (FORFAIT_UNITS.has(unit) && price <= 1 && quantity > 100) {
    return { quantity: price, unit_price: quantity, status: "fixed", note: `quantité et prix unitaire étaient inversés (${quantity.toLocaleString("fr-FR")} ↔ ${price.toLocaleString("fr-FR")})` };
  }

  if (amount > 0) {
    if (near(quantity * price, amount)) {
      // Le produit est juste, mais une quantité plus grande que le prix reste louche (colonnes inversées).
      if (quantity > price && price < 1000 && quantity >= 1000) {
        return { quantity, unit_price: price, status: "warning", note: `quantité (${quantity.toLocaleString("fr-FR")}) plus grande que le prix unitaire (${price.toLocaleString("fr-FR")}) : colonnes peut-être inversées` };
      }
      return { quantity, unit_price: price, status: "ok" };
    }
    // Le produit ne donne pas le montant : on cherche la valeur mal lue.
    const priceFromAmount = round2(amount / quantity);
    const quantityFromAmount = round2(amount / price);
    const priceFits = clean(priceFromAmount) && priceFromAmount > 0;
    const quantityFits = clean(quantityFromAmount) && quantityFromAmount > 0;
    if (priceFits && !quantityFits) {
      const note = `prix unitaire corrigé d'après le montant du devis (${price.toLocaleString("fr-FR")} → ${priceFromAmount.toLocaleString("fr-FR")})`;
      price = priceFromAmount;
      return { quantity, unit_price: price, status: "fixed", note };
    }
    if (quantityFits && !priceFits) {
      const note = `quantité corrigée d'après le montant du devis (${quantity.toLocaleString("fr-FR")} → ${quantityFromAmount.toLocaleString("fr-FR")})`;
      quantity = quantityFromAmount;
      return { quantity, unit_price: price, status: "fixed", note };
    }
    return { quantity, unit_price: price, status: "warning", note: `quantité × prix unitaire (${round2(quantity * price).toLocaleString("fr-FR")}) ≠ montant du devis (${amount.toLocaleString("fr-FR")})` };
  }
  return { quantity, unit_price: price, status: "unchecked" };
}
