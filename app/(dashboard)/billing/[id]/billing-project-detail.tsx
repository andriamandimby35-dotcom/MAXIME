"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { certifiedAmount } from "@/lib/billing";
import { usePdfViewer } from "@/components/PdfViewerProvider";

type Project = { id: string; project_code: string | null; name: string; location: string | null; budget_amount: number | string | null; status: string | null; source_estimate_id: string | null; manual_margin_percent: number | string | null };
type Payment = { id: string; progress_claim_id: string | null; payment_date: string; amount: number | string; method: string; reference: string | null; payment_type: string };
type Claim = { id: string; claim_number: string; issue_date: string; status: string; gross_amount: number | string; retention_amount: number | string; tax_amount: number | string; net_amount: number | string };

type DraftLine = {
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

type Draft = {
  projectId: string;
  projectName: string;
  clientName: string;
  claimNumber: string;
  previousClaimNumber: string | null;
  marginPercent: number;
  lines: DraftLine[];
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

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const today = new Date().toISOString().slice(0, 10);
const paymentTypeLabel: Record<string, string> = { avancement: "Avancement", attachement: "Attachement", solde: "Solde de fin de travaux" };
const claimStatusLabel: Record<string, string> = { draft: "Brouillon", submitted: "Envoyée", approved: "Approuvée", partially_paid: "Partiellement payée", paid: "Payée", rejected: "Refusée" };

export function BillingProjectDetail({ project, payments, claims }: { project: Project; payments: Payment[]; claims: Claim[] }) {
  const router = useRouter();
  const { openPdf } = usePdfViewer();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [paymentForm, setPaymentForm] = useState({
    payment_date: today,
    amount: "0",
    payment_type: "avancement",
    method: "bank_transfer",
    reference: "",
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [needsMargin, setNeedsMargin] = useState(false);
  const [marginInput, setMarginInput] = useState("");
  const [needsClientName, setNeedsClientName] = useState(false);
  const [clientNameInput, setClientNameInput] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  const [claimNumberInput, setClaimNumberInput] = useState("");
  const [issueDateInput, setIssueDateInput] = useState(today);

  const netClaimsTotal = claims.filter((claim) => claim.status !== "rejected").reduce((sum, claim) => sum + Number(claim.net_amount || 0), 0);
  const certified = claims.length > 0 ? netClaimsTotal : certifiedAmount(Number(project.budget_amount) || 0);
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

  async function openInvoiceGenerator() {
    setDraft(null); setNeedsMargin(false); setNeedsClientName(false); setDraftMessage(""); setDraftBusy(true);
    const response = await fetch(`/api/billing/claims/draft?project_id=${project.id}`);
    const result = await response.json();
    setDraftBusy(false);
    if (!response.ok) return setDraftMessage(result.error ?? "Calcul impossible.");
    if (result.needsMarginInput) { setNeedsMargin(true); return; }
    if (result.needsClientInput) { setNeedsClientName(true); return; }
    setDraft(result);
    setClaimNumberInput(result.claimNumber);
    setIssueDateInput(today);
  }

  async function confirmMargin() {
    const margin = Number(marginInput);
    if (!Number.isFinite(margin)) return setDraftMessage("Indique un pourcentage valide.");
    setDraftBusy(true); setDraftMessage("");
    const response = await fetch(`/api/billing/claims/draft?project_id=${project.id}&margin=${margin}${clientNameInput ? `&client_name=${encodeURIComponent(clientNameInput.trim())}` : ""}`);
    const result = await response.json();
    setDraftBusy(false);
    if (!response.ok) return setDraftMessage(result.error ?? "Calcul impossible.");
    if (result.needsClientInput) { setNeedsMargin(false); setNeedsClientName(true); return; }
    setNeedsMargin(false);
    setDraft(result);
    setClaimNumberInput(result.claimNumber);
    setIssueDateInput(today);
  }

  async function confirmClientName() {
    if (!clientNameInput.trim()) return setDraftMessage("Indique le nom du client.");
    setDraftBusy(true); setDraftMessage("");
    const response = await fetch(`/api/billing/claims/draft?project_id=${project.id}&client_name=${encodeURIComponent(clientNameInput.trim())}${marginInput ? `&margin=${Number(marginInput)}` : ""}`);
    const result = await response.json();
    setDraftBusy(false);
    if (!response.ok) return setDraftMessage(result.error ?? "Calcul impossible.");
    if (result.needsMarginInput) { setNeedsClientName(false); setNeedsMargin(true); return; }
    setNeedsClientName(false);
    setDraft(result);
    setClaimNumberInput(result.claimNumber);
    setIssueDateInput(today);
  }

  async function validateInvoice() {
    if (!draft) return;
    setDraftBusy(true); setDraftMessage("");
    const response = await fetch("/api/billing/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: project.id,
        claim_number: claimNumberInput,
        client_name: draft.clientName,
        issue_date: issueDateInput,
        retention_rate: draft.retentionRate,
        tax_rate: draft.taxRate,
        advance_repayment: draft.advanceRepayment,
        other_deductions: draft.otherDeductions,
        margin_percent: draft.marginPercent,
        lines: draft.lines.map((line) => ({
          kind: line.kind,
          position: line.position,
          designation: line.designation,
          unit: line.unit,
          contract_quantity: line.contractQuantity,
          unit_price: line.unitPrice,
          previous_quantity: line.previousQuantity,
          current_quantity: line.currentQuantity,
        })),
      }),
    });
    const result = await response.json();
    setDraftBusy(false);
    if (!response.ok) return setDraftMessage(result.error ?? "Enregistrement impossible.");
    setDraft(null);
    setDraftMessage("");
    router.refresh();
    void openPdf(`Facture ${claimNumberInput}`, `/api/billing/claims/${result.id}/pdf`);
  }

  async function deleteClaim(claimId: string) {
    if (!window.confirm("Supprimer ce brouillon de facture ?")) return;
    setBusy(true); setMessage("");
    const response = await fetch(`/api/billing/claims/${claimId}`, { method: "DELETE" });
    setBusy(false);
    if (!response.ok) { const result = await response.json(); return setMessage(result.error ?? "Suppression impossible."); }
    router.refresh();
  }

  return (
    <section>
      <Link href="/billing" className="tenderBackLink">← Retour aux chantiers</Link>

      <div className="pageHead">
        <div><h1>{project.project_code ? `${project.project_code} — ` : ""}{project.name}</h1><p>Facturation et suivi des paiements de ce chantier.</p></div>
      </div>

      <div className="stats billingStats">
        <article><span>Montant certifié</span><strong>{ariary.format(certified)} Ar</strong></article>
        <article><span>Paiements reçus</span><strong>{ariary.format(received)} Ar</strong></article>
        <article><span>Reste à encaisser</span><strong>{ariary.format(outstanding)} Ar</strong></article>
        <article><span>Encaissé</span><strong>{percent} %</strong></article>
      </div>
      <div className="progress"><span style={{ width: `${percent}%` }} /></div>

      {message && <p className="notice" style={{ marginTop: "16px" }}>{message}</p>}

      <div className="panel" style={{ marginTop: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
          <h3 style={{ margin: 0 }}>Factures</h3>
          <button type="button" className="button" disabled={draftBusy} onClick={() => void openInvoiceGenerator()}>
            {draftBusy && !draft ? "Calcul…" : "Générer une facture"}
          </button>
        </div>

        {draftMessage && <p className="notice" style={{ marginTop: "12px" }}>{draftMessage}</p>}

        {needsMargin && (
          <div className="panel" style={{ marginTop: "12px", background: "#fbf6e8" }}>
            <p>Ce chantier n'a pas de devis d'origine, donc pas de marge connue. Indique le pourcentage de marge à appliquer aux factures de ce chantier (retenu pour la prochaine fois) :</p>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <input type="number" step="0.1" value={marginInput} onChange={(e) => setMarginInput(e.target.value)} placeholder="Ex : 20" style={{ maxWidth: "120px" }} />
              <span>%</span>
              <button type="button" className="button" disabled={draftBusy} onClick={() => void confirmMargin()}>Valider la marge</button>
            </div>
          </div>
        )}

        {needsClientName && (
          <div className="panel" style={{ marginTop: "12px", background: "#fbf6e8" }}>
            <p>Ce chantier n'a pas de DAO avec un nom de client connu. Indique le nom du client à afficher sur les factures de ce chantier (retenu pour la prochaine fois) :</p>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <input value={clientNameInput} onChange={(e) => setClientNameInput(e.target.value)} placeholder="Ex : Mme RAKOTO Hery" style={{ maxWidth: "260px" }} />
              <button type="button" className="button" disabled={draftBusy} onClick={() => void confirmClientName()}>Valider le client</button>
            </div>
          </div>
        )}

        {draft && (
          <div className="panel" style={{ marginTop: "12px" }}>
            <div className="formPair">
              <label>N° de facture<input value={claimNumberInput} onChange={(e) => setClaimNumberInput(e.target.value)} /></label>
              <label>Date d'émission<input type="date" value={issueDateInput} onChange={(e) => setIssueDateInput(e.target.value)} /></label>
            </div>
            <p style={{ fontSize: ".85rem", color: "#666" }}>Client : <strong>{draft.clientName}</strong></p>
            {draft.previousClaimNumber && <p style={{ fontSize: ".85rem", color: "#666" }}>Facture précédente : {draft.previousClaimNumber} (les montants ci-dessous sont déjà nets de ce qui a été facturé dessus).</p>}
            {draft.expensesWarning && <p className="notice" style={{ background: "#fbeee0" }}>⚠ {draft.expensesWarning}</p>}
            {draft.unmatchedCount > 0 && (
              <p className="notice" style={{ background: "#fbeee0" }}>
                ⚠ {draft.unmatchedCount} ligne(s) du devis n'ont trouvé aucune tâche correspondante dans le planning : elles restent à 0 Ar cette fois (repérables ci-dessous par "non reconnue").
              </p>
            )}

            <div className="panel table" style={{ marginTop: "10px", overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Désignation</th><th>Unité</th><th>Qté marché</th><th>Prix unitaire</th>
                    <th>Qté/montant réalisé</th><th>Déjà facturé</th><th>À facturer</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((line, index) => (
                    <tr key={index}>
                      <td>{line.designation}{line.needsReview && <span className="pill" style={{ marginLeft: "6px", background: "#fbeee0" }}>non reconnue</span>}</td>
                      <td>{line.unit}</td>
                      <td>{line.contractQuantity === null ? "—" : line.contractQuantity}</td>
                      <td>{line.unitPrice === null ? "—" : `${ariary.format(line.unitPrice)} Ar`}</td>
                      <td>{ariary.format(line.currentAmount)} Ar</td>
                      <td>{ariary.format(line.previousAmount)} Ar</td>
                      <td><strong>{ariary.format(line.amountThisTime)} Ar</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="formGrid" style={{ marginTop: "12px" }}>
              <div><span className="pill">Montant brut</span><p>{ariary.format(draft.grossAmount)} Ar</p></div>
              <div><span className="pill">Retenue de garantie ({draft.retentionRate} %)</span><p>- {ariary.format(draft.retentionAmount)} Ar</p></div>
              <div><span className="pill">Taxe de l'État ({draft.taxRate} %)</span><p>+ {ariary.format(draft.taxAmount)} Ar</p></div>
              <div><span className="pill">Net à payer</span><p><strong>{ariary.format(draft.netAmount)} Ar</strong></p></div>
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
              <button type="button" className="button" disabled={draftBusy} onClick={() => void validateInvoice()}>{draftBusy ? "Enregistrement…" : "Valider et générer le PDF"}</button>
              <button type="button" className="ghostButton" onClick={() => setDraft(null)}>Annuler</button>
            </div>
          </div>
        )}

        <div className="panel table" style={{ marginTop: "14px" }}>
          <table>
            <thead><tr><th>N°</th><th>Date</th><th>Statut</th><th>Net à payer</th><th /></tr></thead>
            <tbody>{claims.map((claim) => (
              <tr key={claim.id}>
                <td>{claim.claim_number}</td>
                <td>{new Intl.DateTimeFormat("fr-FR").format(new Date(claim.issue_date))}</td>
                <td><span className="pill">{claimStatusLabel[claim.status] || claim.status}</span></td>
                <td><strong>{ariary.format(Number(claim.net_amount))} Ar</strong></td>
                <td style={{ display: "flex", gap: "8px" }}>
                  <button type="button" className="ghostButton" onClick={() => void openPdf(`Facture ${claim.claim_number}`, `/api/billing/claims/${claim.id}/pdf`)}>Ouvrir / Imprimer</button>
                  {claim.status === "draft" && <button type="button" className="dangerButton" disabled={busy} onClick={() => void deleteClaim(claim.id)}>Supprimer</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {!claims.length && <p className="emptyState">Aucune facture générée pour ce chantier.</p>}
        </div>
      </div>

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
