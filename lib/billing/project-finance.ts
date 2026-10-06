import type { SupabaseClient } from "@supabase/supabase-js";
import { computePricing, type Pricing, type PricingSettings } from "@/lib/billing/pricing";

// Lecture des chiffres d'un chantier (dépenses réellement payées, total du
// devis, marge / prix attendus) et calcul du prix client. Partagé par la liste
// « Factures & paiements », la fiche du chantier et la génération de facture.

export type CostCategoryKey = "materiaux" | "salaire" | "transport" | "autre";
export const COST_CATEGORY_LABELS: Record<CostCategoryKey, string> = {
  materiaux: "Matériaux",
  salaire: "Main d'œuvre",
  transport: "Transport",
  autre: "Autres dépenses",
};
const CATEGORY_ORDER: CostCategoryKey[] = ["materiaux", "salaire", "transport", "autre"];
const TRANSPORT_LABELS: Record<string, string> = { homme: "Homme", charrette: "Charrette", camionnette: "Camionnette", camion: "Camion", autre: "Autre" };

export type CostLine = { label: string; cost: number };
export type CostCategory = { key: CostCategoryKey; label: string; total: number; lines: CostLine[] };

export type ProjectFinance = {
  projectId: string;
  settings: PricingSettings;
  devisTotal: number;
  /** Avancement moyen du planning (0 à 1), null sans tâche. */
  progress: number | null;
  categories: CostCategory[];
  realCost: number;
  pricing: Pricing;
};

type OrderRow = { project_id: string; material_name?: string | null; quantity?: number | string | null; unit_price?: number | string | null; expense_kind?: string | null; transport_mode?: string | null; recipient_name?: string | null };
type SalaryRow = { project_id: string; total_amount?: number | string | null; paid_at?: string | null; period_month?: string | null };
type PriceItemRow = { project_id: string; quantity?: number | string | null; external_unit_price?: number | string | null; unit_price?: number | string | null; total?: number | string | null; is_internal?: boolean | null };
type SettingsRow = { id: string; contract_amount?: number | string | null; expected_margin_percent?: number | string | null; expected_margin_amount?: number | string | null };

const num = (value: unknown) => Number(value) || 0;
const nullableNum = (value: unknown): number | null => (value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);

function monthLabel(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date);
}

function orderCategory(order: OrderRow): CostCategoryKey {
  if (order.expense_kind === "transport") return "transport";
  if (order.expense_kind === "other") return "autre";
  return "materiaux";
}
function orderLabel(order: OrderRow) {
  if (order.expense_kind === "transport") return `Transport - ${TRANSPORT_LABELS[order.transport_mode || "autre"] || "Autre"}`;
  if (order.expense_kind === "other") return (order.recipient_name || "Autre dépense").trim();
  return (order.material_name || "Matériau").trim();
}

function buildCategories(orders: OrderRow[], salaries: SalaryRow[]): CostCategory[] {
  const maps = new Map<CostCategoryKey, Map<string, number>>(CATEGORY_ORDER.map((key) => [key, new Map<string, number>()]));
  const add = (category: CostCategoryKey, label: string, amount: number) => {
    if (!(amount > 0)) return;
    const map = maps.get(category)!;
    map.set(label, (map.get(label) ?? 0) + amount);
  };
  for (const order of orders) add(orderCategory(order), orderLabel(order), num(order.quantity) * num(order.unit_price));
  for (const payment of salaries) {
    const when = monthLabel(payment.period_month) || monthLabel(payment.paid_at);
    add("salaire", when ? `Salaires ${when}` : "Salaires", num(payment.total_amount));
  }
  return CATEGORY_ORDER.map((key) => {
    const lines = [...maps.get(key)!.entries()]
      .map(([label, cost]) => ({ label, cost }))
      .sort((a, b) => a.label.localeCompare(b.label, "fr"));
    return { key, label: COST_CATEGORY_LABELS[key], total: lines.reduce((sum, line) => sum + line.cost, 0), lines };
  });
}

