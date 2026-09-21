"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getDaoTemplate } from "@/lib/dao/get-dao-template";
import { createClient } from "@/lib/supabase/client";
import OfficialPdfButton from "@/components/estimates/OfficialPdfButton";

type DaoColumn = {
  name: string;
  order: number;
};

type EstimateLineData = Record<string, string | number | boolean | null | undefined>;

type DaoTemplate = {
  id: string;
  organization_id?: string;
  columns?: { columns?: DaoColumn[] };
};

type EstimateSummary = {
  id: string;
  dao_template_id: string;
  status?: string;
  total?: number | string | null;
  profit_margin_percent?: number | string | null;
  created_at?: string;
};

type TenderWorkItem = {
  row_type?: "section" | "item" | "subtotal";
  parent_title?: string;
  parent_reference?: string;
  section_title?: string;
  designation?: string;
  category?: string;
  categorie?: string;
  unit?: string;
  unite?: string;
  quantity?: number | null;
  quantite?: number | null;
  source_reference?: string;
  needs_review?: boolean;
  note?: string;
  pricing_context?: string;
  internal_only?: boolean;
  recommendation_kind?: string;
  options?: string[];
  default_option?: string;
  reason?: string;
  source_basis?: string;
  safety_note?: string;
  requires_validation?: boolean;
};

type InternalCostRecommendation = {
  kind: "labor" | "material" | "equipment" | "service" | "overhead";
  title: string;
  designation: string;
  unit: string;
  quantity: number | null;
  reason: string;
  source_basis: string;
  options: string[];
  default_option: string;
  requires_validation: boolean;
  safety_note: string;
};

const LINE_ID_KEY = "__estimateLineId";

const QUANTITY_KEYS = ["Quantité", "QuantitÃ©", "quantite"] as const;
const UNIT_PRICE_KEYS = ["Prix unitaire", "prix_unitaire"] as const;
const TOTAL_KEYS = ["Total", "total"] as const;
const POSITION_KEYS = ["N°", "NÂ°", "NÃ‚Â°"] as const;

