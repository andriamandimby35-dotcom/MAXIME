// Affichage homogène des unités d'un devis importé : le PDF d'origine mélange
// « Fft », « FFT », « fft », « ML », « KG »… ; on affiche toujours la même écriture.
export function displayUnit(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[\s.]/g, "").replace("³", "3").replace("²", "2");
  if (["fft", "ft", "forfait", "fforfait"].includes(key)) return "Fft";
  if (key === "ens" || key === "ensemble") return "Ens";
  if (key === "ml") return "ml";
  if (key === "m2") return "m2";
  if (key === "m3") return "m3";
  if (key === "m") return "m";
  if (key === "kg") return "kg";
  if (key === "t" || key === "tonne" || key === "tonnes") return "t";
  if (key === "l" || key === "litre" || key === "litres") return "L";
  if (key === "u" || key === "unite" || key === "piece" || key === "pieces" || key === "pce") return "U";
  if (key === "jour-personne" || key === "jourpersonne") return "JOUR-PERSONNE";
  if (key === "t.km" || key === "tkm") return "T.KM";
  return raw;
}
