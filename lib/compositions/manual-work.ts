// Travaux MANUELS (sans matériau à acheter) : fouille, déblai, remblai compacté à la main, décapage…
// et installation / repli de chantier.
//
// Règle du devis :
//  - INTERNE : le coût est 0, car les ouvriers journaliers sont déjà payés dans les salaires.
//  - EXTERNE : le client voit quand même un prix.
//      * travaux de terrassement et de nettoyage : prix = salaire d'une journée d'ouvrier ÷ ce qu'un ouvrier fait en
//        une journée (rendement) ; la marge du devis s'ajoute ensuite comme pour tous les autres postes ;
//      * installation / repli de chantier : on GARDE le prix déjà mis dans le devis.
// Le prix externe est rangé dans le champ __externalBasePrice de la ligne (prix de base avant marge).
//
// FORMULE COMMUNE à toutes les tâches sans fourniture :
//     prix externe de base = salaire d'une journée d'ouvrier ÷ rendement d'un ouvrier par jour (pour cette tâche et cette unité)
// Les rendements (par ouvrier et par jour) sont dans manualWorkFor ci-dessous, tâche par tâche ; une tâche « sans matériau » qui n'a
// pas de rendement précis reçoit un rendement général selon son unité (GENERIC_OUTPUT_PER_DAY). Un poste au forfait garde son prix.

export type ManualWork = {
  kind: "earth" | "site" | "clearing" | "laying" | "labour";
  /** Ce qu'un ouvrier fait en une journée, dans l'unité du poste (m³, m², ml). null = rendement inconnu. */
  outputPerDay: number | null;
  /** Installation / repli : le prix déjà saisi est conservé pour l'externe. */
  keepPrice: boolean;
  /** Explication courte, en français simple. */
  basis: string;
};

