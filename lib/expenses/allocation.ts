import type { SupabaseClient } from "@supabase/supabase-js";
import { matchTaskForItem, type PlanningTask } from "@/lib/billing/task-matching";

// Classement automatique des dépenses d'un chantier par catégorie / sous-
// catégorie du devis.
//
// Principe (rien n'est stocké : tout est recalculé à partir de ce qui est
// déjà enregistré, donc un rapport corrigé, supprimé ou arrivé en retard
// après une coupure réseau met le classement à jour tout seul) :
//  - un achat de matériau est un « lot » avec son prix d'achat ; les
//    quantités utilisées dans les rapports journaliers consomment les lots
//    du plus ancien au plus récent (jamais de prix moyen) ;
//  - la quantité utilisée un jour est rangée dans la catégorie / sous-
//    catégorie des tâches travaillées dans le rapport de ce jour-là (si
//    plusieurs tâches : au prorata de l'avancement gagné ce jour-là) ;
//  - le transport lié à l'achat suit, au prorata de la quantité utilisée ;
//  - la main d'œuvre suit les jours de présence déjà payés, au salaire payé ;
//  - tout le reste (achat pas encore utilisé, dépense hors tâche du devis,
//    etc.) reste dans « Autre ».

export type AllocationKind = "material" | "transport" | "labor";
export type AllocationLine = { kind: AllocationKind; label: string; quantity: number | null; unit: string; unitPrice: number | null; amount: number };
export type AllocationSub = { name: string; lines: AllocationLine[]; total: number };
export type AllocationCategory = { name: string; subs: AllocationSub[]; total: number };
export type AllocationResult = {
  categories: AllocationCategory[];
  other: { lines: AllocationLine[]; total: number };
  /** Totaux payés (identiques à ceux de la page Dépenses) et part déjà classée. */
  paid: { material: number; transport: number; labor: number; other: number };
  allocated: { material: number; transport: number; labor: number; total: number };
  /** Ce qui reste dans « Autre » (par type). */
  unallocated: { material: number; transport: number; labor: number; other: number; total: number };
};

type PriceItem = { id?: string; designation: string; category?: string | null; subcategory?: string | null; task_id?: string | null };
type TaskRow = PlanningTask;
type ReportRow = { id: string; report_date: string };
type TaskLog = { report_id: string; task_id: string; report_date: string; progress_before: number | string | null; progress_after: number | string | null };
type UsageRow = { report_id: string; material_id: string; quantity: number | string; unit?: string | null };
type MaterialRow = { id: string; designation: string; unit?: string | null };
type OrderRow = {
  id: string; material_id?: string | null; material_name?: string | null; material_key?: string | null; unit?: string | null;
  quantity?: number | string | null; purchased_quantity?: number | string | null; unit_price?: number | string | null;
  expense_kind?: string | null; transport_mode?: string | null; recipient_name?: string | null;
  paid_at?: string | null; created_at?: string | null; source_order_id?: string | null;
};
type AttendanceRow = { staff_member_id: string; report_date: string; present: boolean };
type SalaryLine = { staff_member_id?: string | null; full_name: string; role_name?: string | null; daily_rate?: number | string | null; days_worked?: number | string | null; amount?: number | string | null };
type SalaryPayment = { id: string; paid_at: string; total_amount?: number | string | null; project_salary_payment_lines?: SalaryLine[] | null };

export type AllocationInput = {
  priceItems: PriceItem[];
  tasks: TaskRow[];
  reports: ReportRow[];
  taskLogs: TaskLog[];
  usages: UsageRow[];
  materials: MaterialRow[];
  orders: OrderRow[];
  attendance: AttendanceRow[];
  salaries: SalaryPayment[];
};

const num = (value: unknown) => Number(value) || 0;
const round2 = (value: number) => Math.round(value * 100) / 100;
const TRANSPORT_LABELS: Record<string, string> = { homme: "Homme", charrette: "Charrette", camionnette: "Camionnette", camion: "Camion", autre: "Autre" };

function normalizeKey(value: string | null | undefined) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
}

