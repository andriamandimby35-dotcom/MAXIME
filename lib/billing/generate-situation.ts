import type { SupabaseClient } from "@supabase/supabase-js";
import { computePricing, roundAr } from "@/lib/billing/pricing";
import { loadProjectFinance } from "@/lib/billing/project-finance";
import { matchTaskForItem, type PlanningTask } from "@/lib/billing/task-matching";
import { loadExpenseAllocation } from "@/lib/expenses/allocation";

// Calcul du "brouillon" d'une facture (situation de travaux), à partir :
// - du devis externe du chantier (les lignes réellement vendues au client),
//   facturées selon l'avancement de leur tâche de planning correspondante ;
// - des dépenses réellement payées sur le chantier (transport, main d'œuvre,
//   autre), qui ne sont pas des lignes du devis mais doivent quand même être
//   refacturées au client, majorées de la marge du chantier.
// Rien n'est enregistré ici : cette fonction ne fait que lire et calculer,
// pour que l'administrateur puisse relire/ajuster avant de valider (voir
// POST /api/billing/claims, qui lui enregistre pour de vrai).

export type SituationDraftLine = {
  kind: "devis" | "depense";
  position: number;
  designation: string;
  unit: string;
  contractQuantity: number | null;
  unitPrice: number | null;
  previousQuantity: number;
  currentQuantity: number;
  previousAmount: number;
  currentAmount: number;
  amountThisTime: number;
  matchedTaskTitle?: string | null;
  needsReview?: boolean;
  /** Titre de catégorie / sous-catégorie du devis (repris sur la facture). */
  category?: string;
  subcategory?: string;
  /** Ligne du bordereau (devis) d'où vient cette ligne, pour la relier à une tâche. */
  priceItemId?: string;
};

export type SituationDraft = {
  projectId: string;
  projectName: string;
  clientName: string;
  claimNumber: string;
  previousClaimNumber: string | null;
  marginPercent: number;
  lines: SituationDraftLine[];
  grossAmount: number;
  retentionRate: number;
  retentionAmount: number;
  advanceRepayment: number;
  otherDeductions: number;
  taxRate: number;
  taxAmount: number;
  netAmount: number;
  expensesWarning: string | null;
  unmatchedCount: number;
  /** Tâches du planning (pour relier à la main les lignes non reconnues). */
  tasks: Array<{ id: string; title: string; progress: number }>;
};

export type SituationDraftResult =
  | SituationDraft
  | { error: string }
  | { needsMarginInput: true; projectId: string; projectName: string }
  | { needsClientInput: true; projectId: string; projectName: string };

function normalizeDesignation(value: string) {
  return String(value ?? "").trim().toLocaleLowerCase("fr-FR");
}

