// Prix unitaires du devis EXTERNE (ceux montrés au client) à partir des coûts
// du devis interne : même coefficient pour tous les postes, arrondi à 100 Ar,
// puis ajustement pour que le total tombe pile sur la somme attendue quand
// celle-ci est donnée (mode « montant total fixé »).
//
// Un prix unitaire inférieur à 1 000 Ar est arrondi à l'Ariary (arrondir une
// petite ligne à 100 Ar la fausserait de plusieurs %).

export type ExternalPriceInput = { quantity: number; baseUnitPrice: number };

const TAX_RATE = 0.08;

export function roundPriceStep(price: number): number {
  return price >= 1000 ? 100 : 1;
}

export function roundExternalPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const step = roundPriceStep(price);
  return Math.round(price / step) * step;
}

/** Montant HT visé quand le client doit payer `targetClientTotalTtc` TTC (taxe 8 %), arrondi à 100 Ar. */
export function targetBeforeTax(targetClientTotalTtc: number): number {
  return Math.round(targetClientTotalTtc / (1 + TAX_RATE) / 100) * 100;
}

/**
 * @param items            postes visibles par le client (quantité + prix de base)
 * @param marginPercent    marge en % (mode « appliquer une marge »)
 * @param exactTotalBeforeTax si donné, la somme quantité × prix est ajustée au plus
 *                         près de ce montant HT (mode « montant total fixé »)
 */
export function computeExternalUnitPrices(
  items: ExternalPriceInput[],
  marginPercent: number,
  exactTotalBeforeTax?: number | null,
): number[] {
  const multiplier = 1 + (Number(marginPercent) || 0) / 100;
  const prices = items.map((item) => roundExternalPrice(item.baseUnitPrice * multiplier));
  const target = Number(exactTotalBeforeTax);
  if (!Number.isFinite(target) || target <= 0) return prices;

  const total = () => prices.reduce((sum, price, index) => sum + price * items[index].quantity, 0);
  let residual = target - total();
  // Les postes à petite quantité (forfaits : quantité 1) absorbent le mieux
  // l'écart : on les essaie en premier.
  const order = items
    .map((item, index) => index)
    .filter((index) => items[index].quantity > 0 && prices[index] > 0)
    .sort((a, b) => items[a].quantity - items[b].quantity || prices[b] - prices[a]);

  for (let pass = 0; pass < 6 && Math.abs(residual) >= 1; pass += 1) {
    let changed = false;
    for (const index of order) {
      const quantity = items[index].quantity;
      const step = roundPriceStep(prices[index]);
      const delta = Math.round(residual / quantity / step) * step;
      if (delta === 0 || prices[index] + delta <= 0) continue;
      const nextResidual = residual - quantity * delta;
      if (Math.abs(nextResidual) < Math.abs(residual)) {
        prices[index] += delta;
        residual = nextResidual;
        changed = true;
        if (Math.abs(residual) < 1) break;
      }
    }
    if (!changed) break;
  }
  // Dernier réglage : quantités à virgule (ex. 35,5 m²) empêchent parfois de
  // tomber pile avec des prix ronds. Un poste « forfait » (quantité 1) absorbe
  // alors le reste à l'Ariari près, pour que le total soit exactement celui visé.
  if (Math.abs(residual) >= 1) {
    const forfait = order.find((index) => items[index].quantity === 1 && prices[index] + Math.round(residual) > 0);
    if (forfait !== undefined) prices[forfait] += Math.round(residual);
  }
  return prices;
}
