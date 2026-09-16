"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { certifiedAmount } from "@/lib/billing";

type Project = { id: string; project_code: string | null; name: string; location: string | null; budget_amount: number | string | null; status: string | null };
type Tender = { client_name: string | null; reference: string | null; title: string | null } | null;
type Payment = { id: string; progress_claim_id: string | null; payment_date: string; amount: number | string; method: string; reference: string | null; payment_type: string };

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const today = new Date().toISOString().slice(0, 10);
const paymentTypeLabel: Record<string, string> = { avancement: "Avancement", attachement: "Attachement", solde: "Solde de fin de travaux" };

export function BillingProjectDetail({ project, tender, payments }: { project: Project; tender: Tender; payments: Payment[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [paymentForm, setPaymentForm] = useState({
    payment_date: today,
    amount: "0",
    payment_type: "avancement",
    method: "bank_transfer",
    reference: "",
  });

  const certified = certifiedAmount(Number(project.budget_amount) || 0);
  const received = payments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const outstanding = Math.max(0, certified - received);
  const percent = certified > 0 ? Math.min(100, Math.round((received / certified) * 100)) : 0;

  async function submitPayment(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage("");
    const response = await fetch("/api/billing/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...paymentForm, project_id: project.id }),
    });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setMessage(result.error ?? "Enregistrement impossible.");
    setMessage("Paiement enregistré.");
    setPaymentForm({ payment_date: today, amount: "0", payment_type: "avancement", method: "bank_transfer", reference: "" });
    router.refresh();
  }

  async function cancelPayment(paymentId: string) {
    if (!window.confirm("Annuler ce paiement ?")) return;
    setBusy(true); setMessage("");
    const response = await fetch(`/api/billing/payments/${paymentId}`, { method: "DELETE" });
    setBusy(false);
    if (!response.ok) { const result = await response.json(); return setMessage(result.error ?? "Annulation impossible."); }
    setMessage("Paiement annulé.");
    router.refresh();
  }

  return (
    <section>
      <Link href="/billing" className="tenderBackLink">← Retour aux chantiers</Link>

      <div className="pageHead">
        <div><h1>{project.project_code ? `${project.project_code} — ` : ""}{project.name}</h1><p>Suivi des paiements de ce chantier.</p></div>
      </div>

      <div className="stats billingStats">
        <article><span>Montant certifié</span><strong>{ariary.format(certified)} Ar</strong></article>
        <article><span>Paiements reçus</span><strong>{ariary.format(received)} Ar</strong></article>
        <article><span>Reste à encaisser</span><strong>{ariary.format(outstanding)} Ar</strong></article>
        <article><span>Avancement</span><strong>{percent} %</strong></article>
      </div>
      <div className="progress"><span style={{ width: `${percent}%` }} /></div>

      <div className="panel" style={{ marginTop: "20px" }}>
        <h3>Informations du chantier</h3>
        <div className="formGrid">
          <div><span className="pill">Localisation</span><p>{project.location || "—"}</p></div>
          <div><span className="pill">Client</span><p>{tender?.client_name || "—"}</p></div>
          <div><span className="pill">Référence DAO</span><p>{tender?.reference || "—"}</p></div>
          <div><span className="pill">Statut</span><p>{project.status || "—"}</p></div>
        </div>
      </div>

      {message && <p className="notice" style={{ marginTop: "16px" }}>{message}</p>}

      <div className="billingGrid" style={{ marginTop: "20px" }}>
        <form className="panel businessForm" onSubmit={submitPayment}>
          <h3>Paiement entrant</h3>
          <label>Origine du fonds<select value={paymentForm.payment_type} onChange={(e) => setPaymentForm({ ...paymentForm, payment_type: e.target.value })}><option value="avancement">Avancement</option><option value="attachement">Attachement</option><option value="solde">Solde de fin de travaux</option></select></label>
          <div className="formPair"><label>Date<input type="date" value={paymentForm.payment_date} onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} required /></label><label>Montant (Ar)<input type="number" min="0" value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} required /></label></div>
          <label>Mode<select value={paymentForm.method} onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}><option value="bank_transfer">Virement bancaire</option><option value="cheque">Chèque</option><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="other">Autre</option></select></label>
          <label>Référence<input value={paymentForm.reference} onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })} placeholder="N° virement, chèque…" /></label>
          <div style={{ display: "flex", gap: "10px" }}>
            <button type="submit" disabled={busy} className="button">{busy ? "Enregistrement…" : "Valider le paiement"}</button>
            <button type="button" className="ghostButton" onClick={() => setPaymentForm({ payment_date: today, amount: "0", payment_type: "avancement", method: "bank_transfer", reference: "" })}>Annuler la saisie</button>
          </div>
        </form>

        <div className="panel table">
          <table>
            <thead><tr><th>Date</th><th>Origine</th><th>Montant</th><th>Mode</th><th>Référence</th><th /></tr></thead>
            <tbody>{payments.map((payment) => (
              <tr key={payment.id}>
                <td>{new Intl.DateTimeFormat("fr-FR").format(new Date(payment.payment_date))}</td>
                <td><span className="pill">{paymentTypeLabel[payment.payment_type] || payment.payment_type}</span></td>
                <td><strong>{ariary.format(Number(payment.amount))} Ar</strong></td>
                <td>{payment.method}</td>
                <td>{payment.reference ?? "—"}</td>
                <td><button type="button" className="dangerButton" disabled={busy} onClick={() => void cancelPayment(payment.id)}>Annuler</button></td>
              </tr>
            ))}</tbody>
          </table>
          {!payments.length && <p className="emptyState">Aucun paiement enregistré pour ce chantier.</p>}
        </div>
      </div>
    </section>
  );
}