async function loadSettings(supabase: SupabaseClient, organizationId: string, projectIds: string[]): Promise<Map<string, PricingSettings>> {
  const result = new Map<string, PricingSettings>();
  if (projectIds.length === 0) return result;
  // Les colonnes de prix/marge sont ajoutées par un fichier SQL à exécuter une
  // fois dans Supabase : tant qu'il n'a pas été exécuté, la lecture échoue et
  // on continue simplement sans ces réglages (aucune erreur à l'écran).
  const { data, error } = await supabase
    .from("projects")
    .select("id,contract_amount,expected_margin_percent,expected_margin_amount")
    .eq("organization_id", organizationId)
    .in("id", projectIds);
  if (error || !data) return result;
  for (const row of data as SettingsRow[]) {
    result.set(row.id, {
      contractAmount: nullableNum(row.contract_amount),
      marginPercent: nullableNum(row.expected_margin_percent),
      marginAmount: nullableNum(row.expected_margin_amount),
    });
  }
  return result;
}

export async function loadFinanceForProjects(
  supabase: SupabaseClient,
  organizationId: string,
  projectIds: string[],
): Promise<Map<string, ProjectFinance>> {
  const finances = new Map<string, ProjectFinance>();
  if (projectIds.length === 0) return finances;

  const [settingsByProject, ordersResult, salariesResult, itemsResult, tasksResult] = await Promise.all([
    loadSettings(supabase, organizationId, projectIds),
    supabase
      .from("project_material_orders")
      .select("project_id,material_name,quantity,unit_price,expense_kind,transport_mode,recipient_name")
      .in("project_id", projectIds)
      .eq("status", "paid")
      .is("deleted_at", null),
    supabase
      .from("project_salary_payments")
      .select("project_id,total_amount,paid_at,period_month")
      .in("project_id", projectIds)
      .is("deleted_at", null),
    supabase
      .from("project_price_items")
      .select("project_id,quantity,external_unit_price,unit_price,total,is_internal")
      .in("project_id", projectIds)
      .eq("is_internal", false),
    supabase
      .from("project_tasks")
      .select("project_id,progress_percent")
      .in("project_id", projectIds),
  ]);

  const progressSums = new Map<string, { sum: number; count: number }>();
  for (const task of (tasksResult.data ?? []) as Array<{ project_id: string; progress_percent?: number | string | null }>) {
    const entry = progressSums.get(task.project_id) ?? { sum: 0, count: 0 };
    entry.sum += Math.max(0, Math.min(100, Number(task.progress_percent) || 0));
    entry.count += 1;
    progressSums.set(task.project_id, entry);
  }

  const ordersBy = new Map<string, OrderRow[]>();
  for (const row of (ordersResult.data ?? []) as OrderRow[]) ordersBy.set(row.project_id, [...(ordersBy.get(row.project_id) ?? []), row]);
  const salariesBy = new Map<string, SalaryRow[]>();
  for (const row of (salariesResult.data ?? []) as SalaryRow[]) salariesBy.set(row.project_id, [...(salariesBy.get(row.project_id) ?? []), row]);
  const devisBy = new Map<string, number>();
  for (const item of (itemsResult.data ?? []) as PriceItemRow[]) {
    const external = num(item.external_unit_price);
    const amount = external > 0 ? num(item.quantity) * external : num(item.total) || num(item.quantity) * num(item.unit_price);
    devisBy.set(item.project_id, (devisBy.get(item.project_id) ?? 0) + amount);
  }

  for (const projectId of projectIds) {
    const categories = buildCategories(ordersBy.get(projectId) ?? [], salariesBy.get(projectId) ?? []);
    const realCost = categories.reduce((sum, category) => sum + category.total, 0);
    const settings = settingsByProject.get(projectId) ?? {};
    const devisTotal = devisBy.get(projectId) ?? 0;
    const progressEntry = progressSums.get(projectId);
    const progress = progressEntry && progressEntry.count > 0 ? progressEntry.sum / progressEntry.count / 100 : null;
    finances.set(projectId, {
      projectId,
      settings,
      devisTotal,
      progress,
      categories,
      realCost,
      pricing: computePricing({ settings, realCost, devisTotal, progress }),
    });
  }
  return finances;
}

export async function loadProjectFinance(supabase: SupabaseClient, organizationId: string, projectId: string): Promise<ProjectFinance> {
  const map = await loadFinanceForProjects(supabase, organizationId, [projectId]);
  return map.get(projectId)!;
}