function numberFrom(line: EstimateLineData, keys: readonly string[]) {
  for (const key of keys) {
    const value = Number(line[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function lineTotal(line: EstimateLineData) {
  const storedTotal = numberFrom(line, TOTAL_KEYS);
  if (storedTotal !== 0) return storedTotal;
  return numberFrom(line, QUANTITY_KEYS) * numberFrom(line, UNIT_PRICE_KEYS);
}

function daoRowType(line: EstimateLineData) {
  const value = String(line.__daoRowType ?? "item");
  return value === "section" || value === "subtotal" ? value : "item";
}

function exclusiveOptionReference(line: EstimateLineData) {
  const text = Object.values(line).map((value) => String(value ?? "")).join(" ");
  return text.match(/\b\d+(?:\.\d+)+[a-z]\b/i)?.[0]?.toLowerCase() ?? null;
}

function exclusivePartnerReferences(line: EstimateLineData) {
  const note = String(line.__daoNote ?? "");
  return [...note.matchAll(/option\s+exclusive\s+avec\s+(\d+(?:\.\d+)+[a-z])/gi)]
    .map((match) => match[1].toLowerCase());
}

/** Une seule décision « brique ou parpaing » couvre toutes les paires analogues. */
function masonryChoiceOption(line: EstimateLineData) {
  if (exclusivePartnerReferences(line).length === 0) return "";
  const text = normalizedLabel(Object.values(line).map((value) => String(value ?? "")).join(" "));
  if (text.includes("parpaing")) return "parpaing";
  if (text.includes("brique")) return "brique";
  return "";
}

function sectionSubtotal(lines: EstimateLineData[], subtotalIndex: number) {
  let total = 0;
  for (let index = subtotalIndex - 1; index >= 0; index -= 1) {
    const rowType = daoRowType(lines[index]);
    if (rowType === "section") break;
    if (rowType === "item" && lines[index].__excludedByChoice !== true) total += lineTotal(lines[index]);
  }
  return total;
}

function aiOptions(line: EstimateLineData) {
  try {
    const parsed = JSON.parse(String(line.__aiOptionsJson ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function equivalentOptions(line: EstimateLineData) {
  try {
    const parsed = JSON.parse(String(line.__equivalentOptionsJson ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function columnName(columns: DaoColumn[], candidates: readonly string[]) {
  return columns.find((column) => candidates.includes(column.name))?.name ?? candidates[0];
}

function normalizedLabel(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function extractExecutionDays(analysis: unknown) {
  const text = JSON.stringify(analysis ?? "");
  const explicitDays = text.match(/(?:d[ée]lai|ex[ée]cution)[^0-9]{0,80}(\d{1,4})\s*jours?/i)
    ?? text.match(/(\d{1,4})\s*jours?[^.]{0,80}(?:d[ée]lai|ex[ée]cution)/i);
  if (explicitDays) return Number(explicitDays[1]);
  const explicitMonths = text.match(/(?:d[ée]lai|ex[ée]cution)[^0-9]{0,80}(\d{1,2})\s*mois/i)
    ?? text.match(/(\d{1,2})\s*mois[^.]{0,80}(?:d[ée]lai|ex[ée]cution)/i);
  return explicitMonths ? Number(explicitMonths[1]) * 30 : 0;
}

function numberFromDaoText(value: unknown) {
  const match = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function transportQuantitiesFromDao(table: {
  rows?: string[][];
  total_weight?: string;
  source_reference?: string;
} | undefined) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const allText = [String(table?.total_weight ?? ""), ...rows.map((row) => row.join(" "))].join(" ");
  const declaredTotalKg = numberFromDaoText(table?.total_weight);
  // Si le total n'est pas lisible mais que le tableau contient des poids en kg,
  // on reprend les valeurs de ses lignes sans utiliser Internet.
  const rowTotalKg = rows.reduce((sum, row) => {
    const text = row.join(" ");
    return /\bkg\b/i.test(text) ? sum + numberFromDaoText(text) : sum;
  }, 0);
  const totalKg = declaredTotalKg > 0 ? declaredTotalKg : rowTotalKg;
  const distanceMatch = allText.match(/(\d+(?:[,.]\d+)?)\s*km\b/i);
  const distanceKm = distanceMatch ? Number(distanceMatch[1].replace(",", ".")) : 0;
  return { totalKg, distanceKm, source: String(table?.source_reference ?? "") };
}

function standardInternalRecommendations(
  items: TenderWorkItem[],
  internalExecutionDays: number,
  workerAideCount = 6,
  masonCount = 4,
  siteManagerCount = 1,
  worksManagerCount = 1,
  engineerCount = 1,
): InternalCostRecommendation[] {
  const itemText = items
    .filter((item) => (item.row_type ?? "item") === "item")
    .map((item) => normalizedLabel(`${item.category ?? item.categorie ?? ""} ${item.designation ?? ""}`))
    .join(" ");
  const has = (...terms: string[]) => terms.some((term) => itemText.includes(normalizedLabel(term)));
  const plannedDays = Math.max(0, internalExecutionDays);

  const recommendations: InternalCostRecommendation[] = [
    {
      kind: "labor",
      title: "MAIN-D'ŒUVRE INTERNE",
      designation: "Ouvriers et aides — journée avec nourriture comprise",
      unit: "JOUR-PERSONNE",
      quantity: plannedDays > 0 ? plannedDays * workerAideCount : null,
      reason: "Coût indispensable à l'exécution, généralement non détaillé comme poste séparé dans le DAO.",
      source_basis: `Hypothèse: ${workerAideCount} ouvriers/aides × ${plannedDays || "durée à confirmer"} jours.`,
      options: [],
      default_option: "Ouvriers et aides — journée avec nourriture comprise",
      requires_validation: true,
      safety_note: "Valider les effectifs et la durée avec le planning d'exécution.",
    },
    {
      kind: "labor",
      title: "MAIN-D'ŒUVRE QUALIFIÉE INTERNE",
      designation: "Maçons qualifiés — journée avec nourriture comprise",
      unit: "JOUR-PERSONNE",
      quantity: plannedDays > 0 ? plannedDays * masonCount : null,
      reason: "Les maçons qualifiés ont un tarif journalier différent de celui des ouvriers et aides.",
      source_basis: `Hypothèse: ${masonCount} maçons × ${plannedDays || "durée à confirmer"} jours.`,
      options: [],
      default_option: "Maçons qualifiés — journée avec nourriture comprise",
      requires_validation: true,
      safety_note: "Valider l'effectif selon le planning et le rendement attendu.",
    },
    {
      kind: "labor",
      title: "ENCADREMENT INTERNE",
      designation: "Chef de chantier — journée avec nourriture comprise",
      unit: "JOUR-PERSONNE",
      quantity: plannedDays > 0 ? plannedDays * siteManagerCount : null,
      reason: "Le chef de chantier dispose de son propre tarif journalier.",
      source_basis: `Hypothèse: ${siteManagerCount} chef(s) de chantier × ${plannedDays || "durée à confirmer"} jours.`,
      options: [],
      default_option: "Chef de chantier — journée avec nourriture comprise",
      requires_validation: true,
      safety_note: "Valider le temps de présence exigé par le DAO.",
    },
    {
      kind: "labor",
      title: "ENCADREMENT INTERNE",
      designation: "Conducteur de travaux — journée avec nourriture comprise",
      unit: "JOUR-PERSONNE",
      quantity: plannedDays > 0 ? plannedDays * worksManagerCount : null,
      reason: "Le conducteur de travaux dispose de son propre tarif journalier.",
      source_basis: `Hypothèse: ${worksManagerCount} conducteur(s) × ${plannedDays || "durée à confirmer"} jours.`,
      options: [],
      default_option: "Conducteur de travaux — journée avec nourriture comprise",
      requires_validation: true,
      safety_note: "Valider le temps de présence exigé par le DAO.",
    },
    {
      kind: "labor",
      title: "ENCADREMENT TECHNIQUE INTERNE",
      designation: "Ingénieur ou responsable technique — journée avec nourriture comprise",
      unit: "JOUR-PERSONNE",
      quantity: plannedDays > 0 ? plannedDays * engineerCount : null,
      reason: "L'ingénieur ou responsable technique dispose de son propre tarif journalier.",
      source_basis: `Hypothèse: ${engineerCount} ingénieur(s) × ${plannedDays || "durée à confirmer"} jours.`,
      options: [],
      default_option: "Ingénieur ou responsable technique — journée avec nourriture comprise",
      requires_validation: true,
      safety_note: "Vérifier les qualifications et le temps de présence exigés par le DAO.",
    },
    {
      kind: "service",
      title: "TRANSPORT ET LOGISTIQUE INTERNE",
      designation: "Transport, approvisionnement et livraison rendus chantier",
      unit: "T.KM",
      quantity: null,
      reason: "Les prix doivent intégrer l'acheminement jusqu'à la localisation réelle du chantier.",
      source_basis: "À estimer selon Lazamasy/Fitovinany, les fournisseurs retenus, le tonnage et les accès.",
      options: [],
      default_option: "Transport, approvisionnement et livraison rendus chantier",
      requires_validation: true,
      safety_note: "Confirmer distances, état des routes, tonnage et nombre de rotations.",
    },
    {
      kind: "equipment",
      title: "MATÉRIEL DE CHANTIER INTERNE",
      designation: "Engins, petit matériel, outillage, carburant et entretien",
      unit: "FFT",
      quantity: 1,
      reason: "Les moyens d'exécution sont indispensables mais souvent incorporés implicitement aux prix unitaires.",
      source_basis: "À estimer selon les méthodes d'exécution et la durée du chantier.",
      options: [],
      default_option: "Engins, petit matériel, outillage, carburant et entretien",
      requires_validation: true,
      safety_note: "Valider la liste des engins et leurs rendements avec le planning.",
    },
    {
      kind: "overhead",
      title: "CONSOMMABLES ET ALÉAS INTERNES",
      designation: "Consommables, petites fournitures, pertes, essais et contrôles",
      unit: "FFT",
      quantity: 1,
      reason: "Ces coûts diffus sont nécessaires et risquent d'être oubliés dans le chiffrage détaillé.",
      source_basis: "À estimer d'après les postes du DAO et les pratiques de chantiers comparables.",
      options: [],
      default_option: "Consommables, petites fournitures, pertes, essais et contrôles",
      requires_validation: true,
      safety_note: "Contrôler les essais et documents de qualité exigés par le DAO.",
    },
  ];

  if (has("électricité", "électrique", "éclairage") && !has("câble", "cable", "fil électrique", "conducteur cuivre")) {
    recommendations.push({
      kind: "material",
      title: "ÉLECTRICITÉ — MATÉRIAU À PRÉCISER",
      designation: "Fils et câbles électriques en cuivre selon plans et puissances",
      unit: "ML",
      quantity: null,
      reason: "Le lot électrique existe, mais les conducteurs ne sont pas explicitement quantifiés dans les postes extraits.",
      source_basis: "Choix provisoire fondé sur les usages courants; quantités et sections à relever sur les plans électriques.",
      options: [
        "Conducteurs cuivre 1,5 mm² pour éclairage",
        "Conducteurs cuivre 2,5 mm² pour prises",
        "Conducteurs cuivre 6 mm² ou section calculée pour alimentation",
      ],
      default_option: "Assortiment de conducteurs cuivre 1,5 mm² et 2,5 mm² selon plans",
      requires_validation: true,
      safety_note: "Validation obligatoire par le plan électrique et un technicien qualifié avant achat.",
    });
  }

  return recommendations;
}

function structureDaoWorkItems(items: TenderWorkItem[]) {
  const structured: TenderWorkItem[] = [];
  let currentCategory = "";
  let sectionHasItem = false;
  let sectionHasSubtotal = false;

  const appendMissingSubtotal = () => {
    if (!currentCategory || !sectionHasItem || sectionHasSubtotal) return;
    structured.push({
      row_type: "subtotal",
      section_title: currentCategory,
      designation: `SOUS-TOTAL ${currentCategory}`,
    });
  };

  for (const item of items) {
    const rowType = item.row_type ?? "item";
    const category = String(item.section_title ?? item.category ?? item.categorie ?? "AUTRES OUVRAGES").trim();

    if (rowType === "section") {
      appendMissingSubtotal();
      currentCategory = category || String(item.designation ?? "AUTRES OUVRAGES").trim();
      sectionHasItem = false;
      sectionHasSubtotal = false;
      structured.push({
        ...item,
        row_type: "section",
        section_title: currentCategory,
        designation: item.designation ?? currentCategory,
      });
      continue;
    }

    if (rowType === "subtotal") {
      if (!currentCategory) currentCategory = category;
      structured.push({ ...item, row_type: "subtotal", section_title: currentCategory });
      sectionHasSubtotal = true;
      continue;
    }

    if (category !== currentCategory) {
      appendMissingSubtotal();
      currentCategory = category;
      sectionHasItem = false;
      sectionHasSubtotal = false;
      structured.push({
        row_type: "section",
        section_title: currentCategory,
        designation: currentCategory,
      });
    }
    structured.push({ ...item, row_type: "item", section_title: currentCategory });
    sectionHasItem = true;
  }
  appendMissingSubtotal();
  return structured;
}

function daoColumnName(columns: DaoColumn[], candidates: readonly string[]) {
  const normalizedCandidates = candidates.map(normalizedLabel);
  return columns.find((column) => normalizedCandidates.includes(normalizedLabel(column.name)))?.name
    ?? candidates[0];
}

function linePayload(line: EstimateLineData) {
  const { [LINE_ID_KEY]: _lineId, ...data } = line;
  void _lineId;
  return data;
}

function estimateLinesSnapshot(lines: EstimateLineData[]) {
  return JSON.stringify(lines.map((line) => ({
    id: String(line[LINE_ID_KEY] ?? ""),
    data: linePayload(line),
  })));
}

function isCompositeWork(line: EstimateLineData, designationKey: string) {
  const value = normalizedLabel(String(line[designationKey] ?? ""));
  return [
    "beton", "coffrage", "maconnerie", "brique", "parpaing", "moellon",
    "dallage", "chape", "enduit", "crepi", "jointoiement", "badigeon",
    "peinture", "herissonnage", "mortier", "charpente", "couverture",
    "assainissement", "canalisation", "puisard", "citerne",
  ].some((keyword) => value.includes(keyword));
}

function isInternalLaborLine(line: EstimateLineData) {
  return line.__internalOnly === true && String(line.__recommendationKind ?? "") === "labor";
}

function fallbackLaborInputs(line: EstimateLineData, designationKey: string) {
  const designation = String(line[designationKey] ?? "Main-d'œuvre").trim();
  return [{
    // Le même libellé est volontairement conservé : le salaire enregistré est
    // ainsi retrouvé automatiquement pour ce poste dans les prochains devis.
    designation,
    unit: "JOUR-PERSONNE",
    quantity_per_work_unit: 1,
    note: "Salaire réel pour une journée-personne, nourriture comprise si elle est incluse.",
    found_unit_price: null,
    source_url: "",
    supplier_name: "",
  }];
}

function fallbackCompositeInputs(designation: string) {
  const normalized = normalizedLabel(designation);
  const emptyPrice = { found_unit_price: null, source_url: "", supplier_name: "" };

  if (normalized.includes("beton")) {
    const dosage = Number(normalized.match(/(?:q|dose)[^0-9]*(\d{3})/)?.[1]) || 350;
    return [
      { designation: `Ciment (${dosage} kg/m³)`, unit: "kg", quantity_per_work_unit: dosage, note: "Dosage à vérifier selon le DAO, le CCTP ou le BET.", ...emptyPrice },
      { designation: "Sable", unit: "m³", quantity_per_work_unit: 0.45, note: "Quantité indicative par m³, modifiable.", ...emptyPrice },
      { designation: "Gravillon", unit: "m³", quantity_per_work_unit: 0.85, note: "Quantité indicative par m³, modifiable.", ...emptyPrice },
      { designation: "Eau ou adjuvant", unit: "L", quantity_per_work_unit: 175, note: "À conserver uniquement si facturé séparément.", ...emptyPrice },
    ];
  }

  if (normalized.includes("coffrage")) {
    return [
      { designation: "Planches de coffrage", unit: "m³", quantity_per_work_unit: 0.025, note: "Quantité ramenée à l'unité DAO, à vérifier sur les plans.", ...emptyPrice },
      { designation: "Tasseaux ou chevrons", unit: "m³", quantity_per_work_unit: 0.01, note: "Raidissement et réemploi à confirmer.", ...emptyPrice },
      { designation: "Pointes ou attaches", unit: "kg", quantity_per_work_unit: 0.15, note: "Consommation indicative, modifiable.", ...emptyPrice },
      { designation: "Huile de décoffrage", unit: "L", quantity_per_work_unit: 0.05, note: "À conserver si nécessaire au poste.", ...emptyPrice },
    ];
  }

  if (normalized.includes("maconnerie") || normalized.includes("parpaing") || normalized.includes("brique")) {
    return [
      { designation: "Blocs ou briques", unit: "U", quantity_per_work_unit: 12.5, note: "Quantité indicative par m², à adapter aux dimensions prévues au DAO.", ...emptyPrice },
      { designation: "Ciment pour mortier", unit: "kg", quantity_per_work_unit: 8, note: "Dosage de mortier à confirmer.", ...emptyPrice },
      { designation: "Sable pour mortier", unit: "m³", quantity_per_work_unit: 0.025, note: "Quantité indicative, modifiable.", ...emptyPrice },
    ];
  }

  return [{
    designation: `Composant principal — ${designation}`,
    unit: "U",
    quantity_per_work_unit: 1,
    note: "Le détail des composants n'a pas été identifié automatiquement : renseignez-le puis ajustez le prix.",
    ...emptyPrice,
  }];
}

/** Décompose les choix alternatifs du DAO afin que chaque prix soit mémorisé séparément. */
function expandAlternativeComponents(components: Array<{
  designation: string;
  unit: string;
  quantity_per_work_unit: number;
  note: string;
  found_unit_price?: number | null;
  source_url?: string;
  supplier_name?: string;
  local_unit_price?: number;
  alternative_group?: string;
}>) {
  return components.flatMap((component) => {
    const choices = component.designation.split(/\s+ou\s+/i).map((value) => value.trim()).filter(Boolean);
    if (choices.length < 2) return [component];
    const alternativeGroup = `alternative-${normalizedLabel(component.designation)}`;
    return choices.map((designation) => ({
      ...component,
      designation,
      alternative_group: alternativeGroup,
      note: `${component.note} Choix alternatif : seul le moins cher disponible est retenu.`,
    }));
  });
}

export default function EstimateBuilder({
  initialEstimateId = null,
  showHistory = true,
  sourceTenderId = null,
}: {
  initialEstimateId?: string | null;
  showHistory?: boolean;
  sourceTenderId?: string | null;
}) {
  const router = useRouter();
  const [currentLine, setCurrentLine] = useState<EstimateLineData>({});
  const [estimateLines, setEstimateLines] = useState<EstimateLineData[]>([]);
  const [daoColumns, setDaoColumns] = useState<DaoColumn[]>([]);
  const [template, setTemplate] = useState<DaoTemplate | null>(null);
  const [templates, setTemplates] = useState<DaoTemplate[]>([]);
  const [history, setHistory] = useState<EstimateSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sourceTenderTitle, setSourceTenderTitle] = useState("");
  const [worksiteLocation, setWorksiteLocation] = useState("");
  const [daoExecutionDays, setDaoExecutionDays] = useState(0);
  const [internalExecutionDays, setInternalExecutionDays] = useState(0);
  const [workerAideCount, setWorkerAideCount] = useState(6);
  const [masonCount, setMasonCount] = useState(4);
  const [siteManagerCount, setSiteManagerCount] = useState(1);
  const [worksManagerCount, setWorksManagerCount] = useState(1);
  const [engineerCount, setEngineerCount] = useState(1);
  const daoTransportRef = useRef<{ totalKg: number; distanceKm: number; source: string }>({ totalKg: 0, distanceKm: 0, source: "" });
  const staffingCountsRef = useRef({
    workerAideCount,
    masonCount,
    siteManagerCount,
    worksManagerCount,
    engineerCount,
  });
  const autoSaveSnapshotRef = useRef("");

  useEffect(() => {
    staffingCountsRef.current = {
      workerAideCount,
      masonCount,
      siteManagerCount,
      worksManagerCount,
      engineerCount,
    };
  }, [workerAideCount, masonCount, siteManagerCount, worksManagerCount, engineerCount]);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [estimateId, setEstimateId] = useState<string | null>(null);
  const [profitMarginPercent, setProfitMarginPercent] = useState(0);
  const [externalPricingMode, setExternalPricingMode] = useState<"percentage" | "target_total">("percentage");
  const [targetClientTotal, setTargetClientTotal] = useState("");
  const [externalMarginPreview, setExternalMarginPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [newLineScope, setNewLineScope] = useState<"dao" | "internal">("dao");
  const [newLineCategory, setNewLineCategory] = useState("");
  const [missingPriceItems, setMissingPriceItems] = useState<string[]>([]);
  const [priceSearchStatus, setPriceSearchStatus] = useState<{
    running: boolean;
    current: number;
    total: number;
    designation: string;
    error: string;
  } | null>(null);
  const [lastEquivalenceResult, setLastEquivalenceResult] = useState<{
    lineIndex: number;
    designation: string;
    interpretedDesignation: string;
    options: string[];
    recommended: string;
    note: string;
    requiresValidation: boolean;
    found: boolean;
    selectedPrice: number | null;
    manualPriceInputs: Array<{
      designation: string;
      unit: string;
      quantityPerWorkUnit: number;
      note: string;
      foundUnitPrice: number | null;
      sourceUrl: string;
      supplierName: string;
      alternativeGroup?: string;
    }>;
  } | null>(null);
  const [manualComponentPrices, setManualComponentPrices] = useState<Record<number, string>>({});
  const [manualComponentQuantities, setManualComponentQuantities] = useState<Record<number, string>>({});
  const [editingComposition, setEditingComposition] = useState(false);
  const [applyingManualCalculation, setApplyingManualCalculation] = useState(false);

  async function openEstimate(estimate: EstimateSummary, availableTemplates: DaoTemplate[]) {
    setMessage("");
    const selectedTemplate = availableTemplates.find((item) => item.id === estimate.dao_template_id);
    const columns = selectedTemplate?.columns?.columns;
    if (!selectedTemplate || !Array.isArray(columns)) {
      setMessage("Le modèle DAO lié à ce devis n'est plus accessible.");
      return;
    }

    const supabase = createClient();
    const { data: lines, error } = await supabase
      .from("estimate_lines")
      .select("id,data")
      .eq("estimate_id", estimate.id);

    if (error) {
      setMessage(`Ouverture impossible : ${error.message}`);
      return;
    }

    setTemplate(selectedTemplate);
    setDaoColumns(columns);
    setEstimateId(estimate.id);
    setProfitMarginPercent(Number(estimate.profit_margin_percent) || 0);
    setExternalPricingMode("percentage");
    setTargetClientTotal("");
    const loadedLines: EstimateLineData[] = (lines ?? []).map((line) => ({
      ...(line.data as EstimateLineData),
      [LINE_ID_KEY]: line.id,
    })).sort((left, right) =>
      Number((left as EstimateLineData).__sortOrder ?? numberFrom(left, POSITION_KEYS)) -
      Number((right as EstimateLineData).__sortOrder ?? numberFrom(right, POSITION_KEYS)));
    setEstimateLines(loadedLines);
    autoSaveSnapshotRef.current = estimateLinesSnapshot(loadedLines);
    const storedContext = loadedLines.find((line) => line.__worksiteLocation || line.__worksiteName);
    setWorksiteLocation(String(storedContext?.__worksiteLocation ?? ""));
    setSourceTenderTitle(String(storedContext?.__worksiteName ?? ""));
    const storedDaoDays = Number(storedContext?.__daoExecutionDays) || 0;
    const storedInternalDays = Number(storedContext?.__internalExecutionDays) || 0;
    setDaoExecutionDays(storedDaoDays);
    setInternalExecutionDays(storedInternalDays || (storedDaoDays > 0 ? Math.ceil(storedDaoDays * 2 / 3) : 0));
    setMessage("Devis rouvert. Les lignes restent liées au DAO d'origine.");
  }

  useEffect(() => {
    const waiting = creating || applyingManualCalculation || priceSearchStatus?.running === true;
    if (!waiting) return;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previousCursor; };
  }, [creating, applyingManualCalculation, priceSearchStatus?.running]);

  useEffect(() => {
    if (!estimateId || creating || applyingManualCalculation || priceSearchStatus?.running) return;

    const snapshot = estimateLinesSnapshot(estimateLines);
    if (snapshot === autoSaveSnapshotRef.current) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        const supabase = createClient();
        const saveErrors = await Promise.all(estimateLines.map(async (line) => {
          const lineId = line[LINE_ID_KEY];
          if (!lineId) return null;
          const { error } = await supabase
            .from("estimate_lines")
            .update({ data: linePayload(line) })
            .eq("id", lineId);
          return error?.message ?? null;
        }));
        const firstSaveError = saveErrors.find(Boolean);
        if (firstSaveError) {
          setMessage(`Modification non enregistrée : ${firstSaveError}`);
          return;
        }

        const total = estimateLines.reduce((sum, line) => sum + (line.__excludedByChoice === true ? 0 : lineTotal(line)), 0);
        // Le total est calculé depuis les lignes enregistrées. Certaines bases
        // existantes ne possèdent pas de colonne estimates.total : ne jamais
        // empêcher une sauvegarde ou une création de devis pour cette raison.
        autoSaveSnapshotRef.current = snapshot;
        setHistory((current) => current.map((item) =>
          item.id === estimateId ? { ...item, total } : item,
        ));

        const pdfResponses = await Promise.all([
          fetch(`/api/estimates/${estimateId}/official-pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ save: true, mode: "internal" }),
          }),
          fetch(`/api/estimates/${estimateId}/official-pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ save: true, mode: "external" }),
          }),
        ]);
        setMessage(pdfResponses.every((response) => response.ok)
          ? "Modifications enregistrées et PDF actualisés."
          : "Modifications enregistrées, mais un PDF n'a pas pu être actualisé.");
      })();
    }, 700);

    return () => window.clearTimeout(timer);
  }, [estimateId, estimateLines, creating, applyingManualCalculation, priceSearchStatus?.running]);

  useEffect(() => {
    let active = true;

    async function loadDao() {
      const supabase = createClient();
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) {
        if (active) {
          setMessage("Votre session a expiré.");
          setLoadingHistory(false);
        }
        return;
      }

      const { data: member } = await supabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      const availableTemplates = member?.organization_id
        ? await getDaoTemplate(member.organization_id) as DaoTemplate[] | null
        : [];
      const selectedTemplate = availableTemplates?.[0];
      const columns = selectedTemplate?.columns?.columns;

      if (!active) return;
      setTemplates(availableTemplates ?? []);
      if (!selectedTemplate || !Array.isArray(columns)) {
        setMessage("Aucun modèle de DAO accessible pour votre organisation.");
        setLoadingHistory(false);
        return;
      }

      setTemplate(selectedTemplate);
      setDaoColumns(columns);

      if (sourceTenderId && member?.organization_id) {
        const { data: sourceTender, error: tenderError } = await supabase
          .from("tenders")
          .select("id,title,reference,ai_analysis")
          .eq("id", sourceTenderId)
          .eq("organization_id", member.organization_id)
          .single();

        if (tenderError || !sourceTender) {
          setMessage("Le DAO analysé est introuvable pour votre organisation.");
        } else {
          type StoredTenderAnalysis = {
            schema_version?: string;
            work_items?: TenderWorkItem[];
            lots?: TenderWorkItem[];
            internal_cost_recommendations?: InternalCostRecommendation[];
            pricing_rules?: Array<{ title?: string; formula?: string; applicable_to?: string; source_reference?: string }>;
            environmental_restrictions?: Array<{ material?: string; restriction?: string; suggested_equivalent?: string; source_reference?: string }>;
            transport_weight_table?: { rows?: string[][]; total_weight?: string; source_reference?: string };
            worksite_location?: string;
            worksite_location_source?: string;
          };
          let analysis: StoredTenderAnalysis | null = null;
          if (typeof sourceTender.ai_analysis === "string") {
            try {
              analysis = JSON.parse(sourceTender.ai_analysis) as StoredTenderAnalysis;
            } catch {
              analysis = null;
            }
          } else if (sourceTender.ai_analysis && typeof sourceTender.ai_analysis === "object") {
            analysis = sourceTender.ai_analysis as StoredTenderAnalysis;
          }
          const isVisualStructuredAnalysis =
            analysis?.schema_version === "dao-visual-structured-v3" ||
            Array.isArray(analysis?.work_items) ||
            Array.isArray(analysis?.lots);
          const detectedExecutionDays = extractExecutionDays(analysis);
          const defaultInternalExecutionDays = detectedExecutionDays > 0 ? Math.ceil(detectedExecutionDays * 2 / 3) : 0;
          setDaoExecutionDays(detectedExecutionDays);
          setInternalExecutionDays((current) => current > 0 ? current : defaultInternalExecutionDays);
          const daoWorksiteLocation = String(analysis?.worksite_location ?? "").trim();
          if (daoWorksiteLocation) {
            setWorksiteLocation((current) => current.trim() || daoWorksiteLocation);
          }
          const rawWorkItems = isVisualStructuredAnalysis
            ? analysis?.work_items ?? analysis?.lots ?? []
            : [];
          const workItems = structureDaoWorkItems(rawWorkItems);
          const daoTransport = transportQuantitiesFromDao(analysis?.transport_weight_table);
          daoTransportRef.current = daoTransport;
          const pricingRulesContext = (analysis?.pricing_rules ?? []).map((rule) => `${rule.title || "Barème DAO"} (${rule.source_reference || "source DAO"}) : ${rule.formula || "règle à vérifier"}. Applicable à : ${rule.applicable_to || "à confirmer"}`).join("\n");
          const environmentalRestrictions = analysis?.environmental_restrictions ?? [];
          const staffingCounts = staffingCountsRef.current;
          const existingNames = new Set(
            workItems
              .filter((item) => (item.row_type ?? "item") === "item")
              .map((item) => normalizedLabel(item.designation ?? "")),
          );
          const internalRecommendations = [
            ...(analysis?.internal_cost_recommendations ?? []),
            ...standardInternalRecommendations(
              workItems,
              defaultInternalExecutionDays,
              staffingCounts.workerAideCount,
              staffingCounts.masonCount,
              staffingCounts.siteManagerCount,
              staffingCounts.worksManagerCount,
              staffingCounts.engineerCount,
            ),
          ]
            .filter((item) => {
              const key = normalizedLabel(item.designation);
              if (!key || existingNames.has(key)) return false;
              existingNames.add(key);
              return true;
            });
          const rowsToImport: TenderWorkItem[] = [...workItems];
          if (internalRecommendations.length > 0) {
            rowsToImport.push({
              row_type: "section",
              section_title: "ÉLÉMENTS INTERNES HORS DAO",
              designation: "ÉLÉMENTS OU MATÉRIAUX MANQUANTS UTILES AUX TRAVAUX — INTERNE",
              internal_only: true,
            });
            rowsToImport.push(...internalRecommendations.map((item) => ({
              row_type: "item" as const,
              section_title: item.title || "ÉLÉMENTS INTERNES HORS DAO",
              designation: item.default_option || item.designation,
              unit: item.unit,
              quantity: item.quantity,
              category: item.kind,
              needs_review: item.requires_validation || item.quantity == null,
              note: item.reason,
              internal_only: true,
              recommendation_kind: item.kind,
              options: item.options,
              default_option: item.default_option,
              reason: item.reason,
              source_basis: item.source_basis,
              safety_note: item.safety_note,
              requires_validation: item.requires_validation,
            })));
            rowsToImport.push({
              row_type: "subtotal",
              section_title: "ÉLÉMENTS INTERNES HORS DAO",
              designation: "TOTAL ÉLÉMENTS INTERNES HORS DAO",
              internal_only: true,
            });
          }
          const designationKey = daoColumnName(columns, ["Désignation", "Designation"]);
          const unitKey = daoColumnName(columns, ["Unité", "Unite"]);
          const quantityKey = daoColumnName(columns, ["Quantité", "Quantite"]);
          const unitPriceKey = daoColumnName(columns, ["Prix unitaire"]);
          const totalKey = daoColumnName(columns, ["Total"]);
          const positionKey = daoColumnName(columns, ["N°", "N"]);

          let itemPosition = 0;
          setSourceTenderTitle(sourceTender.title);
          setEstimateLines(
            rowsToImport.map((item, rowIndex) => {
              const rowType = item.row_type ?? "item";
              const relevantRestrictions = environmentalRestrictions.filter((restriction) => restriction.material && normalizedLabel(item.designation ?? "").includes(normalizedLabel(restriction.material)));
              const importedDesignation = normalizedLabel(item.designation ?? "");
              const importedUnit = normalizedLabel(item.unit ?? item.unite ?? "");
              let importedQuantity = item.quantity ?? item.quantite ?? "";
              let importedSourceBasis = item.source_basis ?? "";
              // Pages de poids du DAO : elles priment sur toute estimation.
              // La charge "transport à dos d'homme" est exprimée en kg ; le
              // transport T.KM ne peut être calculé que si la distance figure
              // elle aussi dans le tableau extrait.
              if (item.internal_only && daoTransport.totalKg > 0 &&
                (importedDesignation.includes("transportadosdhomme") || importedDesignation.includes("transportadoshomme")) &&
                importedUnit.includes("kg")) {
                importedQuantity = daoTransport.totalKg;
                importedSourceBasis = `Poids total repris du tableau DAO : ${daoTransport.totalKg.toLocaleString("fr-FR")} kg${daoTransport.source ? ` (${daoTransport.source})` : ""}.`;
              }
              if (item.internal_only && daoTransport.totalKg > 0 && daoTransport.distanceKm > 0 &&
                importedDesignation.includes("transportapprovisionnement") && importedUnit.includes("tkm")) {
                importedQuantity = (daoTransport.totalKg / 1000) * daoTransport.distanceKm;
                importedSourceBasis = `Transport repris du DAO : ${(daoTransport.totalKg / 1000).toLocaleString("fr-FR")} t × ${daoTransport.distanceKm.toLocaleString("fr-FR")} km${daoTransport.source ? ` (${daoTransport.source})` : ""}.`;
              }
              if (rowType === "item") itemPosition += 1;
              return {
              [positionKey]: rowType === "item" ? itemPosition : "",
              [designationKey]: item.designation ?? "",
              [unitKey]: item.unit ?? item.unite ?? "",
              [quantityKey]: importedQuantity,
              [unitPriceKey]: "",
              [totalKey]: 0,
              __daoSourceReference: item.source_reference ?? "",
              __daoNeedsReview: (item.needs_review ?? item.quantity == null) || relevantRestrictions.length > 0,
              __daoNote: [item.note ?? "", ...relevantRestrictions.map((restriction) => `INTERDIT ENVIRONNEMENT : ${restriction.material} — ${restriction.restriction} (${restriction.source_reference}). Équivalent proposé à valider : ${restriction.suggested_equivalent || "aucun"}`)].filter(Boolean).join("\n"),
              __pricingContext: [item.pricing_context ?? "", pricingRulesContext, ...relevantRestrictions.map((restriction) => `MATÉRIAU INTERDIT : ${restriction.material}. ${restriction.restriction}. Source : ${restriction.source_reference}. Équivalent proposé à valider : ${restriction.suggested_equivalent || "aucun équivalent fiable"}.`)].filter(Boolean).join("\n"),
              __daoCategory: item.category ?? item.categorie ?? "",
              __daoParentTitle: item.parent_title ?? "",
              __daoParentReference: item.parent_reference ?? "",
              __daoRowType: rowType,
              __daoSectionTitle: item.section_title ?? "",
              __internalOnly: item.internal_only ?? false,
              __recommendationKind: item.recommendation_kind ?? "",
              __aiOptionsJson: JSON.stringify(item.options ?? []),
              __aiDefaultOption: item.default_option ?? "",
              __aiReason: item.reason ?? "",
              __aiSourceBasis: importedSourceBasis,
              __aiSafetyNote: item.safety_note ?? "",
              __aiRequiresValidation: item.requires_validation ?? false,
              __sourceTenderId: sourceTender.id,
              __sortOrder: rowIndex,
            };}),
          );
          setMessage(
            !isVisualStructuredAnalysis
              ? "Cette analyse est ancienne et ne contient pas les vrais tableaux du DAO. Retournez sur le DAO, relancez l'analyse IA, puis revenez créer le devis."
              : rowsToImport.length > 0
              ? `${workItems.filter((item) => (item.row_type ?? "item") === "item").length} poste(s) DAO et ${internalRecommendations.length} complément(s) interne(s) préparés.`
              : "Le DAO analysé ne contient aucun poste exploitable. Vérifiez son analyse.",
          );
        }
      }

      if (member?.organization_id) {
        const { data: estimates, error } = await supabase
          .from("estimates")
          .select("*")
          .eq("organization_id", member.organization_id)
          .order("created_at", { ascending: false });

        if (!active) return;
        if (error) setMessage(`Historique indisponible : ${error.message}`);
        const loadedHistory = (estimates ?? []) as EstimateSummary[];
        setHistory(loadedHistory);
        if (initialEstimateId) {
          const estimateToOpen = loadedHistory.find((item) => item.id === initialEstimateId);
          if (estimateToOpen) {
            await openEstimate(estimateToOpen, availableTemplates ?? []);
          } else {
            setMessage("Ce devis est introuvable ou n'appartient pas à votre organisation.");
          }
        }
      }
      setLoadingHistory(false);
    }

    void loadDao();
    return () => {
      active = false;
    };
  }, [initialEstimateId, sourceTenderId]);

  useEffect(() => {
    if (daoColumns.length === 0) return;
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    const unitKey = daoColumnName(daoColumns, ["Unité", "Unite"]);
    const quantityKey = daoColumnName(daoColumns, ["Quantité", "Quantite"]);
    const unitPriceKey = daoColumnName(daoColumns, ["Prix unitaire", "Prix Unitaire"]);
    const totalKey = daoColumnName(daoColumns, ["Total", "Montant"]);
    const plannedDays = Math.max(0, internalExecutionDays);
    const daoTransport = daoTransportRef.current;
    const calculationContext = {
      __daoExecutionDays: daoExecutionDays,
      __internalExecutionDays: plannedDays,
      __worksiteLocation: worksiteLocation.trim(),
      __worksiteName: sourceTenderTitle,
    };

    const updateInternalLines = () => setEstimateLines((current) => {
      const nextLines = current.map((rawLine) => {
      const contextChanged = Object.entries(calculationContext).some(([key, value]) => rawLine[key] !== value);
      const line = contextChanged ? { ...rawLine, ...calculationContext } : rawLine;
      if (line.__internalOnly !== true || daoRowType(line) !== "item") return line;
      const designation = normalizedLabel(String(line[designationKey] ?? ""));
      const unit = normalizedLabel(String(line[unitKey] ?? ""));
      const workforce = Math.max(0, workerAideCount + masonCount + siteManagerCount + worksManagerCount + engineerCount);
      const internalContext = calculationContext;
      if (designation.includes("ouvriersetaides")) {
        return {
          ...line,
          ...internalContext,
          [unitKey]: "JOUR-PERSONNE",
          [quantityKey]: plannedDays > 0 ? plannedDays * workerAideCount : "",
          __disabledInternal: workerAideCount === 0,
          __aiSourceBasis: `${workerAideCount} ouvriers/aides × ${plannedDays || "durée à confirmer"} jours, nourriture comprise.`,
        };
      }
      if (designation.includes("maconsqualifies")) {
        return {
          ...line,
          ...internalContext,
          [unitKey]: "JOUR-PERSONNE",
          [quantityKey]: plannedDays > 0 ? plannedDays * masonCount : "",
          __disabledInternal: masonCount === 0,
          __aiSourceBasis: `${masonCount} maçons × ${plannedDays || "durée à confirmer"} jours, nourriture comprise.`,
        };
      }
      const isManagedRole = designation.includes("chefdechantier") ||
        designation.includes("conducteurdetravaux") ||
        designation.includes("ingenieurouresponsabletechnique");
      const roleCount = designation.includes("chefdechantier") ? siteManagerCount
        : designation.includes("conducteurdetravaux") ? worksManagerCount
          : designation.includes("ingenieurouresponsabletechnique") ? engineerCount : 0;
      if (isManagedRole) return {
        ...line,
        ...internalContext,
        [unitKey]: "JOUR-PERSONNE",
        [quantityKey]: plannedDays > 0 ? plannedDays * roleCount : "",
        __disabledInternal: roleCount === 0,
          __aiSourceBasis: `${roleCount} personne(s) × ${plannedDays || "durée à confirmer"} jours, nourriture comprise.`,
      };
      // Les recommandations issues de l'analyse peuvent désigner les mêmes
      // besoins avec un autre libellé. Elles suivent donc les mêmes règles de
      // quantité que le chantier, sans inventer un poids ou une distance.
      if (designation.includes("manoeuvre") || designation.includes("manuvre") || designation.includes("ouvrier") || designation.includes("aide")) {
        return {
          ...line,
          ...internalContext,
          [unitKey]: unit.includes("jour") ? String(line[unitKey] ?? "jour") : "JOUR-PERSONNE",
          [quantityKey]: plannedDays > 0 ? plannedDays * workerAideCount : "",
          __disabledInternal: workerAideCount === 0,
          __aiSourceBasis: `${workerAideCount} manœuvre(s)/ouvrier(s) × ${plannedDays || "durée à confirmer"} jours.`,
        };
      }
      if (designation.includes("epi")) {
        return {
          ...line,
          ...internalContext,
          [quantityKey]: workforce > 0 ? workforce : "",
          __disabledInternal: workforce === 0,
          __aiSourceBasis: `${workforce} équipement(s) de protection individuelle : un par employé affecté au chantier.`,
        };
      }
      if (designation.includes("brouette") && unit.includes("jour")) {
        return {
          ...line,
          ...internalContext,
          [quantityKey]: plannedDays || "",
          __aiSourceBasis: `1 brouette × ${plannedDays || "durée à confirmer"} jours de chantier.`,
        };
      }
      if ((designation.includes("basevie") || designation.includes("base de vie")) && (unit.includes("forfait") || unit === "fft")) {
        return {
          ...line,
          ...internalContext,
          [quantityKey]: 1,
          __aiSourceBasis: "Forfait unique pour le chantier ; à vérifier par rapport aux exigences du DAO.",
        };
      }
      if ((designation.includes("transportadosdhomme") || designation.includes("transportadoshomme")) &&
          unit.includes("kg") && daoTransport.totalKg > 0) {
        return {
          ...line,
          ...internalContext,
          [quantityKey]: daoTransport.totalKg,
          __daoNeedsReview: false,
          __aiSourceBasis: `Poids total repris du tableau DAO : ${daoTransport.totalKg.toLocaleString("fr-FR")} kg${daoTransport.source ? ` (${daoTransport.source})` : ""}.`,
        };
      }
      if (designation.includes("transportapprovisionnement") && unit.includes("tkm") &&
          daoTransport.totalKg > 0 && daoTransport.distanceKm > 0) {
        return {
          ...line,
          ...internalContext,
          [quantityKey]: (daoTransport.totalKg / 1000) * daoTransport.distanceKm,
          __daoNeedsReview: false,
          __aiSourceBasis: `Transport repris du DAO : ${(daoTransport.totalKg / 1000).toLocaleString("fr-FR")} t × ${daoTransport.distanceKm.toLocaleString("fr-FR")} km${daoTransport.source ? ` (${daoTransport.source})` : ""}.`,
        };
      }
      if (designation.includes("transportadosdhomme") || designation.includes("transportadoshomme") || designation.includes("transportapprovisionnement")) {
        return {
          ...line,
          ...internalContext,
          // Les poids et les distances sont relevés dans les tableaux du DAO.
          // Ne pas les remplacer par une hypothèse : ils sont complétés lorsque
          // l'extraction structurée du tableau de transport est disponible.
          __daoNeedsReview: true,
          __aiSourceBasis: "Poids et distance à reprendre dans le tableau de transport du DAO (aucune hypothèse automatique).",
        };
      }
      return line;
      });

      // Toute quantité calculée doit immédiatement mettre à jour son montant.
      // La sauvegarde centralisée enregistre ensuite les lignes, les totaux et les
      // deux PDF : cela évite que plusieurs sauvegardes concurrentes se croisent.
      return nextLines.map((line, index) => {
        if (line === current[index] || line.__internalOnly !== true || daoRowType(line) !== "item") return line;
        const quantity = Number(line[quantityKey]) || 0;
        const unitPrice = Number(line[unitPriceKey]) || 0;
        const total = quantity * unitPrice;
        return line[totalKey] === total ? line : { ...line, [totalKey]: total };
      });
    });

    const timeoutId = window.setTimeout(updateInternalLines, 0);
    return () => window.clearTimeout(timeoutId);
  }, [
    daoExecutionDays, internalExecutionDays, workerAideCount, masonCount, siteManagerCount,
    worksManagerCount, engineerCount, daoColumns, worksiteLocation, sourceTenderTitle,
  ]);

  const estimateTotal = useMemo(
    () => estimateLines.reduce((sum, line) => sum + (line.__excludedByChoice === true ? 0 : lineTotal(line)), 0),
    [estimateLines],
  );
  const daoRecapTables = useMemo(() => {
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    const tables = new Map<string, {
      title: string;
      reference: string;
      rows: Map<string, { reference: string; designation: string; total: number }>;
    }>();
    let currentCategory = "";
    for (const line of estimateLines) {
      const rowType = daoRowType(line);
      if (rowType === "section") {
        currentCategory = String(line.__daoSectionTitle ?? line[designationKey] ?? "").trim();
        continue;
      }
      if (rowType !== "item" || line.__internalOnly === true || line.__disabledInternal === true || line.__excludedByChoice === true) continue;
      const category = String(line.__daoSectionTitle ?? currentCategory ?? "AUTRES OUVRAGES").trim() || "AUTRES OUVRAGES";
      const parentTitle = String(line.__daoParentTitle ?? "").trim() || "RÉCAPITULATION BORDEREAU DÉTAIL QUANTITATIF ET ESTIMATIF";
      const parentReference = String(line.__daoParentReference ?? "").trim();
      const tableKey = `${parentReference}|${parentTitle}`;
      if (!tables.has(tableKey)) {
        tables.set(tableKey, { title: parentTitle, reference: parentReference, rows: new Map() });
      }
      const table = tables.get(tableKey)!;
      const existing = table.rows.get(category);
      table.rows.set(category, {
        reference: existing?.reference ?? "",
        designation: category,
        total: (existing?.total ?? 0) + lineTotal(line),
      });
    }
    return [...tables.values()].map((table) => ({
      ...table,
      // Les références sont présentes dans l'analyse récente ; pour les anciens
      // DAO, l'ordre du récapitulatif est celui du tableau d'origine (0, I, II…).
      rows: [...table.rows.values()].map((row, index) => ({
        ...row,
        reference: row.reference || (index === 0
          ? "0"
          : ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII"][index - 1] ?? String(index)),
      })),
      total: [...table.rows.values()].reduce((sum, row) => sum + row.total, 0),
    }));
  }, [estimateLines, daoColumns]);
  const financialSummary = useMemo(() => {
    const active = estimateLines.filter((line) => daoRowType(line) === "item" && line.__disabledInternal !== true && line.__excludedByChoice !== true);
    const internalCost = active.reduce((sum, line) => sum + lineTotal(line), 0);
    const externalBase = active.filter((line) => line.__internalOnly !== true).reduce((sum, line) => sum + lineTotal(line), 0);
    const requestedClientTotal = Math.max(0, Number(targetClientTotal) || 0);
    const targetMarginPercent = externalBase > 0 && requestedClientTotal > 0
      ? ((requestedClientTotal / 1.08) / externalBase - 1) * 100
      : profitMarginPercent;
    const appliedMarginPercent = externalPricingMode === "target_total" ? targetMarginPercent : profitMarginPercent;
    const expectedMargin = externalBase * appliedMarginPercent / 100;
    const externalBeforeTax = externalBase + expectedMargin;
    const stateTax = externalBeforeTax * 0.08;
    return { internalCost, externalBase, appliedMarginPercent, expectedMargin, expectedProfit: externalBeforeTax - internalCost, stateTax, clientTotal: externalBeforeTax + stateTax };
  }, [estimateLines, profitMarginPercent, externalPricingMode, targetClientTotal]);

  const externalMarginFactor = 1 + financialSummary.appliedMarginPercent / 100;
  const externalPreviewUnitPrice = (line: EstimateLineData) => line.__internalOnly === true
    ? 0
    : numberFrom(line, UNIT_PRICE_KEYS) * externalMarginFactor;
  const externalPreviewLineTotal = (line: EstimateLineData) => line.__internalOnly === true
    ? 0
    : lineTotal(line) * externalMarginFactor;
  const marginClass = financialSummary.appliedMarginPercent < 0 ? "negative" : financialSummary.appliedMarginPercent > 0 ? "positive" : "neutral";

  function applyExternalMarginPreview() {
    setExternalMarginPreview(true);
    setMessage("Aperçu du devis externe activé : les prix internes ne sont pas modifiés et aucun PDF n'est créé.");
  }

  async function saveProfitMargin(value: string) {
    const candidate = Number(value);
    const margin = Number.isFinite(candidate) ? candidate : 0;
    setProfitMarginPercent(margin);
    if (!estimateId) {
      setMessage("Marge conservée dans le brouillon : elle sera enregistrée avec le devis.");
      return;
    }
    const response = await fetch(`/api/estimates/${estimateId}/margin`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profit_margin_percent: margin }) });
    if (!response.ok) { setMessage("Marge non enregistrée."); return; }
    const pdfResponse = await fetch(`/api/estimates/${estimateId}/official-pdf`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ save: true, mode: "external" }) });
    setMessage(pdfResponse.ok ? "Marge enregistrée : le PDF externe a été remplacé. Le devis interne conserve ses prix exacts." : "Marge enregistrée, mais régénération du PDF externe impossible.");
  }

  async function saveTargetClientTotal(value: string) {
    const target = Math.max(0, Number(value) || 0);
    setTargetClientTotal(target ? String(target) : "");
    if (financialSummary.externalBase <= 0 || target <= 0) {
      setMessage(estimateId
        ? "Ajoutez au moins un prix au devis avant de définir un montant total externe."
        : "Prix cible conservé dans le brouillon. La marge sera calculée dès que les prix seront renseignés.");
      return;
    }
    const calculatedMargin = ((target / 1.08) / financialSummary.externalBase - 1) * 100;
    await saveProfitMargin(String(calculatedMargin));
  }

  const daoCategoryChoices = useMemo(() => {
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    return estimateLines
      .filter((line) => daoRowType(line) === "section" && line.__internalOnly !== true)
      .map((line) => String(line.__daoSectionTitle ?? line[designationKey] ?? "").trim())
      .filter((value, index, values) => value && values.indexOf(value) === index);
  }, [estimateLines, daoColumns]);

  const hasMasonryVariants = useMemo(
    () => estimateLines.some((line) => masonryChoiceOption(line) !== ""),
    [estimateLines],
  );
  const masonryChoice = useMemo<"parpaing" | "brique" | "">(() => {
    for (const line of estimateLines) {
      const choice = String(line.__masonryChoice ?? "");
      if (choice === "parpaing" || choice === "brique") return choice;
    }
    return "";
  }, [estimateLines]);
  const otherExclusiveGroups = useMemo(() => {
    const labels = new Map<string, string>();
    const groups = new Map<string, Set<string>>();
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    for (const line of estimateLines) {
      const reference = exclusiveOptionReference(line);
      if (!reference) continue;
      labels.set(reference, `${reference} — ${String(line[designationKey] ?? "").replace(reference, "").trim()}`);
      for (const partner of exclusivePartnerReferences(line)) {
        const key = [reference, partner].sort().join("|");
        groups.set(key, new Set([reference, partner]));
      }
    }
    return [...groups.values()]
      .map((references) => [...references].filter((reference) => labels.has(reference)))
      .filter((references) => references.length > 1 && !references.every((reference) =>
        estimateLines.some((line) => exclusiveOptionReference(line) === reference && masonryChoiceOption(line) !== ""),
      ))
      .map((references) => ({
        references,
        labels,
        selected: references.find((reference) => estimateLines.some((line) =>
          exclusiveOptionReference(line) === reference && String(line.__exclusiveChoiceReference ?? "") === reference,
        )) ?? "",
      }));
  }, [estimateLines, daoColumns]);

  async function persistEstimateTotal(lines: EstimateLineData[]) {
    const total = lines.reduce((sum, line) => sum + (line.__excludedByChoice === true ? 0 : lineTotal(line)), 0);
    // Le détail des lignes est la source de vérité du total. Ne pas écrire
    // estimates.total : cette colonne n'existe pas dans toutes les versions
    // de la base Supabase déjà installées.
    if (!estimateId) return;
    setHistory((current) =>
      current.map((item) => (item.id === estimateId ? { ...item, total } : item)),
    );
  }

  async function chooseMasonryVariant(choice: "parpaing" | "brique") {
    const nextLines = estimateLines.map((line) => {
      const variant = masonryChoiceOption(line);
      if (!variant) return line;
      return {
        ...line,
        __masonryChoice: choice,
        // La variante écartée reste mémorisée pour permettre un changement,
        // mais elle est retirée du tableau et des PDF.
        __excludedByChoice: variant !== choice,
      };
    });
    setEstimateLines(nextLines);

    if (estimateId) {
      const supabase = createClient();
      const changed = nextLines.filter((line, index) => line !== estimateLines[index] && line[LINE_ID_KEY]);
      const results = await Promise.all(changed.map((line) =>
        supabase.from("estimate_lines").update({ data: linePayload(line) }).eq("id", line[LINE_ID_KEY]),
      ));
      const error = results.find((result) => result.error)?.error;
      if (error) {
        setMessage(`Choix de maçonnerie non enregistré : ${error.message}`);
        return;
      }
    }
    await persistEstimateTotal(nextLines);
    setMessage(`Variante « ${choice === "parpaing" ? "Parpaing" : "Brique"} » retenue : les alternatives non choisies sont exclues du devis et des PDF.`);
  }

  async function chooseExclusiveOption(references: string[], selectedReference: string) {
    const allowed = new Set(references);
    const nextLines = estimateLines.map((line) => {
      const reference = exclusiveOptionReference(line);
      if (!reference || !allowed.has(reference)) return line;
      return {
        ...line,
        __exclusiveChoiceReference: selectedReference,
        __excludedByChoice: reference !== selectedReference,
      };
    });
    setEstimateLines(nextLines);
    if (estimateId) {
      const supabase = createClient();
      const changed = nextLines.filter((line, index) => line !== estimateLines[index] && line[LINE_ID_KEY]);
      const results = await Promise.all(changed.map((line) =>
        supabase.from("estimate_lines").update({ data: linePayload(line) }).eq("id", line[LINE_ID_KEY]),
      ));
      const error = results.find((result) => result.error)?.error;
      if (error) {
        setMessage(`Choix d'option non enregistré : ${error.message}`);
        return;
      }
    }
    await persistEstimateTotal(nextLines);
    setMessage(`Option ${selectedReference} retenue : les variantes exclusives écartées ne sont plus chiffrées ni exportées.`);
  }

  async function searchInternetPrices(newEstimateId: string | null, lines: EstimateLineData[]) {
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    const unitKey = daoColumnName(daoColumns, ["Unité", "Unite"]);
    const quantityKey = daoColumnName(daoColumns, ["Quantité", "Quantite"]);
    const unitPriceKey = daoColumnName(daoColumns, ["Prix unitaire"]);
    const totalKey = daoColumnName(daoColumns, ["Total"]);
    const supabase = createClient();
    const updatedLines = [...lines];
    const searchableTotal = updatedLines.filter((line) => daoRowType(line) === "item" && line.__excludedByChoice !== true).length;
    let searchedCount = 0;
    let manualRequired = 0;
    let lowerOffersPending = 0;
    let searchError = "";
    let accumulatedTonneKm = 0;

    setMissingPriceItems([]);

    setPriceSearchStatus({
      running: true,
      current: 0,
      total: searchableTotal,
      designation: "Préparation de la recherche…",
      error: "",
    });

    for (let index = 0; index < updatedLines.length; index += 1) {
      let line = updatedLines[index];
      if (daoRowType(line) !== "item" || line.__excludedByChoice === true) continue;
      searchedCount += 1;
      const designation = String(line[designationKey] ?? "").trim();
      let unit = String(line[unitKey] ?? "").trim();
      let quantity = Number(line[quantityKey]);
      const lineId = String(line[LINE_ID_KEY] ?? "");
      const isTransportLine = line.__internalOnly === true && normalizedLabel(designation).includes("transportapprovisionnement");
      if (isTransportLine) {
        quantity = Math.round(accumulatedTonneKm * 100) / 100;
        unit = "T.KM";
        line = {
          ...line,
          [unitKey]: unit,
          [quantityKey]: quantity > 0 ? quantity : "",
          __transportTonneKm: quantity,
          __transportCalculation: "Somme des poids estimés × distance fournisseur–chantier",
        };
        updatedLines[index] = line;
      }

      setMessage(`Recherche des prix ${searchedCount}/${searchableTotal} : ${designation || "poste sans désignation"}…`);
      setPriceSearchStatus({
        running: true,
        current: searchedCount,
        total: searchableTotal,
        designation: designation || "Poste sans désignation",
        error: "",
      });

      let nextLine: EstimateLineData = line;
      if (!designation || !unit) {
        manualRequired += 1;
        const missingLabel = designation || `Poste ${index + 1} sans désignation`;
        setMissingPriceItems((current) => current.includes(missingLabel) ? current : [...current, missingLabel]);
        nextLine = { ...line, __priceStatus: "manual_required", __daoNeedsReview: true };
      } else {
        try {
          const response = await fetch("/api/prices/internet-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              designation,
              categorie: line.__daoCategory ?? "",
              unite: unit,
              daoQuantity: Number(line[quantityKey]) || 0,
              pricingContext: String(line.__pricingContext ?? line.__daoNote ?? ""),
              worksiteName: sourceTenderTitle,
              worksiteLocation: worksiteLocation.trim(),
            }),
          });
          const result = await response.json() as {
            error?: string;
            details?: string;
            found?: boolean;
            selected_price?: number;
            price_id?: string;
            proposed_lower_price?: number | null;
            requires_validation?: boolean;
            price_provenance?: string;
            contributor_organization?: string | null;
            supplier?: string;
            supplier_distance_km?: number | null;
            estimated_unit_weight_t?: number | null;
            weight_basis?: string;
            interpreted_designation?: string;
            equivalent_options?: string[];
            recommended_equivalent?: string;
            equivalence_note?: string;
            requires_technical_validation?: boolean;
            manual_price_inputs?: Array<{
              designation: string;
              unit: string;
              quantity_per_work_unit: number;
              note: string;
              found_unit_price: number | null;
              source_url: string;
              supplier_name: string;
              alternative_group?: string;
            }>;
          };
          const rawComponentInputs = (result.manual_price_inputs?.length ?? 0) > 0
            ? result.manual_price_inputs ?? []
            : isInternalLaborLine(line)
              ? fallbackLaborInputs(line, designationKey)
              : isCompositeWork(line, designationKey)
              ? fallbackCompositeInputs(designation)
              : [];
          const componentInputs = expandAlternativeComponents(rawComponentInputs);
          const selectedPrice = Number(result.selected_price);

          if (!response.ok) {
            searchError = result.error || "La recherche Internet est momentanément indisponible.";
            setPriceSearchStatus({
              running: false,
              current: searchedCount,
              total: searchableTotal,
              designation,
              error: searchError,
            });
            break;
          }

          if (!result.found || !Number.isFinite(selectedPrice) || selectedPrice <= 0) {
            manualRequired += 1;
            setMissingPriceItems((current) => current.includes(designation) ? current : [...current, designation]);
            nextLine = {
              ...line,
              __priceStatus: "manual_required",
              __daoNeedsReview: true,
              __interpretedDesignation: result.interpreted_designation ?? "",
              __equivalentOptionsJson: JSON.stringify(result.equivalent_options ?? []),
              __recommendedEquivalent: result.recommended_equivalent ?? "",
              __equivalenceNote: result.equivalence_note ?? "",
              __equivalenceRequiresValidation: result.requires_technical_validation ?? false,
              __manualPriceInputsJson: JSON.stringify(componentInputs),
            };
          } else {
            if (result.requires_validation) lowerOffersPending += 1;
            const unitWeightT = Number(result.estimated_unit_weight_t);
            const distanceKm = Number(result.supplier_distance_km);
            if (!isTransportLine && Number.isFinite(quantity) && quantity > 0 &&
                Number.isFinite(unitWeightT) && unitWeightT > 0 &&
                Number.isFinite(distanceKm) && distanceKm > 0) {
              accumulatedTonneKm += quantity * unitWeightT * distanceKm;
            }
            nextLine = {
              ...line,
              [unitPriceKey]: selectedPrice,
              [totalKey]: Number.isFinite(quantity) && quantity > 0 ? quantity * selectedPrice : 0,
              __priceId: result.price_id ?? "",
              __priceStatus: result.requires_validation
                ? "manual_priority_pending_lower_offer"
                : "internet_selected",
              __proposedLowerPrice: result.proposed_lower_price ?? undefined,
              __priceProvenance: result.price_provenance ?? result.supplier ?? "",
              __priceContributorOrganization: result.contributor_organization ?? "",
              __estimatedUnitWeightT: Number.isFinite(unitWeightT) ? unitWeightT : undefined,
              __supplierDistanceKm: Number.isFinite(distanceKm) ? distanceKm : undefined,
              __weightBasis: result.weight_basis ?? "",
              __interpretedDesignation: result.interpreted_designation ?? "",
              __equivalentOptionsJson: JSON.stringify(result.equivalent_options ?? []),
              __recommendedEquivalent: result.recommended_equivalent ?? "",
              __equivalenceNote: result.equivalence_note ?? "",
              __equivalenceRequiresValidation: result.requires_technical_validation ?? false,
              __manualPriceInputsJson: JSON.stringify(componentInputs),
              __daoNeedsReview: !Number.isFinite(quantity) || quantity <= 0,
            };
          }
        } catch {
          searchError = "Connexion interrompue pendant la recherche des prix.";
          setPriceSearchStatus({
            running: false,
            current: searchedCount,
            total: searchableTotal,
            designation,
            error: searchError,
          });
          break;
        }
      }

      updatedLines[index] = nextLine;
      if (newEstimateId && lineId) {
        await supabase.from("estimate_lines").update({ data: linePayload(nextLine) }).eq("id", lineId);
      }
      setEstimateLines([...updatedLines]);
    }

    const total = updatedLines.reduce((sum, line) => sum + (line.__excludedByChoice === true ? 0 : lineTotal(line)), 0);
    if (newEstimateId) {
      setHistory((current) =>
        current.map((item) => (item.id === newEstimateId ? { ...item, total } : item)),
      );
    }
    if (!searchError) {
      setPriceSearchStatus({
        running: false,
        current: searchableTotal,
        total: searchableTotal,
        designation: "Tous les postes ont été examinés.",
        error: "",
      });
    }
    return { updatedLines, manualRequired, lowerOffersPending, searchError };
  }

  async function searchAllDaoPrices() {
    if (priceSearchStatus?.running) return;

    const priceResult = await searchInternetPrices(estimateId, estimateLines);
    setEstimateLines(priceResult.updatedLines);

    const notices = ["Recherche globale des prix terminée."];
    if (priceResult.searchError) notices.push(priceResult.searchError);
    if (priceResult.manualRequired > 0) {
      notices.push(`${priceResult.manualRequired} prix introuvable(s) : ajout manuel nécessaire.`);
    }
    if (priceResult.lowerOffersPending > 0) {
      notices.push(`${priceResult.lowerOffersPending} prix moins cher(s) à valider avant remplacement.`);
    }

    if (estimateId) {
      const pdfResponses = await Promise.all([
        fetch(`/api/estimates/${estimateId}/official-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ save: true, mode: "internal" }),
        }),
        fetch(`/api/estimates/${estimateId}/official-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ save: true, mode: "external" }),
        }),
      ]);

      if (pdfResponses.every((response) => response.ok)) {
        notices.push("Les PDF interne et externe ont été mis à jour.");
      } else {
        notices.push("Les prix sont enregistrés, mais un PDF n'a pas pu être actualisé.");
      }
    } else {
      notices.push("Les prix sont prêts dans le brouillon et seront enregistrés lorsque vous créerez le devis.");
    }
    setMessage(notices.join(" "));
  }

  async function searchEquivalentsForLine(index: number) {
    const line = estimateLines[index];
    if (!line || daoRowType(line) !== "item") return;
    const designationKey = columnName(daoColumns, ["Désignation", "Designation"]);
    const unitKey = columnName(daoColumns, ["Unité", "Unite", "unit"]);
    const quantityKey = columnName(daoColumns, QUANTITY_KEYS);
    const unitPriceKey = columnName(daoColumns, UNIT_PRICE_KEYS);
    const totalKey = columnName(daoColumns, TOTAL_KEYS);
    const designation = String(line[designationKey] ?? "").trim();
    const unit = String(line[unitKey] ?? "").trim();
    const location = String(line.__worksiteLocation ?? worksiteLocation).trim();
    if (!designation || !unit || !location) {
      const missing = !designation ? "désignation" : !unit ? "unité" : "localisation du chantier";
      const error = `Recherche non démarrée : ${missing} manquante.`;
      setMessage(error);
      setPriceSearchStatus({ running: false, current: 0, total: 1, designation, error });
      return;
    }

    setLastEquivalenceResult(null);
    setManualComponentPrices({});
    setManualComponentQuantities({});
    setEditingComposition(false);
    setPriceSearchStatus({ running: true, current: 0, total: 1, designation: `Recherche ciblée : ${designation}`, error: "" });
    try {
      const response = await fetch("/api/prices/internet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          designation,
          categorie: line.__daoCategory ?? "",
          unite: unit,
          daoQuantity: Number(line[quantityKey]) || 0,
          pricingContext: String(line.__pricingContext ?? line.__daoNote ?? ""),
          worksiteName: String(line.__worksiteName ?? sourceTenderTitle),
          worksiteLocation: location,
        }),
      });
      const result = await response.json() as {
        error?: string;
        found?: boolean;
        selected_price?: number;
        price_id?: string;
        equivalent_options?: string[];
        interpreted_designation?: string;
        recommended_equivalent?: string;
        equivalence_note?: string;
        requires_technical_validation?: boolean;
        manual_price_inputs?: Array<{
          designation: string;
          unit: string;
          quantity_per_work_unit: number;
          note: string;
          found_unit_price: number | null;
          source_url: string;
          supplier_name: string;
          alternative_group?: string;
        }>;
      };
      if (!response.ok) throw new Error(result.error || "Recherche ciblée impossible.");
      const rawComponentInputs = (result.manual_price_inputs?.length ?? 0) > 0
        ? result.manual_price_inputs ?? []
        : isInternalLaborLine(line)
          ? fallbackLaborInputs(line, designationKey)
          : isCompositeWork(line, designationKey)
          ? fallbackCompositeInputs(designation)
          : [];
      let componentInputs = expandAlternativeComponents(rawComponentInputs);
      if (componentInputs.length > 0) {
        try {
          const componentResponse = await fetch("/api/prices/internet-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "resolve_component_prices",
              designation,
              categorie: String(line.__daoCategory ?? ""),
              unite: unit,
              worksiteName: String(line.__worksiteName ?? sourceTenderTitle),
              worksiteLocation: location,
              manualComponents: componentInputs,
            }),
          });
          const componentResult = await componentResponse.json().catch(() => ({})) as { components?: Array<{ saved_unit_price?: number | null; saved_supplier?: string; saved_source?: string }> };
          if (componentResponse.ok && Array.isArray(componentResult.components)) {
            componentInputs = componentInputs.map((item, itemIndex) => {
              const stored = componentResult.components?.[itemIndex];
              const storedPrice = Number(stored?.saved_unit_price);
              return Number.isFinite(storedPrice) && storedPrice > 0 ? {
                ...item,
                found_unit_price: storedPrice,
                supplier_name: stored?.saved_supplier ?? item.supplier_name ?? "Historique des prix",
                source_url: stored?.saved_source ?? item.source_url ?? "",
              } : item;
            });
          }
        } catch {
          // La recherche principale reste utilisable même si l'historique composant est indisponible.
        }
      }
      const selectedPrice = Number(result.selected_price);
      const quantity = Number(line[quantityKey]);
      const updatedLine: EstimateLineData = {
        ...line,
        __worksiteLocation: location,
        __worksiteName: String(line.__worksiteName ?? sourceTenderTitle),
        ...(result.found && Number.isFinite(selectedPrice) && selectedPrice > 0 ? {
          [unitPriceKey]: selectedPrice,
          [totalKey]: Number.isFinite(quantity) && quantity > 0 ? quantity * selectedPrice : 0,
          __priceId: result.price_id ?? line.__priceId,
          __priceStatus: "internet_selected",
        } : {
          __priceStatus: "manual_required",
        }),
        __interpretedDesignation: result.interpreted_designation ?? "",
        __equivalentOptionsJson: JSON.stringify(result.equivalent_options ?? []),
        __recommendedEquivalent: result.recommended_equivalent ?? "",
        __equivalenceNote: result.equivalence_note ?? "",
        __equivalenceRequiresValidation: result.requires_technical_validation ?? false,
        __manualPriceInputsJson: JSON.stringify(componentInputs),
      };
      const normalizedDesignation = normalizedLabel(designation);
      const normalizedUnit = normalizedLabel(unit);
      const nextLines = estimateLines.map((item, itemIndex) => {
        const samePost = daoRowType(item) === "item"
          && normalizedLabel(String(item[designationKey] ?? "")) === normalizedDesignation
          && normalizedLabel(String(item[unitKey] ?? "")) === normalizedUnit;
        if (!samePost) return itemIndex === index ? updatedLine : item;
        const itemQuantity = Number(item[quantityKey]) || 0;
        return {
          ...item,
          ...(result.found && Number.isFinite(selectedPrice) && selectedPrice > 0 ? {
            [unitPriceKey]: selectedPrice,
            [totalKey]: itemQuantity * selectedPrice,
            __priceId: result.price_id ?? item.__priceId,
            __priceStatus: "internet_selected",
          } : { __priceStatus: "manual_required" }),
          __worksiteLocation: location,
          __worksiteName: String(item.__worksiteName ?? sourceTenderTitle),
          __interpretedDesignation: result.interpreted_designation ?? "",
          __equivalentOptionsJson: JSON.stringify(result.equivalent_options ?? []),
          __recommendedEquivalent: result.recommended_equivalent ?? "",
          __equivalenceNote: result.equivalence_note ?? "",
          __equivalenceRequiresValidation: result.requires_technical_validation ?? false,
          __manualPriceInputsJson: JSON.stringify(componentInputs),
        };
      });
      setEstimateLines(nextLines);
      setLastEquivalenceResult({
        lineIndex: index,
        designation,
        interpretedDesignation: result.interpreted_designation ?? "",
        options: result.equivalent_options ?? [],
        recommended: result.recommended_equivalent ?? "",
        note: result.equivalence_note ?? "",
        requiresValidation: result.requires_technical_validation ?? false,
        found: Boolean(result.found),
        selectedPrice: Number.isFinite(selectedPrice) && selectedPrice > 0 ? selectedPrice : null,
        manualPriceInputs: componentInputs.map((item) => ({
          designation: item.designation,
          unit: item.unit,
          quantityPerWorkUnit: Number(item.quantity_per_work_unit) || 0,
          note: item.note,
          foundUnitPrice: Number(item.found_unit_price) > 0 ? Number(item.found_unit_price) : null,
          sourceUrl: item.source_url ?? "",
          supplierName: item.supplier_name ?? "",
          alternativeGroup: item.alternative_group,
        })),
      });
      setManualComponentPrices(Object.fromEntries(
        componentInputs
          .map((item, itemIndex) => [itemIndex, Number(item.found_unit_price) > 0 ? String(item.found_unit_price) : ""]),
      ));
      setManualComponentQuantities(Object.fromEntries(
        componentInputs
          .map((item, itemIndex) => [itemIndex, Number(item.quantity_per_work_unit) > 0 ? String(item.quantity_per_work_unit) : ""]),
      ));
      const supabase = createClient();
      await Promise.all(nextLines.map(async (item, itemIndex) => {
        if (item === estimateLines[itemIndex]) return;
        const itemId = item[LINE_ID_KEY];
        if (itemId) await supabase.from("estimate_lines").update({ data: linePayload(item) }).eq("id", itemId);
      }));
      await persistEstimateTotal(nextLines);
      setPriceSearchStatus({ running: false, current: 1, total: 1, designation: "Recherche ciblée terminée.", error: "" });
      setMessage(result.equivalent_options?.length
        ? `${result.equivalent_options.length} équivalent(s) proposé(s) pour « ${designation} ».`
        : `Aucun équivalent fiable proposé pour « ${designation} ».`);
    } catch (error) {
      setPriceSearchStatus({
        running: false, current: 0, total: 1, designation,
        error: error instanceof Error ? error.message : "Recherche ciblée interrompue.",
      });
    }
  }

  async function applyManualComponentCalculation() {
    if (!lastEquivalenceResult || lastEquivalenceResult.manualPriceInputs.length === 0 || applyingManualCalculation) return;
    const missingInput = lastEquivalenceResult.manualPriceInputs.find((item, index) =>
      !item.alternativeGroup && (manualComponentPrices[index] === undefined || manualComponentPrices[index].trim() === ""),
    );
    if (missingInput) {
      setMessage(`Indiquez le prix local de « ${missingInput.designation} » avant le calcul.`);
      return;
    }
    const alternativeGroups = [...new Set(lastEquivalenceResult.manualPriceInputs.map((item) => item.alternativeGroup).filter(Boolean))];
    const missingAlternativeGroup = alternativeGroups.find((group) => !lastEquivalenceResult.manualPriceInputs.some((item, index) =>
      item.alternativeGroup === group && Number(manualComponentPrices[index]) > 0,
    ));
    if (missingAlternativeGroup) {
      const names = lastEquivalenceResult.manualPriceInputs.filter((item) => item.alternativeGroup === missingAlternativeGroup).map((item) => item.designation).join(" ou ");
      setMessage(`Indiquez au moins un prix pour « ${names} » : l'option la moins chère sera retenue.`);
      return;
    }
    const missingQuantity = lastEquivalenceResult.manualPriceInputs.find((_, index) =>
      !(Number(manualComponentQuantities[index]) > 0),
    );
    if (missingQuantity) {
      setMessage(`Indiquez la quantité de « ${missingQuantity.designation} » nécessaire pour une unité du poste DAO.`);
      return;
    }
    setApplyingManualCalculation(true);

    const componentDetails = lastEquivalenceResult.manualPriceInputs.map((item, index) => ({
      designation: item.designation,
      unit: item.unit,
      quantity_per_work_unit: Number(manualComponentQuantities[index]),
      local_unit_price: Math.max(0, Number(manualComponentPrices[index]) || 0),
      note: item.note,
      alternative_group: item.alternativeGroup,
    }));
    const selectedAlternatives = alternativeGroups.map((group) => componentDetails
      .filter((item) => item.alternative_group === group && item.local_unit_price > 0)
      .sort((a, b) => (a.quantity_per_work_unit * a.local_unit_price) - (b.quantity_per_work_unit * b.local_unit_price))[0])
      .filter(Boolean);
    const compositeUnitPrice = [...componentDetails.filter((item) => !item.alternative_group), ...selectedAlternatives].reduce(
      (sum, item) => sum + item.quantity_per_work_unit * item.local_unit_price,
      0,
    );
    if (!(compositeUnitPrice > 0)) {
      setMessage("Le prix composé calculé est nul. Vérifiez les prix et les quantités des composants.");
      setApplyingManualCalculation(false);
      return;
    }

    const index = lastEquivalenceResult.lineIndex;
    const line = estimateLines[index];
    if (!line) return;
    const unitPriceKey = columnName(daoColumns, UNIT_PRICE_KEYS);
    const designationKey = columnName(daoColumns, ["Désignation", "Designation"]);
    const unitKey = columnName(daoColumns, ["Unité", "Unite", "unit"]);
    const quantityKey = columnName(daoColumns, QUANTITY_KEYS);
    const totalKey = columnName(daoColumns, TOTAL_KEYS);
    const quantity = Number(line[quantityKey]) || 0;
    const updatedLine: EstimateLineData = {
      ...line,
      [unitPriceKey]: compositeUnitPrice,
      [totalKey]: quantity * compositeUnitPrice,
      __priceStatus: "manual_composite",
      __manualCompositeJson: JSON.stringify(componentDetails),
      __priceSource: "prix_locaux_saisis",
      __equivalentOptionsJson: "[]",
      __recommendedEquivalent: "",
      __equivalenceNote: "",
      __equivalenceRequiresValidation: false,
    };
    const targetDesignation = normalizedLabel(String(line[designationKey] ?? ""));
    const targetUnit = normalizedLabel(String(line[unitKey] ?? ""));
    const nextLines = estimateLines.map((item, itemIndex) => {
      const samePost = daoRowType(item) === "item"
        && normalizedLabel(String(item[designationKey] ?? "")) === targetDesignation
        && normalizedLabel(String(item[unitKey] ?? "")) === targetUnit;
      if (!samePost) return itemIndex === index ? updatedLine : item;
      const itemQuantity = Number(item[quantityKey]) || 0;
      return {
        ...item,
        [unitPriceKey]: compositeUnitPrice,
        [totalKey]: itemQuantity * compositeUnitPrice,
        __priceStatus: "manual_composite",
        __manualCompositeJson: JSON.stringify(componentDetails),
        __priceSource: "prix_locaux_saisis",
        __equivalentOptionsJson: "[]",
        __recommendedEquivalent: "",
        __equivalenceNote: "",
        __equivalenceRequiresValidation: false,
      };
    });
    setEstimateLines(nextLines);

    const supabase = createClient();
    const saveErrors = await Promise.all(nextLines.map(async (item, itemIndex) => {
      if (item === estimateLines[itemIndex]) return null;
      const itemId = item[LINE_ID_KEY];
      if (!itemId) return null;
      const { error } = await supabase.from("estimate_lines").update({ data: linePayload(item) }).eq("id", itemId);
      return error?.message ?? null;
    }));
    const firstSaveError = saveErrors.find(Boolean);
    if (firstSaveError) {
      setMessage(`Prix calculé mais ligne non enregistrée : ${firstSaveError}`);
      setApplyingManualCalculation(false);
      return;
    }
    await persistEstimateTotal(nextLines);
    let saveResponse: Response;
    try {
      saveResponse = await fetch("/api/prices/internet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_manual_composite",
          designation: lastEquivalenceResult.designation,
          categorie: String(line.__daoCategory ?? ""),
          unite: String(line[columnName(daoColumns, ["Unité", "Unite", "unit"])] ?? ""),
          worksiteName: String(line.__worksiteName ?? sourceTenderTitle),
          worksiteLocation: String(line.__worksiteLocation ?? worksiteLocation),
          manualCompositePrice: compositeUnitPrice,
          manualComponents: componentDetails,
        }),
      });
    } catch {
      setMessage("Prix appliqué au devis, mais la connexion a empêché l'enregistrement dans l'historique.");
      setApplyingManualCalculation(false);
      return;
    }
    const saveResult = await saveResponse.json().catch(() => ({})) as { error?: string };
    setLastEquivalenceResult((current) => current ? { ...current, found: true, selectedPrice: compositeUnitPrice } : current);
    setMessage(saveResponse.ok
      ? `Prix composé appliqué et enregistré dans l'historique : ${compositeUnitPrice.toLocaleString("fr-FR")} Ar par unité DAO.`
      : `Prix appliqué au devis, mais historique non enregistré : ${saveResult.error ?? "erreur inconnue"}`);
    setEditingComposition(false);
    setApplyingManualCalculation(false);
  }

  async function openCompositePriceDetail(index: number) {
    const line = estimateLines[index];
    if (!line) return;
    let components: Array<{
      designation: string;
      unit: string;
      quantity_per_work_unit: number;
      local_unit_price: number;
      note: string;
      alternative_group?: string;
    }> = [];
    try {
      const parsed = JSON.parse(String(line.__manualCompositeJson ?? line.__manualPriceInputsJson ?? "[]"));
      if (Array.isArray(parsed)) components = expandAlternativeComponents(parsed.map((item) => ({
        designation: String(item.designation ?? "Composant"),
        unit: String(item.unit ?? "U"),
        quantity_per_work_unit: Number(item.quantity_per_work_unit) || 0,
        local_unit_price: Number(item.local_unit_price ?? item.found_unit_price) || 0,
        note: String(item.note ?? ""),
      }))).map((item) => ({ ...item, local_unit_price: Number(item.local_unit_price) || 0 }));
    } catch {
      components = [];
    }
    if (components.length === 0) {
      setMessage("Préparation du détail : recherche ciblée des composants de ce poste.");
      void searchEquivalentsForLine(index);
      return;
    }
    const designationKey = columnName(daoColumns, ["Désignation", "Designation"]);
    const designation = String(line[designationKey] ?? "Poste composé");
    setApplyingManualCalculation(true);
    setPriceSearchStatus({ running: true, current: 0, total: 1, designation: "Consultation des prix déjà enregistrés…", error: "" });
    try {
      const response = await fetch("/api/prices/internet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resolve_component_prices",
          designation,
          categorie: String(line.__daoCategory ?? ""),
          unite: String(line[columnName(daoColumns, ["Unité", "Unite", "unit"])] ?? "U"),
          worksiteName: String(line.__worksiteName ?? sourceTenderTitle ?? "Chantier"),
          worksiteLocation: String(line.__worksiteLocation ?? worksiteLocation ?? "Madagascar"),
          manualComponents: components,
        }),
      });
      const resolved = await response.json() as {
        components?: Array<{
          saved_unit_price?: number | null;
          saved_supplier?: string;
          saved_source?: string;
        }>;
      };
      if (response.ok && Array.isArray(resolved.components)) {
        components = components.map((component, itemIndex) => {
          const saved = resolved.components?.[itemIndex];
          const savedPrice = Number(saved?.saved_unit_price);
          return {
            ...component,
            local_unit_price: component.local_unit_price > 0
              ? component.local_unit_price
              : Number.isFinite(savedPrice) && savedPrice > 0 ? savedPrice : 0,
            note: component.note,
          };
        });
      }
    } catch {
      // Le détail reste utilisable avec les données locales du devis.
    }
    setManualComponentPrices(Object.fromEntries(
      components.map((item, itemIndex) => [itemIndex, String(item.local_unit_price ?? "")]),
    ));
    setManualComponentQuantities(Object.fromEntries(
      components.map((item, itemIndex) => [itemIndex, String(item.quantity_per_work_unit ?? "")]),
    ));
    setLastEquivalenceResult({
      lineIndex: index,
      designation,
      interpretedDesignation: "Composition actuellement enregistrée",
      options: [],
      recommended: "",
      note: "Vous pouvez modifier les quantités et les prix locaux. La validation met à jour le poste et son historique sans créer un nouveau matériau.",
      requiresValidation: false,
      found: true,
      selectedPrice: numberFrom(line, UNIT_PRICE_KEYS),
      manualPriceInputs: components.map((item) => ({
        designation: item.designation,
        unit: item.unit,
        quantityPerWorkUnit: Number(item.quantity_per_work_unit) || 0,
        note: item.note ?? "",
        foundUnitPrice: Number(item.local_unit_price) > 0 ? Number(item.local_unit_price) : null,
        sourceUrl: "historique interne",
        supplierName: "Prix enregistré",
        alternativeGroup: item.alternative_group,
      })),
    });
    setEditingComposition(true);
    setApplyingManualCalculation(false);
    setPriceSearchStatus({ running: false, current: 1, total: 1, designation: "Détail du prix composé", error: "" });
  }

  async function createEstimate() {
    if (!template || creating) return;

    // Le bouton reste accessible avec des montants à zéro : cela permet de
    // contrôler les tableaux et annotations du DAO sans recherche de prix.
    // Pour un devis existant, il actualise seulement les deux PDF : aucun
    // doublon n'est créé et aucune recherche IA supplémentaire n'est lancée.
    if (estimateId) {
      setCreating(true);
      setMessage("");
      const responses = await Promise.all([
        fetch(`/api/estimates/${estimateId}/official-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ save: true, mode: "internal" }),
        }),
        fetch(`/api/estimates/${estimateId}/official-pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ save: true, mode: "external" }),
        }),
      ]);
      setCreating(false);
      setMessage(
        responses.every((response) => response.ok)
          ? "Les deux PDF ont été actualisés. Les prix non renseignés restent à 0 Ar."
          : "Les PDFs n'ont pas tous pu être actualisés. Vérifiez les documents puis réessayez.",
      );
      return;
    }
    const activeEstimateLines = estimateLines.filter((line) => line.__disabledInternal !== true);

    if (sourceTenderId && !worksiteLocation.trim()) {
      setMessage("Indiquez la ville ou la localisation du chantier avant de créer le devis.");
      return;
    }

    if (sourceTenderId && activeEstimateLines.length === 0) {
      setMessage(
        "Création arrêtée : aucun poste du DAO n'est chargé. Retournez au DAO puis cliquez de nouveau sur Générer le devis IA.",
      );
      return;
    }

    setCreating(true);
    setMessage("");
    const supabase = createClient();

    const { data: userData, error: userError } = await supabase.auth.getUser();
    const user = userData.user;
    if (userError || !user) {
      setMessage("Votre session a expiré. Reconnectez-vous pour créer le devis.");
      setCreating(false);
      return;
    }

    const { data: member, error: memberError } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (memberError || !member) {
      setMessage("Aucune organisation active n'est associée à votre compte.");
      setCreating(false);
      return;
    }

    if (template.organization_id && template.organization_id !== member.organization_id) {
      setMessage("Le modèle sélectionné n'appartient pas à votre organisation.");
      setCreating(false);
      return;
    }

    // Un DAO ne conserve qu'un seul devis actif. Au lieu de créer un nouveau
    // devis puis de supprimer l'ancien (ce qui pouvait laisser les deux en
    // cas d'erreur en cours de route), on met à jour le devis existant : il
    // n'y a donc jamais deux lignes pour le même DAO. Les prix recherchés
    // restent dans la bibliothèque de prix et ne sont jamais supprimés.
    let previousEstimateIds: string[] = [];
    if (sourceTenderId) {
      const { data: previousEstimates, error: previousEstimatesError } = await supabase
        .from("estimates")
        .select("id")
        .eq("organization_id", member.organization_id)
        .eq("source_tender_id", sourceTenderId)
        .order("created_at", { ascending: false });
      if (previousEstimatesError) {
        setMessage(`Vérification de l'ancien devis impossible : ${previousEstimatesError.message}`);
        setCreating(false);
        return;
      }
      previousEstimateIds = (previousEstimates ?? []).map((estimate) => estimate.id);
    }
    const [keepEstimateId, ...extraDuplicateIds] = previousEstimateIds;

    setPriceSearchStatus(null);
    const initialEstimateTotal = activeEstimateLines.reduce((sum, line) => sum + (line.__excludedByChoice === true ? 0 : lineTotal(line)), 0);

    let targetEstimateId: string;
    if (keepEstimateId) {
      const { error: updateError } = await supabase
        .from("estimates")
        .update({
          dao_template_id: template.id,
          status: "brouillon",
          profit_margin_percent: financialSummary.appliedMarginPercent,
        })
        .eq("id", keepEstimateId);

      if (updateError) {
        setMessage(`Mise à jour du devis impossible : ${updateError.message}`);
        setPriceSearchStatus({
          running: false,
          current: 0,
          total: activeEstimateLines.length,
          designation: "Le devis n'a pas été mis à jour.",
          error: updateError.message,
        });
        setCreating(false);
        return;
      }

      const { error: oldLinesError } = await supabase
        .from("estimate_lines")
        .delete()
        .eq("estimate_id", keepEstimateId);

      if (oldLinesError) {
        setMessage(`Mise à jour du devis impossible : anciens postes non supprimés (${oldLinesError.message})`);
        setCreating(false);
        return;
      }

      targetEstimateId = keepEstimateId;
    } else {
      const { data, error } = await supabase
        .from("estimates")
        .insert({
          organization_id: member.organization_id,
          dao_template_id: template.id,
          source_tender_id: sourceTenderId || null,
          status: "brouillon",
          profit_margin_percent: financialSummary.appliedMarginPercent,
        })
        .select("id")
        .single();

      if (error) {
        setMessage(`Création impossible : ${error.message}`);
        setPriceSearchStatus({
          running: false,
          current: 0,
          total: activeEstimateLines.length,
          designation: "Le devis n'a pas été créé.",
          error: error.message,
        });
        setCreating(false);
        return;
      }
      targetEstimateId = data.id;
    }

    let savedEstimateLines = activeEstimateLines;
    if (activeEstimateLines.length > 0) {
      const { data: savedLines, error: linesError } = await supabase
        .from("estimate_lines")
        .insert(
          activeEstimateLines.map((line) => ({
            estimate_id: targetEstimateId,
            data: {
              ...linePayload(line),
              __worksiteLocation: worksiteLocation.trim(),
              __worksiteName: sourceTenderTitle,
              __daoExecutionDays: daoExecutionDays,
              __internalExecutionDays: internalExecutionDays,
            },
          })),
        )
        .select("id");

      if (linesError) {
        setMessage(`Devis enregistré, mais postes non enregistrés : ${linesError.message}`);
        setPriceSearchStatus({
          running: false,
          current: 0,
          total: activeEstimateLines.length,
          designation: "L'enregistrement des postes s'est arrêté.",
          error: linesError.message,
        });
        setEstimateId(targetEstimateId);
        setCreating(false);
        return;
      }

      savedEstimateLines = activeEstimateLines.map((line, index) => ({
        ...line,
        [LINE_ID_KEY]: savedLines?.[index]?.id,
      }));
      setEstimateLines(savedEstimateLines);
      autoSaveSnapshotRef.current = estimateLinesSnapshot(savedEstimateLines);
    }

    if (extraDuplicateIds.length > 0) {
      // Nettoyage défensif : d'anciens doublons du même DAO (créés avant cette
      // correction) peuvent encore exister. On les supprime maintenant.
      const { data: oldDocuments, error: oldDocumentsReadError } = await supabase
        .from("estimate_documents")
        .select("storage_path")
        .in("estimate_id", extraDuplicateIds);
      if (oldDocumentsReadError) {
        setMessage(`Devis enregistré, mais lecture d'anciens doublons impossible : ${oldDocumentsReadError.message}`);
        setEstimateId(targetEstimateId);
        setCreating(false);
        return;
      }
      const oldPaths = (oldDocuments ?? []).map((document) => document.storage_path).filter(Boolean);
      if (oldPaths.length > 0) {
        const removal = await supabase.storage.from("estimate-pdfs").remove(oldPaths);
        if (removal.error) {
          setMessage(`Devis enregistré, mais suppression d'anciens PDF en double impossible : ${removal.error.message}`);
          setEstimateId(targetEstimateId);
          setCreating(false);
          return;
        }
      }
      const { error: oldDocumentsError } = await supabase
        .from("estimate_documents")
        .delete()
        .in("estimate_id", extraDuplicateIds);
      if (oldDocumentsError) {
        setMessage(`Devis enregistré, mais anciens doublons non supprimés : ${oldDocumentsError.message}`);
        setEstimateId(targetEstimateId);
        setCreating(false);
        return;
      }
      const { error: oldLinesError } = await supabase
        .from("estimate_lines")
        .delete()
        .in("estimate_id", extraDuplicateIds);
      if (oldLinesError) {
        setMessage(`Devis enregistré, mais anciens doublons non supprimés : ${oldLinesError.message}`);
        setEstimateId(targetEstimateId);
        setCreating(false);
        return;
      }
      const { error: oldEstimateError } = await supabase
        .from("estimates")
        .delete()
        .in("id", extraDuplicateIds);
      if (oldEstimateError) {
        setMessage(`Devis enregistré, mais anciens doublons non supprimés : ${oldEstimateError.message}`);
        setEstimateId(targetEstimateId);
        setCreating(false);
        return;
      }
      setHistory((current) => current.filter((estimate) => !extraDuplicateIds.includes(estimate.id)));
    }

    setEstimateId(targetEstimateId);
    setHistory((current) => [
      {
        id: targetEstimateId,
        dao_template_id: template.id,
        status: "brouillon",
        total: initialEstimateTotal,
        profit_margin_percent: financialSummary.appliedMarginPercent,
        created_at: new Date().toISOString(),
      },
      ...current.filter((estimate) => estimate.id !== targetEstimateId),
    ]);

    setMessage(`Devis ${keepEstimateId ? "mis à jour" : "brouillon créé"} avec les postes du DAO.${keepEstimateId ? " L'ancienne version de ce DAO a été remplacée ; les prix de matériaux sont conservés." : ""}`);
    // Les deux documents sont stockés indépendamment dès la création. Le PDF
    // externe sera régénéré quand la marge changera ; l'interne ne varie pas.
    const pdfResponses = await Promise.all([
      fetch(`/api/estimates/${targetEstimateId}/official-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: true, mode: "internal" }),
      }),
      fetch(`/api/estimates/${targetEstimateId}/official-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: true, mode: "external" }),
      }),
    ]);
    if (pdfResponses.every((response) => response.ok)) {
      setMessage((current) => `${current} Les versions interne et externe ont été enregistrées séparément.`.trim());
    } else {
      setMessage((current) => `${current} Le devis est créé, mais l'enregistrement automatique d'un PDF a échoué : ouvrez les deux versions pour réessayer.`.trim());
    }
    setCreating(false);
  }

  function startNewEstimate() {
    if (showHistory) {
      router.push("/estimates/new");
      return;
    }
    const defaultTemplate = templates[0] ?? null;
    setTemplate(defaultTemplate);
    setDaoColumns(defaultTemplate?.columns?.columns ?? []);
    setEstimateId(null);
    setEstimateLines([]);
    setCurrentLine({});
    setSelectedLine(null);
    setEditingLine(null);
    setMessage("Nouveau devis prêt. L'IA et le modèle DAO restent la source des colonnes.");
  }

  async function deleteEstimate(estimate: EstimateSummary) {
    if (!window.confirm("Supprimer définitivement ce devis et toutes ses lignes ?")) return;

    setMessage("");
    const supabase = createClient();
    const { error: linesError } = await supabase
      .from("estimate_lines")
      .delete()
      .eq("estimate_id", estimate.id);

    if (linesError) {
      setMessage(`Suppression des lignes impossible : ${linesError.message}`);
      return;
    }

    const { error } = await supabase.from("estimates").delete().eq("id", estimate.id);
    if (error) {
      setMessage(`Suppression du devis impossible : ${error.message}`);
      return;
    }

    setHistory((current) => current.filter((item) => item.id !== estimate.id));
    setMessage("Devis supprimé.");
  }

  async function addLine() {
    if (newLineScope === "dao" && !newLineCategory) {
      setMessage("Choisissez la catégorie DAO dans laquelle ajouter la ligne.");
      return;
    }
    const quantityKey = columnName(daoColumns, QUANTITY_KEYS);
    const unitPriceKey = columnName(daoColumns, UNIT_PRICE_KEYS);
    const totalKey = columnName(daoColumns, TOTAL_KEYS);
    const positionKey = columnName(daoColumns, POSITION_KEYS);
    const quantity = Number(currentLine[quantityKey]);
    const unitPrice = Number(currentLine[unitPriceKey]);
    const targetSection = newLineScope === "internal"
      ? "ÉLÉMENTS INTERNES HORS DAO"
      : newLineCategory;

    let newLine: EstimateLineData = {
      ...currentLine,
      [positionKey]: 0,
      [totalKey]:
        (Number.isFinite(quantity) ? quantity : 0) *
        (Number.isFinite(unitPrice) ? unitPrice : 0),
      __daoRowType: "item",
      __daoSectionTitle: targetSection,
      __daoCategory: targetSection,
      __internalOnly: newLineScope === "internal",
      __manuallyAdded: true,
    };

    let insertionIndex = estimateLines.findIndex((line) =>
      daoRowType(line) === "subtotal" &&
      (newLineScope === "internal"
        ? line.__internalOnly === true
        : normalizedLabel(String(line.__daoSectionTitle ?? "")) === normalizedLabel(newLineCategory)),
    );
    if (insertionIndex < 0 && newLineScope === "dao") {
      insertionIndex = estimateLines.findIndex((line) =>
        daoRowType(line) === "section" && line.__internalOnly === true,
      );
    }
    if (insertionIndex < 0) insertionIndex = estimateLines.length;

    if (estimateId) {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("estimate_lines")
        .insert({ estimate_id: estimateId, data: linePayload(newLine) })
        .select("id")
        .single();
      if (error) {
        setMessage(`Ligne non enregistrée : ${error.message}`);
        return;
      }
      newLine[LINE_ID_KEY] = data.id;
    }

    const insertedLines = [...estimateLines];
    insertedLines.splice(insertionIndex, 0, newLine);
    let itemPosition = 0;
    const nextLines = insertedLines.map((line, index) => {
      if (daoRowType(line) === "item" && line.__disabledInternal !== true) itemPosition += 1;
      return {
        ...line,
        [positionKey]: daoRowType(line) === "item" ? itemPosition : "",
        __sortOrder: index,
      };
    });
    if (estimateId) {
      const supabase = createClient();
      await Promise.all(nextLines.map(async (line) => {
        const lineId = line[LINE_ID_KEY];
        if (!lineId) return;
        await supabase.from("estimate_lines").update({ data: linePayload(line) }).eq("id", lineId);
      }));
    }
    setEstimateLines(nextLines);
    setCurrentLine({});
    setMessage(newLineScope === "internal"
      ? "Ligne ajoutée au calcul interne; elle sera exclue du PDF de soumission."
      : `Ligne ajoutée dans la catégorie DAO « ${newLineCategory} ».`);
    await persistEstimateTotal(nextLines);
  }

  function updateLineValue(index: number, key: string, value: string) {
    const totalKey = columnName(daoColumns, TOTAL_KEYS);
    setEstimateLines((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const changed = { ...item, [key]: value };
        return { ...changed, [totalKey]: numberFrom(changed, QUANTITY_KEYS) * numberFrom(changed, UNIT_PRICE_KEYS) };
      }),
    );
  }

  async function saveLine(index: number) {
    const currentLine = estimateLines[index];
    const manuallyPriced = numberFrom(currentLine, UNIT_PRICE_KEYS) > 0;
    const changedLine: EstimateLineData = manuallyPriced ? {
      ...currentLine,
      __priceStatus: "manual_enterprise",
      __equivalentOptionsJson: "[]",
      __recommendedEquivalent: "",
      __equivalenceNote: "",
      __equivalenceRequiresValidation: false,
    } : currentLine;
    const nextLines = estimateLines.map((line, itemIndex) => itemIndex === index ? changedLine : line);
    setEstimateLines(nextLines);
    const lineId = changedLine?.[LINE_ID_KEY];
    if (lineId) {
      const supabase = createClient();
      const { error } = await supabase
        .from("estimate_lines")
        .update({ data: linePayload(changedLine) })
        .eq("id", lineId);
      if (error) setMessage(`Modification non enregistrée : ${error.message}`);
    }
    setEditingLine(null);
    await persistEstimateTotal(nextLines);
  }

  async function removeLine(index: number) {
    const lineId = estimateLines[index]?.[LINE_ID_KEY];
    if (lineId) {
      const supabase = createClient();
      const { error } = await supabase.from("estimate_lines").delete().eq("id", lineId);
      if (error) {
        setMessage(`Suppression impossible : ${error.message}`);
        return;
      }
    }
    const nextLines = estimateLines.filter((_, itemIndex) => itemIndex !== index);
    setEstimateLines(nextLines);
    setSelectedLine(null);
    await persistEstimateTotal(nextLines);
  }

  return (
    <div className="space-y-4">
      {showHistory ? <section className="panel">
        <div className="panelHead">
          <div>
            <h2 className="text-xl font-bold">Historique des devis</h2>
            <p className="text-sm text-gray-600">Devis de votre organisation, liés à leur modèle DAO.</p>
          </div>
          <button type="button" onClick={startNewEstimate} className="button">
            Nouveau devis
          </button>
        </div>

        {loadingHistory ? (
          <p className="mt-3">Chargement…</p>
        ) : history.length === 0 ? (
          <p className="mt-3">Aucun devis enregistré.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border">
              <thead>
                <tr>
                  <th className="border p-2 text-left">Date</th>
                  <th className="border p-2 text-left">Statut</th>
                  <th className="border p-2 text-right">Total</th>
                  <th className="border p-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {history.map((estimate) => (
                  <tr key={estimate.id}>
                    <td className="border p-2">
                      {estimate.created_at
                        ? new Intl.DateTimeFormat("fr-FR").format(new Date(estimate.created_at))
                        : "—"}
                    </td>
                    <td className="border p-2">{estimate.status ?? "brouillon"}</td>
                    <td className="border p-2 text-right">
                      {Number(estimate.total ?? 0).toLocaleString("fr-FR")} Ar
                    </td>
                    <td className="border p-2 text-center">
                      <div className="buttonRow" style={{ justifyContent: "center", marginBottom: 0 }}>
                        <button
                          type="button"
                          onClick={() => router.push(`/estimates/${estimate.id}`)}
                          className="tenderButton"
                        >
                          Ouvrir
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteEstimate(estimate)}
                          className="tenderButton tenderButtonDanger"
                        >
                          Supprimer
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section> : null}

      {message && !priceSearchStatus && <p role="status" className="rounded border p-3">{message}</p>}

      {!showHistory && <>
      <div className="estimateWorkspace">
        <aside className="estimateWorkspaceSidebar">
          <section className="estimateControlPanel">
            <button
              type="button"
              onClick={() => router.push("/estimates")}
              className="estimateBackButton"
            >
              ← Retour aux devis
            </button>
            <p className="estimatePanelEyebrow">DAO associé</p>
            <h2>{sourceTenderTitle || "Nouveau devis"}</h2>
            <p className="estimatePanelDescription">
              Créez le devis une fois les paramètres internes et les lignes renseignés.
            </p>
            <button
              type="button"
              onClick={createEstimate}
              disabled={!template || creating}
              className="estimatePrimaryAction"
            >
              {creating ? "Actualisation…" : estimateId ? "Actualiser les devis" : "Créer le devis"}
            </button>
          </section>

          {estimateId ? (
            <section className="estimateVersionsPanel">
              <div className="estimateVersionsHeading">
                <p className="estimatePanelEyebrow">Documents enregistrés</p>
                <h3>Deux versions du devis</h3>
              </div>
              <p className="estimatePanelDescription">
                Le devis interne garde les coûts exacts et les lignes privées. La marge s&apos;applique seulement au devis externe, y compris aux prix composés, sans modifier le détail de leurs matériaux.
              </p>
              <div className="estimateFinancialSummary">
                <div><span>Coût réel interne</span><strong>{financialSummary.internalCost.toLocaleString("fr-FR")} Ar</strong></div>
                <div><span>Marge externe appliquée</span><strong>{financialSummary.appliedMarginPercent.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %</strong></div>
                <div><span>Bénéfice attendu</span><strong>{financialSummary.expectedProfit.toLocaleString("fr-FR")} Ar</strong></div>
                <div><span>Taxe de l&apos;État (8 %)</span><strong>{financialSummary.stateTax.toLocaleString("fr-FR")} Ar</strong></div>
                <div className="estimateClientTotal"><span>Total à payer par le client</span><strong>{financialSummary.clientTotal.toLocaleString("fr-FR")} Ar</strong></div>
              </div>
              <div className="estimatePdfCards">
                <div className="estimatePdfCard"><strong>Devis interne</strong><span>Coûts réels et informations internes</span><OfficialPdfButton estimateId={estimateId} mode="internal" /></div>
                <div className="estimatePdfCard"><strong>Devis externe</strong><span>Version officielle à soumettre</span><OfficialPdfButton estimateId={estimateId} mode="external" /></div>
              </div>
            </section>
          ) : (
            <section className="estimateVersionsPanel estimateVersionsPanelPending">
              <p className="estimatePanelEyebrow">Documents PDF</p>
              <h3>Deux versions seront préparées</h3>
              <p className="estimatePanelDescription">Le PDF interne et le PDF externe seront générés et enregistrés après la création du devis.</p>
            </section>
          )}

          <section className="estimateVersionsPanel estimatePriceSearchPanel">
            <p className="estimatePanelEyebrow">Prix du DAO</p>
            <h3>Recherche globale des prix</h3>
            <p className="estimatePanelDescription">
              Recherche automatiquement les prix de tous les postes du DAO et met à jour les deux PDF du devis.
            </p>
            <button
              type="button"
              onClick={() => void searchAllDaoPrices()}
              disabled={Boolean(priceSearchStatus?.running)}
              className="estimatePrimaryAction"
            >
              {priceSearchStatus?.running
                ? `Recherche en cours (${priceSearchStatus.current}/${priceSearchStatus.total})…`
                : "Rechercher tous les prix avec l’IA"}
            </button>
            {!estimateId ? (
              <p className="estimatePanelDescription mt-3">Les prix trouvés restent dans ce brouillon puis sont enregistrés au moment de créer le devis.</p>
            ) : null}
          </section>

          <section className="estimateVersionsPanel estimatePricingPanel">
            <p className="estimatePanelEyebrow">Devis externe</p>
            <h3>Marge ou prix cible</h3>
            <p className="estimatePanelDescription">
              Choisissez une marge par poste ou indiquez le montant total TTC attendu pour la soumission.
            </p>
            <label className="estimateMargin">
              <span>Calcul du devis externe</span>
              <select
                value={externalPricingMode}
                onChange={(event) => {
                  const mode = event.target.value as "percentage" | "target_total";
                  setExternalPricingMode(mode);
                  if (mode === "target_total" && !targetClientTotal) setTargetClientTotal(String(Math.round(financialSummary.clientTotal)));
                }}
              >
                <option value="percentage">Appliquer une marge (%)</option>
                <option value="target_total">Fixer un montant total</option>
              </select>
              {externalPricingMode === "percentage" ? (
                <input type="number" step="0.1" value={profitMarginPercent} onChange={(event) => setProfitMarginPercent(Number(event.target.value) || 0)} onBlur={(event) => void saveProfitMargin(event.target.value)} aria-label="Marge du devis externe" />
              ) : (
                <input type="number" min="0" step="1" value={targetClientTotal} onChange={(event) => setTargetClientTotal(event.target.value)} onBlur={(event) => void saveTargetClientTotal(event.target.value)} placeholder="Montant total TTC" aria-label="Montant total externe souhaité" />
              )}
              <small>{externalPricingMode === "percentage" ? "% appliqué à tous les postes externes" : "Ar TTC (taxe de l’État de 8 % comprise)"}</small>
            </label>
            <div className="estimatePricingPreview">
              <span>Marge appliquée <strong className={`estimateMarginTrend ${marginClass}`}>{financialSummary.appliedMarginPercent.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %</strong></span>
              <span>Total client TTC <strong>{financialSummary.clientTotal.toLocaleString("fr-FR")} Ar</strong></span>
            </div>
            <button type="button" onClick={applyExternalMarginPreview} className="estimatePrimaryAction mt-3">
              {externalMarginPreview ? "Actualiser l’aperçu du devis externe" : "Appliquer la marge pour l’aperçu"}
            </button>
            {!estimateId ? <p className="estimatePanelDescription mt-3">Le réglage sera enregistré lors de la création du devis.</p> : null}
          </section>
        </aside>

        <div className="estimateWorkspaceMain">
      {(sourceTenderId || estimateId) && (
        <section className="estimateWorksitePanel">
          <h2 className="font-bold">Paramètres internes du chantier</h2>
          <p>{sourceTenderTitle || "Chargement du DAO…"}</p>
          <label className="mt-3 block">
            <span className="mb-1 block font-semibold">Ville ou localisation du chantier</span>
            <input
              type="text"
              value={worksiteLocation}
              onChange={(event) => setWorksiteLocation(event.target.value)}
              placeholder="Exemple : Lazamasy, Fitovinany"
              className="w-full rounded border p-2"
              required
            />
          </label>
          <p className="mt-2 text-sm text-gray-600">
            Cette localisation sert uniquement à rechercher le coût rendu chantier et reste interne.
          </p>
          <div className="estimateWorksiteFields">
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Délai d&apos;exécution du DAO (jours)</span>
              <input readOnly value={daoExecutionDays > 0 ? `${daoExecutionDays} jours` : "Non indiqué dans le DAO"}
                title="Ce délai est extrait du DAO et ne peut pas être modifié ici."
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6, background: "#f3f4f6", cursor: "not-allowed" }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Durée interne prévue (jours — 2/3 par défaut)</span>
              <input type="number" min="0" value={internalExecutionDays || ""}
                onChange={(event) => setInternalExecutionDays(Math.max(0, Number(event.target.value) || 0))}
                placeholder="Exemple : 100" style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Ouvriers et aides</span>
              <input type="number" min="0" value={workerAideCount}
                onChange={(event) => setWorkerAideCount(Math.max(0, Number(event.target.value) || 0))}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Maçons qualifiés</span>
              <input type="number" min="0" value={masonCount}
                onChange={(event) => setMasonCount(Math.max(0, Number(event.target.value) || 0))}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Chefs de chantier</span>
              <input type="number" min="0" value={siteManagerCount}
                onChange={(event) => setSiteManagerCount(Math.max(0, Number(event.target.value) || 0))}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Conducteurs de travaux</span>
              <input type="number" min="0" value={worksManagerCount}
                onChange={(event) => setWorksManagerCount(Math.max(0, Number(event.target.value) || 0))}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Ingénieurs / responsables techniques</span>
              <input type="number" min="0" value={engineerCount}
                onChange={(event) => setEngineerCount(Math.max(0, Number(event.target.value) || 0))}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
          </div>
          <p style={{ marginTop: 8, fontSize: 13 }}>
            Les journées-personnes comprennent la nourriture. Les effectifs et la durée restent modifiables avant création.
          </p>
        </section>
      )}
      {!sourceTenderId && estimateId && false && (
        <section style={{ padding: 14, border: "1px solid #9ca3af", borderRadius: 8, background: "#f9fafb" }}>
          <label>
            <span style={{ display: "block", fontWeight: 800, marginBottom: 5 }}>
              Localisation du chantier pour les recherches ciblées
            </span>
            <input
              type="text"
              value={worksiteLocation}
              onChange={(event) => setWorksiteLocation(event.target.value)}
              placeholder="Exemple : Lazamasy, Fitovinany, Vohipeno, Madagascar"
              style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }}
            />
          </label>
          <p style={{ marginTop: 6, fontSize: 13 }}>
            Ce lieu sert uniquement à chercher les prix, fournisseurs, distances et transports.
          </p>
        </section>
      )}
      <section className="estimateLineEntryPanel">
        <div className="estimateLineEntryHeading">
          <div>
            <p className="estimatePanelEyebrow">À compléter</p>
            <h2>Lignes du devis</h2>
          </div>
          <span>Les lignes internes restent exclues du PDF de soumission.</span>
        </div>
        <div className="estimateLineScopeFields">
          <label>
            <span style={{ display: "block", fontWeight: 700, marginBottom: 4 }}>Type de nouvelle ligne</span>
            <select
              value={newLineScope}
              onChange={(event) => setNewLineScope(event.target.value as "dao" | "internal")}
              style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }}
            >
              <option value="dao">Ligne du DAO</option>
              <option value="internal">Ligne du devis interne</option>
            </select>
          </label>
          {newLineScope === "dao" && (
            <label>
              <span style={{ display: "block", fontWeight: 700, marginBottom: 4 }}>Catégorie du DAO</span>
              <select
                value={newLineCategory}
                onChange={(event) => setNewLineCategory(event.target.value)}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }}
              >
                <option value="">Choisir une catégorie…</option>
                {daoCategoryChoices.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p style={{ fontSize: 13, color: "#4b5563" }}>
          Une ligne interne est automatiquement exclue du PDF officiel de soumission.
        </p>
        {daoColumns
          .filter((column) => !["N°", "NÂ°", "Total", "total"].includes(column.name))
          .map((column) => (
            <input
              key={column.order}
              type="text"
              inputMode={QUANTITY_KEYS.includes(column.name as never) || UNIT_PRICE_KEYS.includes(column.name as never) ? "decimal" : undefined}
              className="w-full rounded border p-2"
              placeholder={column.name}
              value={String(currentLine[column.name] ?? "")}
              onChange={(event) =>
                setCurrentLine((current) => ({ ...current, [column.name]: event.target.value }))
              }
            />
          ))}

        <button type="button" onClick={addLine} className="estimateSecondaryAction">
          + Ajouter une ligne
        </button>
      </section>
        </div>
      </div>

      <div className="estimateDetailPanel">
        <h3 className="text-lg font-bold">Détail du devis</h3>
        {hasMasonryVariants && (
          <section className="mb-4 mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <h4 className="font-bold text-emerald-950">Choix de la maçonnerie</h4>
            <p className="mt-1 text-sm text-emerald-900">
              Le DAO impose une seule option pour les postes 5.01 et 5.02. La variante non retenue est retirée du devis, des sous-totaux et des PDF.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={() => void chooseMasonryVariant("parpaing")} className={masonryChoice === "parpaing" ? "estimatePrimaryAction" : "estimateSecondaryAction"}>
                {masonryChoice === "parpaing" ? "✓ Parpaing retenu" : "Choisir Parpaing"}
              </button>
              <button type="button" onClick={() => void chooseMasonryVariant("brique")} className={masonryChoice === "brique" ? "estimatePrimaryAction" : "estimateSecondaryAction"}>
                {masonryChoice === "brique" ? "✓ Brique retenue" : "Choisir Brique"}
              </button>
            </div>
          </section>
        )}
        {otherExclusiveGroups.map((group) => (
          <section key={group.references.join("|")} className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <h4 className="font-bold text-amber-950">Option exclusive du DAO</h4>
            <p className="mt-1 text-sm text-amber-900">
              Choisissez une seule ligne : les autres options de cette paire seront retirées du chiffrage et des PDF.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              {group.references.map((reference) => (
                <button
                  key={reference}
                  type="button"
                  onClick={() => void chooseExclusiveOption(group.references, reference)}
                  className={group.selected === reference ? "estimatePrimaryAction" : "estimateSecondaryAction"}
                >
                  {group.selected === reference ? "✓ " : "Choisir "}{group.labels.get(reference)}
                </button>
              ))}
            </div>
          </section>
        ))}
        <table className="mb-8 mt-3 w-full border">
          <thead>
            <tr>
              {daoColumns.map((column) => (
                <th key={column.order} className="border p-2">{column.name}</th>
              ))}
              {externalMarginPreview && <>
                <th className="border p-2">PU externe — marge {financialSummary.appliedMarginPercent.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %</th>
                <th className="border p-2">Montant externe HT</th>
              </>}
              <th className="border p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {estimateLines.length === 0 && (
              <tr>
                <td colSpan={daoColumns.length + 1 + (externalMarginPreview ? 2 : 0)} className="border p-4 text-center text-gray-600">
                  Aucune ligne enregistrée pour ce devis.
                </td>
              </tr>
            )}
            {estimateLines.map((item, index) =>
              item.__disabledInternal === true || item.__excludedByChoice === true ? null : daoRowType(item) === "section" ? (
                <tr key={index}>
                  <td
                    colSpan={daoColumns.length + 1 + (externalMarginPreview ? 2 : 0)}
                    style={{
                      padding: "12px 10px",
                      background: "#e5e7eb",
                      border: "1px solid #9ca3af",
                      fontWeight: 800,
                      textTransform: "uppercase",
                    }}
                  >
                    {item[columnName(daoColumns, ["Désignation", "Designation"])]}
                    {item.__internalOnly === true && (
                      <small style={{ display: "block", marginTop: 4, textTransform: "none" }}>
                        Calcul interne uniquement — automatiquement exclu du PDF de soumission
                      </small>
                    )}
                  </td>
                </tr>
              ) : daoRowType(item) === "subtotal" ? (
                <tr key={index} style={{ background: "#f3f4f6", fontWeight: 800 }}>
                  {daoColumns.map((column) => (
                    <td key={column.order} style={{ border: "1px solid #d1d5db", padding: 10 }}>
                      {column.name === columnName(daoColumns, ["Désignation", "Designation"])
                        ? item[column.name]
                        : column.name === columnName(daoColumns, TOTAL_KEYS)
                          ? `${sectionSubtotal(estimateLines, index).toLocaleString("fr-FR")} Ar`
                          : ""}
                    </td>
                  ))}
                  {externalMarginPreview && <><td style={{ border: "1px solid #d1d5db", padding: 10 }} /><td style={{ border: "1px solid #d1d5db", padding: 10 }}>{sectionSubtotal(estimateLines, index) * externalMarginFactor > 0 ? `${(sectionSubtotal(estimateLines, index) * externalMarginFactor).toLocaleString("fr-FR")} Ar` : "0 Ar"}</td></>}
                  <td style={{ border: "1px solid #d1d5db", padding: 10 }} />
                </tr>
              ) : (
              <tr
                key={index}
                onClick={() => setSelectedLine((current) => (current === index ? null : index))}
                className="cursor-pointer"
              >
                {daoColumns.map((column) => (
                  <td key={column.order} className="border p-2">
                    {editingLine === index &&
                    !TOTAL_KEYS.includes(column.name as never) &&
                    !POSITION_KEYS.includes(column.name as never) ? (
                      column.name === columnName(daoColumns, ["Désignation", "Designation"]) && aiOptions(item).length > 0 ? (
                        <select
                          value={String(item[column.name] ?? "")}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateLineValue(index, column.name, event.target.value)}
                          style={{ width: "100%", padding: 6 }}
                        >
                          {[String(item[column.name] ?? ""), ...aiOptions(item)]
                            .filter((value, optionIndex, values) => value && values.indexOf(value) === optionIndex)
                            .map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      ) : <input
                        type="text"
                        inputMode={
                          QUANTITY_KEYS.includes(column.name as never) ||
                          UNIT_PRICE_KEYS.includes(column.name as never)
                            ? "decimal"
                            : undefined
                        }
                        value={String(item[column.name] ?? "")}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => updateLineValue(index, column.name, event.target.value)}
                        className="w-full border p-1"
                      />
                    ) : column.name === columnName(daoColumns, UNIT_PRICE_KEYS) && item.__priceStatus === "manual_required" ? (
                      <span style={{ color: "#b91c1c", fontWeight: 700 }}>À saisir manuellement</span>
                    ) : column.name === columnName(daoColumns, UNIT_PRICE_KEYS) && item.__priceProvenance ? (
                      <div>
                        <div>{item[column.name]}</div>
                        <div className="print:hidden" data-internal-only="true" style={{ marginTop: 4, color: "#17613d", fontSize: 11, fontWeight: 700 }}>
                          Provenance : {String(item.__priceProvenance)}{item.__priceContributorOrganization ? ` — ${String(item.__priceContributorOrganization)}` : ""}
                        </div>
                      </div>
                    ) : column.name === columnName(daoColumns, TOTAL_KEYS) ? (
                      lineTotal(item).toLocaleString("fr-FR")
                    ) : column.name === columnName(daoColumns, ["Désignation", "Designation"]) &&
                        (equivalentOptions(item).length > 0 || item.__recommendedEquivalent) ? (
                      <div>
                        <div>{String(item[column.name] ?? "")}</div>
                        <div className="print:hidden" data-internal-only="true" style={{ marginTop: 5, color: "#1d4ed8", fontSize: 12, fontWeight: 700 }}>
                          Équivalent interne proposé : {String(item.__recommendedEquivalent || equivalentOptions(item)[0])}
                        </div>
                        {item.__equivalenceRequiresValidation === true && (
                          <div className="print:hidden" data-internal-only="true" style={{ color: "#b91c1c", fontSize: 12 }}>Validation technique obligatoire</div>
                        )}
                      </div>
                    ) : (
                      item[column.name]
                    )}
                    {column.name === columnName(daoColumns, ["Désignation", "Designation"]) && String(item.__daoNote ?? "").trim() && (
                      <small style={{ display: "block", marginTop: 5, color: "#6b4f12", lineHeight: 1.35, whiteSpace: "pre-line" }}>
                        {String(item.__daoNote)}
                      </small>
                    )}
                    {/* Diagnostic temporaire : à retirer une fois le bug du choix maçonnerie identifié. */}
                    {column.name === columnName(daoColumns, ["Désignation", "Designation"]) && masonryChoiceOption(item) !== "" && (
                      <small style={{ display: "block", marginTop: 4, color: "#b91c1c", fontWeight: 700 }}>
                        [DIAG] variante={masonryChoiceOption(item)} · __masonryChoice={String(item.__masonryChoice ?? "(vide)")} · __excludedByChoice={String(item.__excludedByChoice ?? "(vide)")} · id={String(item[LINE_ID_KEY] ?? "(aucun)")}
                      </small>
                    )}
                  </td>
                ))}
                {externalMarginPreview && <>
                  <td className="border p-2">{item.__internalOnly === true ? "—" : `${externalPreviewUnitPrice(item).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Ar`}</td>
                  <td className="border p-2">{item.__internalOnly === true ? "—" : `${externalPreviewLineTotal(item).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Ar`}</td>
                </>}
                <td className="border p-2">
                  {selectedLine === index && (
                    <div className="buttonRow" style={{ marginBottom: 0 }}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (editingLine === index) void saveLine(index);
                          else setEditingLine(index);
                        }}
                        className="ghostButton"
                      >
                        {editingLine === index ? "Enregistrer" : "Modifier"}
                      </button>
                      {Number(item.__proposedLowerPrice) > 0 && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            const unitPriceKey = columnName(daoColumns, UNIT_PRICE_KEYS);
                            updateLineValue(index, unitPriceKey, String(item.__proposedLowerPrice));
                            setEditingLine(index);
                            setMessage("Prix partagé appliqué. Cliquez sur Enregistrer pour confirmer votre choix.");
                          }}
                          className="ghostButton"
                        >
                          Appliquer le prix moins cher ({Number(item.__proposedLowerPrice).toLocaleString("fr-FR")} Ar)
                        </button>
                      )}
                      {(isInternalLaborLine(item) ||
                        isCompositeWork(item, columnName(daoColumns, ["Désignation", "Designation"])) ||
                        String(item.__manualCompositeJson ?? "").length > 2 ||
                        String(item.__manualPriceInputsJson ?? "").length > 2) && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openCompositePriceDetail(index);
                          }}
                          className="ghostButton"
                        >
                          Détail du prix
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void searchEquivalentsForLine(index);
                        }}
                        className="ghostButton"
                      >
                        Chercher les équivalents
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeLine(index);
                        }}
                        className="dangerButton"
                      >
                        Supprimer
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mb-6 space-y-5">
          {daoRecapTables.map((table) => (
            <div key={`${table.reference}|${table.title}`} className="overflow-x-auto rounded-xl border border-slate-400 bg-white p-4">
              <table className="w-full min-w-[620px] border-collapse text-sm text-black">
                <colgroup>
                  <col className="w-[10%]" />
                  <col className="w-[65%]" />
                  <col className="w-[25%]" />
                  {externalMarginPreview && <col className="w-[25%]" />}
                </colgroup>
                <caption className="border border-slate-700 border-b-0 bg-white px-4 py-3 text-center text-base font-extrabold uppercase">
                  {table.reference ? `${table.reference} — ` : ""}{table.title}
                </caption>
                <thead>
                  <tr className="bg-white text-center text-xs font-extrabold uppercase">
                    <th className="border border-slate-700 px-3 py-2">Ref</th>
                    <th className="border border-slate-700 px-3 py-2">Désignation</th>
                    <th className="border border-slate-700 px-3 py-2">Montant (Ar)</th>
                    {externalMarginPreview && <th className="border border-slate-700 px-3 py-2">Montant externe HT (Ar)</th>}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, index) => (
                    <tr key={`${row.designation}-${index}`}>
                      <td className="border border-slate-700 px-3 py-2 text-center font-bold">{row.reference}</td>
                      <td className="border border-slate-700 px-3 py-2 font-extrabold uppercase">{row.designation}</td>
                      <td className="border border-slate-700 px-3 py-2 text-right font-bold">{row.total.toLocaleString("fr-FR")} Ar</td>
                      {externalMarginPreview && <td className="border border-slate-700 px-3 py-2 text-right font-bold">{(row.total * externalMarginFactor).toLocaleString("fr-FR")} Ar</td>}
                    </tr>
                  ))}
                  <tr className="bg-slate-100 font-extrabold uppercase">
                    <td className="border border-slate-700 px-3 py-2" colSpan={2}>Total {table.title}</td>
                    <td className="border border-slate-700 px-3 py-2 text-right">{table.total.toLocaleString("fr-FR")} Ar</td>
                    {externalMarginPreview && <td className="border border-slate-700 px-3 py-2 text-right">{(table.total * externalMarginFactor).toLocaleString("fr-FR")} Ar</td>}
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <div className="overflow-x-auto rounded-xl border border-slate-700 bg-white p-4">
            <table className="w-full min-w-[620px] border-collapse text-sm text-black">
              <thead>
                <tr className="text-center text-xs font-extrabold uppercase">
                  <th className="border border-slate-700 px-4 py-2" colSpan={externalMarginPreview ? 3 : 2}>RÉCAPITULATION GÉNÉRALE DU BQDE</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-slate-200 font-extrabold uppercase">
                  <td className="border border-slate-700 px-4 py-3">Total général du BQDE (hors éléments internes)</td>
                  <td className="border border-slate-700 px-4 py-3 text-right">{financialSummary.externalBase.toLocaleString("fr-FR")} Ar</td>
                  {externalMarginPreview && <td className="border border-slate-700 px-4 py-3 text-right">{(financialSummary.externalBase * externalMarginFactor).toLocaleString("fr-FR")} Ar</td>}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-6 overflow-x-auto rounded-xl border border-slate-700 bg-white p-4">
          <table className="w-full min-w-[620px] border-collapse text-sm text-black">
            <thead>
              <tr className="text-center text-xs font-extrabold uppercase">
                <th className="border border-slate-700 px-4 py-2" colSpan={2}>TOTAUX DU DEVIS</th>
              </tr>
            </thead>
            <tbody>
              <tr className="font-extrabold uppercase">
                <td className="border border-slate-700 px-4 py-3">Total devis interne</td>
                <td className="border border-slate-700 px-4 py-3 text-right">{estimateTotal.toLocaleString("fr-FR")} Ar</td>
              </tr>
              {externalMarginPreview && <>
                <tr className="font-extrabold uppercase">
                  <td className="border border-slate-700 px-4 py-3">Total devis externe HT</td>
                  <td className="border border-slate-700 px-4 py-3 text-right">{(financialSummary.externalBase * externalMarginFactor).toLocaleString("fr-FR")} Ar</td>
                </tr>
                <tr className="bg-slate-200 font-extrabold uppercase">
                  <td className="border border-slate-700 px-4 py-3">Total à payer par le client (TTC)</td>
                  <td className="border border-slate-700 px-4 py-3 text-right">{financialSummary.clientTotal.toLocaleString("fr-FR")} Ar</td>
                </tr>
              </>}
            </tbody>
          </table>
        </section>
      </div>
      </>}

      {priceSearchStatus && (
        <aside
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            right: 20,
            bottom: 20,
            zIndex: 9999,
            width: "min(420px, calc(100vw - 40px))",
            maxHeight: "calc(100vh - 40px)",
            overflowY: "auto",
            overflowX: "hidden",
            padding: 16,
            border: `2px solid ${priceSearchStatus.error ? "#dc2626" : priceSearchStatus.running ? "#2563eb" : "#15803d"}`,
            borderRadius: 12,
            background: priceSearchStatus.error ? "#fef2f2" : priceSearchStatus.running ? "#eff6ff" : "#f0fdf4",
            color: priceSearchStatus.error ? "#7f1d1d" : priceSearchStatus.running ? "#172554" : "#14532d",
            boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <strong>
              {priceSearchStatus.running && <span aria-hidden="true">⏳ </span>}
              {priceSearchStatus.error
                ? "Recherche arrêtée"
                : priceSearchStatus.running
                  ? "Recherche des prix en cours"
                  : "✅ Recherche terminée"}
            </strong>
            {!priceSearchStatus.running && (
              <button
                type="button"
                onClick={() => {
                  setPriceSearchStatus(null);
                  setLastEquivalenceResult(null);
                  setEditingComposition(false);
                }}
                aria-label="Fermer l'indication de recherche"
                title="Fermer"
                style={{
                  width: 34,
                  height: 34,
                  flex: "0 0 34px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid #14532d",
                  borderRadius: "50%",
                  background: "#ffffff",
                  color: "#14532d",
                  fontSize: 25,
                  fontWeight: 800,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            )}
          </div>
          <p style={{ marginTop: 10 }}>
            Poste {priceSearchStatus.current} sur {priceSearchStatus.total}
          </p>
          <p style={{ marginTop: 6, fontSize: 14 }}>{priceSearchStatus.designation}</p>
          {priceSearchStatus.error && <p style={{ marginTop: 10, fontWeight: 700 }}>{priceSearchStatus.error}</p>}
          {!priceSearchStatus.running && !priceSearchStatus.error && lastEquivalenceResult && (
            <div style={{ marginTop: 12, borderTop: "1px solid currentColor", paddingTop: 10 }}>
              <p style={{ margin: 0 }}>
                <strong>Poste recherche :</strong> {lastEquivalenceResult.designation}
              </p>
              {lastEquivalenceResult.interpretedDesignation && (
                <p style={{ marginTop: 8 }}>
                  <strong>Interpretation :</strong> {lastEquivalenceResult.interpretedDesignation}
                </p>
              )}
              {lastEquivalenceResult.selectedPrice !== null && (
                <p style={{ marginTop: 8 }}>
                  <strong>Prix trouve :</strong>{" "}
                  {lastEquivalenceResult.selectedPrice.toLocaleString("fr-FR")} Ar
                </p>
              )}
              {lastEquivalenceResult.recommended && (
                <p style={{ marginTop: 8 }}>
                  <strong>Equivalent recommande :</strong> {lastEquivalenceResult.recommended}
                </p>
              )}
              {lastEquivalenceResult.options.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <strong>Choix proposes :</strong>
                  <ul style={{ marginTop: 4, maxHeight: 130, overflowY: "auto", paddingLeft: 20 }}>
                    {lastEquivalenceResult.options.map((option) => <li key={option}>{option}</li>)}
                  </ul>
                </div>
              )}
              {lastEquivalenceResult.note && (
                <p style={{ marginTop: 8 }}>
                  <strong>Explication :</strong> {lastEquivalenceResult.note}
                </p>
              )}
              {lastEquivalenceResult.manualPriceInputs.length > 0 && (
                <div style={{ marginTop: 12, borderTop: "1px solid currentColor", paddingTop: 10 }}>
                  <strong>Détail des matériaux composant ce prix</strong>
                  <p style={{ marginTop: 4, fontSize: 13 }}>
                    Ces montants sont les coûts réels des matériaux, sans marge. Le prix affiché dans le devis externe reçoit ensuite la marge globale choisie, sans modifier ce détail.
                  </p>
                  <div style={{ marginTop: 8, maxHeight: 340, overflowY: "auto", overflowX: "hidden" }}>
                    {lastEquivalenceResult.manualPriceInputs.map((item, index) => (
                      <div
                        key={`${item.designation}-${index}`}
                        style={{ marginBottom: 10, padding: 9, border: "1px solid #86a88e", borderRadius: 7, background: "#ffffff" }}
                      >
                        <strong style={{ display: "block", color: "#14532d", overflowWrap: "anywhere" }}>
                          {item.designation}
                        </strong>
                        <label style={{ display: "block", marginTop: 6, fontWeight: 700 }}>
                          Quantité nécessaire pour une unité DAO ({item.unit})
                          <input
                            type="text"
                            inputMode="decimal"
                            value={manualComponentQuantities[index] ?? ""}
                            onChange={(event) => {
                              const value = event.target.value.replace(/[^0-9.,]/g, "").replace(",", ".");
                              setManualComponentQuantities((current) => ({ ...current, [index]: value }));
                            }}
                            placeholder={`Quantité en ${item.unit}`}
                            style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: 9, color: "#111827", background: "white", border: "1px solid #166534", borderRadius: 5 }}
                          />
                        </label>
                        {item.note && <small style={{ display: "block", marginTop: 3, opacity: 0.8 }}>{item.note}</small>}
                        {item.alternativeGroup && <small style={{ display: "block", marginTop: 4, color: "#166534", fontWeight: 700 }}>Choix « ou » : l&apos;option la moins chère sera retenue.</small>}
                        {item.foundUnitPrice !== null && (
                          <small style={{ display: "block", marginTop: 4, color: "#166534", fontWeight: 700 }}>
                            Prix prérempli depuis {item.supplierName || "l'historique interne"}
                          </small>
                        )}
                        <label style={{ display: "block", marginTop: 6, fontWeight: 700 }}>
                          Coût réel pour 1 {item.unit} (Ar)
                          <input
                            type="text"
                            inputMode="decimal"
                            value={manualComponentPrices[index] ?? ""}
                            onChange={(event) => {
                              const value = event.target.value.replace(/[^0-9.,]/g, "").replace(",", ".");
                              setManualComponentPrices((current) => ({ ...current, [index]: value }));
                            }}
                            placeholder={`Exemple : 25000 Ar/${item.unit}`}
                            aria-label={`Prix local de ${item.designation} par ${item.unit}`}
                            style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: 9, color: "#111827", background: "white", border: "2px solid #166534", borderRadius: 5 }}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={applyManualComponentCalculation}
                    disabled={applyingManualCalculation}
                    style={{ marginTop: 10, padding: "7px 10px", border: "1px solid #166534", borderRadius: 5, fontWeight: 700, cursor: applyingManualCalculation ? "wait" : "pointer", opacity: applyingManualCalculation ? 0.7 : 1 }}
                  >
                    {applyingManualCalculation ? "Calcul et enregistrement en cours…" : "Calculer et appliquer au devis"}
                  </button>
                </div>
              )}
              {lastEquivalenceResult.requiresValidation && (
                <p style={{ marginTop: 8, color: "#b91c1c", fontWeight: 700 }}>
                  Validation technique necessaire avant utilisation de cet equivalent.
                </p>
              )}
              {!lastEquivalenceResult.found &&
                !lastEquivalenceResult.recommended &&
                lastEquivalenceResult.options.length === 0 && (
                  <p style={{ marginTop: 8, fontWeight: 700 }}>
                    Aucun equivalent fiable ni prix exploitable n&apos;a ete trouve pour ce poste.
                  </p>
                )}
            </div>
          )}
          {missingPriceItems.length > 0 && (
            <div style={{ marginTop: 12, borderTop: "1px solid currentColor", paddingTop: 10 }}>
              <strong>Prix à ajouter manuellement ({missingPriceItems.length})</strong>
              <ul style={{ marginTop: 6, maxHeight: 150, overflowY: "auto", paddingLeft: 20 }}>
                {missingPriceItems.map((designation) => <li key={designation}>{designation}</li>)}
              </ul>
            </div>
          )}
          {priceSearchStatus.running && (
            priceSearchStatus.current === 0 ? (
              <div
                className="appProgress isIndeterminate"
                role="progressbar"
                aria-label="Préparation du devis en cours"
                aria-valuetext="Préparation en cours"
              >
                <span />
              </div>
            ) : priceSearchStatus.total > 0 ? (
              <div
                className="appProgress"
                role="progressbar"
                aria-label="Recherche des prix en cours"
                aria-valuemin={0}
                aria-valuemax={priceSearchStatus.total}
                aria-valuenow={priceSearchStatus.current}
                aria-valuetext={`${priceSearchStatus.current} sur ${priceSearchStatus.total}`}
              >
                <span style={{ width: `${(priceSearchStatus.current / priceSearchStatus.total) * 100}%` }} />
              </div>
            ) : null
          )}
        </aside>
      )}
    </div>
  );
}