type Bucket = { category: string; subcategory: string; order: number };
type Share = { bucket: Bucket | null; share: number };

export function computeAllocation(input: AllocationInput): AllocationResult {
  // ---- 1. Tâche du planning -> catégorie / sous-catégorie du devis ----
  const taskIds = new Set(input.tasks.map((task) => task.id));
  const bucketByTask = new Map<string, Bucket>();
  input.priceItems.forEach((item, index) => {
    const linked = item.task_id && taskIds.has(item.task_id) ? item.task_id : matchTaskForItem({ designation: item.designation, subcategory: item.subcategory, category: item.category }, input.tasks)?.id;
    if (!linked || bucketByTask.has(linked)) return;
    const category = String(item.category ?? "").trim() || String(item.designation ?? "").trim() || "Travaux";
    bucketByTask.set(linked, { category, subcategory: String(item.subcategory ?? "").trim(), order: index });
  });

  // ---- 2. Parts de chaque jour : quelles tâches ont été travaillées ----
  const sharesCache = new Map<string, Share[]>();
  const logsByDate = new Map<string, TaskLog[]>();
  for (const log of input.taskLogs) logsByDate.set(log.report_date, [...(logsByDate.get(log.report_date) ?? []), log]);
  function sharesFor(date: string): Share[] {
    const cached = sharesCache.get(date);
    if (cached) return cached;
    const logs = logsByDate.get(date) ?? [];
    const gainByTask = new Map<string, number>();
    for (const log of logs) gainByTask.set(log.task_id, (gainByTask.get(log.task_id) ?? 0) + Math.max(0, num(log.progress_after) - num(log.progress_before)));
    const taskList = [...gainByTask.keys()];
    let total = [...gainByTask.values()].reduce((sum, value) => sum + value, 0);
    const weights = new Map<string, number>();
    if (total > 0) for (const taskId of taskList) weights.set(taskId, gainByTask.get(taskId) ?? 0);
    else { for (const taskId of taskList) weights.set(taskId, 1); total = taskList.length; }
    const merged = new Map<string, Share>();
    for (const taskId of taskList) {
      const weight = (weights.get(taskId) ?? 0) / (total || 1);
      if (weight <= 0) continue;
      const bucket = bucketByTask.get(taskId) ?? null;
      const key = bucket ? `${bucket.category}|||${bucket.subcategory}` : "none";
      const existing = merged.get(key);
      if (existing) existing.share += weight;
      else merged.set(key, { bucket, share: weight });
    }
    const result = [...merged.values()];
    sharesCache.set(date, result);
    return result;
  }

  // ---- 3. Résultat : arbre catégorie > sous-catégorie > lignes ----
  const tree = new Map<string, { category: string; order: number; subs: Map<string, { name: string; order: number; lines: Map<string, AllocationLine> }> }>();
  function addLine(bucket: Bucket, line: AllocationLine) {
    let category = tree.get(bucket.category);
    if (!category) { category = { category: bucket.category, order: bucket.order, subs: new Map() }; tree.set(bucket.category, category); }
    category.order = Math.min(category.order, bucket.order);
    let sub = category.subs.get(bucket.subcategory);
    if (!sub) { sub = { name: bucket.subcategory, order: bucket.order, lines: new Map() }; category.subs.set(bucket.subcategory, sub); }
    sub.order = Math.min(sub.order, bucket.order);
    const key = `${line.kind}|${line.label}|${line.unitPrice ?? ""}`;
    const existing = sub.lines.get(key);
    if (existing) { existing.quantity = existing.quantity === null || line.quantity === null ? null : existing.quantity + line.quantity; existing.amount += line.amount; }
    else sub.lines.set(key, { ...line });
  }

  const allocated = { material: 0, transport: 0, labor: 0 };

  // ---- 4. Matériaux (lots à prix d'achat, du plus ancien au plus récent) + transport lié ----
  const materialById = new Map(input.materials.map((material) => [material.id, material]));
  const materialByKey = new Map(input.materials.map((material) => [normalizeKey(material.designation), material]));
  type Lot = { order: OrderRow; materialId: string | null; stock: number; remaining: number; price: number; total: number; allocQty: number; allocAmount: number };
  const lots: Lot[] = [];
  const lotsByMaterial = new Map<string, Lot[]>();
  const lotById = new Map<string, Lot>();
  const materialOrders = input.orders.filter((order) => (order.expense_kind || "material") === "material");
  const sortKey = (order: OrderRow) => order.paid_at || order.created_at || "";
  for (const order of [...materialOrders].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))) {
    const materialId = order.material_id && materialById.has(order.material_id) ? order.material_id : materialByKey.get(normalizeKey(order.material_key || order.material_name))?.id ?? null;
    const stock = num(order.purchased_quantity) > 0 ? num(order.purchased_quantity) : num(order.quantity);
    const lot: Lot = { order, materialId, stock, remaining: stock, price: num(order.unit_price), total: num(order.quantity) * num(order.unit_price), allocQty: 0, allocAmount: 0 };
    lots.push(lot);
    lotById.set(order.id, lot);
    if (materialId) lotsByMaterial.set(materialId, [...(lotsByMaterial.get(materialId) ?? []), lot]);
  }
  const transportOrders = input.orders.filter((order) => order.expense_kind === "transport");
  const transportByLot = new Map<string, Array<{ order: OrderRow; total: number; allocated: number }>>();
  const transportRows = transportOrders.map((order) => ({ order, total: num(order.quantity) * num(order.unit_price), allocated: 0 }));
  for (const row of transportRows) {
    const source = row.order.source_order_id;
    if (source && lotById.has(source)) transportByLot.set(source, [...(transportByLot.get(source) ?? []), row]);
  }

  const reportDate = new Map(input.reports.map((report) => [report.id, report.report_date]));
  const usages = input.usages
    .map((usage) => ({ usage, date: reportDate.get(usage.report_id) ?? "" }))
    .filter((entry) => entry.date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.usage.report_id.localeCompare(b.usage.report_id));
  for (const { usage, date } of usages) {
    const material = materialById.get(usage.material_id);
    const lotList = lotsByMaterial.get(usage.material_id) ?? [];
    let need = num(usage.quantity);
    const shares = sharesFor(date);
    for (const lot of lotList) {
      if (need <= 1e-9) break;
      if (lot.remaining <= 1e-9) continue;
      const take = Math.min(lot.remaining, need);
      lot.remaining -= take;
      need -= take;
      for (const share of shares) {
        if (!share.bucket) continue;
        const quantity = take * share.share;
        const amount = quantity * lot.price;
        addLine(share.bucket, { kind: "material", label: material?.designation || lot.order.material_name || "Matériau", quantity, unit: material?.unit || lot.order.unit || "", unitPrice: lot.price, amount });
        lot.allocQty += quantity;
        lot.allocAmount += amount;
        allocated.material += amount;
        for (const transport of transportByLot.get(lot.order.id) ?? []) {
          const part = lot.stock > 0 ? transport.total * (take / lot.stock) * share.share : 0;
          if (part <= 0) continue;
          transport.allocated += part;
          allocated.transport += part;
          const mode = TRANSPORT_LABELS[transport.order.transport_mode || "autre"] || "Autre";
          addLine(share.bucket, { kind: "transport", label: `Transport (${mode}) — ${material?.designation || lot.order.material_name || "matériau"}`, quantity: null, unit: "", unitPrice: null, amount: part });
        }
      }
    }
  }

  // ---- 5. Main d'œuvre : jours de présence déjà payés, au salaire payé ----
  type LaborLot = { line: SalaryLine; remainingDays: number; perDay: number; allocated: number };
  const laborLotsByStaff = new Map<string, LaborLot[]>();
  const allLaborLots: LaborLot[] = [];
  const payments = [...input.salaries].sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
  for (const payment of payments) {
    for (const line of payment.project_salary_payment_lines ?? []) {
      const days = Math.max(0, Math.round(num(line.days_worked)));
      const perDay = days > 0 ? num(line.amount) / days : num(line.daily_rate);
      const lot: LaborLot = { line, remainingDays: days, perDay, allocated: 0 };
      allLaborLots.push(lot);
      if (line.staff_member_id) laborLotsByStaff.set(line.staff_member_id, [...(laborLotsByStaff.get(line.staff_member_id) ?? []), lot]);
    }
  }
  const presence = [...input.attendance].filter((row) => row.present).sort((a, b) => a.report_date.localeCompare(b.report_date));
  for (const row of presence) {
    const lot = (laborLotsByStaff.get(row.staff_member_id) ?? []).find((candidate) => candidate.remainingDays > 0);
    if (!lot) continue;
    lot.remainingDays -= 1;
    for (const share of sharesFor(row.report_date)) {
      if (!share.bucket) continue;
      const amount = lot.perDay * share.share;
      lot.allocated += amount;
      allocated.labor += amount;
      const role = lot.line.role_name ? ` (${lot.line.role_name})` : "";
      addLine(share.bucket, { kind: "labor", label: `Main d'œuvre — ${lot.line.full_name}${role}`, quantity: share.share, unit: "j", unitPrice: lot.perDay, amount });
    }
  }

  // ---- 6. Totaux payés (mêmes règles que la page Dépenses) et reste dans « Autre » ----
  const paid = {
    material: lots.reduce((sum, lot) => sum + lot.total, 0),
    transport: transportRows.reduce((sum, row) => sum + row.total, 0),
    labor: payments.reduce((sum, payment) => sum + num(payment.total_amount), 0),
    other: input.orders.filter((order) => order.expense_kind === "other").reduce((sum, order) => sum + num(order.quantity) * num(order.unit_price), 0),
  };
  const otherLines: AllocationLine[] = [];
  for (const lot of lots) {
    const remainingAmount = Math.max(0, lot.total - lot.allocAmount);
    if (remainingAmount < 0.5) continue;
    otherLines.push({ kind: "material", label: `${materialById.get(lot.materialId ?? "")?.designation || lot.order.material_name || "Matériau"} — achat non classé`, quantity: Math.max(0, lot.stock - lot.allocQty), unit: lot.order.unit || "", unitPrice: lot.price, amount: remainingAmount });
  }
  for (const row of transportRows) {
    const remainingAmount = Math.max(0, row.total - row.allocated);
    if (remainingAmount < 0.5) continue;
    otherLines.push({ kind: "transport", label: `Transport (${TRANSPORT_LABELS[row.order.transport_mode || "autre"] || "Autre"}) — non classé`, quantity: null, unit: "", unitPrice: null, amount: remainingAmount });
  }
  const laborRemaining = Math.max(0, paid.labor - allocated.labor);
  if (laborRemaining >= 0.5) otherLines.push({ kind: "labor", label: "Main d'œuvre — non classée", quantity: null, unit: "", unitPrice: null, amount: laborRemaining });
  for (const order of input.orders.filter((candidate) => candidate.expense_kind === "other")) {
    const amount = num(order.quantity) * num(order.unit_price);
    if (amount <= 0) continue;
    otherLines.push({ kind: "material", label: (order.recipient_name || "Autre dépense").trim(), quantity: null, unit: "", unitPrice: null, amount });
  }

  const unallocated = {
    material: Math.max(0, paid.material - allocated.material),
    transport: Math.max(0, paid.transport - allocated.transport),
    labor: laborRemaining,
    other: paid.other,
    total: 0,
  };
  unallocated.total = unallocated.material + unallocated.transport + unallocated.labor + unallocated.other;

  const categories: AllocationCategory[] = [...tree.values()]
    .sort((a, b) => a.order - b.order)
    .map((category) => {
      const subs: AllocationSub[] = [...category.subs.values()]
        .sort((a, b) => a.order - b.order)
        .map((sub) => {
          const lines = [...sub.lines.values()].map((line) => ({ ...line, quantity: line.quantity === null ? null : Math.round(line.quantity * 1000) / 1000, amount: round2(line.amount) }));
          return { name: sub.name, lines, total: round2(lines.reduce((sum, line) => sum + line.amount, 0)) };
        });
      return { name: category.category, subs, total: round2(subs.reduce((sum, sub) => sum + sub.total, 0)) };
    });

  return {
    categories,
    other: { lines: otherLines.map((line) => ({ ...line, amount: round2(line.amount) })), total: round2(unallocated.total) },
    paid: { material: round2(paid.material), transport: round2(paid.transport), labor: round2(paid.labor), other: round2(paid.other) },
    allocated: { material: round2(allocated.material), transport: round2(allocated.transport), labor: round2(allocated.labor), total: round2(allocated.material + allocated.transport + allocated.labor) },
    unallocated: { material: round2(unallocated.material), transport: round2(unallocated.transport), labor: round2(unallocated.labor), other: round2(unallocated.other), total: round2(unallocated.total) },
  };
}

