// Aide commune à la bibliothèque de prix : conditionnement (sac, rouleau, barre…) d'un matériau.
// Affichage seulement : rien ici ne modifie un prix ni un devis.

// Quand la fiche n'a pas encore de « vendu par » enregistré, on le lit dans le NOM du matériau
// (ex. « sac de 50 kg », « rouleau de 100 m », « barre de 6 m »).
export function packFromName(designation: unknown, unite: unknown): string {
  const name = String(designation ?? "");
  const m = name.match(/\b(sacs?|rouleaux?|couronnes?|barres?|tubes?|cartons?|bo[iî]tes?|seaux?|bidons?|pots?|f[uû]ts?|paquets?|bobines?|bottes?|cartouches?|flacons?)(?:\s+[A-Za-zÀ-ÿ]+){0,2}?\s+(?:de|d')\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|m²|m2|m|cm|mm|pièces|pieces|pcs|pces)(?![A-Za-zÀ-ÿ])/i);
  if (m) {
    const word = m[1].toLowerCase().replace(/s$/, "").replace("boite", "boîte").replace("fut", "fût");
    return `${word} de ${m[2]} ${m[3].replace(/^m2$/i, "m²")}`;
  }
  // « (50 kg) » dans le nom d'un matériau vendu au sac / seau / bidon…
  const key = String(unite ?? "").trim().toLowerCase();
  const m2 = name.match(/\(?\b(\d+(?:[.,]\d+)?)\s*(kg|l)\b\)?/i);
  if (m2 && ["sac", "seau", "bidon", "pot", "fût", "fut"].includes(key)) return `${key === "fut" ? "fût" : key} de ${m2[1]} ${m2[2].toLowerCase()}`;
  return "";
}

function plain(value: unknown) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/œ/g, "oe");
}

// Travaux, ouvrages, main-d'œuvre, locations… : ce ne sont pas des matériaux « vendus par rouleau/sac »,
// donc on ne leur demande pas de conditionnement.
const WORK = /main.?d.?oeuvre|fourniture et pose|fabrication|pose d|repar|refection|remplacement|remise en|curage|drainage|forage|puits|reseau|location|depose|traitement|fauchage|reprofilage|engazonnement|haie vive|cloture de chantier|garde-corps|escalier|echelle|palissade|glissiere|separateur|dos d.ane|joint de dilatation|manutention|galvanisation|terrassement|demolition|nettoyage|entretien|installation|transport|salaire|heure|journee|forfait|cunette|dalot|caniveau|buse|bordure/;

// Vrai si le conditionnement (sac de combien de kg, rouleau de combien de mètres…) reste à indiquer.
export function packInfoMissing(price: any): boolean {
  if (String(price?.unite_achat ?? "").trim()) return false;
  if (packFromName(price?.designation, price?.unite)) return false;
  const name = plain(price?.designation);
  if (WORK.test(name)) return false;
  const unit = plain(price?.unite).replace(/\s+/g, "");
  if (["ml", "kg", "l", "sac", "rouleau", "barre", "carton", "boite", "paquet", "pack", "seau", "bidon"].includes(unit)) return true;
  if (unit === "m2") return /carrel|faience|parquet|plaque|panneau|tole|dalle|laine|isolant|moquette|lino|revetement|membrane/.test(name);
  if (unit === "u" || unit === "un" || unit === "unite") {
    return /\b(sac|rouleau|barre|tube|tuyau|fer|acier|cable|fil|gaine|peinture|colle|ciment|enduit|mortier|sable|gravillon|vis|clou|pointe|carton|boite|cheville|electrode|joint|silicone|mastic|vernis|lasure)\b/.test(name);
  }
  return false;
}
