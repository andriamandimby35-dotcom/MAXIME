import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalMaterialKey } from "@/lib/material-normalization";

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
};

export type SituationDraftResult =
  | SituationDraft
  | { error: string }
  | { needsMarginInput: true; projectId: string; projectName: string }
  | { needsClientInput: true; projectId: string; projectName: string };

function normalizeDesignation(value: string) {
  return String(value ?? "").trim().toLocaleLowerCase("fr-FR");
}

function tokensOf(value: string) {
  return canonicalMaterialKey(value).split(" ").filter(Boolean);
}

// Une tâche du planning ("Terrassement", "Fondations"...) et une ligne du
// devis chiffré ("Fouille en pleine masse", "Béton de propreté 150 kg/m3"...)
// ne partagent aucun identifiant commun dans la base (ce sont deux listes
// séparées, même si elles viennent du même DAO à l'origine) : on les
// rapproche donc par ressemblance de texte. Une ligne du devis est reliée à
// la tâche dont le titre partage le plus de mots avec elle, seulement si
// cette ressemblance est assez forte — sinon elle reste "non reconnue" (0 %,
// à vérifier à la main), plutôt que de deviner un avancement au hasard.
function bestMatchingTask(designation: string, tasks: Array<{ title: string; progress_percent: number | string }>) {
  const designationTokens = new Set(tokensOf(designation));
  if (designationTokens.size === 0) return null;
  let best: { title: string; progress: number; score: number } | null = null;
  for (const task of tasks) {
    const taskTokens = new Set(tokensOf(task.title));
    if (taskTokens.size === 0) continue;
    const shared = [...designationTokens].filter((token) => taskTokens.has(token)).length;
    const smaller = Math.min(designationTokens.size, taskTokens.size);
    const score = smaller > 0 ? shared / smaller : 0;
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { title: task.title, progress: Math.max(0, Math.min(100, Number(task.progress_percent) || 0)), score };
    }
  }
  return best;
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
  let marginPercent: number;
  if (project.source_estimate_id) {
    const { data: estimate } = await supabase
      .from("estimates")
      .select("profit_margin_percent")
      .eq("id", project.source_estimate_id)
      .maybeSingle();
    marginPercent = Number(estimate?.profit_margin_percent) || 0;
  } else if (project.manual_margin_percent !== null && project.manual_margin_percent !== undefined) {
    marginPercent = Number(project.manual_margin_percent) || 0;
  } else if (marginOverride !== undefined && Number.isFinite(marginOverride)) {
    marginPercent = marginOverride;
  } else {
    return { needsMarginInput: true, projectId, projectName: project.name };
  }

  const { data: priceItems, error: priceItemsError } = await supabase
    .from("project_price_items")
    .select("designation,unit,quantity,unit_price,external_unit_price,is_internal,created_at")
    .eq("project_id", projectId)
    .eq("is_internal", false)
    .order("created_at", { ascending: true });
  if (priceItemsError) return { error: priceItemsError.message };
  if (!priceItems || priceItems.length === 0) {
    return { error: "Ce chantier n'a aucun poste de devis externe : impossible de générer une facture." };
  }

  const { data: tasks } = await supabase
    .from("project_tasks")
    .select("title,progress_percent")
    .eq("project_id", projectId);

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
  const devisLines: SituationDraftLine[] = priceItems.map((item, index) => {
    const contractQuantity = Number(item.quantity) || 0;
    const baseUnitPrice = Number(item.unit_price) || 0;
    const storedExternalPrice = Number(item.external_unit_price);
    const unitPrice = Number.isFinite(storedExternalPrice) && storedExternalPrice > 0
      ? storedExternalPrice
      : Math.round(baseUnitPrice * (1 + marginPercent / 100) * 100) / 100;
    const previousQuantity = previousQuantityByDesignation.get(normalizeDesignation(item.designation)) || 0;
    const match = bestMatchingTask(item.designation, tasks ?? []);
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

  const depenseLines: SituationDraftLine[] = [
    { label: "Transport", cumulativePaid: transportPaid },
    { label: "Main d'œuvre", cumulativePaid: salaryPaid },
    { label: "Autre", cumulativePaid: otherPaid },
  ].map(({ label, cumulativePaid }, index) => {
    const currentAmount = Math.round(cumulativePaid * (1 + marginPercent / 100) * 100) / 100;
    const previousAmount = previousQuantityByDesignation.get(normalizeDesignation(label)) || 0;
    // Sur ces lignes, "quantité" représente directement un montant en
    // Ariary (prix unitaire = 1) : il n'y a pas de quantité/prix séparés à
    // afficher, seulement des dépenses réelles.
    const current = Math.max(previousAmount, currentAmount);
    return {
      kind: "depense" as const,
      position: priceItems.length + index + 1,
      designation: label,
      unit: "forfait",
      contractQuantity: null,
      unitPrice: null,
      previousQuantity: previousAmount,
      currentQuantity: current,
      previousAmount,
      currentAmount: current,
      amountThisTime: Math.round((current - previousAmount) * 100) / 100,
    };
  });

  const lines = [...devisLines, ...depenseLines];
  const grossAmount = Math.round(lines.reduce((sum, line) => sum + line.amountThisTime, 0) * 100) / 100;

  const internalBudget = priceItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0), 0);
  const totalExpenses = transportPaid + otherPaid + salaryPaid;
  const globalProgressFromMatches = devisLines.length > 0
    ? devisLines.reduce((sum, line) => sum + (line.contractQuantity ? line.currentQuantity / (line.contractQuantity || 1) : 0), 0) / devisLines.length * 100
    : 0;
  const expensesRatio = internalBudget > 0 ? (totalExpenses / internalBudget) * 100 : 0;
  let expensesWarning: string | null = null;
  if (internalBudget > 0 && Math.abs(expensesRatio - globalProgressFromMatches) > 20) {
    expensesWarning = `L'avancement calculé (${globalProgressFromMatches.toFixed(0)} % en moyenne) semble incohérent avec les dépenses déjà engagées (${expensesRatio.toFixed(0)} % du coût interne prévu). Vérifie ces chiffres avant d'envoyer la facture.`;
  }

  const retentionRate = 5;
  const retentionAmount = Math.round(grossAmount * retentionRate / 100 * 100) / 100;
  const advanceRepayment = 0;
  const otherDeductions = 0;
  const taxable = Math.max(0, grossAmount - retentionAmount - advanceRepayment - otherDeductions);
  const taxRate = 8;
  const taxAmount = Math.round(taxable * taxRate / 100 * 100) / 100;
  const netAmount = Math.round((taxable + taxAmount) * 100) / 100;

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
  };
}