export async function computeSituationDraft(
  supabase: SupabaseClient,
  params: { organizationId: string; projectId: string; marginOverride?: number; clientNameOverride?: string },
): Promise<SituationDraftResult> {
  const { organizationId, projectId, marginOverride, clientNameOverride } = params;

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,name,project_code,source_estimate_id,source_tender_id,manual_margin_percent,manual_client_name,next_claim_seq")
    .eq("id", projectId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (projectError) return { error: projectError.message };
  if (!project) return { error: "Chantier introuvable dans votre organisation." };

  // Le nom du client vient du DAO (tender) quand ce chantier en a un ; sinon
  // (chantier créé à la main), on le demande une fois à l'utilisateur, puis
  // on le retient sur le chantier pour ne plus le redemander — même logique
  // que la marge ci-dessous.
  let clientName = "";
  if (project.source_tender_id) {
    const { data: tender } = await supabase.from("tenders").select("client_name").eq("id", project.source_tender_id).maybeSingle();
    clientName = tender?.client_name || "";
  }
  if (!clientName && project.manual_client_name) clientName = project.manual_client_name;
  if (!clientName) {
    if (clientNameOverride && clientNameOverride.trim()) clientName = clientNameOverride.trim();
    else return { needsClientInput: true, projectId, projectName: project.name };
  }

  // La marge à appliquer vient du devis d'origine ; à défaut (chantier créé
  // à la main, sans devis), on demande à l'utilisateur de la préciser une
  // fois, puis on la retient sur le chantier pour ne plus la redemander.
  const finance = await loadProjectFinance(supabase, organizationId, projectId);
  let marginPercent: number;
  if (project.source_estimate_id) {
    const { data: estimate } = await supabase
      .from("estimates")
      .select("profit_margin_percent")
      .eq("id", project.source_estimate_id)
      .maybeSingle();
    marginPercent = Number(estimate?.profit_margin_percent) || 0;
  } else if (finance.settings.marginPercent !== null && finance.settings.marginPercent !== undefined) {
    // Marge attendue donnée à la création du chantier.
    marginPercent = Number(finance.settings.marginPercent) || 0;
  } else if (finance.settings.contractAmount || finance.settings.marginAmount) {
    // Prix ou bénéfice attendu donné sans pourcentage : la marge appliquée
    // est celle qui résulte des dépenses réelles (elle bouge avec elles).
    marginPercent = Math.max(0, finance.pricing.marginPercent ?? 0);
  } else if (project.manual_margin_percent !== null && project.manual_margin_percent !== undefined) {
    marginPercent = Number(project.manual_margin_percent) || 0;
  } else if (marginOverride !== undefined && Number.isFinite(marginOverride)) {
    marginPercent = marginOverride;
  } else {
    return { needsMarginInput: true, projectId, projectName: project.name };
  }

  // Les titres de catégorie / sous-catégorie sont dans deux colonnes ajoutées
  // par un fichier SQL : tant qu'il n'a pas été exécuté, on relit sans elles
  // (la facture reste alors "à plat", sans titres).
  type PriceItemRow = { id?: string; task_id?: string | null; designation: string; unit: string | null; quantity: number | string | null; unit_price: number | string | null; external_unit_price: number | string | null; is_internal: boolean | null; created_at: string; category?: string | null; subcategory?: string | null };
  let priceItems: PriceItemRow[] | null = null;
  {
    // Colonnes ajoutées par des fichiers SQL (task_id, titres) : tant qu'ils ne
    // sont pas exécutés, on relit sans elles (facture « à plat », rapprochement
    // par le texte seulement).
    const base = "id,designation,unit,quantity,unit_price,external_unit_price,is_internal,created_at";
    const attempts = [`${base},category,subcategory,task_id`, `${base},category,subcategory`, `${base}`];
    let lastError = "";
    for (const columns of attempts) {
      const result = await supabase
        .from("project_price_items")
        .select(columns)
        .eq("project_id", projectId)
        .eq("is_internal", false)
        .order("created_at", { ascending: true });
      if (!result.error) { priceItems = result.data as unknown as PriceItemRow[]; break; }
      lastError = result.error.message;
    }
    if (!priceItems) return { error: lastError };
  }

  // Chantier sans devis chiffré : la facture est bâtie à partir des dépenses
  // réellement payées (catégories et sous-catégories), chacune multipliée par
  // le même coefficient pour arriver au prix client (voir pricing.ts).
  const noDevis = !priceItems || priceItems.length === 0;
  const items = priceItems ?? [];
  if (noDevis && finance.realCost <= 0) {
    return { error: "Ce chantier n'a ni devis chiffré ni dépense payée : rien à facturer pour l'instant." };
  }

  const { data: tasksData } = await supabase
    .from("project_tasks")
    .select("id,title,progress_percent")
    .eq("project_id", projectId);
  const tasks = (tasksData ?? []) as unknown as PlanningTask[];
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  // Situation précédente (la plus récente, hors refusée) : sert à retrouver
  // ce qui a déjà été facturé, poste par poste, pour ne jamais facturer deux
  // fois le même avancement. Le rapprochement se fait par désignation, faute
  // d'un lien direct entre les lignes d'une situation et celles du devis.
  const { data: previousClaims } = await supabase
    .from("progress_claims")
    .select("id,claim_number,issue_date,created_at")
    .eq("project_id", projectId)
    .eq("organization_id", organizationId)
    .neq("status", "rejected")
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  const previousClaim = previousClaims?.[0] ?? null;

  const previousQuantityByDesignation = new Map<string, number>();
  if (previousClaim) {
    const { data: previousItems } = await supabase
      .from("progress_claim_items")
      .select("designation,current_quantity")
      .eq("progress_claim_id", previousClaim.id);
    for (const item of previousItems ?? []) {
      previousQuantityByDesignation.set(normalizeDesignation(item.designation), Number(item.current_quantity) || 0);
    }
  }

  let unmatchedCount = 0;
  const devisLines: SituationDraftLine[] = items.map((item, index) => {
    const contractQuantity = Number(item.quantity) || 0;
    const baseUnitPrice = Number(item.unit_price) || 0;
    const storedExternalPrice = Number(item.external_unit_price);
    const unitPrice = Number.isFinite(storedExternalPrice) && storedExternalPrice > 0
      ? storedExternalPrice
      : Math.round(baseUnitPrice * (1 + marginPercent / 100) * 100) / 100;
    const previousQuantity = previousQuantityByDesignation.get(normalizeDesignation(item.designation)) || 0;
    // Lien enregistré sur la ligne (corrigé à la main ou trouvé à l'import) ;
    // sinon rapprochement par le texte : titre de la ligne, puis sa
    // sous-catégorie, puis sa catégorie.
    const linked = item.task_id ? taskById.get(item.task_id) : undefined;
    const match = linked
      ? { id: linked.id, title: linked.title, progress: Math.max(0, Math.min(100, Number(linked.progress_percent) || 0)), score: 1 }
      : matchTaskForItem({ designation: item.designation, subcategory: item.subcategory, category: item.category }, tasks);
    const needsReview = !match;
    if (needsReview) unmatchedCount += 1;
    // Une ligne non reconnue reste à son avancement déjà facturé (0 % de
    // plus cette fois) : on ne facture jamais un travail juste "prévu".
    const targetQuantity = match ? Math.round(contractQuantity * (match.progress / 100) * 1000) / 1000 : previousQuantity;
    const currentQuantity = Math.max(previousQuantity, targetQuantity);
    const previousAmount = Math.round(previousQuantity * unitPrice * 100) / 100;
    const currentAmount = Math.round(currentQuantity * unitPrice * 100) / 100;
    return {
      kind: "devis" as const,
      position: index + 1,
      designation: item.designation,
      unit: item.unit || "",
      contractQuantity,
      unitPrice,
      previousQuantity,
      currentQuantity,
      previousAmount,
      currentAmount,
      amountThisTime: Math.round((currentAmount - previousAmount) * 100) / 100,
      matchedTaskTitle: match?.title ?? null,
      needsReview,
      priceItemId: item.id,
      category: String(item.category ?? "").trim() || undefined,
      subcategory: String(item.subcategory ?? "").trim() || undefined,
    };
  });

  // Dépenses diverses : trois lignes à part, calculées sur ce qui a été
  // réellement payé sur le chantier (jamais sur une quantité prévue), et
  // majorées de la même marge que le reste. Les achats de matériaux ne sont
  // jamais repris ici : ils sont déjà comptés dans les lignes du devis
  // ci-dessus (ex: le parpaing d'un mur déjà facturé avec ce mur).
  const [transportOrders, otherOrders, salaryPayments] = await Promise.all([
    supabase.from("project_material_orders").select("quantity,unit_price").eq("project_id", projectId).eq("status", "paid").eq("expense_kind", "transport").is("deleted_at", null),
    supabase.from("project_material_orders").select("quantity,unit_price").eq("project_id", projectId).eq("status", "paid").eq("expense_kind", "other").is("deleted_at", null),
    supabase.from("project_salary_payments").select("total_amount").eq("project_id", projectId).is("deleted_at", null),
  ]);
  const sumAmount = (rows: Array<{ quantity?: number; unit_price?: number }> | null | undefined) =>
    (rows ?? []).reduce((sum, row) => sum + (Number(row.quantity) || 0) * (Number(row.unit_price) || 0), 0);
  const transportPaid = sumAmount(transportOrders.data);
  const otherPaid = sumAmount(otherOrders.data);
  const salaryPaid = (salaryPayments.data ?? []).reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0);

  // Les dépenses qui ne sont pas des lignes du devis ne sont jamais listées une
  // par une : tout est regroupé dans UNE seule ligne « Autre ».
  // Les anciennes factures avaient parfois trois lignes (Transport, Main
  // d'œuvre, Autre) : on les additionne pour retrouver ce qui a déjà été
  // facturé et ne rien facturer deux fois.
  const previousOtherAmount = ["autre", "transport", "main d'œuvre"]
    .reduce((sum, label) => sum + (previousQuantityByDesignation.get(label) || 0), 0);

  // Part des transports, salaires et autres dépenses pas encore classée dans
  // une catégorie du devis. Si le calcul échoue (tables pas encore à jour),
  // on retombe sur le comportement d'avant : tout est refacturé en « Autre ».
  let unallocatedOther: number | null = null;
  if (!noDevis) {
    try {
      const allocation = await loadExpenseAllocation(supabase, projectId);
      unallocatedOther = Math.max(0, allocation.unallocated.transport + allocation.unallocated.labor + allocation.unallocated.other);
    } catch { unallocatedOther = null; }
  }

  let noDevisWarning: string | null = null;
  const depenseLines: SituationDraftLine[] = (() => {
    let currentAmount: number;
    if (noDevis) {
      const pricing = finance.pricing.mode !== "none"
        ? finance.pricing
        : computePricing({ settings: { marginPercent }, realCost: finance.realCost, progress: finance.progress });
      if (pricing.mode === "fixed" && finance.progress === null) {
        noDevisWarning = "Ce chantier n'a aucune tâche dans le planning : toute la somme de l'offre est facturée d'un coup. Ajoute les travaux au planning pour facturer selon l'avancement.";
      }
      // Sans prix de devis, tout le chantier tient dans la ligne « Autre » (prix
      // de l'offre × avancement, ou dépenses réelles + marge).
      currentAmount = pricing.forceTotal ? pricing.certified : roundAr(finance.realCost * (pricing.coefficient ?? 1 + marginPercent / 100));
      noDevisWarning = `${noDevisWarning ? `${noDevisWarning} ` : ""}Ce chantier n'a pas de prix de devis : tout est regroupé dans une seule ligne « Autre ». Utilise « Importer les prix du devis (PDF) » pour une facture avec les catégories et sous-catégories du devis.`;
    } else {
      // Avec devis : transport, main d'œuvre et autres dépenses (les achats de
      // matériaux sont déjà dans les lignes du devis) majorés de la marge.
      // Seul ce qui n'est PAS encore classé dans une catégorie du devis (le
      // « Autre » de la page Dépenses) est refacturé ici : le reste est déjà
      // compris dans les lignes du devis, facturées selon l'avancement.
      const autreBase = unallocatedOther ?? (transportPaid + salaryPaid + otherPaid);
      currentAmount = roundAr(autreBase * (1 + marginPercent / 100));
    }
    const previousAmount = previousOtherAmount;
    const current = Math.max(previousAmount, currentAmount);
    if (current <= 0 && previousAmount <= 0 && !noDevis) return [];
    return [{
      kind: "depense" as const,
      position: items.length + 1,
      designation: "Autre",
      // Catégorie « Autre » : tout ce qui n'est pas une ligne du devis.
      category: "Autre",
      unit: "",
      contractQuantity: null,
      unitPrice: null,
      previousQuantity: previousAmount,
      currentQuantity: current,
      previousAmount,
      currentAmount: current,
      amountThisTime: roundAr(current - previousAmount),
    }];
  })();

  const lines = [...devisLines, ...depenseLines];
  const grossAmount = Math.round(lines.reduce((sum, line) => sum + line.amountThisTime, 0) * 100) / 100;

  const internalBudget = items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0), 0);
  const totalExpenses = transportPaid + otherPaid + salaryPaid;
  const globalProgressFromMatches = devisLines.length > 0
    ? devisLines.reduce((sum, line) => sum + (line.contractQuantity ? line.currentQuantity / (line.contractQuantity || 1) : 0), 0) / devisLines.length * 100
    : 0;
  const expensesRatio = internalBudget > 0 ? (totalExpenses / internalBudget) * 100 : 0;
  let expensesWarning: string | null = noDevisWarning;
  if (internalBudget > 0 && Math.abs(expensesRatio - globalProgressFromMatches) > 20) {
    expensesWarning = `L'avancement calculé (${globalProgressFromMatches.toFixed(0)} % en moyenne) semble incohérent avec les dépenses déjà engagées (${expensesRatio.toFixed(0)} % du coût interne prévu). Vérifie ces chiffres avant d'envoyer la facture.`;
  }

  // Retenue de garantie et taxe de l'État sont des OPTIONS choisies à l'écran
  // (désactivées par défaut) : si elles sont mises sur la facture, elles sont
  // DÉDUITES du total, jamais ajoutées. Les taux ci-dessous ne sont que les
  // valeurs proposées ; les montants sont recalculés à l'écran puis à
  // l'enregistrement (POST /api/billing/claims).
  const retentionRate = 5;
  const retentionAmount = 0;
  const advanceRepayment = 0;
  const otherDeductions = 0;
  const taxRate = 8;
  const taxAmount = 0;
  const netAmount = grossAmount;

  // Le numéro s'appuie sur un compteur qui n'avance que dans un sens
  // (project.next_claim_seq), jamais sur le nombre de factures existantes :
  // sinon, supprimer un brouillon ferait retomber le prochain numéro sur un
  // numéro déjà utilisé. Ce numéro n'est qu'une proposition affichée à
  // l'écran (modifiable avant validation) ; le compteur n'avance vraiment
  // qu'à l'enregistrement (voir POST /api/billing/claims).
  const codeBase = String(project.project_code || projectId.slice(0, 6)).toUpperCase();
  const nextSeq = Number(project.next_claim_seq) || 1;
  const claimNumber = `FACT-${codeBase}-${String(nextSeq).padStart(2, "0")}`;

  return {
    projectId,
    projectName: project.name,
    clientName,
    claimNumber,
    previousClaimNumber: previousClaim?.claim_number ?? null,
    marginPercent,
    lines,
    grossAmount,
    retentionRate,
    retentionAmount,
    advanceRepayment,
    otherDeductions,
    taxRate,
    taxAmount,
    netAmount,
    expensesWarning,
    unmatchedCount,
    tasks: tasks.map((task) => ({ id: task.id, title: task.title, progress: Math.max(0, Math.min(100, Number(task.progress_percent) || 0)) })),
  };
}
