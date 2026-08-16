"use client";

import { useEffect, useMemo, useState } from "react";
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
  total_amount?: number | string | null;
  created_at?: string;
};

type TenderWorkItem = {
  row_type?: "section" | "item" | "subtotal";
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

function sectionSubtotal(lines: EstimateLineData[], subtotalIndex: number) {
  let total = 0;
  for (let index = subtotalIndex - 1; index >= 0; index -= 1) {
    const rowType = daoRowType(lines[index]);
    if (rowType === "section") break;
    if (rowType === "item") total += lineTotal(lines[index]);
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

function standardInternalRecommendations(
  items: TenderWorkItem[],
  daoExecutionDays: number,
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
  const plannedDays = daoExecutionDays > 0 ? Math.ceil(daoExecutionDays * 2 / 3) : 0;

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
  if (items.some((item) => item.row_type === "section" || item.row_type === "subtotal")) {
    return items;
  }

  const structured: TenderWorkItem[] = [];
  let currentCategory = "";
  for (const item of items) {
    const category = String(item.category ?? item.categorie ?? "AUTRES OUVRAGES").trim();
    if (category !== currentCategory) {
      if (currentCategory) {
        structured.push({
          row_type: "subtotal",
          section_title: currentCategory,
          designation: `SOUS-TOTAL ${currentCategory}`,
        });
      }
      currentCategory = category;
      structured.push({
        row_type: "section",
        section_title: currentCategory,
        designation: currentCategory,
      });
    }
    structured.push({ ...item, row_type: "item", section_title: currentCategory });
  }
  if (currentCategory) {
    structured.push({
      row_type: "subtotal",
      section_title: currentCategory,
      designation: `SOUS-TOTAL ${currentCategory}`,
    });
  }
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

function isCompositeWork(line: EstimateLineData, designationKey: string) {
  const value = normalizedLabel(String(line[designationKey] ?? ""));
  return [
    "beton", "coffrage", "maconnerie", "brique", "parpaing", "moellon",
    "dallage", "chape", "enduit", "crepi", "jointoiement", "badigeon",
    "peinture", "herissonnage", "mortier", "charpente", "couverture",
    "assainissement", "canalisation", "puisard", "citerne",
  ].some((keyword) => value.includes(keyword));
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
  const [workerAideCount, setWorkerAideCount] = useState(6);
  const [masonCount, setMasonCount] = useState(4);
  const [siteManagerCount, setSiteManagerCount] = useState(1);
  const [worksManagerCount, setWorksManagerCount] = useState(1);
  const [engineerCount, setEngineerCount] = useState(1);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [estimateId, setEstimateId] = useState<string | null>(null);
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
    }>;
  } | null>(null);
  const [manualComponentPrices, setManualComponentPrices] = useState<Record<number, string>>({});
  const [manualComponentQuantities, setManualComponentQuantities] = useState<Record<number, string>>({});
  const [editingComposition, setEditingComposition] = useState(false);
  const [applyingManualCalculation, setApplyingManualCalculation] = useState(false);

  useEffect(() => {
    const waiting = creating || applyingManualCalculation || priceSearchStatus?.running === true;
    if (!waiting) return;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previousCursor; };
  }, [creating, applyingManualCalculation, priceSearchStatus?.running]);

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

      const availableTemplates = (await getDaoTemplate()) as DaoTemplate[] | null;
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
          setDaoExecutionDays(detectedExecutionDays);
          const rawWorkItems = isVisualStructuredAnalysis
            ? analysis?.work_items ?? analysis?.lots ?? []
            : [];
          const workItems = structureDaoWorkItems(rawWorkItems);
          const existingNames = new Set(
            workItems
              .filter((item) => (item.row_type ?? "item") === "item")
              .map((item) => normalizedLabel(item.designation ?? "")),
          );
          const internalRecommendations = [
            ...(analysis?.internal_cost_recommendations ?? []),
            ...standardInternalRecommendations(
              workItems,
              detectedExecutionDays,
              workerAideCount,
              masonCount,
              siteManagerCount,
              worksManagerCount,
              engineerCount,
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
              if (rowType === "item") itemPosition += 1;
              return {
              [positionKey]: rowType === "item" ? itemPosition : "",
              [designationKey]: item.designation ?? "",
              [unitKey]: item.unit ?? item.unite ?? "",
              [quantityKey]: item.quantity ?? item.quantite ?? "",
              [unitPriceKey]: "",
              [totalKey]: 0,
              __daoSourceReference: item.source_reference ?? "",
              __daoNeedsReview: item.needs_review ?? item.quantity == null,
              __daoNote: item.note ?? "",
              __pricingContext: item.pricing_context ?? "",
              __daoCategory: item.category ?? item.categorie ?? "",
              __daoRowType: rowType,
              __daoSectionTitle: item.section_title ?? "",
              __internalOnly: item.internal_only ?? false,
              __recommendationKind: item.recommendation_kind ?? "",
              __aiOptionsJson: JSON.stringify(item.options ?? []),
              __aiDefaultOption: item.default_option ?? "",
              __aiReason: item.reason ?? "",
              __aiSourceBasis: item.source_basis ?? "",
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
    if (estimateId || daoColumns.length === 0) return;
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    const unitKey = daoColumnName(daoColumns, ["Unité", "Unite"]);
    const quantityKey = daoColumnName(daoColumns, ["Quantité", "Quantite"]);
    const plannedDays = daoExecutionDays > 0 ? Math.ceil(daoExecutionDays * 2 / 3) : 0;

    setEstimateLines((current) => current.map((line) => {
      if (line.__internalOnly !== true || daoRowType(line) !== "item") return line;
      const designation = normalizedLabel(String(line[designationKey] ?? ""));
      if (designation.includes("ouvriersetaides")) {
        return {
          ...line,
          [unitKey]: "JOUR-PERSONNE",
          [quantityKey]: plannedDays > 0 ? plannedDays * workerAideCount : "",
          __disabledInternal: workerAideCount === 0,
          __aiSourceBasis: `${workerAideCount} ouvriers/aides × ${plannedDays || "durée à confirmer"} jours, nourriture comprise.`,
        };
      }
      if (designation.includes("maconsqualifies")) {
        return {
          ...line,
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
        [unitKey]: "JOUR-PERSONNE",
        [quantityKey]: plannedDays > 0 ? plannedDays * roleCount : "",
        __disabledInternal: roleCount === 0,
        __aiSourceBasis: `${roleCount} personne(s) × ${plannedDays || "durée à confirmer"} jours, nourriture comprise.`,
      };
      return line;
    }));
  }, [
    daoExecutionDays, workerAideCount, masonCount, siteManagerCount,
    worksManagerCount, engineerCount, daoColumns, estimateId,
  ]);

  const estimateTotal = useMemo(
    () => estimateLines.reduce((sum, line) => sum + lineTotal(line), 0),
    [estimateLines],
  );

  const daoCategoryChoices = useMemo(() => {
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    return estimateLines
      .filter((line) => daoRowType(line) === "section" && line.__internalOnly !== true)
      .map((line) => String(line.__daoSectionTitle ?? line[designationKey] ?? "").trim())
      .filter((value, index, values) => value && values.indexOf(value) === index);
  }, [estimateLines, daoColumns]);

  async function openEstimate(estimate: EstimateSummary, availableTemplates = templates) {
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
    const loadedLines: EstimateLineData[] = (lines ?? []).map((line) => ({
        ...(line.data as EstimateLineData),
        [LINE_ID_KEY]: line.id,
      })).sort((left, right) =>
        Number((left as EstimateLineData).__sortOrder ?? numberFrom(left, POSITION_KEYS)) -
        Number((right as EstimateLineData).__sortOrder ?? numberFrom(right, POSITION_KEYS)));
    setEstimateLines(loadedLines);
    const storedContext = loadedLines.find((line) => line.__worksiteLocation || line.__worksiteName);
    setWorksiteLocation(String(storedContext?.__worksiteLocation ?? ""));
    setSourceTenderTitle(String(storedContext?.__worksiteName ?? ""));
    setMessage("Devis rouvert. Les lignes restent liées au DAO d'origine.");
  }

  async function persistEstimateTotal(lines: EstimateLineData[]) {
    if (!estimateId) return;
    const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
    const supabase = createClient();
    const { error } = await supabase
      .from("estimates")
      .update({ total_amount: total })
      .eq("id", estimateId);

    if (error) setMessage(`Total non enregistré : ${error.message}`);
    setHistory((current) =>
      current.map((item) => (item.id === estimateId ? { ...item, total_amount: total } : item)),
    );
  }

  async function searchInternetPrices(newEstimateId: string, lines: EstimateLineData[]) {
    const designationKey = daoColumnName(daoColumns, ["Désignation", "Designation"]);
    const unitKey = daoColumnName(daoColumns, ["Unité", "Unite"]);
    const quantityKey = daoColumnName(daoColumns, ["Quantité", "Quantite"]);
    const unitPriceKey = daoColumnName(daoColumns, ["Prix unitaire"]);
    const totalKey = daoColumnName(daoColumns, ["Total"]);
    const supabase = createClient();
    const updatedLines = [...lines];
    const searchableTotal = updatedLines.filter((line) => daoRowType(line) === "item").length;
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
      if (daoRowType(line) !== "item") continue;
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
            }>;
          };
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
              __manualPriceInputsJson: JSON.stringify(result.manual_price_inputs ?? []),
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
              __estimatedUnitWeightT: Number.isFinite(unitWeightT) ? unitWeightT : undefined,
              __supplierDistanceKm: Number.isFinite(distanceKm) ? distanceKm : undefined,
              __weightBasis: result.weight_basis ?? "",
              __interpretedDesignation: result.interpreted_designation ?? "",
              __equivalentOptionsJson: JSON.stringify(result.equivalent_options ?? []),
              __recommendedEquivalent: result.recommended_equivalent ?? "",
              __equivalenceNote: result.equivalence_note ?? "",
              __equivalenceRequiresValidation: result.requires_technical_validation ?? false,
              __manualPriceInputsJson: JSON.stringify(result.manual_price_inputs ?? []),
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
      if (lineId) {
        await supabase.from("estimate_lines").update({ data: linePayload(nextLine) }).eq("id", lineId);
      }
      setEstimateLines([...updatedLines]);
    }

    const total = updatedLines.reduce((sum, line) => sum + lineTotal(line), 0);
    await supabase.from("estimates").update({ total_amount: total }).eq("id", newEstimateId);
    setHistory((current) =>
      current.map((item) => (item.id === newEstimateId ? { ...item, total_amount: total } : item)),
    );
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
        }>;
      };
      if (!response.ok) throw new Error(result.error || "Recherche ciblée impossible.");
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
        __manualPriceInputsJson: JSON.stringify(result.manual_price_inputs ?? []),
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
          __manualPriceInputsJson: JSON.stringify(result.manual_price_inputs ?? []),
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
        manualPriceInputs: (result.manual_price_inputs ?? []).map((item) => ({
          designation: item.designation,
          unit: item.unit,
          quantityPerWorkUnit: Number(item.quantity_per_work_unit) || 0,
          note: item.note,
          foundUnitPrice: Number(item.found_unit_price) > 0 ? Number(item.found_unit_price) : null,
          sourceUrl: item.source_url,
          supplierName: item.supplier_name,
        })),
      });
      setManualComponentPrices(Object.fromEntries(
        (result.manual_price_inputs ?? [])
          .map((item, itemIndex) => [itemIndex, Number(item.found_unit_price) > 0 ? String(item.found_unit_price) : ""]),
      ));
      setManualComponentQuantities(Object.fromEntries(
        (result.manual_price_inputs ?? [])
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
    const missingInput = lastEquivalenceResult.manualPriceInputs.find((_, index) =>
      manualComponentPrices[index] === undefined || manualComponentPrices[index].trim() === "",
    );
    if (missingInput) {
      setMessage(`Indiquez le prix local de « ${missingInput.designation} » avant le calcul.`);
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
    }));
    const compositeUnitPrice = componentDetails.reduce(
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
    }> = [];
    try {
      const parsed = JSON.parse(String(line.__manualCompositeJson ?? line.__manualPriceInputsJson ?? "[]"));
      if (Array.isArray(parsed)) components = parsed.map((item) => ({
        designation: String(item.designation ?? "Composant"),
        unit: String(item.unit ?? "U"),
        quantity_per_work_unit: Number(item.quantity_per_work_unit) || 0,
        local_unit_price: Number(item.local_unit_price ?? item.found_unit_price) || 0,
        note: String(item.note ?? ""),
      }));
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
      })),
    });
    setEditingComposition(true);
    setApplyingManualCalculation(false);
    setPriceSearchStatus({ running: false, current: 1, total: 1, designation: "Détail du prix composé", error: "" });
  }

  async function createEstimate() {
    if (!template || creating || estimateId) return;
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

    setPriceSearchStatus({
      running: true,
      current: 0,
      total: activeEstimateLines.filter((line) => daoRowType(line) === "item").length,
      designation: "Enregistrement des postes et préparation de la recherche des prix…",
      error: "",
    });

    const { data, error } = await supabase
      .from("estimates")
      .insert({
        organization_id: member.organization_id,
        dao_template_id: template.id,
        status: "brouillon",
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

    let savedEstimateLines = activeEstimateLines;
    if (activeEstimateLines.length > 0) {
      const { data: savedLines, error: linesError } = await supabase
        .from("estimate_lines")
        .insert(
          activeEstimateLines.map((line) => ({
            estimate_id: data.id,
            data: {
              ...linePayload(line),
              __worksiteLocation: worksiteLocation.trim(),
              __worksiteName: sourceTenderTitle,
            },
          })),
        )
        .select("id");

      if (linesError) {
        setMessage(`Devis créé, mais lignes non enregistrées : ${linesError.message}`);
        setPriceSearchStatus({
          running: false,
          current: 0,
          total: activeEstimateLines.length,
          designation: "L'enregistrement des postes s'est arrêté.",
          error: linesError.message,
        });
        setEstimateId(data.id);
        setCreating(false);
        return;
      }

      savedEstimateLines = activeEstimateLines.map((line, index) => ({
        ...line,
        [LINE_ID_KEY]: savedLines?.[index]?.id,
      }));
      setEstimateLines(savedEstimateLines);
    }

    setEstimateId(data.id);
    setHistory((current) => [
      {
        id: data.id,
        dao_template_id: template.id,
        status: "brouillon",
        total_amount: 0,
        created_at: new Date().toISOString(),
      },
      ...current,
    ]);

    if (sourceTenderId && savedEstimateLines.length > 0) {
      const priceResult = await searchInternetPrices(data.id, savedEstimateLines);
      setEstimateLines(priceResult.updatedLines);
      const notices = ["Devis créé avec les postes et les prix disponibles."];
      if (priceResult.searchError) notices.push(priceResult.searchError);
      if (priceResult.manualRequired > 0) {
        notices.push(`${priceResult.manualRequired} prix introuvable(s) : ajout manuel nécessaire.`);
      }
      if (priceResult.lowerOffersPending > 0) {
        notices.push(`${priceResult.lowerOffersPending} prix moins cher(s) à valider avant remplacement.`);
      }
      setMessage(notices.join(" "));
    } else {
      setMessage("Devis brouillon créé avec les postes du DAO.");
      setPriceSearchStatus(null);
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
      {showHistory ? <section className="rounded border p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">Historique des devis</h2>
            <p className="text-sm text-gray-600">Devis de votre organisation, liés à leur modèle DAO.</p>
          </div>
          <button type="button" onClick={startNewEstimate} className="rounded border px-4 py-2">
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
                      {Number(estimate.total_amount ?? 0).toLocaleString("fr-FR")} Ar
                    </td>
                    <td className="border p-2 text-center">
                      <button
                        type="button"
                        onClick={() => router.push(`/estimates/${estimate.id}`)}
                        className="text-blue-700 underline"
                      >
                        Ouvrir
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteEstimate(estimate)}
                        className="ml-4 text-red-700 underline"
                      >
                        Supprimer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section> : (
        <button type="button" onClick={() => router.push("/estimates")} className="text-blue-700 underline">
          ← Retour à l'historique des devis
        </button>
      )}

      {message && !priceSearchStatus && <p role="status" className="rounded border p-3">{message}</p>}

      {!showHistory && <>
      {(sourceTenderId || estimateId) && (
        <section className="rounded border p-4">
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginTop: 16 }}>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Délai d'exécution du DAO (jours)</span>
              <input type="number" min="1" value={daoExecutionDays || ""}
                onChange={(event) => setDaoExecutionDays(Math.max(0, Number(event.target.value) || 0))}
                placeholder="Exemple : 90" style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6 }} />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 700 }}>Durée interne prévue (2/3)</span>
              <input readOnly value={daoExecutionDays > 0 ? `${Math.ceil(daoExecutionDays * 2 / 3)} jours` : "À calculer"}
                style={{ width: "100%", padding: 9, border: "1px solid #9ca3af", borderRadius: 6, background: "#f3f4f6" }} />
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
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold">Lignes du devis</h2>
        <button
          type="button"
          onClick={createEstimate}
          disabled={!template || creating || Boolean(estimateId)}
          className="rounded bg-blue-700 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {estimateId ? "Devis créé" : creating ? "Création…" : "Créer le devis"}
        </button>
      </div>

      {estimateId && (
        <section style={{ padding: 14, border: "1px solid #86a892", borderRadius: 8, background: "#f0fdf4" }}>
          <h3 style={{ margin: "0 0 5px", fontWeight: 800 }}>PDF officiel de soumission</h3>
          <p style={{ margin: "0 0 10px", fontSize: 13 }}>
            Ce document reprend uniquement le DAO, ses catégories, ses postes, ses sous-totaux et les informations de société prévues pour la soumission. Les éléments internes et les annotations IA sont exclus.
          </p>
          <OfficialPdfButton estimateId={estimateId} />
        </section>
      )}

      <div className="space-y-2">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
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

        <button type="button" onClick={addLine} className="rounded bg-green-800 px-4 py-2 text-white">
          + Ajouter une ligne
        </button>
      </div>

      <div className="mt-6">
        <h3 className="text-lg font-bold">Détail du devis</h3>
        <table className="mb-8 mt-3 w-full border">
          <thead>
            <tr>
              {daoColumns.map((column) => (
                <th key={column.order} className="border p-2">{column.name}</th>
              ))}
              <th className="border p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {estimateLines.length === 0 && (
              <tr>
                <td colSpan={daoColumns.length + 1} className="border p-4 text-center text-gray-600">
                  Aucune ligne enregistrée pour ce devis.
                </td>
              </tr>
            )}
            {estimateLines.map((item, index) =>
              item.__disabledInternal === true ? null : daoRowType(item) === "section" ? (
                <tr key={index}>
                  <td
                    colSpan={daoColumns.length + 1}
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
                  </td>
                ))}
                <td className="border p-2">
                  {selectedLine === index && (
                    <>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (editingLine === index) void saveLine(index);
                          else setEditingLine(index);
                        }}
                        className="mr-3 text-blue-600"
                      >
                        {editingLine === index ? "Enregistrer" : "Modifier"}
                      </button>
                      {(isCompositeWork(item, columnName(daoColumns, ["Désignation", "Designation"])) ||
                        String(item.__manualCompositeJson ?? "").length > 2 ||
                        String(item.__manualPriceInputsJson ?? "").length > 2) && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openCompositePriceDetail(index);
                          }}
                          className="mr-3 text-emerald-700"
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
                        className="mr-3 text-violet-700"
                      >
                        Chercher les équivalents
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeLine(index);
                        }}
                        className="text-red-600"
                      >
                        Supprimer
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-12 block border-t pt-6 text-right font-bold">
          <span>TOTAL DEVIS :</span>
          <span className="ml-2">{estimateTotal.toLocaleString("fr-FR")} Ar</span>
        </div>
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
                  : "Recherche terminée"}
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
                style={{ border: 0, background: "transparent", fontSize: 22, cursor: "pointer" }}
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
                  <strong>Prix locaux nécessaires au calcul</strong>
                  <p style={{ marginTop: 4, fontSize: 13 }}>
                    Remplissez uniquement le prix d'achat d'une unité de chaque matériau. Le calcul utilise les quantités proposées pour une unité du poste DAO.
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
                        {item.foundUnitPrice !== null && (
                          <small style={{ display: "block", marginTop: 4, color: "#166534", fontWeight: 700 }}>
                            Prix prérempli depuis {item.supplierName || "l'historique interne"}
                          </small>
                        )}
                        <label style={{ display: "block", marginTop: 6, fontWeight: 700 }}>
                          Prix local pour 1 {item.unit} (Ar)
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
                    Aucun equivalent fiable ni prix exploitable n'a ete trouve pour ce poste.
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
              <progress
                aria-label="Préparation du devis en cours"
                style={{ width: "100%", height: 18, marginTop: 12 }}
              />
            ) : priceSearchStatus.total > 0 ? (
              <div style={{ marginTop: 12, height: 10, overflow: "hidden", borderRadius: 999, background: "#dbeafe" }}>
                <div
                  style={{
                    width: `${(priceSearchStatus.current / priceSearchStatus.total) * 100}%`,
                    height: "100%",
                    background: "#1d4ed8",
                    transition: "width 250ms ease",
                  }}
                />
              </div>
            ) : null
          )}
        </aside>
      )}
    </div>
  );
}
