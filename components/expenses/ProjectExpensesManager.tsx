"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type StaffMember = { id: string; project_id: string; full_name: string; role_name?: string | null; active?: boolean; mvola_number?: string | null };
type Attendance = { id: string; staff_member_id: string; report_date: string; present: boolean };
type MaterialOrder = {
  id: string; project_id: string; material_name: string; material_key?: string | null; unit?: string | null; quantity: number | string; unit_price: number | string;
  status: string; expense_kind?: string | null; transport_mode?: string | null; recipient_name?: string | null;
  paid_at?: string | null; submitted_at?: string | null; deleted_at?: string | null;
};
type SalaryPaymentLine = { id: string; staff_member_id?: string | null; full_name: string; role_name?: string | null; daily_rate: number; days_worked: number; amount: number; mvola_number?: string | null };
type SalaryPayment = { id: string; project_id: string; paid_at: string; total_amount: number; deleted_at?: string | null; project_salary_payment_lines: SalaryPaymentLine[] };
type LaborRate = { designation: string; unitPrice: unknown };
type AccessRole = "admin" | "works_manager" | "site_manager" | "viewer";

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

export function ProjectExpensesManager({ project, accessRole, userId, staffMembers: initialStaffMembers, attendance: initialAttendance, materialOrders: initialMaterialOrders, salaryPayments: initialSalaryPayments, laborRates }: {
  project: { id: string; name: string; project_code?: string | null; organization_id: string };
  accessRole: AccessRole;
  userId: string;
  staffMembers: StaffMember[];
  attendance: Attendance[];
  materialOrders: MaterialOrder[];
  salaryPayments: SalaryPayment[];
  laborRates: LaborRate[];
}) {
  const supabase = useState(() => createClient())[0];
  const canManage = accessRole === "admin" || accessRole === "works_manager";
  const [staffMembers, setStaffMembers] = useState(initialStaffMembers);
  const [attendance, setAttendance] = useState(initialAttendance);
  const [materialOrders, setMaterialOrders] = useState(initialMaterialOrders);
  const [salaryPayments, setSalaryPayments] = useState(initialSalaryPayments);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);

  const [viewingPaySummary, setViewingPaySummary] = useState(false);
  const [viewingSalaryHistory, setViewingSalaryHistory] = useState(false);
  const [viewingSalaryDetail, setViewingSalaryDetail] = useState<SalaryPayment | null>(null);
  const [addingMisc, setAddingMisc] = useState(false);
  const [miscDraft, setMiscDraft] = useState({ recipient: "", amount: "", note: "" });
  const [confirmingMisc, setConfirmingMisc] = useState(false);
  const [revealedRowKey, setRevealedRowKey] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<{ type: "salary" | "order"; id: string; label: string } | null>(null);

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

  // Rattachement salaire ⇄ devis interne : on rapproche le poste de
  // l'employé (texte libre) à la désignation de la ligne main-d'œuvre du
  // devis interne (aussi du texte libre), en ignorant accents/majuscules.
  function matchLaborRate(roleName: string): number | null {
    const role = normalize(roleName || "");
    if (!role) return null;
    const match = laborRates.find((line) => {
      const designation = normalize(line.designation);
      return designation.includes(role) || role.includes(designation.split(/[—-]/)[0].trim());
    });
    if (!match) return null;
    const price = number(match.unitPrice);
    return price > 0 ? price : null;
  }

  const lastPaymentDateByStaff = new Map<string, string>();
  for (const payment of salaryPayments) {
    if (payment.deleted_at) continue;
    for (const line of payment.project_salary_payment_lines) {
      if (!line.staff_member_id) continue;
      const current = lastPaymentDateByStaff.get(line.staff_member_id);
      if (!current || payment.paid_at > current) lastPaymentDateByStaff.set(line.staff_member_id, payment.paid_at);
    }
  }

  const salaryRows = staffMembers.map((staff) => {
    const cutoff = lastPaymentDateByStaff.get(staff.id);
    const counted = attendance.filter((item) => item.staff_member_id === staff.id && item.present && (!cutoff || item.report_date > cutoff.slice(0, 10)));
    const daysWorked = counted.length;
    const firstDate = counted.length ? counted.map((item) => item.report_date).sort()[0] : null;
    const dailyRate = matchLaborRate(staff.role_name || "");
    const amount = dailyRate ? dailyRate * daysWorked : 0;
    return { staff, dailyRate, daysWorked, firstDate, amount };
  });
  const salaryTotal = salaryRows.reduce((sum, row) => sum + row.amount, 0);
  const payableRows = salaryRows.filter((row) => row.daysWorked > 0);

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
      return { key: `salary-${payment.id}`, type: "salary" as const, id: payment.id, date: payment.paid_at, label: `Salaire (${payment.project_salary_payment_lines.length} ouvrier(s))`, qty: `${totalDays} j-personne`, amount: number(payment.total_amount) };
    }),
    ...paidOrders.map((order) => ({ key: `order-${order.id}`, type: "order" as const, id: order.id, date: order.paid_at || order.submitted_at || "", label: orderLabel(order), qty: `${number(order.quantity)} ${order.unit || ""}`.trim(), amount: orderTotal(order) })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const recapTotal = recapRows.reduce((sum, row) => sum + row.amount, 0);

  async function payerSalaires() {
    if (!canManage || !payableRows.length) return;
    setBusy(true);
    setMessage({ kind: "info", text: "Enregistrement du paiement…" });
    const total = payableRows.reduce((sum, row) => sum + row.amount, 0);
    const { data: payment, error } = await supabase.from("project_salary_payments").insert({
      organization_id: project.organization_id,
      project_id: project.id,
      paid_by: userId,
      total_amount: total,
    }).select().single();
    if (error || !payment) { setBusy(false); setMessage({ kind: "error", text: `Paiement non enregistré : ${error?.message || "erreur inconnue"}` }); return; }
    const lines = payableRows.map((row) => ({
      payment_id: payment.id,
      staff_member_id: row.staff.id,
      full_name: row.staff.full_name,
      role_name: row.staff.role_name || null,
      daily_rate: row.dailyRate || 0,
      days_worked: row.daysWorked,
      amount: row.amount,
      mvola_number: row.staff.mvola_number || null,
    }));
    const { data: insertedLines, error: linesError } = await supabase.from("project_salary_payment_lines").insert(lines).select();
    setBusy(false);
    if (linesError) { setMessage({ kind: "error", text: `Paiement partiel : détail non enregistré (${linesError.message}).` }); return; }
    setSalaryPayments((rows) => [{ ...payment, project_salary_payment_lines: insertedLines ?? [] }, ...rows]);
    setViewingPaySummary(false);
    setMessage({ kind: "success", text: "Salaires certifiés payés. Envoyé au compte dépense générale." });
  }

  function exportExcel() {
    if (!payableRows.length) { setMessage({ kind: "error", text: "Aucun salaire à exporter pour l’instant." }); return; }
    import("xlsx").then((XLSX) => {
      const rows = payableRows.map((row) => ({ Téléphone: row.staff.mvola_number || "", Raison: "Salaire", Montant: row.amount }));
      const sheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "Salaires");
      XLSX.writeFile(workbook, `salaires-${project.name.replace(/[^a-zA-Z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.xlsx`);
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
      <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">SALAIRE</p><h2>Salaire employés</h2></div><span>{money(salaryTotal)}</span></div>
        <p className="projectHint">Calculé automatiquement depuis le devis interne (taux par fonction) et la présence déclarée. Lecture seule — rien n’est modifiable ici.</p>
        <div className="projectStockSummaryList">{salaryRows.length ? salaryRows.map((row) => <div key={row.staff.id}>
          <span className="chipName">{row.staff.full_name} <small style={{ color: "#8a5b08" }}>{row.staff.role_name}</small></span>
          <span className="chipQty">{row.daysWorked} j{row.dailyRate ? ` · ${money(row.dailyRate)}/j · ${money(row.amount)}` : " · taux non défini"}</span>
        </div>) : <p className="projectEmptyText">Aucun employé actif sur ce chantier.</p>}</div>
        {canManage && <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "12px", marginBottom: "10px" }}>
          <button type="button" className="secondary" onClick={exportExcel}>Exporter Excel</button>
          <button type="button" disabled={!payableRows.length || busy} onClick={() => setViewingPaySummary(true)}>Payer</button>
        </div>}
        <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingSalaryHistory(true)}>Voir l’historique</button>
      </section>

      <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">À VALIDER</p><h2>Demandes en cours</h2></div><span>{pendingOrders.length}</span></div>
        <div className="projectStockSummaryList">{pendingOrders.length ? pendingOrders.map((order) => <div key={order.id}>
          <span className="chipName">{orderLabel(order)}</span><span className="chipQty">{number(order.quantity)} {order.unit || ""} · {money(orderTotal(order))}</span>
        </div>) : <p className="projectEmptyText">Aucune demande en cours.</p>}</div>
      </section>

      <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">ACHATS PAYÉS</p><h2>Dépenses effectuées</h2></div><span>{money(paidOrders.reduce((sum, order) => sum + orderTotal(order), 0))}</span></div>
        <div className="projectStockSummaryList">{paidOrders.length ? paidOrders.map((order) => <div key={order.id}>
          <span className="chipName">{orderReason(order)} — {orderLabel(order)}</span><span className="chipQty">{number(order.quantity)} {order.unit || ""} · {money(orderTotal(order))}</span>
        </div>) : <p className="projectEmptyText">Aucun achat payé.</p>}</div>
      </section>

      <section className="projectSiteCard">
        <div className="projectCardHead"><div><p className="projectEyebrow">IMPRÉVU</p><h2>Dépenses imprévues</h2></div></div>
        <p className="projectHint">Cadeaux, pots-de-vin ou toute dépense hors matériau/salaire. Envoyée directement au compte dépense générale après confirmation.</p>
        {canManage && (addingMisc ? <>
          <div className="projectMaterialForm">
            <input placeholder="Nom du bénéficiaire ou organisme" value={miscDraft.recipient} onChange={(event) => setMiscDraft((draft) => ({ ...draft, recipient: event.target.value }))} />
            <input type="number" min="0" step="any" placeholder="Montant (Ar)" value={miscDraft.amount} onChange={(event) => setMiscDraft((draft) => ({ ...draft, amount: event.target.value }))} />
            <input placeholder="Note (facultatif)" value={miscDraft.note} onChange={(event) => setMiscDraft((draft) => ({ ...draft, note: event.target.value }))} />
            <button type="button" disabled={busy} onClick={() => setConfirmingMisc(true)}>Valider</button>
          </div>
          <button type="button" className="ghostButton mt-2" onClick={() => setAddingMisc(false)}>Annuler</button>
        </> : <button type="button" onClick={() => setAddingMisc(true)}>+ Ajouter une dépense imprévue</button>)}
      </section>

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
      <p className="projectHint">Ne liste que ce qui est déjà payé (salaires, achats, transport, imprévus). Cliquez une ligne pour la supprimer.</p>
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

    {viewingPaySummary && <div className="modalBackdrop" onClick={() => setViewingPaySummary(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Confirmer le paiement des salaires</h2>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        <p className="projectHint">Ce bouton ne déclenche aucun paiement réel — il certifie que vous avez payé, et envoie le détail au compte dépense générale.</p>
        <div className="projectStockSummaryList">{payableRows.map((row) => <div key={row.staff.id}><span className="chipName">{row.staff.full_name}</span><span className="chipQty">{money(row.amount)}</span></div>)}</div>
      </div>
      {message && <p className={`projectAccessStatus ${message.kind}`} style={{ flex: "0 0 auto", marginTop: "10px" }}>{message.text}</p>}
      <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
        <button type="button" disabled={busy} onClick={() => void payerSalaires()}>{busy ? "Envoi…" : `Confirmer — ${money(payableRows.reduce((sum, row) => sum + row.amount, 0))}`}</button>
        <button type="button" className="ghostButton" onClick={() => setViewingPaySummary(false)}>Annuler</button>
      </div>
    </div></div>}

    {viewingSalaryHistory && <div className="modalBackdrop" onClick={() => setViewingSalaryHistory(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Historique des paiements de salaire</h2>
      <div className="projectStockSummaryList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{activeSalaryPayments.length ? activeSalaryPayments.map((payment) => <div key={payment.id} style={{ cursor: "pointer" }} onClick={() => setViewingSalaryDetail(payment)}>
        <span className="chipName">{dateFmt.format(new Date(payment.paid_at))} · {payment.project_salary_payment_lines.length} ouvrier(s)</span><span className="chipQty">{money(number(payment.total_amount))}</span>
      </div>) : <p className="projectEmptyText">Aucun paiement pour l’instant.</p>}</div>
      <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingSalaryHistory(false)}>Fermer</button>
    </div></div>}

    {viewingSalaryDetail && <div className="modalBackdrop" onClick={() => setViewingSalaryDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
      <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Paiement du {dateFmt.format(new Date(viewingSalaryDetail.paid_at))}</h2>
      <div className="projectStockSummaryList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{viewingSalaryDetail.project_salary_payment_lines.map((line) => <div key={line.id}>
        <span className="chipName">{line.full_name} <small style={{ color: "#8a5b08" }}>{line.role_name}</small></span><span className="chipQty">{line.days_worked} j × {money(line.daily_rate)} = {money(line.amount)}</span>
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