// Lecture des données du chantier puis calcul. Les colonnes / tables ajoutées
// par le fichier SQL de cette fonction sont facultatives : tant qu'il n'est
// pas exécuté, on lit sans elles (rien n'est classé, tout reste dans « Autre »).
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; from < 20000; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) return { rows, error: error.message };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, error: null };
}

export async function loadExpenseAllocation(supabase: SupabaseClient, projectId: string): Promise<AllocationResult> {
  const itemBase = "id,designation,category,subcategory,created_at";
  let priceItems: PriceItem[] = [];
  for (const columns of [`${itemBase},task_id`, itemBase, "id,designation,created_at"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", projectId).eq("is_internal", false).order("created_at", { ascending: true });
    if (!result.error) { priceItems = (result.data ?? []) as unknown as PriceItem[]; break; }
  }

  const orderBase = "id,material_id,material_name,material_key,unit,quantity,unit_price,expense_kind,transport_mode,recipient_name,paid_at,created_at";
  const ordersPromise = (async () => {
    for (const columns of [`${orderBase},purchased_quantity,source_order_id`, `${orderBase},purchased_quantity`, orderBase]) {
      const result = await fetchAll<OrderRow>((from, to) => supabase.from("project_material_orders").select(columns).eq("project_id", projectId).eq("status", "paid").is("deleted_at", null).order("created_at", { ascending: true }).range(from, to));
      if (!result.error) return result.rows;
    }
    return [] as OrderRow[];
  })();

  const [tasksResult, reportsResult, logsResult, usagesResult, materialsResult, orders, attendanceResult, salariesResult] = await Promise.all([
    supabase.from("project_tasks").select("id,title,progress_percent").eq("project_id", projectId),
    fetchAll<ReportRow>((from, to) => supabase.from("project_daily_reports").select("id,report_date").eq("project_id", projectId).range(from, to)),
    fetchAll<TaskLog>((from, to) => supabase.from("project_report_task_progress").select("report_id,task_id,report_date,progress_before,progress_after").eq("project_id", projectId).range(from, to)),
    fetchAll<UsageRow>((from, to) => supabase.from("project_report_material_usages").select("report_id,material_id,quantity,unit").eq("project_id", projectId).range(from, to)),
    supabase.from("project_materials").select("id,designation,unit").eq("project_id", projectId),
    ordersPromise,
    fetchAll<AttendanceRow>((from, to) => supabase.from("project_daily_attendance").select("staff_member_id,report_date,present").eq("project_id", projectId).eq("present", true).order("report_date", { ascending: true }).range(from, to)),
    supabase.from("project_salary_payments").select("id,paid_at,total_amount,project_salary_payment_lines(staff_member_id,full_name,role_name,daily_rate,days_worked,amount)").eq("project_id", projectId).is("deleted_at", null),
  ]);

  return computeAllocation({
    priceItems,
    tasks: (tasksResult.data ?? []) as unknown as TaskRow[],
    reports: reportsResult.rows,
    // Table absente (SQL pas encore exécuté) : aucune tâche connue, rien n'est classé.
    taskLogs: logsResult.error ? [] : logsResult.rows,
    usages: usagesResult.rows,
    materials: (materialsResult.data ?? []) as unknown as MaterialRow[],
    orders,
    attendance: attendanceResult.rows,
    salaries: (salariesResult.data ?? []) as unknown as SalaryPayment[],
  });
}
