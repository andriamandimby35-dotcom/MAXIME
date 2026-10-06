// Montant en toutes lettres, en français (pour « arrêtée la présente facture à
// la somme de … »). Fonctions simples, sans accès à la base.

const UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];

// 0 à 99
function underHundred(n: number): string {
  if (n < 20) return UNITS[n];
  const ten = Math.floor(n / 10);
  const unit = n % 10;
  if (ten === 7 || ten === 9) {
    // soixante-dix, soixante et onze, quatre-vingt-dix, quatre-vingt-onze…
    const base = ten === 7 ? "soixante" : "quatre-vingt";
    const rest = 10 + unit;
    if (ten === 7 && unit === 1) return "soixante et onze";
    return `${base}-${UNITS[rest]}`;
  }
  if (ten === 8) return unit === 0 ? "quatre-vingts" : `quatre-vingt-${UNITS[unit]}`;
  if (unit === 0) return TENS[ten];
  if (unit === 1) return `${TENS[ten]} et un`;
  return `${TENS[ten]}-${UNITS[unit]}`;
}

// 0 à 999 ; `final` = le nombre se termine ici (accorde « cents » et « vingts »)
function underThousand(n: number, final: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) {
    if (hundreds === 1) parts.push("cent");
    else parts.push(`${UNITS[hundreds]} cent${rest === 0 && final ? "s" : ""}`);
  }
  if (rest > 0) {
    let words = underHundred(rest);
    // « quatre-vingts » n'a son s qu'en fin de nombre
    if (rest === 80 && !final) words = "quatre-vingt";
    parts.push(words);
  }
  return parts.join(" ");
}

const SCALES: Array<[number, string, string]> = [
  [1_000_000_000_000, "billion", "billions"],
  [1_000_000_000, "milliard", "milliards"],
  [1_000_000, "million", "millions"],
];

export function integerToWordsFr(value: number): string {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return "zéro";
  const parts: string[] = [];
  for (const [size, singular, plural] of SCALES) {
    const count = Math.floor(n / size);
    if (count > 0) {
      parts.push(`${underThousand(count, true)} ${count > 1 ? plural : singular}`); // « deux cents millions » : le s reste devant million/milliard
      n -= count * size;
    }
  }
  const thousands = Math.floor(n / 1000);
  if (thousands > 0) {
    parts.push(thousands === 1 ? "mille" : `${underThousand(thousands, false)} mille`);
    n -= thousands * 1000;
  }
  if (n > 0) parts.push(underThousand(n, true));
  return parts.join(" ");
}

/** Ex. 2 280 000 → « Deux millions deux cent quatre-vingt mille Ariary » (arrondi à l'Ariary). */
export function amountInWordsFr(value: number, currency = "Ariary"): string {
  const rounded = Math.round(Number(value) || 0);
  const words = integerToWordsFr(rounded);
  const sentence = `${words.charAt(0).toUpperCase()}${words.slice(1)} ${currency}`;
  return rounded < 0 ? `Moins ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence;
}
