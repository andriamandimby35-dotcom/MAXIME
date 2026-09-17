"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type StaffMember = { id: string; project_id: string; full_name: string; role_name?: string | null; active?: boolean; mvola_number?: string | null; mvola_enabled?: boolean; call_enabled?: boolean };
type Attendance = { id: string; staff_member_id: string; report_date: string; present: boolean };
type ConductorAssignment = { id: string; user_id: string; role: string; active?: boolean; displayName?: string | null; phone_number?: string | null; mvola_enabled?: boolean; call_enabled?: boolean; created_at?: string };
type MaterialOrder = {
  id: string; project_id: string; material_name: string; material_key?: string | null; unit?: string | null; quantity: number | string; unit_price: number | string;
  status: string; expense_kind?: string | null; transport_mode?: string | null; recipient_name?: string | null;
  paid_at?: string | null; submitted_at?: string | null; deleted_at?: string | null;
};
type SalaryPaymentLine = { id: string; staff_member_id?: string | null; assignment_id?: string | null; full_name: string; role_name?: string | null; daily_rate: number; days_worked: number; amount: number; mvola_number?: string | null; note?: string | null };
type SalaryPayment = { id: string; project_id: string; paid_at: string; total_amount: number; deleted_at?: string | null; period_month?: string | null; payment_method?: "mvola" | "cash" | "other" | null; is_advance?: boolean; project_salary_payment_lines: SalaryPaymentLine[] };
type LaborRate = { designation: string; unitPrice: unknown };
type LaborRateOverride = { id: string; project_id: string; role_name: string; daily_rate: number; monthly_rate?: number | null };
type AccessRole = "admin" | "works_manager" | "site_manager" | "viewer";

type SalaryRow = {
  key: string;
  kind: "staff" | "assignment";
  refId: string;
  name: string;
  roleName: string;
  phone: string | null;
  mvolaEnabled: boolean;
  callEnabled: boolean;
  dailyRate: number | null;
  daysWorked: number;
  amount: number;
  alreadyPaid: boolean;
};

const number = (value: unknown) => Number(value) || 0;
const money = (value: number) => `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Ar`;
const dateFmt = new Intl.DateTimeFormat("fr-FR");
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const TRANSPORT_LABELS: Record<string, string> = { homme: "Homme", charrette: "Charrette", camionnette: "Camionnette", camion: "Camion", autre: "Autre" };

function orderLabel(order: MaterialOrder) {
  if (order.expense_kind === "transport") return `Transport — ${TRANSPORT_LABELS[order.transport_mode || "autre"] || "Autre"}`;
  if (order.expense_kind === "other") return order.recipient_name || "Autre";
  return order.material_name;
}
function orderReason(order: MaterialOrder) {
  if (order.expense_kind === "transport") return "Transport";
  if (order.expense_kind === "other") return "Autre";
  return "Achat";
}
function orderTotal(order: MaterialOrder) {
  return number(order.quantity) * number(order.unit_price);
}
function mvolaAppelLabel(row: SalaryRow) {
  if (row.mvolaEnabled && row.callEnabled) return "Mvola + Appel";
  if (row.mvolaEnabled) return "Mvola";
  if (row.callEnabled) return "Appel";
  return "—";
}
function paymentLabel(payment: SalaryPayment) {
  const lines = payment.project_salary_payment_lines;
  if (payment.is_advance) return `Acompte — ${lines[0]?.full_name ?? ""}`;
  const methodLabel = payment.payment_method === "mvola" ? "Mvola" : payment.payment_method === "cash" ? "Espèces" : payment.payment_method === "other" ? "Autre" : "";
  if (lines.length === 1) return `Salaire — ${lines[0].full_name}${methodLabel ? ` (${methodLabel})` : ""}`;
  return `Salaire${methodLabel ? ` ${methodLabel}` : ""} (${lines.length} personne(s))`;
}

