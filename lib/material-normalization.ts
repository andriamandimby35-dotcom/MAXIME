/**
 * Clés stables du catalogue de prix.
 * Elles sont volontairement strictes pour la désignation (un ciment 350 et un
 * ciment 400 restent deux matériaux distincts), mais tolérantes pour l'unité.
 */
export function canonicalMaterialKey(value: string) {
  let text = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR");
  // Un DAO note souvent un diam\u00e8tre "\u00d86" l\u00e0 o\u00f9 la biblioth\u00e8que de prix l'a
  // enregistr\u00e9 "D6" (ou l'inverse) : sans cette \u00e9quivalence, le m\u00eame
  // mat\u00e9riau ne serait jamais reconnu et on relancerait une recherche IA
  // (payante) pour un fer ou une armature d\u00e9j\u00e0 enregistr\u00e9s. M\u00eame chose pour
  // "40\u00d740" \u00e9crit "40x40" (dimensions d'une pi\u00e8ce de bois, d'une plaque...).
  text = text.replace(/\u00f8\s*(?=\d)/g, "d");
  text = text.replace(/(\d)\s*\u00d7\s*(\d)/g, "$1x$2");
  // Une mesure peut \u00eatre \u00e9crite en toutes lettres ("6 millim\u00e8tres") ou en
  // abr\u00e9g\u00e9, coll\u00e9e au chiffre ou s\u00e9par\u00e9e par un espace ("6mm", "6 mm") :
  // sans cette \u00e9quivalence, "Fer 6mm" et "Fer 6 millim\u00e8tres" compteraient
  // comme deux mat\u00e9riaux diff\u00e9rents.
  // (le "mètre" seul n'est pas reconverti ici : "mètre cube"/"mètre carré"
  // ont un sens précis pour canonicalUnit ci-dessous, qu'on ne veut pas
  // perturber).
  text = text.replace(/\bmillimetres?\b/g, "mm");
  text = text.replace(/\bcentimetres?\b/g, "cm");
  text = text.replace(/\bkilogrammes?\b/g, "kg");
  text = text.replace(/\btonnes?\b/g, "t");
  text = text.replace(/(\d)\s*(mm|cm|kg|t)\b/g, "$1$2");
  return text
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function supplierSlug(value: string) {
  const key = canonicalMaterialKey(value);
  return key ? key.replace(/\s+/g, "-") : "autre";
}

// Anciens noms français encore courants dans les données face aux noms
// malgaches actuels : pour regrouper "Sanifer Tananarive" et "Sanifer
// Antananarivo" comme un seul et même fournisseur.
const CITY_ALIASES: Record<string, string> = {
  tananarive: "antananarivo",
  tamatave: "toamasina",
  majunga: "mahajanga",
  "diego suarez": "antsiranana",
  diegosuarez: "antsiranana",
  tulear: "toliara",
};

export function canonicalCityName(value: string) {
  const key = canonicalMaterialKey(value);
  return CITY_ALIASES[key] || key;
}

// Un même fournisseur ("Sanifer") est parfois saisi avec la ville dans le nom
// ("Sanifer Antananarivo") et parfois seul, avec la ville dans le champ
// localisation du prix ("Sanifer" + ville="Antananarivo"). On regroupe les
// deux sous un même fournisseur : le libellé complète le nom avec la ville
// quand elle n'y figure pas déjà, et la clé applique aussi les alias de ville
// pour que "Tananarive" et "Antananarivo" (ou "Tamatave"/"Toamasina") ne
// créent jamais deux fournisseurs différents.
export function supplierGroup(fournisseur: string, ville: string, region: string) {
  const name = fournisseur.trim();
  const cityDisplay = String(ville || region || "Madagascar").trim();
  const cityKey = canonicalCityName(cityDisplay);
  const nameKeyAliased = Object.entries(CITY_ALIASES).reduce(
    (text, [alias, canonical]) => text.replace(new RegExp(`\\b${alias}\\b`, "g"), canonical),
    canonicalMaterialKey(name),
  );
  const alreadyHasCity = !cityKey || nameKeyAliased.includes(cityKey);
  return {
    label: alreadyHasCity ? name : `${name} ${cityDisplay}`,
    key: supplierSlug(alreadyHasCity ? nameKeyAliased : `${nameKeyAliased} ${cityKey}`),
  };
}

export function canonicalUnit(value: string) {
  const normalized = canonicalMaterialKey(String(value ?? "")
    .replaceAll("³", "3")
    .replaceAll("²", "2"));
  if (["m3", "m 3", "metre cube", "metres cubes", "cubic meter", "cubic metres"].includes(normalized)) return "m3";
  if (["m2", "m 2", "metre carre", "metres carres"].includes(normalized)) return "m2";
  if (["ml", "m l", "metre lineaire", "metres lineaires"].includes(normalized)) return "ml";
  if (["l", "litre", "litres"].includes(normalized)) return "l";
  if (["kg", "kilogramme", "kilogrammes"].includes(normalized)) return "kg";
  if (["t", "tonne", "tonnes"].includes(normalized)) return "t";
  if (["u", "unite", "unites", "piece", "pieces"].includes(normalized)) return "u";
  if (normalized.includes("jour") && normalized.includes("personne")) return "jour-personne";
  return normalized;
}

export function materialFamily(value: string) {
  const normalized = canonicalMaterialKey(value);
  if (normalized.includes("ciment")) return "ciment";
  if (normalized.includes("sable")) return "sable";
  if (normalized.includes("gravillon") || normalized.includes("gravier")) return "granulat_gravier";
  if (normalized === "eau" || normalized.startsWith("eau ")) return "eau";
  if (normalized.includes("adjuvant")) return "adjuvant";
  if (normalized.includes("parpaing") || normalized.includes("bloc creux") || normalized.includes("agglo")) return "parpaing";
  if (normalized.includes("planche")) return "planche";
  if (normalized.includes("tasseau") || normalized.includes("chevron") || normalized.includes("raidisseur")) return "bois_raidissement";
  if (normalized.includes("pointe") || normalized.includes("clou")) return "pointes";
  if (normalized.includes("huile") && normalized.includes("coffrage")) return "huile_decoffrage";
  // Un fer à béton ou une armature ne sont le même matériau que si leur
  // diamètre est identique (HA8, HA10, Ø12...) : la marque (Turcky, Indien,
  // technique DAO) peut varier sans changer le produit acheté.
  if (normalized.includes("acier") || normalized.includes("armature") || normalized.includes("fer tor") || normalized.includes("fer turcky") || normalized.includes("fer indien") || /\bha\s?\d+\b/.test(normalized)) {
    const diameter = normalized.match(/\bha\s?(\d+)\b/)?.[1] ?? normalized.match(/diametre\s?(\d+)/)?.[1] ?? normalized.match(/\b(\d+)\s?mm\b/)?.[1];
    return diameter ? `acier_${diameter}` : "acier";
  }
  // Un béton n'est le même matériau que s'il a le même dosage (Q350, 350
  // kg/m3...) : le libellé technique du DAO ou le nom commercial n'importent
  // pas pour retrouver le bon prix déjà enregistré.
  if (normalized.includes("beton")) {
    const dosage = normalized.match(/q\s?(\d{2,4})/)?.[1] ?? normalized.match(/(\d{2,4})\s?kg/)?.[1];
    return dosage ? `beton_${dosage}` : "beton";
  }
  return normalized;
}

// Les 23 régions officielles de Madagascar, utilisées comme liste fermée
// dans le formulaire de prix : ça évite les doublons (fautes de frappe,
// variantes d'écriture) qu'on aurait avec un champ texte libre.
export const MADAGASCAR_REGIONS = [
  "Analamanga", "Vakinankaratra", "Itasy", "Bongolava", "Haute Matsiatra",
  "Amoron'i Mania", "Vatovavy", "Fitovinany", "Atsimo-Atsinanana", "Ihorombe",
  "Atsinanana", "Analanjirofo", "Alaotra-Mangoro", "Boeny", "Sofia",
  "Betsiboka", "Melaky", "Atsimo-Andrefana", "Androy", "Anosy", "Menabe",
  "Diana", "Sava",
];

// Regroupe les prix par région pour le mode d'affichage "Région" de la
// bibliothèque de prix (même esprit que supplierGroup ci-dessus, mais plus
// simple car la région vient d'une liste fermée, sans variantes d'écriture).
export function regionGroup(region: string) {
  const label = region.trim();
  return { label, key: canonicalMaterialKey(label) || "autre" };
}

// Des origines "génériques" (Madagascar, Import...) sont déjà utilisées sur
// presque tous les matériaux, sans vraiment rien distinguer (contrairement à
// "Turquie" vs "Inde" pour un fer à béton, qui correspond à deux qualités/
// prix réellement différents) : on ne les ajoute jamais au nom, sinon
// pratiquement tous les matériaux se retrouveraient avec "Madagascar" ou
// "Import" collé au bout de leur nom.
const GENERIC_ORIGIN_VALUES = new Set([
  "madagascar", "import", "import marche", "importe", "importee", "importees", "importes",
  "local", "locale", "locaux", "n a", "na", "inconnue", "inconnu", "divers",
]);

// Les caractéristiques techniques sont des paires libres (label, valeur)
// tapées par l'utilisateur (ex: "diamètre", "norme", "origine"...) : il n'y a
// pas de champ dédié. Par convention déjà utilisée dans l'appli, l'origine
// (Turquie, Inde...) est enregistrée avec le label "origine" — on la
// retrouve ici pour construire le nom du matériau (voir
// buildDesignationWithOrigin ci-dessous). Une origine générique (voir
// GENERIC_ORIGIN_VALUES) ou une phrase trop longue (ex: une note technique
// tapée par erreur dans "origine") est ignorée : elle ne devient jamais un
// mot ajouté au nom.
export function originFromCaracteristiques(caracteristiques: unknown): string {
  if (!Array.isArray(caracteristiques)) return "";
  const entry = caracteristiques.find(
    (item) => String((item as { label?: unknown })?.label ?? "").trim().toLocaleLowerCase("fr-FR") === "origine",
  );
  const value = String((entry as { valeur?: unknown })?.valeur ?? "").trim();
  if (!value) return "";
  const normalized = canonicalMaterialKey(value);
  const looksLikeASentence = value.length > 24 || value.includes(";") || value.split(/\s+/).length > 3;
  if (GENERIC_ORIGIN_VALUES.has(normalized) || looksLikeASentence) return "";
  return value;
}

// Construit le nom final d'un matériau : nom (+ dimension, déjà dans le nom
// tel que saisi) + origine SEULEMENT si elle est connue — jamais le nom du
// fournisseur, qui vit désormais dans la liste "fournisseurs" de la fiche.
// Deux matériaux au nom identique mais d'origine différente (ex: "Fer à
// béton Ø6 Turquie" vs "Fer à béton Ø6 Inde") doivent rester deux fiches
// séparées : comme toute la détection de doublon compare le texte du nom,
// ajouter l'origine ICI, dans le nom lui-même, suffit à empêcher qu'elles se
// mélangent — pas besoin d'une règle séparée.
export function buildDesignationWithOrigin(baseDesignation: string, origine: string): string {
  const base = baseDesignation.trim();
  const originClean = origine.trim();
  if (!originClean) return base;
  if (base.toLocaleLowerCase("fr-FR").endsWith(originClean.toLocaleLowerCase("fr-FR"))) return base;
  return `${base} ${originClean}`;
}