function norm(text: string) {
  return String(text ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/œ/g, "oe").replace(/[’'`´]/g, " ").replace(/[^a-z0-9.,=/ ]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function unitGroup(unit: string) {
  const u = String(unit ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/³/g, "3").replace(/²/g, "2").replace(/[ .]/g, "");
  if (/^(m3|metrecube|metrescubes)$/.test(u)) return "m3";
  if (/^(m2|metrecarre|metrescarres)$/.test(u)) return "m2";
  if (u === "ml" || u === "m" || u === "metre" || u === "metres") return "ml";
  if (/^(u|unite|unites|pce|piece|pieces|pc)$/.test(u)) return "u";
  if (/^(ft|fft|forfait|ens|ensemble|lot|pm)$/.test(u)) return "forfait";
  return u;
}

function num(text: string) {
  const value = Number(String(text).replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** Profondeur de fouille citée dans la désignation (en mètres), sinon null. */
export function depthFromText(text: string): number | null {
  const t = norm(text);
  const match = t.match(/\b(?:profondeur|prof|hauteur|ht|h)\s*(?:moyenne|de|=|:)?\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(cm|m)?\b/);
  if (!match) return null;
  const value = num(match[1]);
  if (value === null) return null;
  const meters = match[2] === "cm" ? value / 100 : value;
  return meters > 0 && meters < 15 ? meters : null;
}

/** Largeur de fouille citée dans la désignation (en mètres), sinon null. */
export function widthFromText(text: string): number | null {
  const t = norm(text);
  const match = t.match(/\b(?:largeur|larg|l)\s*(?:moyenne|de|=|:)?\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(cm|m)?\b/);
  if (!match) return null;
  const value = num(match[1]);
  if (value === null) return null;
  const meters = match[2] === "cm" ? value / 100 : value;
  return meters > 0 && meters < 15 ? meters : null;
}

/**
 * Fouille à la main (angady / pelle malgache) en terre pure, sans rocher : m³ par ouvrier et par jour.
 * Plus c'est profond, plus c'est lent (il faut lancer la terre plus haut) ; une tranchée étroite est plus pénible.
 */
export function digOutputPerDay(depthMeters: number | null, widthMeters: number | null, rocky: boolean): number {
  if (rocky) return 0.8;
  const depth = depthMeters ?? 1.5;
  let output = depth <= 1 ? 4 : depth <= 1.5 ? 3 : depth <= 2 ? 2.2 : 1.5;
  if (widthMeters !== null && widthMeters <= 0.6) output *= 0.85;
  return Math.round(output * 100) / 100;
}

const MECHANICAL = /\b(mecanique|mecanise|mecaniquement|pelle|pelleteuse|engin|engins|bulldozer|camion|tractopelle|niveleuse|compacteur|rouleau|chargeur|grue|benne)\b/;
const WITH_MATERIAL = /\b(fourniture|fournitures|beton|armature|armatures|coffrage|maconnerie|enrobe)\b/;
const IMPORTED_FILL = /\b(apport|apports|tout venant|tout-venant|sable|gravier|graviers|gravillon|gravillons|concasse|cailloux|laterite|materiaux|stabilise|empierrement|argile|selectionne|selectionnes)\b/;
const ROCKY = /\b(rocher|rochers|rocheux|rocheuse|rocheuses|roche|roches|rocailleux|rocailleuse)\b/;

/**
 * Reconnaît un poste de travaux manuels. `unit` est l'unité du poste (m3, m2, ml, ft…).
 * Retourne null pour tout poste qui demande des matériaux ou des machines.
 */
export function manualWorkFor(designation: string, unit: string): ManualWork | null {
  const t = norm(designation);
  if (!t) return null;
  const u = unitGroup(unit);

  // Installation / repli de chantier : main d'œuvre en interne, prix conservé en externe.
  if (/\binstallation\b.*\bchantier\b/.test(t) || /\brepli\b.*\b(chantier|materiel|installations?)\b/.test(t) || /\bamenee\b.*\brepli\b/.test(t)) {
    return { kind: "site", outputPerDay: null, keepPrice: true, basis: "Installation / repli de chantier : main d'œuvre déjà payée dans les salaires (0 en interne). Le prix du devis est gardé pour le client." };
  }

  if (MECHANICAL.test(t)) return null;
  const rocky = ROCKY.test(t);

  // Déblai (avec ou sans « fouille ») : terre prise sur place et mise de côté.
  if (/\bdeblais?\b/.test(t) && !/\bevacuation\b/.test(t) && u === "m3") {
    const output = rocky ? 1 : 5;
    return { kind: "earth", outputPerDay: output, keepPrice: false, basis: `Déblai à la main (${rocky ? "terrain rocheux" : "terre pure"}) : un ouvrier fait ${output} m³ par jour.` };
  }

  // Remblai compacté à la main avec la terre du chantier (pas de terre ou de matériau acheté).
  if (/\bremblais?\b/.test(t) && u === "m3" && !IMPORTED_FILL.test(t) && !WITH_MATERIAL.test(t)) {
    return { kind: "earth", outputPerDay: 5, keepPrice: false, basis: "Remblai à la main avec la terre du chantier (étalé et compacté par couches) : un ouvrier fait 5 m³ par jour." };
  }

  // Fouille / excavation / tranchée / rigole / terrassement manuel : en m³.
  if (/\b(fouilles?|excavations?|tranchees?|rigoles?|terrassements?|puits|puisards?)\b/.test(t) && u === "m3" && !WITH_MATERIAL.test(t) && !/\bremblais?\b/.test(t)) {
    const depth = depthFromText(designation);
    const width = widthFromText(designation);
    const output = digOutputPerDay(depth, width, rocky);
    const detail = [depth !== null ? `profondeur ${depth} m` : "profondeur non précisée (1,5 m retenu)", width !== null ? `largeur ${width} m` : null, rocky ? "terrain rocheux" : "terre pure, sans rocher"].filter(Boolean).join(", ");
    return { kind: "earth", outputPerDay: output, keepPrice: false, basis: `Fouille à la main à l'angady (${detail}) : un ouvrier fait ${output} m³ par jour.` };
  }

  // Décapage de la terre végétale.
  if (/\bdecapages?\b/.test(t)) {
    if (u === "m2") return { kind: "earth", outputPerDay: 40, keepPrice: false, basis: "Décapage à la main (environ 10 cm) : un ouvrier fait 40 m² par jour." };
    if (u === "m3") return { kind: "earth", outputPerDay: 4, keepPrice: false, basis: "Décapage à la main : un ouvrier fait 4 m³ par jour." };
  }

  // Réglage / nivellement du terrain.
  if (/\b(regalage|nivellement|reglage|planage)\b/.test(t) && u === "m2" && !WITH_MATERIAL.test(t) && !IMPORTED_FILL.test(t)) {
    return { kind: "earth", outputPerDay: 60, keepPrice: false, basis: "Nivellement à la main : un ouvrier fait 60 m² par jour." };
  }

  // Évacuation des déblais (brouette sur courte distance).
  if (/\bevacuation\b.*\b(deblais|terres|gravois|decombres|remblais)\b/.test(t) && u === "m3") {
    return { kind: "earth", outputPerDay: 4, keepPrice: false, basis: "Évacuation à la brouette sur courte distance : un ouvrier fait 4 m³ par jour." };
  }

  // Nettoyage / débroussaillage.
  if (/\bdebroussaillage\b/.test(t) && u === "m2") return { kind: "clearing", outputPerDay: 150, keepPrice: false, basis: "Débroussaillage à la main : un ouvrier fait 150 m² par jour." };
  if (/\bnettoyage\b/.test(t) && u === "m2") return { kind: "clearing", outputPerDay: 300, keepPrice: false, basis: "Nettoyage du terrain : un ouvrier fait 300 m² par jour." };

  // Démolition / dépose à la main.
  if (/\b(demolition|depose)\b/.test(t) && !WITH_MATERIAL.test(t)) {
    if (u === "m3") return { kind: "clearing", outputPerDay: 1.5, keepPrice: false, basis: "Démolition à la main : un ouvrier fait 1,5 m³ par jour." };
    if (u === "m2") return { kind: "clearing", outputPerDay: 10, keepPrice: false, basis: "Dépose à la main : un ouvrier fait 10 m² par jour." };
    if (u === "ml") return { kind: "clearing", outputPerDay: 12, keepPrice: false, basis: "Dépose à la main : un ouvrier fait 12 ml par jour." };
  }

  // Piquetage / implantation.
  if (/\b(piquetage|implantation)\b/.test(t) && u === "ml") return { kind: "clearing", outputPerDay: 100, keepPrice: false, basis: "Piquetage : une équipe fait 100 ml par jour." };

  // Travail de pose SEULE (sans fourniture) et autres tâches de main d'œuvre : tuyaux, accessoires, essais, plantation…
  // Un poste « Fourniture et pose … » n'est PAS concerné : il y a des matériaux à acheter.
  const supplied = /\b(fourniture|fournitures|fourni|fournis|fournir|approvisionnement|livraison|y compris fourniture)\b/.test(t);
  if (!supplied && !WITH_MATERIAL.test(t)) {
    const pipe = /\b(tuyau|tuyaux|canalisation|canalisations|conduite|conduites|pehd|phed|pvc|fonte|buse|buses)\b/.test(t);
    if (/\b(epreuves?|essais?)\b/.test(t) && u === "ml") return { kind: "labour", outputPerDay: 150, keepPrice: false, basis: "Essai / épreuve de la conduite : une équipe fait 150 ml par jour." };
    if (/\b(desinfection|rincage|purge)\b/.test(t) && u === "ml") return { kind: "labour", outputPerDay: 200, keepPrice: false, basis: "Rinçage / désinfection de la conduite : 200 ml par ouvrier et par jour." };
    if (/\b(pose|poses|poser|mise en place|montage|assemblage|raccordement|soudure)\b/.test(t)) {
      if (pipe && u === "ml") {
        const found = String(designation).match(/(?:ø|dn|diam[eè]tre|\bd)\s*=?\s*(\d{2,3})\b/i) ?? t.match(/\b(?:pehd|phed|pvc|pe)\s+(\d{2,3})\b/);
        const diameter = found ? Number(found[1]) : null;
        const output = diameter === null ? 25 : diameter <= 63 ? 40 : diameter <= 110 ? 25 : diameter <= 200 ? 12 : 6;
        return { kind: "laying", outputPerDay: output, keepPrice: false, basis: `Pose de tuyau en tranchée (${diameter === null ? "diamètre non précisé" : `Ø${diameter}`}) : un ouvrier pose ${output} ml par jour.` };
      }
      return genericLabour(u, "Pose / montage sans fourniture");
    }
    if (/\b(plantation|engazonnement|enherbement|arrosage)\b/.test(t)) return genericLabour(u, "Travail d'espaces verts");
  }

  return null;
}

/** Rendement général d'un ouvrier par jour, selon l'unité, pour une tâche sans matériau sans rendement précis. */
const GENERIC_OUTPUT_PER_DAY: Record<string, number> = { ml: 25, m2: 20, m3: 3, u: 4 };

function genericLabour(unitKind: string, label: string): ManualWork {
  const output = GENERIC_OUTPUT_PER_DAY[unitKind] ?? null;
  if (output === null) return { kind: "labour", outputPerDay: null, keepPrice: true, basis: `${label} : main d'œuvre déjà payée dans les salaires (0 en interne). Le prix du devis est gardé pour le client.` };
  return { kind: "labour", outputPerDay: output, keepPrice: false, basis: `${label} : rendement général d'un ouvrier = ${output} ${unitKind === "u" ? "unités" : unitKind} par jour.` };
}

/** Prix externe de base (avant marge) d'un poste manuel, en Ar par unité : salaire du jour ÷ rendement. */
export function manualExternalBasePrice(work: ManualWork, dayRate: number): number {
  if (!work.outputPerDay || !(dayRate > 0)) return 0;
  return Math.round(dayRate / work.outputPerDay);
}

/** Texte « 15 000 Ar/jour ÷ 3 m³/jour = 5 000 Ar » pour le détail du prix. */
export function manualPriceExplanation(work: ManualWork, dayRate: number, unit: string, externalBase: number): string {
  const fmt = (value: number) => value.toLocaleString("fr-FR");
  if (work.keepPrice) return `${work.basis} Prix gardé pour le devis externe : ${fmt(externalBase)} Ar (avant marge).`;
  if (!work.outputPerDay) return `Main d'œuvre : 0 en interne (salaires). Prix externe à saisir.`;
  return `${work.basis} Prix externe de base = ${fmt(dayRate)} Ar par jour ÷ ${work.outputPerDay.toLocaleString("fr-FR")} ${unit || "unité"} par jour = ${fmt(externalBase)} Ar par ${unit || "unité"} (avant marge). Interne : 0 Ar, car les ouvriers journaliers sont déjà payés dans les salaires.`;
}

/** Prix externe de base mémorisé sur une ligne de poste manuel (0 si la ligne n'en a pas). */
export function externalOverride(line: Record<string, unknown>): number {
  const value = Number(line.__externalBasePrice);
  return line.__laborOnly === true && Number.isFinite(value) && value > 0 ? value : 0;
}
