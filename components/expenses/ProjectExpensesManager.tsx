"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { RealtimeRefresh } from "@/components/realtime-refresh";

type RoleHistoryEntry = { role_name: string; effective_from: string };
type StaffMember = { id: string; project_id: string; full_name: string; role_name?: string | null; active?: boolean; mvola_number?: string | null; mvola_enabled?: boolean; call_enabled?: boolean; created_at?: string | null; linked_assignment_id?: string | null; role_history?: RoleHistoryEntry[] | null };
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
  // true si les jours comptés n'ont pas tous été payés au même taux (la
  // personne a changé de poste — donc de taux — pendant la période) :
  // dailyRate reste alors indicatif (poste actuel) mais amount seul fait foi.
  mixedRates: boolean;
  daysWorked: number;
  amount: number;
  alreadyPaid: boolean;
  // Pour le récapitulatif d'export : depuis quand la personne est comptée
  // (arrivée sur le chantier ou début de période, le plus tardif des deux)
  // et combien de jours ouvrés du chantier elle a manqués sur cette période.
  trackedDays: number;
  absenceDays: number;
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
  project: { id: string; name: string; project_code?: string | null; organization_id: string; location?: string | null; closed_at?: string | null };
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
  // Le conducteur (works_manager) a les mêmes droits que l'administrateur sur
  // la Dépense de son chantier (taux, paiements, acomptes, dépense imprévue,
  // export…), sauf la suppression d'une ligne du compte dépense générale,
  // qui reste réservée à l'administrateur (canDelete).
  const canManage = accessRole === "admin" || accessRole === "works_manager";
  const canDelete = accessRole === "admin";
  const canViewPurchases = canManage;
  const [staffMembers, setStaffMembers] = useState(initialStaffMembers);
  const [attendance, setAttendance] = useState(initialAttendance);
  const [materialOrders, setMaterialOrders] = useState(initialMaterialOrders);
  const [salaryPayments, setSalaryPayments] = useState(initialSalaryPayments);
  const [laborRateOverrides, setLaborRateOverrides] = useState(initialLaborRateOverrides ?? []);
  const [assignments, setAssignments] = useState(initialAssignments ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  // Clôture du chantier : bloque l'accès de tout le monde sauf l'administrateur
  // (voir aussi app/(dashboard)/projects/[id]/page.tsx et ProjectCard.tsx).
  const [closedAt, setClosedAt] = useState(project.closed_at ?? null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingReopen, setConfirmingReopen] = useState(false);
  // Si la clôture est faite ou annulée ailleurs (autre onglet, liste des
  // chantiers), RealtimeRefresh redemande la page côté serveur et ce prop
  // change : on garde l'état local synchronisé, sans rechargement complet.
  useEffect(() => { setClosedAt(project.closed_at ?? null); }, [project.closed_at]);

  const [viewingRates, setViewingRates] = useState(false);
  const [viewingGeneralExport, setViewingGeneralExport] = useState(false);
  const [exportGeneratedAt, setExportGeneratedAt] = useState<string | null>(null);
  const [rateDrafts, setRateDrafts] = useState<Record<string, { daily: string; monthly: string }>>({});
  const [viewingSalaryHistory, setViewingSalaryHistory] = useState(false);
  const [viewingSalaryDetail, setViewingSalaryDetail] = useState<SalaryPayment | null>(null);
  const [addingMisc, setAddingMisc] = useState(false);
  const [miscDraft, setMiscDraft] = useState({ recipient: "", amount: "", note: "" });
  const [confirmingMisc, setConfirmingMisc] = useState(false);
  const [revealedRowKey, setRevealedRowKey] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<{ type: "salary" | "order"; id: string; label: string } | null>(null);

  // Un clic sur une ligne du compte dépense générale révèle un petit bouton
  // "Supprimer" ; un clic en dehors de cette ligne le referme sans rien
  // supprimer (au lieu d'un bouton toujours visible).
  useEffect(() => {
    if (!revealedRowKey) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("[data-revealable]")) return;
      setRevealedRowKey(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [revealedRowKey]);

  const todayKey = new Date().toISOString().slice(0, 10);
  const nowMonthKey = new Date().toISOString().slice(0, 7);
  const [periodMonth, setPeriodMonth] = useState(nowMonthKey);
  const [viewingEmployeeDetail, setViewingEmployeeDetail] = useState<SalaryRow | null>(null);
  const [advanceDraft, setAdvanceDraft] = useState<{ amount: string; note: string; method: "cash" | "mvola" | "other" }>({ amount: "", note: "", method: "cash" });
  const [viewingMvolaConfirm, setViewingMvolaConfirm] = useState(false);
  const [viewingExport, setViewingExport] = useState(false);
  const [confirmingCashPay, setConfirmingCashPay] = useState<{ row: SalaryRow; method: "cash" | "other" } | null>(null);
  const [resumeExportAfterCashPay, setResumeExportAfterCashPay] = useState(false);

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

  // Le libellé d'un conducteur/chef reprend celui de sa fiche "Équipe
  // déclarée" liée (donc "Conducteur associé" si c'est le cas), avec
  // repli sur le libellé générique du rôle pour un accès pas encore lié.
  const roleNameForAssignment = (assignment: ConductorAssignment) =>
    staffMembers.find((item) => item.linked_assignment_id === assignment.id)?.role_name
    || (assignment.role === "works_manager" ? "Conducteur" : "Chef de chantier");

  // Une promotion (ouvrier → chef, conducteur → conducteur associé, etc.)
  // ne doit changer le taux de paye qu'à partir du jour du changement,
  // jamais rétroactivement sur des jours déjà travaillés sous l'ancien
  // poste : on retrouve donc, pour une date donnée, le poste réellement en
  // vigueur ce jour-là dans l'historique (role_history), pas le poste
  // actuel de la fiche.
  function roleOnDate(member: StaffMember, dateStr: string, fallbackRole: string): string {
    const history = Array.isArray(member.role_history) ? member.role_history : [];
    const applicable = history.filter((entry) => entry.effective_from <= dateStr).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
    return applicable[0]?.role_name || member.role_name || fallbackRole;
  }

  // Calcule la paye d'une personne jour par jour (chaque jour pointé
  // présent utilise le taux du poste qu'elle occupait CE jour-là), et
  // signale si plusieurs taux ont été utilisés sur la période (mixedRates)
  // pour ne pas afficher un "X FMG/j" trompeur dans ce cas.
  function payForPresentDays(member: StaffMember | null, presentDates: string[], fallbackRole: string) {
    let amount = 0;
    const ratesUsed = new Set<number>();
    for (const dateStr of presentDates) {
      const roleForDay = member ? roleOnDate(member, dateStr, fallbackRole) : fallbackRole;
      const rate = matchLaborRate(roleForDay) ?? 0;
      amount += rate;
      ratesUsed.add(rate);
    }
    const mixedRates = ratesUsed.size > 1;
    const currentRole = member ? roleOnDate(member, todayKey, fallbackRole) : fallbackRole;
    const dailyRate = matchLaborRate(currentRole);
    return { amount, dailyRate, mixedRates };
  }

  const presentRoles: string[] = Array.from(new Set<string>([
    ...assignments.map((item) => roleNameForAssignment(item)),
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

  // Jours suivis sur le chantier pendant la période : chaque date où au
  // moins une présence a été pointée (par n'importe qui). Sert à calculer
  // les absences d'un ouvrier sans compter les jours où le chantier
  // lui-même n'a rien enregistré (dimanche, jour férié, etc.).
  const trackedDatesInPeriod = Array.from(new Set(
    attendance.filter((item) => item.report_date >= periodStart && item.report_date <= periodEnd).map((item) => item.report_date),
  )).sort();

  // Un ouvrier n'a de jour "travaillé" que s'il a été pointé présent. Un
  // conducteur/chef fonctionne pareil, mais reste affiché comme une ligne
  // "accès" séparée ci-dessous (assignmentRows) — sa fiche "Équipe déclarée"
  // liée (linked_assignment_id) n'apparaît donc pas ici en double, elle sert
  // seulement à retrouver son pointage réel.
  const staffRows: SalaryRow[] = staffMembers.filter((staff) => staff.active !== false && !staff.linked_assignment_id).map((staff) => {
    const joinedAt = staff.created_at ? staff.created_at.slice(0, 10) : periodStart;
    const effectiveStart = joinedAt > periodStart ? joinedAt : periodStart;
    const presentDates = attendance.filter((item) => item.staff_member_id === staff.id && item.present && item.report_date >= periodStart && item.report_date <= periodEnd).map((item) => item.report_date);
    const daysWorked = presentDates.length;
    // Jours où le chantier a pointé quelqu'un, depuis l'arrivée de cette
    // personne : ce sont les jours où elle était censée être présente.
    const trackedDays = trackedDatesInPeriod.filter((date) => date >= effectiveStart).length;
    const absenceDays = Math.max(0, trackedDays - daysWorked);
    const { amount, dailyRate, mixedRates } = payForPresentDays(staff, presentDates, staff.role_name || "Ouvrier");
    return {
      key: `staff-${staff.id}`, kind: "staff" as const, refId: staff.id, name: staff.full_name, roleName: staff.role_name || "Ouvrier",
      phone: staff.mvola_number || null, mvolaEnabled: Boolean(staff.mvola_enabled && staff.mvola_number), callEnabled: Boolean(staff.call_enabled && staff.mvola_number),
      dailyRate, mixedRates, daysWorked, amount, alreadyPaid: isPaidThisPeriod("staff", staff.id),
      trackedDays, absenceDays,
    };
  });
  // Un conducteur/chef a désormais sa présence pointée exactement comme un
  // employé (voir l'Espace chantier, carte "Présence du jour"), via la fiche
  // "Équipe déclarée" liée à son accès : ses jours travaillés viennent de ce
  // pointage réel, plus jamais d'un simple décompte de jours calendaires
  // depuis la création de l'accès (ce qui comptait à tort un conducteur créé
  // avant même le démarrage du chantier comme déjà au travail).
  const assignmentRows: SalaryRow[] = assignments.map((assignment) => {
    const linkedStaff = staffMembers.find((item) => item.linked_assignment_id === assignment.id);
    const fallbackRole = assignment.role === "works_manager" ? "Conducteur" : "Chef de chantier";
    const roleName = linkedStaff?.role_name || fallbackRole;
    const joinedAt = linkedStaff?.created_at ? linkedStaff.created_at.slice(0, 10) : (assignment.created_at ? assignment.created_at.slice(0, 10) : periodStart);
    const effectiveStart = joinedAt > periodStart ? joinedAt : periodStart;
    const presentDates = linkedStaff
      ? attendance.filter((item) => item.staff_member_id === linkedStaff.id && item.present && item.report_date >= periodStart && item.report_date <= periodEnd).map((item) => item.report_date)
      : [];
    const daysWorked = presentDates.length;
    const trackedDays = trackedDatesInPeriod.filter((date) => date >= effectiveStart).length;
    const absenceDays = Math.max(0, trackedDays - daysWorked);
    const { amount, dailyRate, mixedRates } = payForPresentDays(linkedStaff ?? null, presentDates, fallbackRole);
    return {
      key: `assignment-${assignment.id}`, kind: "assignment" as const, refId: assignment.id, name: assignment.displayName || roleName, roleName,
      phone: assignment.phone_number || null, mvolaEnabled: Boolean(assignment.mvola_enabled && assignment.phone_number), callEnabled: Boolean(assignment.call_enabled && assignment.phone_number),
      dailyRate, mixedRates, daysWorked, amount, alreadyPaid: isPaidThisPeriod("assignment", assignment.id),
      trackedDays, absenceDays,
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
  // Trace de suppression : un paiement supprimé reste visible dans
  // l'historique (avec la date de suppression) au lieu de disparaître.
  const allSalaryPaymentsSorted = [...salaryPayments].sort((a, b) => b.paid_at.localeCompare(a.paid_at));

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

  type RecapCategory = "salaire" | "materiaux" | "transport" | "autre";
  type RecapRow = { key: string; type: "salary" | "order"; id: string; date: string; label: string; qty: string; amount: number; category: RecapCategory; outsideClosure: boolean };
  function orderCategory(order: MaterialOrder): RecapCategory {
    if (order.expense_kind === "transport") return "transport";
    if (order.expense_kind === "other") return "autre";
    return "materiaux";
  }
  // Une saisie faite hors ligne avant la clôture (par un appareil resté sans
  // réseau) est synchronisée normalement dès le retour de connexion, même
  // après la clôture. Si sa date dépasse la date de clôture, elle est quand
  // même comptée dans le total — juste signalée à part, en rouge, pour que
  // l'administrateur sache qu'elle est arrivée après coup.
  const outsideClosure = (date: string) => Boolean(closedAt && date && date > closedAt);
  const recapRows: RecapRow[] = [
    ...activeSalaryPayments.map((payment) => {
      const totalDays = payment.project_salary_payment_lines.reduce((sum, line) => sum + number(line.days_worked), 0);
      return { key: `salary-${payment.id}`, type: "salary" as const, id: payment.id, date: payment.paid_at, label: paymentLabel(payment), qty: `${totalDays} j-personne`, amount: number(payment.total_amount), category: "salaire" as const, outsideClosure: outsideClosure(payment.paid_at) };
    }),
    ...paidOrders.map((order) => { const date = order.paid_at || order.submitted_at || ""; return { key: `order-${order.id}`, type: "order" as const, id: order.id, date, label: orderLabel(order), qty: `${number(order.quantity)} ${order.unit || ""}`.trim(), amount: orderTotal(order), category: orderCategory(order), outsideClosure: outsideClosure(date) }; }),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const recapTotal = recapRows.reduce((sum, row) => sum + row.amount, 0);
  const outsideClosureTotal = recapRows.filter((row) => row.outsideClosure).reduce((sum, row) => sum + row.amount, 0);
  // Très important pour l'administrateur : voir combien part dans chaque
  // catégorie avant le total général (matériaux, transport, salaire, autre).
  const categoryTotals: Record<RecapCategory, number> = { materiaux: 0, transport: 0, salaire: 0, autre: 0 };
  for (const row of recapRows) categoryTotals[row.category] += row.amount;
  const categoryLabels: Record<RecapCategory, string> = { materiaux: "Matériaux", transport: "Transport", salaire: "Salaire", autre: "Autre" };

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
      // Taux moyen réellement payé (utile quand le poste — donc le taux — a
      // changé en cours de période) : days_worked × daily_rate retombe
      // toujours juste sur amount, même en cas de changement de poste.
      daily_rate: row.mixedRates && row.daysWorked ? Math.round((row.amount / row.daysWorked) * 100) / 100 : (row.dailyRate || 0),
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

  // Deux fenêtres ne doivent jamais s'afficher en même temps (elles se
  // superposaient sans qu'on puisse dire laquelle était devant) : si la
  // demande de paiement espèces/autre part de l'aperçu export, on referme
  // l'aperçu pendant la confirmation, puis on le rouvre ensuite.
  function requestCashPayment(row: SalaryRow) {
    if (!canManage || row.alreadyPaid || row.daysWorked === 0) return;
    if (viewingExport) { setViewingExport(false); setResumeExportAfterCashPay(true); }
    setConfirmingCashPay({ row, method: "cash" });
  }

  function closeCashPayModal() {
    setConfirmingCashPay(null);
    if (resumeExportAfterCashPay) { setResumeExportAfterCashPay(false); setViewingExport(true); }
  }

  async function confirmCashPayment() {
    if (!confirmingCashPay) return;
    setBusy(true);
    const { error } = await insertSalaryPayment([confirmingCashPay.row], { paymentMethod: confirmingCashPay.method });
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Paiement non enregistré : ${error.message}` }); return; }
    setMessage({ kind: "success", text: `Paiement de ${confirmingCashPay.row.name} enregistré et envoyé au compte dépense générale.` });
    closeCashPayModal();
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

  async function closeProject() {
    setBusy(true);
    setMessage(null);
    // On met en pause uniquement les accès actifs au moment de la clôture,
    // avec une marque distincte (paused_by_closure) pour ne réactiver que
    // ceux-là à la réouverture — jamais un accès retiré volontairement avant.
    const { data: activeAssignments, error: readError } = await supabase.from("project_assignments").select("id").eq("project_id", project.id).eq("active", true);
    if (readError) { setBusy(false); setMessage({ kind: "error", text: `Clôture impossible : ${readError.message}` }); return; }
    if (activeAssignments?.length) {
      const { error: pauseError } = await supabase.from("project_assignments").update({ active: false, paused_by_closure: true }).in("id", activeAssignments.map((row) => row.id));
      if (pauseError) { setBusy(false); setMessage({ kind: "error", text: `Clôture impossible : ${pauseError.message}` }); return; }
    }
    const now = new Date().toISOString();
    const { error } = await supabase.from("projects").update({ closed_at: now, closed_by: userId }).eq("id", project.id);
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Clôture impossible : ${error.message}` }); return; }
    setClosedAt(now);
    setConfirmingClose(false);
    setMessage({ kind: "success", text: "Chantier clôturé : les accès conducteur, chef et équipe sont maintenant bloqués, et vous-même êtes en lecture seule sur cette page. Réouvrez-le pour tout réactiver." });
  }

  async function reopenProject() {
    setBusy(true);
    setMessage(null);
    const { error: reactivateError } = await supabase
      .from("project_assignments")
      .update({ active: true, paused_by_closure: false })
      .eq("project_id", project.id)
      .eq("paused_by_closure", true);
    if (reactivateError) { setBusy(false); setMessage({ kind: "error", text: `Réouverture impossible : ${reactivateError.message}` }); return; }
    const { error } = await supabase.from("projects").update({ closed_at: null, closed_by: null }).eq("id", project.id);
    setBusy(false);
    if (error) { setMessage({ kind: "error", text: `Réouverture impossible : ${error.message}` }); return; }
    setClosedAt(null);
    setConfirmingReopen(false);
    setMessage({ kind: "success", text: "Chantier rouvert : tous les accès actifs au moment de la clôture sont réactivés." });
  }

  // Chantier clôturé : plus aucune modification n'est possible, y compris
  // pour l'administrateur qui garde seulement la consultation (et l'accès à
  // la réouverture, ci-dessous, volontairement exclue de ce verrouillage).
  return <div className="projectSitePage" style={closedAt ? { pointerEvents: "none" } : undefined}>
    <RealtimeRefresh channelName={`expense-closure-${project.id}`} tables={[{ table: "projects", filter: `id=eq.${project.id}` }]} />
    <header className="projectSiteHeader" style={closedAt ? { pointerEvents: "auto" } : undefined}>
      <div><p className="projectEyebrow">DÉPENSES ET APPROVISIONNEMENT</p><h1>{project.name}</h1><p>{project.project_code || ""}</p></div>
      <div className="projectHeaderActions">
        {canManage && <button type="button" className="dangerButton" onClick={() => { setExportGeneratedAt(new Date().toISOString()); setViewingGeneralExport(true); }}>📄 Exporter résumé dépense</button>}
        <Link className="projectBackLink" href="/expenses">← Retour aux dépenses</Link>
      </div>
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
            {row.daysWorked} j{row.amount > 0 ? ` · ${row.mixedRates ? "taux variable (changement de poste)" : row.dailyRate ? `${money(row.dailyRate)}/j` : ""} · ${money(row.amount)}` : (row.daysWorked > 0 ? " · taux non défini" : "")}
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
        {canManage && (addingMisc ? <>
          <div className="projectMaterialForm">
            <input placeholder="Nom du bénéficiaire ou organisme" value={miscDraft.recipient} onChange={(event) => setMiscDraft((draft) => ({ ...draft, recipient: event.target.value }))} />
            <input type="number" min="0" step="any" placeholder="Montant (Ar)" value={miscDraft.amount} onChange={(event) => setMiscDraft((draft) => ({ ...draft, amount: event.target.value }))} />
            <input placeholder="Note (facultatif)" value={miscDraft.note} onChange={(event) => setMiscDraft((draft) => ({ ...draft, note: event.target.value }))} />
            <button type="button" disabled={busy} onClick={() => setConfirmingMisc(true)}>Valider</button>
          </div>
          <button type="button" className="ghostButton mt-2" onClick={() => setAddingMisc(false)}>Annuler</button>
        </> : <button type="button" onClick={() => setAddingMisc(true)}>+ Ajouter une dépense imprévue</button>)}
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
      <div className="projectStockSummaryList" style={{ maxHeight: "420px" }}>{recapRows.length ? recapRows.map((row) => <div key={row.key} data-revealable style={{ cursor: "pointer" }} onClick={() => setRevealedRowKey((current) => current === row.key ? null : row.key)}>
        <span className="chipName" style={row.outsideClosure ? { color: "#a33b3e" } : undefined}>{row.date ? dateFmt.format(new Date(row.date)) : "—"} · {row.label}{row.outsideClosure ? " · 🔴 Dépense hors clôture" : ""}</span>
        <span className="chipQty" style={{ display: "flex", alignItems: "center", gap: "8px", color: row.outsideClosure ? "#a33b3e" : undefined }}>
          {row.qty} · {money(row.amount)}
          {canDelete && revealedRowKey === row.key && <button type="button" className="projectRejectButton" style={{ padding: "4px 8px", fontSize: ".7rem" }} onClick={(event) => { event.stopPropagation(); setConfirmingDelete({ type: row.type, id: row.id, label: row.label }); }}>Supprimer</button>}
        </span>
      </div>) : <p className="projectEmptyText">Aucune dépense enregistrée pour l’instant.</p>}</div>
      <div className="projectStockSummaryList" style={{ marginTop: "10px" }}>
        {(Object.keys(categoryLabels) as RecapCategory[]).map((category) => <div key={category}>
          <span className="chipName">Sous-total {categoryLabels[category]}</span>
          <span className="chipQty">{money(categoryTotals[category])}</span>
        </div>)}
        {outsideClosureTotal > 0 && <div>
          <span className="chipName" style={{ color: "#a33b3e" }}>🔴 Sous-total dépense hors clôture</span>
          <span className="chipQty" style={{ color: "#a33b3e" }}>{money(outsideClosureTotal)}</span>
        </div>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "12px", borderTop: "2px solid #145b35" }}>
        <strong style={{ fontSize: "1rem" }}>TOTAL GÉNÉRAL DES DÉPENSES</strong>
        <strong style={{ fontSize: "1.35rem", color: "#0b3920" }}>{money(recapTotal)}</strong>
      </div>
    </section>

    {accessRole === "admin" && <section className="projectSiteCard" style={{ marginTop: "18px", borderColor: "#eab7b6", pointerEvents: "auto" }}>
      <div className="projectCardHead"><div><p className="projectEyebrow" style={{ color: "#a33b3e" }}>ZONE SENSIBLE</p><h2>Clôture du chantier</h2></div></div>
      {closedAt ? <>
        <p className="projectHint">🔒 Ce chantier est clôturé depuis le {dateFmt.format(new Date(closedAt))}. Les accès conducteur, chef et équipe sont bloqués, et vous-même êtes en lecture seule sur cette page. Réouvrez-le pour tout réactiver et retrouver la main.</p>
        <button type="button" disabled={busy} onClick={() => setConfirmingReopen(true)}>Réouvrir le chantier</button>
      </> : <>
        <p className="projectHint">Bloque l’accès de tout le monde sauf vous (administrateur) sur ce chantier : conducteur, chef de chantier et équipe. Réversible à tout moment depuis ici ou la liste des chantiers.</p>
        <button type="button" className="dangerButton" disabled={busy} onClick={() => setConfirmingClose(true)}>🔒 Clôture chantier</button>
      </>}
    </section>}

    {confirmingClose && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" style={{ pointerEvents: "auto" }} onClick={() => setConfirmingClose(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(440px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Clôturer « {project.name} » ?</h2>
      <p className="projectHint">Le conducteur, le(s) chef(s) de chantier et l’équipe perdront l’accès à ce chantier jusqu’à sa réouverture. Vous seul (administrateur) garderez l’accès, en lecture seule. C’est réversible : vous pourrez rouvrir le chantier à tout moment depuis ici, ce qui réactivera automatiquement tous les accès qui étaient actifs.</p>
      {message && <p className={`projectAccessStatus ${message.kind}`}>{message.text}</p>}
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" className="dangerButton" disabled={busy} onClick={() => void closeProject()}>{busy ? "Clôture en cours…" : "Confirmer la clôture"}</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingClose(false)}>Annuler</button>
      </div>
    </div></div>, document.body)}

    {confirmingReopen && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" style={{ pointerEvents: "auto" }} onClick={() => setConfirmingReopen(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(440px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Rouvrir « {project.name} » ?</h2>
      <p className="projectHint">Tous les accès conducteur, chef et équipe qui étaient actifs au moment de la clôture seront réactivés. Le chantier redevient actif comme avant.</p>
      {message && <p className={`projectAccessStatus ${message.kind}`}>{message.text}</p>}
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" disabled={busy} onClick={() => void reopenProject()}>{busy ? "Réouverture…" : "Confirmer la réouverture"}</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingReopen(false)}>Annuler</button>
      </div>
    </div></div>, document.body)}

    {viewingRates && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingRates(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(520px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
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
    </div></div>, document.body)}

    {viewingMvolaConfirm && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingMvolaConfirm(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
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
    </div></div>, document.body)}

    {confirmingCashPay && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={closeCashPayModal}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Confirmer le paiement</h2>
      <p className="projectHint">{confirmingCashPay.row.name} — {money(confirmingCashPay.row.amount)}. Ce paiement sera comptabilisé immédiatement dans le compte dépense générale.</p>
      <label>Mode de paiement<select value={confirmingCashPay.method} onChange={(event) => setConfirmingCashPay((current) => current ? { ...current, method: event.target.value as "cash" | "other" } : current)}><option value="cash">Espèces</option><option value="other">Autre</option></select></label>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" disabled={busy} onClick={() => void confirmCashPayment()}>Valider</button>
        <button type="button" className="ghostButton" onClick={closeCashPayModal}>Annuler</button>
      </div>
    </div></div>, document.body)}

    {viewingExport && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingExport(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(620px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
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
    </div></div>, document.body)}

    {viewingEmployeeDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingEmployeeDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
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
    </div></div>, document.body)}

    {viewingSalaryHistory && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingSalaryHistory(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Historique des paiements de salaire</h2>
      <p className="projectHint" style={{ flex: "0 0 auto" }}>Les paiements supprimés restent visibles ici, avec la date de suppression, pour garder une trace.</p>
      <div className="projectStockSummaryList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{allSalaryPaymentsSorted.length ? allSalaryPaymentsSorted.map((payment) => <div key={payment.id} style={{ cursor: payment.deleted_at ? "default" : "pointer", opacity: payment.deleted_at ? 0.6 : 1 }} onClick={() => !payment.deleted_at && setViewingSalaryDetail(payment)}>
        <span className="chipName">{dateFmt.format(new Date(payment.paid_at))} · {paymentLabel(payment)}{payment.deleted_at ? ` · Supprimé le ${dateFmt.format(new Date(payment.deleted_at))}` : ""}</span><span className="chipQty">{money(number(payment.total_amount))}</span>
      </div>) : <p className="projectEmptyText">Aucun paiement pour l’instant.</p>}</div>
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingSalaryHistory(false)}>Fermer</button>
    </div></div>, document.body)}

    {viewingSalaryDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingSalaryDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Paiement du {dateFmt.format(new Date(viewingSalaryDetail.paid_at))}</h2>
      <div className="projectStockSummaryList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{viewingSalaryDetail.project_salary_payment_lines.map((line) => <div key={line.id}>
        <span className="chipName">{line.full_name} <small style={{ color: "#8a5b08" }}>{line.role_name}</small></span><span className="chipQty">{line.days_worked ? `${line.days_worked} j × ${money(line.daily_rate)} = ` : ""}{money(line.amount)}</span>
      </div>)}</div>
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingSalaryDetail(null)}>Fermer</button>
    </div></div>, document.body)}

    {confirmingMisc && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setConfirmingMisc(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Confirmer la dépense</h2>
      <p className="projectHint">{miscDraft.recipient} — {money(number(miscDraft.amount))}. Envoyée directement au compte dépense générale, aucune validation supplémentaire.</p>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" disabled={busy} onClick={() => void submitMiscExpense()}>Confirmer</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingMisc(false)}>Annuler</button>
      </div>
    </div></div>, document.body)}

    {confirmingDelete && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setConfirmingDelete(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
      <h2 className="font-bold text-xl mb-4">Supprimer cette ligne ?</h2>
      <p className="projectHint">"{confirmingDelete.label}" sera retirée du compte dépense générale. Cette action est réversible uniquement par un administrateur en base.</p>
      <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
        <button type="button" className="projectRejectButton" disabled={busy} onClick={() => void confirmDeleteRow()}>Supprimer</button>
        <button type="button" className="ghostButton" onClick={() => setConfirmingDelete(null)}>Annuler</button>
      </div>
    </div></div>, document.body)}

    {viewingGeneralExport && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingGeneralExport(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(760px,100%)", display: "flex", flexDirection: "column", maxHeight: "90vh" }}>
      <div className="printableExport" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        <h2 className="font-bold text-xl mb-1">Résumé dépense — {project.name}</h2>
        <p className="projectHint">{project.location || "Localisation à confirmer"}{project.project_code ? ` · ${project.project_code}` : ""} · Période : {periodMonth} · Généré le {exportGeneratedAt ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(exportGeneratedAt)) : ""}</p>

        <h3 style={{ marginTop: "16px" }}>Conducteur et chef(s) de chantier</h3>
        <div className="projectStockSummaryList">{assignmentRows.length ? assignmentRows.map((row) => <div key={row.key}>
          <span className="chipName">{row.roleName} — {row.name}</span>
          <span className="chipQty">{row.daysWorked} j sur la période</span>
        </div>) : <p className="projectEmptyText">Aucun conducteur ni chef de chantier actif.</p>}</div>

        <h3 style={{ marginTop: "16px" }}>Ouvriers, manœuvres et autres présents</h3>
        <div className="projectStockSummaryList">{staffRows.length ? staffRows.map((row) => <div key={row.key}>
          <span className="chipName">{row.name} <small style={{ color: "#8a5b08" }}>{row.roleName}</small></span>
          <span className="chipQty">{row.trackedDays === 0 ? "Aucun jour suivi" : row.absenceDays === 0 ? `Présent du début à la fin (${row.daysWorked} j)` : `${row.daysWorked} j présent · ${row.absenceDays} j d’absence`}</span>
        </div>) : <p className="projectEmptyText">Aucun ouvrier déclaré.</p>}</div>

        <h3 style={{ marginTop: "16px" }}>Détail des dépenses payées</h3>
        <div className="projectStockSummaryList">{recapRows.length ? recapRows.map((row) => <div key={row.key}>
          <span className="chipName" style={row.outsideClosure ? { color: "#a33b3e" } : undefined}>{row.date ? dateFmt.format(new Date(row.date)) : "—"} · {row.label}{row.outsideClosure ? " · 🔴 Dépense hors clôture" : ""}</span>
          <span className="chipQty" style={row.outsideClosure ? { color: "#a33b3e" } : undefined}>{row.qty} · {money(row.amount)}</span>
        </div>) : <p className="projectEmptyText">Aucune dépense enregistrée.</p>}</div>

        <h3 style={{ marginTop: "16px" }}>Matériaux (quantités déjà achetées/utilisées)</h3>
        <div className="projectStockSummaryList">{materialUsageTotals.length ? materialUsageTotals.map((item) => <div key={item.key}>
          <span className="chipName">{item.name}</span><span className="chipQty">{item.quantity} {item.unit}</span>
        </div>) : <p className="projectEmptyText">Aucun matériau acheté.</p>}</div>

        <h3 style={{ marginTop: "16px" }}>Sous-totaux par catégorie</h3>
        <div className="projectStockSummaryList">
          {(Object.keys(categoryLabels) as RecapCategory[]).map((category) => <div key={category}>
            <span className="chipName">Sous-total {categoryLabels[category]}</span>
            <span className="chipQty">{money(categoryTotals[category])}</span>
          </div>)}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", paddingTop: "12px", borderTop: "2px solid #145b35" }}>
          <strong style={{ fontSize: "1rem" }}>TOTAL GÉNÉRAL DES DÉPENSES</strong>
          <strong style={{ fontSize: "1.35rem", color: "#0b3920" }}>{money(recapTotal)}</strong>
        </div>
      </div>
      <div className="noPrint" style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto", flexWrap: "wrap" }}>
        <button type="button" className="secondary" onClick={() => setExportGeneratedAt(new Date().toISOString())}>Nouvel export</button>
        <button type="button" onClick={() => window.print()}>Enregistrer sous (PDF)</button>
        <button type="button" className="secondary" onClick={() => window.print()}>Imprimer</button>
        <button type="button" className="ghostButton" onClick={() => setViewingGeneralExport(false)}>Fermer</button>
      </div>
    </div></div>, document.body)}
  </div>;
}
