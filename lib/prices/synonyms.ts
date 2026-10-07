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
  // Peintures : le DAO dit « glycérophtalique », la fiche « à l'huile » ; « vinylique / plastique / acrylique » = peinture à l'eau.
  ["huile", "glycerophtalique", "glycerophtalic", "glycero", "alkyde"],
  ["peinture eau", "peinture vinylique", "peinture acrylique", "peinture plastique", "peinture a l eau", "peinture a eau", "peinture emulsion", "peinture latex"],
  ["badigeon", "badigeonnage", "badigeonner", "lait de chaux"],
  ["antirouille", "anti rouille", "anticorrosion", "anti corrosion", "minium"],
  ["ardoisine", "ardoise", "tableau noir"],
  ["soubassement", "plinthe haute"],
  // Couverture et zinguerie.
  ["tole", "tpg", "tole plane", "tole plane galvanisee", "tole galvanise"],
  ["prelaque", "pre laque", "pre laquee", "prelaquee", "laquee"],
  ["gouttiere tole", "gouttiere zinc", "gouttiere en zinc", "gouttiere galvanisee"],
  ["descente", "descente eaux pluviales", "descente d eaux pluviales", "descente des eaux pluviales", "descente d eau pluviale", "descente ep", "descente d eau", "tuyau de descente"],
  ["faitiere", "faitage"],
  ["echantignole", "echantignolle", "echantignoles", "echantignolles"],
  ["lierne", "liernes"],
  ["filete", "filetee", "filetees", "filetes"],
  ["volige", "voliges", "voligeage"],
  ["lattis", "lattes", "latte"],
  ["panne", "pannes"],
  ["cornier", "corniere"],
  // Terrassement.
  ["fouille", "fouille en excavation", "excavation", "deblai", "fouilles"],
  ["defrichage", "debroussaillage", "nettoyage du site", "nettoyage du terrain", "decapage du terrain"],
  ["maconnerie", "mac"],
  ["interieur", "int"],
  ["exterieur", "ext"],
  ["prefabrique", "prefa", "prefabrication"],
  ["sanplat", "sanplaten", "sanplas"],
  ["evacuation", "evacuation des terres", "chargement et transport", "mise en decharge"],
  // Mobilier scolaire.
  ["table banc", "tables bancs", "table bancs", "tables banc", "table et banc", "pupitre", "table scolaire"],
  ["bureau maitre", "table du maitre", "tables du maitre", "bureau du maitre", "table maitre", "bureau enseignant", "table enseignant"],
  ["chaise maitre", "chaise du maitre", "chaises du maitre", "chaise enseignant", "chaise d enseignant", "chaise du professeur"],
  ["tuyau", "canalisation", "conduite"],
  ["eaux usees", "eau usee", "e u", "eu"],
  ["robinet puisage", "robinet de puisage", "robinet de jardin", "robinet de lavage"],
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
  "deux", "trois", "couche", "couches", "croisee", "croisees", "superieur", "superieure", "couleur", "ton", "teinte",
  "dimension", "dimensions", "dim", "chacune", "surface", "long", "longueur", "comprenant", "compris", "parties", "partie", "chaque", "extremite", "extremites",
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
    // Hauteur ou longueur seulement indiquée entre parenthèses (« h=0,75 », « long=4,5m ») : pas une dimension de la fiche.
    .replace(/\(?\s*\b(?:h|haut|hauteur|long|longueur(?:\s+totale)?|l)\s*=\s*\d+(?:[.,]\d+)?\s*m?\s*\)?/g, " ")
    // « 2,0 mm » = « 2 mm ».
    .replace(/(\d+)[,.]0+\s*(mm|cm|m)\b/g, "$1 $2")
    .replace(/ø\s*(\d+)/g, " $1mm ")
    .replace(/\bha\s?(\d+)\b/g, " acier $1mm ")
    .replace(/\bd\s?(\d{1,2})\b/g, " $1mm ")
    .replace(/\bq\s?(\d{3})\b/g, " $1kg ")
    .replace(/(\d+)\s*kg\s*\/?\s*m\s?[3³]?/g, " $1kg ")
    // « sauf volige » : la restriction n'est pas le matériau de la fiche.
    .replace(/\bsauf\s+[^(),;]*/g, " ")
    // Dimensions en mètres écrites « 1,10*2,10 » ou « 1,40x1,40x2,50m » (toutes avec virgule) : en centimètres (110x210).
    .replace(/\d+[.,]\d+\s*m?(?:\s*[*x×]\s*\d+[.,]\d+\s*m?){1,2}\b/g, (match) => ` ${match.split(/\s*[*x×]\s*/).map((part) => Math.round(Number(part.replace(/\s*m$/, "").replace(",", ".")) * 100)).join("x")} `)
    // Épaisseurs de tôle « 50/100 », « 50/100è » : un seul bloc.
    .replace(/\b(\d+)\s*\/\s*(\d+)(?:e|eme|ieme)?\b/g, " $1sur$2 ")
    // Codes de types (Type_FP1a, Type ECH2, Type_01) : le numéro de type ne change pas le matériau.
    .replace(/\btype\s*_?\s*(fp|ech)\s*\d+[a-z]?\b/g, " $1 ")
    .replace(/\btype\s*_?\s*\d+\b/g, " ")
    .replace(/\b(fp|ech)\s?\d+[a-z]?\b/g, " $1 ")
    .replace(/(\d+)\s*(?:x|×|\*)\s*(\d+)/g, " $1x$2 ")
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

/**
 * Un DAO écrit le numéro du poste dans la désignation (« 6,13 Gouttière en zinc », « 9.01 Badigeonnage… », « 6.02a Type_01… »,
 * « 1.1 -Tables bancs »). Ce numéro n'est pas une dimension : on le retire avant toute comparaison avec la bibliothèque.
 */
export function stripLineReference(text: string): string {
  const original = String(text ?? "");
  // « 2,5 mm² câble » commence par une mesure, pas par un numéro de ligne : on n'y touche pas.
  if (/^\s*\d{1,3}(?:\s?[.,]\s?\d{1,3})+\s*(?:mm|cm|dm|m|ml|kg|t|l|%|x|\*|sur|ar)\b/i.test(original)) return original.trim();
  const cleaned = original
    .replace(/^\s*\(?\d{1,3}(?:\s?[.,]\s?\d{1,3}){1,3}(?:[a-z](?![a-zà-ÿ]))?\)?\s*[-–—:.)]*\s*/i, "")
    .replace(/^\d\s+(?=[A-Za-zÀ-ÿ])/, "");
  return cleaned.trim() || String(text ?? "").trim();
}
