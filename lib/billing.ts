// Montant certifié = montant du marché, moins la taxe de l'État (8 %),
// puis moins la retenue de garantie (5 %) calculée sur le montant déjà net de taxe.
export function certifiedAmount(contractAmount: number) {
  const afterTax = contractAmount * (1 - 0.08);
  return afterTax * (1 - 0.05);
}
