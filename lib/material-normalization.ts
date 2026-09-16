/**
 * Clés stables du catalogue de prix.
 * Elles sont volontairement strictes pour la désignation (un ciment 350 et un
 * ciment 400 restent deux matériaux distincts), mais tolérantes pour l'unité.
 */
export function canonicalMaterialKey(value: string) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
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
