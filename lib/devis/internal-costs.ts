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
  /** Poids total à transporter (tonnes) donné par le DAO ou le dossier de soumission ; 0 = estimation automatique. */
  weightTonnes: number;
};
// Mêmes effectifs par défaut que le DAO.
export const DEFAULT_INTERNAL_PARAMS: InternalParams = { days: 0, workerAideCount: 6, masonCount: 4, siteManagerCount: 1, worksManagerCount: 1, engineerCount: 1, distanceKm: 0, weightTonnes: 0 };

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
    weightTonnes: count("weightTonnes", 0),
  };
}

const DENSITY_T_PER_M3: Array<[string, number]> = [["sable", 1.6], ["gravillon", 1.5], ["gravier", 1.5], ["mortier", 2], ["moellon", 1.6], ["laterite", 1.7], ["tout-venant", 1.8], ["tout venant", 1.8], ["remblai", 1.7]];

// Poids d'une pièce vendue à l'unité (en tonnes).
function pieceTonnes(designation: string) {
  const text = designation.toLowerCase();
  if (text.includes("parpaing")) {
    if (/\b10\b/.test(text)) return 0.013;
    if (/\b20\b/.test(text)) return 0.024;
    return 0.018; // 15 cm, le plus courant
  }
  if (text.includes("brique")) return /\b22\b/.test(text) ? 0.0045 : 0.0025;
  if (text.includes("colle")) return 0.025; // sac de 25 kg
  if (text.includes("joint")) return 0.005; // sac de 5 kg
  if (text.includes("planche")) return 0.02;
  if (text.includes("tasseau")) return 0.006;
  return 0;
}

// Poids d'un mètre carré d'un matériau de surface (en tonnes).
function surfaceTonnes(designation: string) {
  const text = designation.toLowerCase();
  if (text.includes("carreau") || text.includes("carrelage")) return 0.022;
  if (text.includes("faience")) return 0.015;
  return 0;
}

export type MaterialWeight = { designation: string; unit: string; quantity: number; tonnes: number };

/**
 * Liste des matériaux lourds du devis avec leur poids (tonnes) : ciment, sable, gravillon, parpaings, briques,
 * moellons, remblais, acier, carreaux, colle… d'après les mêmes compositions que le calcul des prix. C'est la
 * base du « poids des matériaux à transporter » (souvent demandé par le dossier de soumission). Les poids du DAO,
 * quand il en donne, passent avant cette estimation.
 */
export function estimateMaterialWeights(items: Array<{ designation: string | null; unit: string | null; quantity: number | string | null }>): MaterialWeight[] {
  const totals = new Map<string, MaterialWeight>();
  for (const item of items) {
    const quantity = Number(item.quantity) || 1;
    const composition = compositionFor(String(item.designation ?? ""), String(item.unit ?? ""));
    if (!composition) continue;
    for (const component of composition.components) {
      const amount = component.quantity * quantity;
      const unit = String(component.unit).toLowerCase();
      const name = component.designation.toLowerCase();
      let tonnes = 0;
      if (unit === "kg") tonnes = amount / 1000;
      else if (unit === "m3") tonnes = amount * (DENSITY_T_PER_M3.find(([word]) => name.includes(word))?.[1] ?? 1.5);
      else if (unit === "m2") tonnes = amount * surfaceTonnes(name);
      else if (unit === "u") tonnes = amount * pieceTonnes(name);
      else if (unit === "l") tonnes = amount / 1000;
      if (!(tonnes > 0)) continue;
      const key = `${component.designation}|${component.unit}`;
      const known = totals.get(key);
      if (known) { known.quantity += amount; known.tonnes += tonnes; }
      else totals.set(key, { designation: component.designation, unit: component.unit, quantity: amount, tonnes });
    }
  }
  return [...totals.values()]
    .filter((row) => !/^eau\b/i.test(row.designation))
    .map((row) => ({ ...row, quantity: Math.round(row.quantity * 100) / 100, tonnes: Math.round(row.tonnes * 1000) / 1000 }))
    .sort((a, b) => b.tonnes - a.tonnes);
}

/** Poids estimé (en tonnes) de tous les matériaux lourds du devis. */
export function estimateMaterialTonnes(items: Array<{ designation: string | null; unit: string | null; quantity: number | string | null }>): number {
  return Math.round(estimateMaterialWeights(items).reduce((sum, row) => sum + row.tonnes, 0) * 100) / 100;
}