export function ProjectExpensesManager({ project, accessRole, userId, staffMembers: initialStaffMembers, attendance: initialAttendance, materialOrders: initialMaterialOrders, salaryPayments: initialSalaryPayments, laborRates, laborRateOverrides: initialLaborRateOverrides, assignments: initialAssignments }: {
  project: { id: string; name: string; project_code?: string | null; organization_id: string };
  accessRole: AccessRole;
  userId: string;
  staffMembers: StaffMember[];
  attendance: Attendance[];
  materialOrders: MaterialOrder[];
  salaryPayments: SalaryPayment[];
  laborRates: LaborRate[];
  laborRateOverrides?: LaborRateOverride[];
  assignments?: ConductorAssignment[];
}) {
  const supabase = useState(() => createClient())[0];
  const canManage = accessRole === "admin";
  // Le conducteur (works_manager) a un accès en lecture seule aux dépenses
  // matériaux/transport de son chantier (voir le commentaire dans
  // app/(dashboard)/layout.tsx) : il voit "Demandes en cours" et "Achats
  // payés", mais jamais le Salaire (données sensibles) ni les actions
  // réservées à l'administrateur (payer, supprimer, dépense imprévue).
  const canViewPurchases = canManage || accessRole === "works_manager";
  const [staffMembers, setStaffMembers] = useState(initialStaffMembers);
  const [attendance, setAttendance] = useState(initialAttendance);
  const [materialOrders, setMaterialOrders] = useState(initialMaterialOrders);
  const [salaryPayments, setSalaryPayments] = useState(initialSalaryPayments);
  const [laborRateOverrides, setLaborRateOverrides] = useState(initialLaborRateOverrides ?? []);
  const [assignments, setAssignments] = useState(initialAssignments ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);

  const [viewingRates, setViewingRates] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<Record<string, { daily: string; monthly: string }>>({});
  const [viewingSalaryHistory, setViewingSalaryHistory] = useState(false);
  const [viewingSalaryDetail, setViewingSalaryDetail] = useState<SalaryPayment | null>(null);
  const [addingMisc, setAddingMisc] = useState(false);
  const [miscDraft, setMiscDraft] = useState({ recipient: "", amount: "", note: "" });
  const [confirmingMisc, setConfirmingMisc] = useState(false);
  const [revealedRowKey, setRevealedRowKey] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<{ type: "salary" | "order"; id: string; label: string } | null>(null);

  const nowMonthKey = new Date().toISOString().slice(0, 7);
  const [periodMonth, setPeriodMonth] = useState(nowMonthKey);
  const [viewingEmployeeDetail, setViewingEmployeeDetail] = useState<SalaryRow | null>(null);
  const [advanceDraft, setAdvanceDraft] = useState<{ amount: string; note: string; method: "cash" | "mvola" | "other" }>({ amount: "", note: "", method: "cash" });
  const [viewingMvolaConfirm, setViewingMvolaConfirm] = useState(false);
  const [viewingExport, setViewingExport] = useState(false);
  const [confirmingCashPay, setConfirmingCashPay] = useState<{ row: SalaryRow; method: "cash" | "other" } | null>(null);

  // Toute la page doit refléter en direct ce que fait un autre poste
  // (nouvel achat, salaire payé ailleurs, présence cochée, employé ajouté),
  // sans recharger — même principe que l'Espace chantier.
  useEffect(() => {
    const channel = supabase
      .channel(`project-expenses-orders-${project.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_material_orders", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as MaterialOrder;
          setMaterialOrders((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_material_orders", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as MaterialOrder;
          setMaterialOrders((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project.id, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-expenses-salaries-${project.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_salary_payments", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as SalaryPayment;
          setSalaryPayments((rows) => rows.some((item) => item.id === row.id) ? rows : [{ ...row, project_salary_payment_lines: [] }, ...rows]);
          void supabase.from("project_salary_payment_lines").select("*").eq("payment_id", row.id).then(({ data }) => {
            setSalaryPayments((rows) => rows.map((item) => item.id === row.id ? { ...item, project_salary_payment_lines: data ?? [] } : item));
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_salary_payments", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as SalaryPayment;
          setSalaryPayments((rows) => rows.map((item) => item.id === row.id ? { ...item, ...row } : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project.id, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-expenses-rates-${project.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_labor_rates", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as LaborRateOverride;
          setLaborRateOverrides((rows) => rows.some((item) => item.id === row.id) ? rows : [...rows, row]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_labor_rates", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as LaborRateOverride;
          setLaborRateOverrides((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project.id, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-expenses-staff-${project.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_staff_members", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as StaffMember;
          setStaffMembers((rows) => rows.some((item) => item.id === row.id) ? rows : [...rows, row]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_staff_members", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as StaffMember;
          setStaffMembers((rows) => row.active ? rows.map((item) => item.id === row.id ? row : item) : rows.filter((item) => item.id !== row.id));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project.id, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-expenses-attendance-${project.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_daily_attendance", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as Attendance;
          setAttendance((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_daily_attendance", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as Attendance;
          setAttendance((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project.id, supabase]);

  // Conducteur(s)/chef(s) actifs : un nouvel accès créé ou retiré ailleurs
  // (Espace chantier) doit se refléter dans la paie sans recharger.
  useEffect(() => {
    const channel = supabase
      .channel(`project-expenses-team-${project.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_assignments", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as ConductorAssignment;
          if (!row.active || !["works_manager", "site_manager"].includes(row.role)) return;
          setAssignments((rows) => rows.some((item) => item.id === row.id) ? rows : [...rows, row]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_assignments", filter: `project_id=eq.${project.id}` },
        (payload) => {
          const row = payload.new as ConductorAssignment;
          setAssignments((rows) => {
            if (!row.active || !["works_manager", "site_manager"].includes(row.role)) return rows.filter((item) => item.id !== row.id);
            return rows.some((item) => item.id === row.id) ? rows.map((item) => item.id === row.id ? { ...item, ...row } : item) : [...rows, row];
          });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project.id, supabase]);

  // Priorité au taux défini manuellement pour ce poste (bouton "Taux") ; à
  // défaut, on retombe sur l'ancien rapprochement avec le devis interne
  // (désignation de la ligne main-d'œuvre, texte libre, sans accents/majuscules).
  function matchLaborRate(roleName: string): number | null {
    const role = normalize(roleName || "");
    if (!role) return null;
    const override = laborRateOverrides.find((item) => normalize(item.role_name) === role);
    if (override) {
      if (number(override.daily_rate) > 0) return number(override.daily_rate);
      if (override.monthly_rate && number(override.monthly_rate) > 0) return number(override.monthly_rate) / 26;
    }
    const match = laborRates.find((line) => {
      const designation = normalize(line.designation);
      return designation.includes(role) || role.includes(designation.split(/[—-]/)[0].trim());
    });
    if (!match) return null;
    const price = number(match.unitPrice);
    return price > 0 ? price : null;
  }

  const presentRoles: string[] = Array.from(new Set<string>([
    ...assignments.map((item) => item.role === "works_manager" ? "Conducteur" : "Chef de chantier"),
    ...staffMembers
      .filter((item) => item.active !== false)
      .map((item) => (item.role_name || "Ouvrier").trim())
      .filter((role): role is string => role.length > 0),
  ])).sort((a, b) => a.localeCompare(b, "fr"));

  function openRatesModal() {
    const drafts: Record<string, { daily: string; monthly: string }> = {};
    for (const role of presentRoles) {
      const existing = laborRateOverrides.find((item) => normalize(item.role_name) === normalize(role));
      drafts[role] = { daily: existing?.daily_rate ? String(existing.daily_rate) : "", monthly: existing?.monthly_rate ? String(existing.monthly_rate) : "" };
    }
    setRateDrafts(drafts);
    setViewingRates(true);
  }

  async function saveLaborRate(roleName: string) {
    if (!canManage) return;
    const draft = rateDrafts[roleName] || { daily: "", monthly: "" };
    setBusy(true);
    const { data, error } = await supabase.from("project_labor_rates").upsert({
      organization_id: project.organization_id,
      project_id: project.id,
      role_name: roleName,
      daily_rate: Number(draft.daily) || 0,
      monthly_rate: draft.monthly ? Number(draft.monthly) : null,
      created_by: userId,
    }, { onConflict: "project_id,role_name" }).select().single();
    setBusy(false);
    if (error || !data) { setMessage({ kind: "error", text: `Taux non enregistré : ${error?.message ?? "erreur inconnue"}` }); return; }
    setLaborRateOverrides((rows) => rows.some((item) => item.id === data.id) ? rows.map((item) => item.id === data.id ? data : item) : [...rows, data]);
    setMessage({ kind: "success", text: `Taux enregistré pour "${roleName}".` });
  }

  // --- Période de paie (mois en cours par défaut, choix possible d'un autre mois) ---
  const periodStart = `${periodMonth}-01`;
  const isCurrentPeriod = periodMonth === nowMonthKey;
  const periodEnd = isCurrentPeriod
    ? new Date().toISOString().slice(0, 10)
    : new Date(Number(periodMonth.slice(0, 4)), Number(periodMonth.slice(5, 7)), 0).toISOString().slice(0, 10);

  function isPaidThisPeriod(kind: "staff" | "assignment", id: string) {
    return salaryPayments.some((payment) => !payment.deleted_at && !payment.is_advance && payment.period_month === periodStart &&
      payment.project_salary_payment_lines.some((line) => kind === "staff" ? line.staff_member_id === id : line.assignment_id === id));
  }

  // Un ouvrier n'a de jour "travaillé" que s'il a été pointé présent ; un
  // conducteur/chef est considéré présent chaque jour de sa mission active,
  // comme pour la Présence du jour de l'Espace chantier (pas de pointage).
  const staffRows: SalaryRow[] = staffMembers.filter((staff) => staff.active !== false).map((staff) => {
    const daysWorked = attendance.filter((item) => item.staff_member_id === staff.id && item.present && item.report_date >= periodStart && item.report_date <= periodEnd).length;
    const dailyRate = matchLaborRate(staff.role_name || "");
    return {
      key: `staff-${staff.id}`, kind: "staff" as const, refId: staff.id, name: staff.full_name, roleName: staff.role_name || "Ouvrier",
      phone: staff.mvola_number || null, mvolaEnabled: Boolean(staff.mvola_enabled && staff.mvola_number), callEnabled: Boolean(staff.call_enabled && staff.mvola_number),
      dailyRate, daysWorked, amount: dailyRate ? dailyRate * daysWorked : 0, alreadyPaid: isPaidThisPeriod("staff", staff.id),
    };
  });
  const assignmentRows: SalaryRow[] = assignments.map((assignment) => {
    const startedAt = assignment.created_at ? assignment.created_at.slice(0, 10) : periodStart;
    const effectiveStart = startedAt > periodStart ? startedAt : periodStart;
    const daysWorked = effectiveStart > periodEnd ? 0 : Math.floor((new Date(periodEnd).getTime() - new Date(effectiveStart).getTime()) / 86400000) + 1;
    const roleName = assignment.role === "works_manager" ? "Conducteur" : "Chef de chantier";
    const dailyRate = matchLaborRate(roleName);
    return {
      key: `assignment-${assignment.id}`, kind: "assignment" as const, refId: assignment.id, name: assignment.displayName || roleName, roleName,
      phone: assignment.phone_number || null, mvolaEnabled: Boolean(assignment.mvola_enabled && assignment.phone_number), callEnabled: Boolean(assignment.call_enabled && assignment.phone_number),
      dailyRate, daysWorked, amount: dailyRate ? dailyRate * daysWorked : 0, alreadyPaid: isPaidThisPeriod("assignment", assignment.id),
    };
  });
  const salaryRows: SalaryRow[] = [...assignmentRows, ...staffRows];
  const presentRows = salaryRows.filter((row) => row.daysWorked > 0);
  const payableRows = presentRows.filter((row) => !row.alreadyPaid);
  const mvolaPayable = payableRows.filter((row) => row.mvolaEnabled);
  const salaryTotal = presentRows.reduce((sum, row) => sum + row.amount, 0);

  const employeeHistory = viewingEmployeeDetail
    ? salaryPayments
      .filter((payment) => !payment.deleted_at)
      .flatMap((payment) => payment.project_salary_payment_lines
        .filter((line) => viewingEmployeeDetail.kind === "staff" ? line.staff_member_id === viewingEmployeeDetail.refId : line.assignment_id === viewingEmployeeDetail.refId)
        .map((line) => ({ ...line, paid_at: payment.paid_at, is_advance: Boolean(payment.is_advance), payment_method: payment.payment_method })))
      .sort((a, b) => b.paid_at.localeCompare(a.paid_at))
    : [];

  const activeOrders = materialOrders.filter((order) => !order.deleted_at);
  const pendingOrders = activeOrders.filter((order) => ["draft", "requested", "submitted", "approved", "covered_by_stock"].includes(order.status));
  const paidOrders = activeOrders.filter((order) => order.status === "paid");
  const activeSalaryPayments = salaryPayments.filter((payment) => !payment.deleted_at);

  // Un même matériau peut être acheté plusieurs fois (plusieurs lignes dans
  // Dépenses effectuées) : ici on les combine par matériau pour n'avoir
  // qu'un seul total de quantité déjà utilisée/achetée sur ce chantier.
  const materialUsageTotals = (() => {
    const map = new Map<string, { key: string; name: string; unit: string; quantity: number }>();
    for (const order of paidOrders) {
      if ((order.expense_kind || "material") !== "material") continue;
      const key = (order.material_key || normalize(order.material_name)).trim();
      if (!key) continue;
      const existing = map.get(key);
      if (existing) existing.quantity += number(order.quantity);
      else map.set(key, { key, name: order.material_name, unit: order.unit || "", quantity: number(order.quantity) });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  })();

  type RecapRow = { key: string; type: "salary" | "order"; id: string; date: string; label: string; qty: string; amount: number };
  const recapRows: RecapRow[] = [
    ...activeSalaryPayments.map((payment) => {
      const totalDays = payment.project_salary_payment_lines.reduce((sum, line) => sum + number(line.days_worked), 0);
      return { key: `salary-${payment.id}`, type: "salary" as const, id: payment.id, date: payment.paid_at, label: paymentLabel(payment), qty: `${totalDays} j-personne`, amount: number(payment.total_amount) };
    }),
    ...paidOrders.map((order) => ({ key: `order-${order.id}`, type: "order" as const, id: order.id, date: order.paid_at || order.submitted_at || "", label: orderLabel(order), qty: `${number(order.quantity)} ${order.unit || ""}`.trim(), amount: orderTotal(order) })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const recapTotal = recapRows.reduce((sum, row) => sum + row.amount, 0);

  async function insertSalaryPayment(rows: SalaryRow[], options: { paymentMethod: "mvola" | "cash" | "other" | null; isAdvance?: boolean; advanceNote?: string }) {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const { data: payment, error } = await supabase.from("project_salary_payments").insert({
      organization_id: project.organization_id,
      project_id: project.id,
      paid_by: userId,
      total_amount: total,
      period_month: options.isAdvance ? null : periodStart,
      payment_method: options.paymentMethod,
      is_advance: options.isAdvance ?? false,
    }).select().single();
    if (error || !payment) return { error };
    const lines = rows.map((row) => ({
      payment_id: payment.id,
      staff_member_id: row.kind === "staff" ? row.refId : null,
      assignment_id: row.kind === "assignment" ? row.refId : null,
      full_name: row.name,
      role_name: row.roleName,
      daily_rate: row.dailyRate || 0,
      days_worked: row.daysWorked,
      amount: row.amount,
      mvola_number: row.phone,
      note: options.advanceNote ?? null,
    }));
    const { data: insertedLines, error: linesError } = await supabase.from("project_salary_payment_lines").insert(lines).select();
    if (linesError) return { error: linesError };
    setSalaryPayments((rows2) => [{ ...payment, project_salary_payment_lines: insertedLines ?? [] }, ...rows2]);
    return { payment };
  }

  async function payMvolaGroup() {
    if (!canManage || !mvolaPayable.length) return;
    setBusy(true);
    setMessage({ kind: "info", text: "Enregistrement du paiement Mvola…" });
    const { error } = await insertSalaryPayment(mvolaPayable, { paymentMethod: "mvola" });
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Paiement non enregistré : ${error.message}` }); return; }
    setViewingMvolaConfirm(false);
    setMessage({ kind: "success", text: `Paiement Mvola de ${mvolaPayable.length} personne(s) envoyé au compte dépense générale.` });
  }

  function requestCashPayment(row: SalaryRow) {
    if (!canManage || row.alreadyPaid || row.daysWorked === 0) return;
    setConfirmingCashPay({ row, method: "cash" });
  }

  async function confirmCashPayment() {
    if (!confirmingCashPay) return;
    setBusy(true);
    const { error } = await insertSalaryPayment([confirmingCashPay.row], { paymentMethod: confirmingCashPay.method });
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Paiement non enregistré : ${error.message}` }); return; }
    setMessage({ kind: "success", text: `Paiement de ${confirmingCashPay.row.name} enregistré et envoyé au compte dépense générale.` });
    setConfirmingCashPay(null);
  }

  async function submitAdvance() {
    if (!viewingEmployeeDetail) return;
    const amount = number(advanceDraft.amount);
    if (amount <= 0) { setMessage({ kind: "error", text: "Indiquez un montant supérieur à zéro." }); return; }
    setBusy(true);
    const row = viewingEmployeeDetail;
    const { error } = await insertSalaryPayment(
      [{ ...row, amount, daysWorked: 0 }],
      { paymentMethod: advanceDraft.method, isAdvance: true, advanceNote: advanceDraft.note.trim() || "Acompte" },
    );
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Acompte non enregistré : ${error.message}` }); return; }
    setAdvanceDraft({ amount: "", note: "", method: "cash" });
    setMessage({ kind: "success", text: `Acompte de ${money(amount)} enregistré pour ${row.name}, envoyé au compte dépense générale.` });
  }

  function exportExcel() {
    if (!presentRows.length) { setMessage({ kind: "error", text: "Personne présent pour ce mois-ci." }); return; }
    import("xlsx").then((XLSX) => {
      const todayLabel = dateFmt.format(new Date());
      const generalRows = presentRows.map((row) => ({
        Nom: row.name,
        Motif: "Salaire",
        "Jours de présence": row.daysWorked,
        "Salaire journalier (avec repas)": row.dailyRate ?? 0,
        Total: row.amount,
        "Mvola / Appel": mvolaAppelLabel(row),
        Téléphone: row.phone || "",
      }));
      const mvolaRows = presentRows.filter((row) => row.mvolaEnabled).map((row) => ({ Nom: row.name, Raison: `Salaire ${todayLabel}`, Téléphone: row.phone || "" }));
      const cashRows = presentRows.filter((row) => !row.mvolaEnabled).map((row) => ({ Nom: row.name, Payé: row.alreadyPaid ? "Oui" : "Non" }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(generalRows), "Salaires");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(mvolaRows), "Paye Mvola");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(cashRows), "Especes - Autre");
      XLSX.writeFile(workbook, `salaires-${project.name.replace(/[^a-zA-Z0-9]+/g, "-")}-${periodMonth}.xlsx`);
    });
  }

  async function submitMiscExpense() {
    const amount = number(miscDraft.amount);
    if (!miscDraft.recipient.trim() || amount <= 0) { setMessage({ kind: "error", text: "Indiquez le nom du bénéficiaire et un montant supérieur à zéro." }); return; }
    setBusy(true);
    const { data, error } = await supabase.from("project_material_orders").insert({
      organization_id: project.organization_id,
      project_id: project.id,
      material_name: "Autre",
      material_key: "autre",
      unit: "U",
      quantity: 1,
      unit_price: amount,
      status: "paid",
      expense_kind: "other",
      recipient_name: miscDraft.recipient.trim(),
      notes: miscDraft.note.trim() || null,
      requested_by: userId,
      validated_by: userId,
      paid_at: new Date().toISOString(),
    }).select().single();
    setBusy(false);
    setConfirmingMisc(false);
    if (error) { setMessage({ kind: "error", text: `Dépense non enregistrée : ${error.message}` }); return; }
    setMaterialOrders((rows) => [data as MaterialOrder, ...rows]);
    setMiscDraft({ recipient: "", amount: "", note: "" });
    setAddingMisc(false);
    setMessage({ kind: "success", text: "Dépense imprévue enregistrée dans le compte dépense générale." });
  }

  async function confirmDeleteRow() {
    if (!confirmingDelete) return;
    setBusy(true);
    const table = confirmingDelete.type === "salary" ? "project_salary_payments" : "project_material_orders";
    const { error } = await supabase.from(table).update({ deleted_at: new Date().toISOString(), deleted_by: userId }).eq("id", confirmingDelete.id);
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Suppression impossible : ${error.message}` }); return; }
    if (confirmingDelete.type === "salary") setSalaryPayments((rows) => rows.map((row) => row.id === confirmingDelete.id ? { ...row, deleted_at: new Date().toISOString() } : row));
    else setMaterialOrders((rows) => rows.map((row) => row.id === confirmingDelete.id ? { ...row, deleted_at: new Date().toISOString() } : row));
    setConfirmingDelete(null);
    setRevealedRowKey(null);
    setMessage({ kind: "success", text: "Ligne supprimée du compte dépense générale." });
  }

  return <div className="projectSitePage">
    <header className="projectSiteHeader">
      <div><p className="projectEyebrow">DÉPENSES ET APPROVISIONNEMENT</p><h1>{project.name}</h1><p>{project.project_code || ""}</p></div>
      <div className="projectHeaderActions"><Link className="projectBackLink" href="/expenses">← Retour aux dépenses</Link></div>
    </header>
    {message && <div className="notice">{message.text}</div>}

    <div className="projectSiteGrid">
      {canManage && <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">SALAIRE</p><h2>Salaire employés</h2></div><span>{money(salaryTotal)}</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: ".85rem", fontWeight: 600 }}>Période
            <input type="month" value={periodMonth} max={nowMonthKey} onChange={(event) => setPeriodMonth(event.target.value || nowMonthKey)} />
          </label>
        </div>
        <p className="projectHint">Calculé depuis le taux du poste (bouton "Taux") ou, à défaut, depuis le devis interne, et la présence déclarée. Inclut conducteur et chef, comme la Présence du jour. Cliquez un nom pour voir le détail ou ajouter un acompte.</p>
        <div className="projectStockSummaryList">{presentRows.length ? presentRows.map((row) => <div key={row.key} style={{ cursor: "pointer" }} onClick={() => { setViewingEmployeeDetail(row); setAdvanceDraft({ amount: "", note: "", method: "cash" }); }}>
          <span className="chipName">{row.name} <small style={{ color: "#8a5b08" }}>{row.roleName}</small></span>
          <span className="chipQty" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {row.daysWorked} j{row.dailyRate ? ` · ${money(row.dailyRate)}/j · ${money(row.amount)}` : " · taux non défini"}
            {row.alreadyPaid ? <span className="projectChecklistBadge">Payé</span> : (canManage && !row.mvolaEnabled && <button type="button" className="secondary" style={{ padding: "4px 8px", fontSize: ".7rem" }} onClick={(event) => { event.stopPropagation(); requestCashPayment(row); }}>Marquer payé</button>)}
          </span>
        </div>) : <p className="projectEmptyText">Personne présent sur ce chantier pour ce mois.</p>}</div>
        {canManage && <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "12px", marginBottom: "10px" }}>
          <button type="button" className="secondary" onClick={openRatesModal}>Taux</button>
          <button type="button" className="secondary" onClick={() => setViewingExport(true)}>Aperçu / Excel</button>
          <button type="button" disabled={!mvolaPayable.length || busy} onClick={() => setViewingMvolaConfirm(true)}>Payer par Mvola{mvolaPayable.length ? ` (${mvolaPayable.length})` : ""}</button>
        </div>}
        <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingSalaryHistory(true)}>Voir l’historique</button>
      </section>}

      {canViewPurchases && <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">À VALIDER</p><h2>Demandes en cours</h2></div><span>{pendingOrders.length}</span></div>
        <div className="projectStockSummaryList">{pendingOrders.length ? pendingOrders.map((order) => <div key={order.id}>
          <span className="chipName">{orderLabel(order)}</span><span className="chipQty">{number(order.quantity)} {order.unit || ""} · {money(orderTotal(order))}</span>
        </div>) : <p className="projectEmptyText">Aucune demande en cours.</p>}</div>
      </section>}

      {canViewPurchases && <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">ACHATS PAYÉS</p><h2>Dépenses effectuées</h2></div><span>{money(paidOrders.reduce((sum, order) => sum + orderTotal(order), 0))}</span></div>
        <div className="projectStockSummaryList">{paidOrders.length ? paidOrders.map((order) => <div key={order.id}>
          <span className="chipName">{orderReason(order)} — {orderLabel(order)}</span><span className="chipQty">{number(order.quantity)} {order.unit || ""} · {money(orderTotal(order))}</span>
        </div>) : <p className="projectEmptyText">Aucun achat payé.</p>}</div>
      </section>}

      {canManage && <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">IMPRÉVU</p><h2>Dépenses imprévues</h2></div></div>
        <p className="projectHint">Cadeaux ou toute dépense hors matériau/salaire. Envoyée directement au compte dépense générale après confirmation.</p>
        {addingMisc ? <>
          <div className="projectMaterialForm">
            <input placeholder="Nom du bénéficiaire ou organisme" value={miscDraft.recipient} onChange={(event) => setMiscDraft((draft) => ({ ...draft, recipient: event.target.value }))} />
            <input type="number" min="0" step="any" placeholder="Montant (Ar)" value={miscDraft.amount} onChange={(event) => setMiscDraft((draft) => ({ ...draft, amount: event.target.value }))} />
            <input placeholder="Note (facultatif)" value={miscDraft.note} onChange={(event) => setMiscDraft((draft) => ({ ...draft, note: event.target.value }))} />
            <button type="button" disabled={busy} onClick={() => setConfirmingMisc(true)}>Valider</button>
          </div>
          <button type="button" className="ghostButton mt-2" onClick={() => setAddingMisc(false)}>Annuler</button>
        </> : <button type="button" onClick={() => setAddingMisc(true)}>+ Ajouter une dépense imprévue</button>}
      </section>}

      <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">MATÉRIAUX</p><h2>Dépense matériaux</h2></div></div>
        <p className="projectHint">Quantité totale déjà achetée/utilisée de chaque matériau sur ce chantier, tous achats combinés.</p>
        <div className="projectStockSummaryList">{materialUsageTotals.length ? materialUsageTotals.map((item) => <div key={item.key}>
          <span className="chipName">{item.name}</span><span className="chipQty">{item.quantity} {item.unit}</span>
        </div>) : <p className="projectEmptyText">Aucun matériau acheté pour l’instant.</p>}</div>
      </section>
    </div>

    <section className="projectSiteCard expenseRecap" style={{ marginTop: "18px" }}>
      <div className="projectCardHead"><div><p className="projectEyebrow">RÉCAPITULATIF GÉNÉRAL</p><h2>Compte dépense générale</h2></div><span>{money(recapTotal)}</span></div>
      <p className="projectHint">Ne liste que ce qui est déjà payé (salaires, acomptes, achats, transport, imprévus). Cliquez une ligne pour la supprimer.</p>
      <div className="projectStockSummaryList" style={{ maxHeight: "420px" }}>{recapRows.length ? recapRows.map((row) => <div key={row.key} style={{ cursor: "pointer" }} onClick={() => setRevealedRowKey((current) => current === row.key ? null : row.key)}>
        <span className="chipName">{row.date ? dateFmt.format(new Date(row.date)) : "—"} · {row.label}</span>
        <span className="chipQty" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {row.qty} · {money(row.amount)}
          {canManage && revealedRowKey === row.key && <button type="button" className="projectRejectButton" style={{ padding: "4px 8px", fontSize: ".7rem" }} onClick={(event) => { event.stopPropagation(); setConfirmingDelete({ type: row.type, id: row.id, label: row.label }); }}>Supprimer</button>}
        </span>
      </div>) : <p className="projectEmptyText">Aucune dépense enregistrée pour l’instant.</p>}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "12px", borderTop: "2px solid #145b35" }}>
        <strong style={{ fontSize: "1rem" }}>TOTAL GÉNÉRAL DES DÉPENSES</strong>
        <strong style={{ fontSize: "1.35rem", color: "#0b3920" }}>{money(recapTotal)}</strong>
      </div>
    </section>

    {viewingRates && <div className="modalBackdrop" onClick={() => setViewingRates(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(520px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Taux par poste</h2>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        <p className="projectHint">Indiquez le montant journalier (ou mensuel — le journalier est déduit sur 26 jours si le journalier n’est pas rempli) pour chaque poste présent sur ce chantier, y compris Conducteur et Chef de chantier.</p>
        {presentRoles.length ? presentRoles.map((role) => <div key={role} className="formRow" style={{ alignItems: "end", marginBottom: "10px" }}>
          <label style={{ gridColumn: "1 / -1", fontWeight: 700 }}>{role}</label>
          <label>Par jour<input type="number" min="0" step="0.01" value={rateDrafts[role]?.daily ?? ""} onChange={(event) => setRateDrafts((drafts) => ({ ...drafts, [role]: { daily: event.target.value, monthly: drafts[role]?.monthly ?? "" } }))} /></label>
          <label>Par mois<input type="number" min="0" step="0.01" value={rateDrafts[role]?.monthly ?? ""} onChange={(event) => setRateDrafts((drafts) => ({ ...drafts, [role]: { daily: drafts[role]?.daily ?? "", monthly: event.target.value } }))} /></label>
          <button type="button" className="secondary" disabled={busy} onClick={() => void saveLaborRate(role)}>Enregistrer</button>
        </div>) : <p className="projectEmptyText">Aucun poste déclaré pour l’instant sur ce chantier.</p>}
      </div>
      {message && <p className={`projectAccessStatus ${message.kind}`} style={{ flex: "0 0 auto", marginTop: "10px" }}>{message.text}</p>}
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingRates(false)}>Fermer</button>
    </div></div>}

    {viewingMvolaConfirm && <div className="modalBackdrop" onClick={() => setViewingMvolaConfirm(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Confirmer le paiement groupé par Mvola</h2>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        <p className="projectHint">Ce bouton ne déclenche aucun transfert Mvola réel — il certifie que vous avez payé, et envoie le détail au compte dépense générale.</p>
        <div className="projectStockSummaryList">{mvolaPayable.map((row) => <div key={row.key}><span className="chipName">{row.name}</span><span className="chipQty">{money(row.amount)}</span></div>)}</div>
      </div>
      {message && <p className={`projectAccessStatus ${message.kind}`} style={{ flex: "0 0 auto", marginTop: "10px" }}>{message.text}</p>}
      <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
        <button type="button" disabled={busy} onClick={() => void payMvolaGroup()}>{busy ? "Envoi…" : `Confirmer — ${money(mvolaPayable.reduce((sum, row) => sum + row.amount, 0))}`}</button>
        <button type="button" className="ghostButton" onClick={() => setViewingMvolaConfirm(false)}>Annuler</button>
      </div>
    </div></div>}

    {confirmingCashPay && <div className="modalBackdrop" onClick={() => setConfirmingCashPay(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Confirmer le paiement</h2>
      <p className="projectHint">{confirmingCashPay.row.name} — {money(confirmingCashPay.row.amount)}. Ce paiement sera comptabilisé immédiatement dans le compte dépense générale.</p>
      <label>Mode de paiement<select value={confirmingCashPay.method} onChange={(event) => setConfirmingCashPay((current) => current ? { ...current, method: event.target.value as "cash" | "other" } : current)}><option value="cash">Espèces</option><option value="other">Autre</option></select></label>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" disabled={busy} onClick={() => void confirmCashPayment()}>Valider</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingCashPay(null)}>Annuler</button>
      </div>
    </div></div>}

    {viewingExport && <div className="modalBackdrop" onClick={() => setViewingExport(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(620px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Aperçu export salaires — {periodMonth}</h2>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        <h3>Feuille 1 — Salaires</h3>
        <div className="projectStockSummaryList">{presentRows.length ? presentRows.map((row) => <div key={row.key}>
          <span className="chipName">{row.name} <small style={{ color: "#8a5b08" }}>{row.roleName}</small></span>
          <span className="chipQty">{row.daysWorked} j · {money(row.amount)} · {mvolaAppelLabel(row)}</span>
        </div>) : <p className="projectEmptyText">Personne présent ce mois-ci.</p>}</div>
        <h3 style={{ marginTop: "16px" }}>Feuille 2 — Paye Mvola</h3>
        <div className="projectStockSummaryList">{presentRows.filter((row) => row.mvolaEnabled).length ? presentRows.filter((row) => row.mvolaEnabled).map((row) => <div key={row.key}>
          <span className="chipName">{row.name}</span><span className="chipQty">{row.phone || "—"}</span>
        </div>) : <p className="projectEmptyText">Aucun profil compatible Mvola.</p>}</div>
        <h3 style={{ marginTop: "16px" }}>Feuille 3 — Espèces / Autre</h3>
        <div className="projectStockSummaryList">{presentRows.filter((row) => !row.mvolaEnabled).length ? presentRows.filter((row) => !row.mvolaEnabled).map((row) => <div key={row.key}>
          <span className="chipName">{row.name}</span>
          <span className="chipQty"><label className="projectInlineCheck"><input type="checkbox" checked={row.alreadyPaid} disabled={!canManage || row.alreadyPaid} onChange={() => requestCashPayment(row)} /> Payé</label></span>
        </div>) : <p className="projectEmptyText">Tout le monde est compatible Mvola.</p>}</div>
      </div>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
        <button type="button" onClick={exportExcel}>Télécharger le fichier Excel</button>
        <button type="button" className="ghostButton" onClick={() => setViewingExport(false)}>Fermer</button>
      </div>
    </div></div>}

    {viewingEmployeeDetail && <div className="modalBackdrop" onClick={() => setViewingEmployeeDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>{viewingEmployeeDetail.name}</h2>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        <p className="projectHint">{viewingEmployeeDetail.roleName}{viewingEmployeeDetail.phone ? ` · ${viewingEmployeeDetail.phone}` : ""}</p>
        <div className="priceDetailStat"><span>Ce mois-ci</span><strong>{viewingEmployeeDetail.daysWorked} j · {money(viewingEmployeeDetail.amount)}{viewingEmployeeDetail.alreadyPaid ? " · déjà payé" : ""}</strong></div>
        {canManage && <>
          <h3 style={{ marginTop: "16px" }}>Ajouter un acompte ou paiement ponctuel</h3>
          <div className="projectMaterialForm">
            <input type="number" min="0" step="any" placeholder="Montant (Ar)" value={advanceDraft.amount} onChange={(event) => setAdvanceDraft((draft) => ({ ...draft, amount: event.target.value }))} />
            <input placeholder="Motif (ex : acompte, avance)" value={advanceDraft.note} onChange={(event) => setAdvanceDraft((draft) => ({ ...draft, note: event.target.value }))} />
            <select value={advanceDraft.method} onChange={(event) => setAdvanceDraft((draft) => ({ ...draft, method: event.target.value as "cash" | "mvola" | "other" }))}>
              <option value="cash">Espèces</option><option value="mvola">Mvola</option><option value="other">Autre</option>
            </select>
            <button type="button" disabled={busy} onClick={() => void submitAdvance()}>Enregistrer</button>
          </div>
        </>}
        <h3 style={{ marginTop: "16px" }}>Historique</h3>
        <div className="projectStockSummaryList">{employeeHistory.length ? employeeHistory.map((line) => <div key={line.id}>
          <span className="chipName">{dateFmt.format(new Date(line.paid_at))} · {line.is_advance ? (line.note || "Acompte") : "Salaire"}</span>
          <span className="chipQty">{money(number(line.amount))}</span>
        </div>) : <p className="projectEmptyText">Aucun paiement enregistré.</p>}</div>
      </div>
      {message && <p className={`projectAccessStatus ${message.kind}`} style={{ flex: "0 0 auto", marginTop: "10px" }}>{message.text}</p>}
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingEmployeeDetail(null)}>Fermer</button>
    </div></div>}

    {viewingSalaryHistory && <div className="modalBackdrop" onClick={() => setViewingSalaryHistory(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Historique des paiements de salaire</h2>
      <div className="projectStockSummaryList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{activeSalaryPayments.length ? activeSalaryPayments.map((payment) => <div key={payment.id} style={{ cursor: "pointer" }} onClick={() => setViewingSalaryDetail(payment)}>
        <span className="chipName">{dateFmt.format(new Date(payment.paid_at))} · {paymentLabel(payment)}</span><span className="chipQty">{money(number(payment.total_amount))}</span>
      </div>) : <p className="projectEmptyText">Aucun paiement pour l’instant.</p>}</div>
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingSalaryHistory(false)}>Fermer</button>
    </div></div>}

    {viewingSalaryDetail && <div className="modalBackdrop" onClick={() => setViewingSalaryDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Paiement du {dateFmt.format(new Date(viewingSalaryDetail.paid_at))}</h2>
      <div className="projectStockSummaryList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{viewingSalaryDetail.project_salary_payment_lines.map((line) => <div key={line.id}>
        <span className="chipName">{line.full_name} <small style={{ color: "#8a5b08" }}>{line.role_name}</small></span><span className="chipQty">{line.days_worked ? `${line.days_worked} j × ${money(line.daily_rate)} = ` : ""}{money(line.amount)}</span>
      </div>)}</div>
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingSalaryDetail(null)}>Fermer</button>
    </div></div>}

    {confirmingMisc && <div className="modalBackdrop" onClick={() => setConfirmingMisc(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Confirmer la dépense</h2>
      <p className="projectHint">{miscDraft.recipient} — {money(number(miscDraft.amount))}. Envoyée directement au compte dépense générale, aucune validation supplémentaire.</p>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" disabled={busy} onClick={() => void submitMiscExpense()}>Confirmer</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingMisc(false)}>Annuler</button>
      </div>
    </div></div>}

    {confirmingDelete && <div className="modalBackdrop" onClick={() => setConfirmingDelete(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Supprimer cette ligne ?</h2>
      <p className="projectHint">"{confirmingDelete.label}" sera retirée du compte dépense générale. Cette action est réversible uniquement par un administrateur en base.</p>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" className="projectRejectButton" disabled={busy} onClick={() => void confirmDeleteRow()}>Supprimer</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingDelete(null)}>Annuler</button>
      </div>
    </div></div>}
  </div>;
}
