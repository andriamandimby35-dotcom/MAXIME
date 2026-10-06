import { compositionFor } from "@/lib/compositions/works";

// Dépenses internes d'un devis importé : MÊMES lignes et MÊMES règles que le devis
// du DAO (voir standardInternalRecommendations dans EstimateBuilder) :
// - 5 lignes de main-d'œuvre « JOUR-PERSONNE » : quantité = durée interne × effectif,
//   salaire journalier (nourriture comprise) retrouvé dans la bibliothèque de prix
//   sous le MÊME libellé ;
// - 1 ligne « Transport, approvisionnement et livraison rendus chantier » en T.KM :
//   quantité = tonnes de matériaux lourds × distance fournisseur–chantier.

export const INTERNAL_COSTS_CATEGORY = "COÛTS INTERNES DU CHANTIER";
export const TRANSPORT_DESIGNATION = "Transport, approvisionnement et livraison rendus chantier";
export const TRANSPORT_UNIT = "T.KM";
export const LABOR_UNIT = "JOUR-PERSONNE";

export type StaffKey = "workerAideCount" | "masonCount" | "siteManagerCount" | "worksManagerCount" | "engineerCount";
export const LABOR_ROLES: Array<{ key: StaffKey; designation: string; position: string }> = [
  { key: "workerAideCount", designation: "Ouvriers et aides — journée avec nourriture comprise", position: "B.1" },
  { key: "masonCount", designation: "Maçons qualifiés — journée avec nourriture comprise", position: "B.2" },
  { key: "siteManagerCount", designation: "Chef de chantier — journée avec nourriture comprise", position: "B.3" },
  { key: "worksManagerCount", designation: "Conducteur de travaux — journée avec nourriture comprise", position: "B.4" },
  { key: "engineerCount", designation: "Ingénieur ou responsable technique — journée avec nourriture comprise", position: "B.5" },
];
export const TRANSPORT_POSITION = "B.6";
export const INTERNAL_COST_DESIGNATIONS = [...LABOR_ROLES.map((role) => role.designation), TRANSPORT_DESIGNATION];

export type InternalParams = {
  /** Durée interne prévue (jours). */
  days: number;
  workerAideCount: number; masonCount: number; siteManagerCount: number; worksManagerCount: number; engineerCount: number;
  /** Distance fournisseur → chantier (km), pour le transport. */
  distanceKm: number;
};
// Mêmes effectifs par défaut que le DAO.
export const DEFAULT_INTERNAL_PARAMS: InternalParams = { days: 0, workerAideCount: 6, masonCount: 4, siteManagerCount: 1, worksManagerCount: 1, engineerCount: 1, distanceKm: 0 };

export function cleanParams(raw: unknown): InternalParams {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const count = (key: keyof InternalParams, fallback: number) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : fallback;
  };
  return {
    days: count("days", 0),
    workerAideCount: count("workerAideCount", DEFAULT_INTERNAL_PARAMS.workerAideCount),
    masonCount: count("masonCount", DEFAULT_INTERNAL_PARAMS.masonCount),
    siteManagerCount: count("siteManagerCount", DEFAULT_INTERNAL_PARAMS.siteManagerCount),
    worksManagerCount: count("worksManagerCount", DEFAULT_INTERNAL_PARAMS.worksManagerCount),
    engineerCount: count("engineerCount", DEFAULT_INTERNAL_PARAMS.engineerCount),
    distanceKm: count("distanceKm", 0),
  };
}

const DENSITY_T_PER_M3: Array<[string, number]> = [["sable", 1.6], ["gravillon", 1.5], ["gravier", 1.5], ["mortier", 2]];
function pieceTonnes(designation: string) {
  const text = designation.toLowerCase();
  if (text.includes("parpaing")) {
    if (/\b10\b/.test(text)) return 0.013;
    if (/\b20\b/.test(text)) return 0.024;
    return 0.018; // 15 cm, le plus courant
  }
  if (text.includes("brique")) return /\b22\b/.test(text) ? 0.0045 : 0.0025;
  return 0;
}

/**
 * Poids estimé (en tonnes) des matériaux lourds du devis : ciment, sable, gravillon,
 * parpaings et briques, d'après les mêmes compositions que le calcul des prix.
 * Les autres matériaux (fer, bois, peinture…) ne sont pas comptés.
 */
export function estimateMaterialTonnes(items: Array<{ designation: string | null; unit: string | null; quantity: number | string | null }>): number {
  let tonnes = 0;
  for (const item of items) {
    const quantity = Number(item.quantity) || 1;
    const composition = compositionFor(String(item.designation ?? ""), String(item.unit ?? ""));
    if (!composition) continue;
    for (const component of composition.components) {
      const amount = component.quantity * quantity;
      const unit = String(component.unit).toLowerCase();
      if (unit === "kg") tonnes += amount / 1000;
      else if (unit === "m3") {
        const density = DENSITY_T_PER_M3.find(([word]) => component.designation.toLowerCase().includes(word))?.[1] ?? 1.5;
        tonnes += amount * density;
      } else if (unit === "u") tonnes += amount * pieceTonnes(component.designation);
    }
  }
  return Math.round(tonnes * 100) / 100;
}
