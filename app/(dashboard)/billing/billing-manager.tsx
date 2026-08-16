"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Project = { id: string; project_code: string | null; name: string; budget_amount: number | string | null };
type Claim = {
  id: string;
  project_id: string;
  claim_number: string;
  issue_date: string;
  status: string;
  gross_amount: number | string;
  retention_amount: number | string;
  tax_amount: number | string;
  net_amount: number | string;
  projects?: { name?: string; project_code?: string | null } | null;
};
type Payment = {
  id: string;
  project_id: string | null;
  progress_claim_id: string | null;
  payment_date: string;
  amount: number | string;
  method: string;
  reference: string | null;
};

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const today = new Date().toISOString().slice(0, 10);

export function BillingManager({
  organizationId,
  projects,
  initialClaims,
  initialPayments,
}: {
  organizationId: string | null;
  projects: Project[];
  initialClaims: Claim[];
  initialPayments: Payment[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"claims" | "payments">("claims");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [claimForm, setClaimForm] = useState({
    project_id: projects[0]?.id ?? "",
    claim_number: `SIT-${new Date().getFullYear()}-001`,
    issue_date: today,
    gross_amount: "0",
    retention_rate: "5",
    advance_repayment: "0",
    other_deductions: "0",
    tax_rate: "20",
    notes: "",
  });
  const [paymentForm, setPaymentForm] = useState({
    project_id: projects[0]?.id ?? "",
    progress_claim_id: "",
    payment_date: today,
    amount: "0",
    method: "bank_transfer",
    reference: "",
  });

  const calculation = useMemo(() => {
    const gross = Number(claimForm.gross_amount) || 0;
    const retention = gross * ((Number(claimForm.retention_rate) || 0) / 100);
    const advance = Number(claimForm.advance_repayment) || 0;
    const other = Number(claimForm.other_deductions) || 0;
    const taxable = Math.max(0, gross - retention - advance - other);
    const tax = taxable * ((Number(claimForm.tax_rate) || 0) / 100);
    return { gross, retention, taxable, tax, net: taxable + tax };
  }, [claimForm]);

  const totalCertified = initialClaims.reduce((sum, item) => sum + Number(item.net_amount || 0), 0);
  const totalPaid = initialPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const outstanding = Math.max(0, totalCertified - totalPaid);

  async function submitClaim(event: FormEvent) {
    event.preventDefault();
    if (!organizationId) return setMessage("Aucune entreprise associée à ce compte.");
    setBusy(true); setMessage("");
    const response = await fetch("/api/billing/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...claimForm, organization_id: organizationId }),
    });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setMessage(result.error ?? "Enregistrement impossible.");
    setMessage("Situation enregistrée.");
    router.refresh();
  }

  async function submitPayment(event: FormEvent) {
    event.preventDefault();
    if (!organizationId) return setMessage("Aucune entreprise associée à ce compte.");
    setBusy(true); setMessage("");
    const response = await fetch("/api/billing/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...paymentForm, organization_id: organizationId }),
    });
    const result = await response.json();
    setBusy(false);
    if (!response.ok) return setMessage(result.error ?? "Enregistrement impossible.");
    setMessage("Paiement enregistré.");
    router.refresh();
  }

  return (
    <section>
      <div className="pageHead">
        <div><h1>Situations & paiements</h1><p>Facturation des travaux et suivi des encaissements.</p></div>
      </div>

      <div className="stats billingStats">
        <article><span>Montant certifié TTC</span><strong>{ariary.format(totalCertified)} Ar</strong></article>
        <article><span>Paiements reçus</span><strong>{ariary.format(totalPaid)} Ar</strong></article>
        <article><span>Reste à encaisser</span><strong>{ariary.format(outstanding)} Ar</strong></article>
        <article><span>Situations émises</span><strong>{initialClaims.length}</strong></article>
      </div>

      <div className="billingTabs">
        <button className={tab === "claims" ? "active" : ""} onClick={() => setTab("claims")}>Situations de travaux</button>
        <button className={tab === "payments" ? "active" : ""} onClick={() => setTab("payments")}>Paiements</button>
      </div>

      {message && <p className="notice">{message}</p>}

      {tab === "claims" ? (
        <div className="billingGrid">
          <form className="panel businessForm" onSubmit={submitClaim}>
            <h3>Nouvelle situation</h3>
            <label>Chantier<select value={claimForm.project_id} onChange={e => setClaimForm({ ...claimForm, project_id: e.target.value })}>{projects.map(p => <option key={p.id} value={p.id}>{p.project_code ? `${p.project_code} — ` : ""}{p.name}</option>)}</select></label>
            <div className="formPair"><label>Numéro<input value={claimForm.claim_number} onChange={e => setClaimForm({ ...claimForm, claim_number: e.target.value })} required /></label><label>Date<input type="date" value={claimForm.issue_date} onChange={e => setClaimForm({ ...claimForm, issue_date: e.target.value })} required /></label></div>
            <label>Montant brut des travaux (Ar)<input type="number" min="0" value={claimForm.gross_amount} onChange={e => setClaimForm({ ...claimForm, gross_amount: e.target.value })} required /></label>
            <div className="formPair"><label>Retenue de garantie (%)<input type="number" min="0" step="0.01" value={claimForm.retention_rate} onChange={e => setClaimForm({ ...claimForm, retention_rate: e.target.value })} /></label><label>TVA (%)<input type="number" min="0" step="0.01" value={claimForm.tax_rate} onChange={e => setClaimForm({ ...claimForm, tax_rate: e.target.value })} /></label></div>
            <div className="formPair"><label>Remboursement avance<input type="number" min="0" value={claimForm.advance_repayment} onChange={e => setClaimForm({ ...claimForm, advance_repayment: e.target.value })} /></label><label>Autres déductions<input type="number" min="0" value={claimForm.other_deductions} onChange={e => setClaimForm({ ...claimForm, other_deductions: e.target.value })} /></label></div>
            <label>Notes<textarea value={claimForm.notes} onChange={e => setClaimForm({ ...claimForm, notes: e.target.value })} rows={3} /></label>
            <div className="claimCalculation"><span>Retenue <b>{ariary.format(calculation.retention)} Ar</b></span><span>Base nette <b>{ariary.format(calculation.taxable)} Ar</b></span><span>TVA <b>{ariary.format(calculation.tax)} Ar</b></span><strong>Net à payer {ariary.format(calculation.net)} Ar</strong></div>
            <button disabled={busy || !projects.length}>{busy ? "Enregistrement…" : "Enregistrer la situation"}</button>
          </form>

          <div className="panel table">
            <table><thead><tr><th>N°</th><th>Chantier</th><th>Date</th><th>Brut</th><th>Retenue</th><th>Net TTC</th><th>Statut</th></tr></thead><tbody>{initialClaims.map(claim => <tr key={claim.id}><td><strong>{claim.claim_number}</strong></td><td>{claim.projects?.name ?? "—"}</td><td>{new Intl.DateTimeFormat("fr-FR").format(new Date(claim.issue_date))}</td><td>{ariary.format(Number(claim.gross_amount))} Ar</td><td>{ariary.format(Number(claim.retention_amount))} Ar</td><td><strong>{ariary.format(Number(claim.net_amount))} Ar</strong></td><td><span className="pill">{claim.status}</span></td></tr>)}</tbody></table>
            {!initialClaims.length && <p className="emptyState">Aucune situation enregistrée.</p>}
          </div>
        </div>
      ) : (
        <div className="billingGrid">
          <form className="panel businessForm" onSubmit={submitPayment}>
            <h3>Nouveau paiement reçu</h3>
            <label>Chantier<select value={paymentForm.project_id} onChange={e => setPaymentForm({ ...paymentForm, project_id: e.target.value })}>{projects.map(p => <option key={p.id} value={p.id}>{p.project_code ? `${p.project_code} — ` : ""}{p.name}</option>)}</select></label>
            <label>Situation associée<select value={paymentForm.progress_claim_id} onChange={e => setPaymentForm({ ...paymentForm, progress_claim_id: e.target.value })}><option value="">Aucune / paiement global</option>{initialClaims.filter(c => c.project_id === paymentForm.project_id).map(c => <option key={c.id} value={c.id}>{c.claim_number} — {ariary.format(Number(c.net_amount))} Ar</option>)}</select></label>
            <div className="formPair"><label>Date<input type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} required /></label><label>Montant (Ar)<input type="number" min="0" value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} required /></label></div>
            <label>Mode<select value={paymentForm.method} onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}><option value="bank_transfer">Virement bancaire</option><option value="cheque">Chèque</option><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="other">Autre</option></select></label>
            <label>Référence<input value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} placeholder="N° virement, chèque…" /></label>
            <button disabled={busy || !projects.length}>{busy ? "Enregistrement…" : "Enregistrer le paiement"}</button>
          </form>
          <div className="panel table"><table><thead><tr><th>Date</th><th>Montant</th><th>Mode</th><th>Référence</th></tr></thead><tbody>{initialPayments.map(payment => <tr key={payment.id}><td>{new Intl.DateTimeFormat("fr-FR").format(new Date(payment.payment_date))}</td><td><strong>{ariary.format(Number(payment.amount))} Ar</strong></td><td>{payment.method}</td><td>{payment.reference ?? "—"}</td></tr>)}</tbody></table>{!initialPayments.length && <p className="emptyState">Aucun paiement enregistré.</p>}</div>
        </div>
      )}
    </section>
  );
}
