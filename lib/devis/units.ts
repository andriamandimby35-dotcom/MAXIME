// Les unités d'un devis importé s'affichent EXACTEMENT comme dans le devis d'origine
// (« Fft », « FFT », « ml »…) : le devis généré doit ressembler au PDF d'origine.
export function displayUnit(value: string | null | undefined): string {
  return String(value ?? "").trim();
}
