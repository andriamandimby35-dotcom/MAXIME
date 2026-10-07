// Vocabulaire du bâtiment à Madagascar : un DAO écrit « Maçonnerie d'agglos de 15 hourdés au mortier »,
// la bibliothèque dit « Parpaing 15 ». Ce fichier ramène les différentes façons d'écrire la MÊME chose à un mot
// unique, pour que la recherche gratuite retrouve le prix déjà connu. Il ne touche jamais aux données :
// il sert seulement à COMPARER des textes (recherche automatique, recherche manuelle, titres voisins).

// 1) Groupes de mots équivalents : le premier mot est le mot « officiel » ; les autres s'y ramènent.
// Écrits sans accents, au singulier.
export const SYNONYM_GROUPS: string[][] = [
  ["parpaing", "agglo", "agglomere", "bloc creux", "bloc beton", "bloc de beton", "bloc en beton", "bloc agglomere"],
  ["brique", "brique terre cuite", "brique de terre cuite", "brique cuite"],
  ["moellon", "moellon pierre", "pierre moellon"],
  ["enduit", "crepi", "crepissage", "enduisage"],
  ["carreau", "carrelage", "revetement carreaux", "revetement en carreaux"],
  ["gravier", "gravillon", "granulat"],
  ["acier", "armature", "ferraillage", "ferraille", "fer a beton", "fer beton", "fer rond", "fer ha", "fer"],
  ["tole", "bac acier", "tole ondulee", "tole galvanisee", "tole bac"],
  ["wc", "w c", "toilette", "water closet", "cuvette wc"],
  ["lavabo", "vasque"],
  ["etancheite", "etanchement", "etanche"],
  ["demolition", "deconstruction", "demolir"],
  ["remblai", "remblayage", "remblaiement"],
  ["coffrage", "banchage", "banche"],
  ["peinture", "peinturage"],
  ["vitrage", "vitre", "verre"],
  ["prise", "prise courant", "prise de courant", "socle prise"],
  ["chainage", "raidisseur"],
  ["porte", "bloc porte"],
  ["fenetre", "chassis", "croisee"],
];

// 2) Mots « de remplissage » qui ne changent pas le matériau (verbes de mise en œuvre, unités écrites dans le texte…).
export const FILLER_WORDS = new Set([
  "de", "des", "du", "la", "le", "les", "l", "d", "et", "en", "a", "au", "aux", "sur", "pour", "avec", "un", "une",
  "fourniture", "fournitures", "fournir", "pose", "poser", "mise", "place", "travaux", "y", "compris", "ens", "ensemble",
  "oeuvre", "realisation", "execution", "confection", "fabrication", "toutes", "tous", "tout", "sujetion", "sujetions",
  "ouvrage", "ouvrages", "selon", "plan", "plans", "cps", "dose", "dosage", "dosee", "dosees", "type", "qualite",
  "soigne", "soignee", "conforme", "necessaire", "necessaires", "complet", "complete", "par", "ou", "ainsi", "que",
  "cm", "mm", "ml", "m2", "m3", "kg", "ep", "epaisseur", "hauteur", "largeur", "diametre", "dimension", "dimensions", "section",
  "nb", "nombre", "unite", "piece", "pieces", "ff", "fft", "forfait", "lot",
]);

// 3) Unités qui veulent dire la même chose (le DAO écrit « Fft », la bibliothèque « FFT » ou « Ens »…).
const UNIT_GROUPS: string[][] = [
  ["u", "un", "unite", "unites", "pce", "pc", "piece", "pieces", "nb", "nombre"],
  ["ff", "fft", "forfait", "ens", "ensemble", "lot", "fg", "forfaitaire"],
  ["ml", "m l", "metre lineaire", "metres lineaires", "m"],
  ["m2", "m 2", "metre carre", "metres carres"],
  ["m3", "m 3", "metre cube", "metres cubes"],
  ["j", "jour", "jours", "jour personne", "jour-personne", "j pers", "j-pers", "hj", "homme jour"],
];

const plain = (text: string) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[œ]/g, "oe").replace(/[’']/g, " ");

export function unitGroup(unit: string): string {
  const key = plain(unit).replace(/²/g, "2").replace(/³/g, "3").replace(/[^a-z0-9]+/g, " ").trim();
  for (const group of UNIT_GROUPS) if (group.includes(key)) return group[0];
  return key;
}

// Réécrit les écritures techniques : dosages, diamètres, dimensions.
function normaliseNumbers(text: string): string {
  return text
    .replace(/ø\s*(\d+)/g, " $1mm ")
    .replace(/\bha\s?(\d+)\b/g, " acier $1mm ")
    .replace(/\bd\s?(\d{1,2})\b/g, " $1mm ")
    .replace(/\bq\s?(\d{3})\b/g, " $1kg ")
    .replace(/(\d+)\s*kg\s*\/?\s*m\s?[3³]?/g, " $1kg ")
    .replace(/(\d+)\s*(?:x|×)\s*(\d+)/g, " $1x$2 ")
    .replace(/(\d+)\s*cm\b/g, " $1 ")
    .replace(/(\d+)\s*millimetres?\b|(\d+)\s*mm\b/g, (_m, a, b) => ` ${a ?? b}mm `)
    .replace(/\bb\.?\s?a\.?\b(?!\s*\d)/g, " beton arme ");
}

// Table mot (ou expression) → mot officiel, triée par longueur (les expressions longues d'abord).
const PHRASES: Array<[string, string]> = [];
for (const group of SYNONYM_GROUPS) {
  const [official, ...variants] = group;
  for (const variant of variants) PHRASES.push([plain(variant).replace(/[^a-z0-9]+/g, " ").trim(), official]);
}
PHRASES.sort((a, b) => b[0].length - a[0].length);

const stem = (word: string) => (/\d/.test(word) || word.length <= 3 ? word : word.replace(/(s|x)$/, ""));

/** Mots importants d'un texte, ramenés au vocabulaire officiel (sans accents, singulier, sans mots de remplissage). */
export function btpTokens(text: string): string[] {
  let value = normaliseNumbers(plain(text)).replace(/[^a-z0-9]+/g, " ").trim();
  value = ` ${value} `;
  for (const [variant, official] of PHRASES) {
    if (value.includes(` ${variant} `)) value = value.split(` ${variant} `).join(` ${official} `);
  }
  return value.split(" ").filter(Boolean).map(stem).filter((word) => !FILLER_WORDS.has(word));
}

/** Toutes les écritures connues d'un mot (pour chercher dans la base avec LIKE : « agglo » trouve aussi « parpaing »). */
export function wordVariants(word: string): string[] {
  const base = plain(word).replace(/[^a-z0-9]+/g, " ").trim();
  const out = new Set<string>([base]);
  for (const group of SYNONYM_GROUPS) {
    const normalised = group.map((entry) => plain(entry).replace(/[^a-z0-9]+/g, " ").trim());
    if (normalised.some((entry) => entry === base || stem(entry) === stem(base))) normalised.filter((entry) => !entry.includes(" ")).forEach((entry) => out.add(entry));
  }
  return [...out].filter((entry) => entry.length >= 3);
}
