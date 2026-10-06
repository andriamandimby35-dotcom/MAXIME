"use client";

import Link from "next/link";
import { FormEvent, Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { certifiedAmount } from "@/lib/billing";
import { usePdfViewer } from "@/components/PdfViewerProvider";
import { overpaidAmount } from "@/lib/billing/pricing";

type Project = { id: string; project_code: string | null; name: string; location: string | null; budget_amount: number | string | null; status: string | null; source_estimate_id: string | null; manual_margin_percent: number | string | null };
type Payment = { id: string; progress_claim_id: string | null; payment_date: string; amount: number | string; method: string; reference: string | null; payment_type: string };
type Claim = { id: string; claim_number: string; issue_date: string; status: string; gross_amount: number | string; retention_amount: number | string; tax_amount: number | string; net_amount: number | string };
// Le chantier facturé peut provenir d'un appel d'offres remporté (source_tender_id) :
// on rappelle alors ici de quel DAO il s'agit, purement informatif — le calcul
// du client de la facture continue de se faire côté serveur (generate-situation.ts).
type Tender = { client_name: string | null; reference: string | null; title: string | null };

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
  category?: string;
  subcategory?: string;
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

type PricingInfo = {
  mode: "fixed" | "floating" | "none";
  certified: number;
  realCost: number;
  margin: number;
  marginPercent: number | null;
  expectedCost: number | null;
  hasDevis: boolean;
  contractAmount: number | null;
  settingsMarginPercent: number | null;
  settingsMarginAmount: number | null;
};

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const today = new Date().toISOString().slice(0, 10);
const paymentTypeLabel: Record<string, string> = { avancement: "Avancement", attachement: "Attachement", solde: "Solde de fin de travaux" };
const claimStatusLabel: Record<string, string> = { draft: "Brouillon", submitted: "Envoyée", approved: "Approuvée", partially_paid: "Partiellement payée", paid: "Payée", rejected: "Refusée" };

export function BillingProjectDetail({ project, tender, payments, claims, isAdmin, pricing }: { project: Project; tender: Tender | null; payments: Payment[]; claims: Claim[]; isAdmin: boolean; pricing: PricingInfo }) {
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
  // Certifié = ce que le client doit payer (devis, prix de l'offre, ou
  // dépenses réelles + marge attendue). Sans aucune information de prix, on
  // garde l'ancien calcul.
  const certified = pricing.mode !== "none"
    ? pricing.certified
    : claims.length > 0 ? netClaimsTotal : certifiedAmount(Number(project.budget_amount) || 0);
  const received = payments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const outstanding = Math.max(0, certified - received);
  const percent = certified > 0 ? Math.min(100, Math.round((received / certified) * 100)) : 0;
  const overpaid = overpaidAmount(certified, received);

  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editPayment, setEditPayment] = useState({ payment_date: today, amount: "0", payment_type: "avancement", method: "bank_transfer", reference: "" });
  // Prix de l'offre OU marge attendue, jamais les deux : l'application doit
  // savoir sans ambiguïté lequel est fixe.
  const [pricingForm, setPricingForm] = useState({
    kind: (pricing.contractAmount ? "price" : pricing.settingsMarginPercent !== null || pricing.settingsMarginAmount !== null ? "margin" : "price") as "price" | "margin",
    contract_amount: pricing.contractAmount ? String(pricing.contractAmount) : "",
    margin_kind: pricing.settingsMarginAmount !== null && pricing.settingsMarginPercent === null ? "amount" : "percent",
    margin_value: pricing.settingsMarginPercent !== null ? String(pricing.settingsMarginPercent) : pricing.settingsMarginAmount !== null ? String(pricing.settingsMarginAmount) : "",
  });
  const [pricingMessage, setPricingMessage] = useState("");
  const [editingPricing, setEditingPricing] = useState(false);
  const hasSavedPricing = Boolean(pricing.contractAmount) || pricing.settingsMarginPercent !== null || pricing.settingsMarginAmount !== null;

  // Import des prix du devis (PDF) pour un chantier créé sans prix.
  type ImportLine = { category: string; subcategory: string; designation: string; unit: string; quantity: number; unit_price: number };
  const [importLines, setImportLines] = useState<ImportLine[] | null>(null);
  const [importTotal, setImportTotal] = useState<number | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  async function deletePricing() {
    if (!window.confirm("Supprimer le prix / la marge enregistrés pour ce chantier ?")) return;
    setBusy(true); setPricingMessage("");
    const response = await fetch(`/api/billing/projects/${project.id}/pricing`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setPricingMessage(result.error ?? "Suppression impossible.");
    setPricingForm({ kind: "price", contract_amount: "", margin_kind: "percent", margin_value: "" });
    setEditingPricing(false);
    router.refresh();
  }

  async function readDevisPdf(file: File) {
    setImportBusy(true); setImportMessage(""); setImportLines(null);
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/billing/projects/${project.id}/import-devis`, { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    setImportBusy(false);
    if (!response.ok) return setImportMessage(result.error ?? "Lecture du PDF impossible.");
    setImportLines(result.price_lines ?? []);
    setImportTotal(result.devis_total ?? null);
  }

  async function saveImportedDevis() {
    if (!importLines) return;
    setImportBusy(true); setImportMessage("");
    const response = await fetch(`/api/billing/projects/${project.id}/import-devis`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ price_lines: importLines }),
    });
    const result = await response.json().catch(() => ({}));
    setImportBusy(false);
    if (!response.ok) return setImportMessage(result.error ?? "Enregistrement impossible.");
    setImportLines(null);
    setImportMessage("Prix du devis enregistrés.");
    router.refresh();
  }

  function startEditPayment(payment: Payment) {
    setEditingPaymentId(payment.id);
    setEditPayment({ payment_date: payment.payment_date.slice(0, 10), amount: String(Number(payment.amount)), payment_type: payment.payment_type, method: payment.method, reference: payment.reference ?? "" });
  }

  async function saveEditedPayment() {
    if (!editingPaymentId) return;
    setBusy(true); setMessage("");
    const response = await fetch(`/api/billing/payments/${editingPaymentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editPayment),
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setMessage(result.error ?? "Modification impossible.");
    setEditingPaymentId(null);
    setMessage("Paiement modifié.");
    router.refresh();
  }

  async function savePricing() {
    setBusy(true); setPricingMessage("");
    const response = await fetch(`/api/billing/projects/${project.id}/pricing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract_amount: pricingForm.kind === "price" ? pricingForm.contract_amount : "",
        margin_kind: pricingForm.margin_kind,
        margin_value: pricingForm.kind === "margin" ? pricingForm.margin_value : "",
      }),
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setPricingMessage(result.error ?? "Enregistrement impossible.");
    setPricingMessage("Prix et marge enregistrés.");
    setEditingPricing(false);
    router.refresh();
  }

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
          category: line.category,
          subcategory: line.subcategory,
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
        <div>
          <h1>{project.project_code ? `${project.project_code} — ` : ""}{project.name}</h1>
          <p>Facturation et suivi des paiements de ce chantier.</p>
          {tender && (
            <p style={{ fontSize: ".85rem", color: "#666" }}>
              Issu de l'appel d'offres {tender.reference ? `${tender.reference} — ` : ""}{tender.title ?? ""}
              {tender.client_name ? ` (client : ${tender.client_name})` : ""}
            </p>
          )}
        </div>
      </div>

      <div className="stats billingStats">
        <article><span>Montant certifié</span><strong>{ariary.format(certified)} Ar</strong></article>
        <article style={overpaid > 0 ? { background: "#fdecec", border: "2px solid #c0392b" } : undefined}>
          <span style={overpaid > 0 ? { color: "#b3261e" } : undefined}>Paiements reçus</span>
          <strong style={overpaid > 0 ? { color: "#b3261e" } : undefined}>{ariary.format(received)} Ar</strong>
        </article>
        <article><span>Reste à encaisser</span><strong>{ariary.format(outstanding)} Ar</strong></article>
        <article><span>Encaissé</span><strong>{percent} %</strong></article>
      </div>
      <div className="progress"><span style={{ width: `${percent}%` }} /></div>

      {overpaid > 0 && (
        <p className="notice" style={{ marginTop: "12px", background: "#fdecec", color: "#b3261e", fontWeight: 700 }}>
          Erreur : les paiements reçus dépassent le montant certifié de {ariary.format(overpaid)} Ar.
          {isAdmin ? " Corrige ou annule le paiement fautif dans la liste ci-dessous (bouton « Modifier »)." : " Demande à l'administrateur de corriger le paiement."}
        </p>
      )}

      {pricing.mode !== "none" && (
        <p style={{ marginTop: "10px", fontSize: ".9rem", color: "#555" }}>
          Dépenses réelles payées : <strong>{ariary.format(pricing.realCost)} Ar</strong>
          {" · "}Marge actuelle : <strong>{ariary.format(pricing.margin)} Ar{pricing.marginPercent !== null ? ` (${pricing.marginPercent.toFixed(1)} % des dépenses)` : ""}</strong>
          {pricing.mode === "fixed" ? " · Prix fixe : seule la marge change quand les dépenses changent." : " · Prix = dépenses réelles + marge attendue."}
        </p>
      )}

      {isAdmin && !pricing.hasDevis && hasSavedPricing && !editingPricing && (
        <div className="panel" style={{ marginTop: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <span style={{ fontSize: ".8rem", color: "#666" }}>{pricing.contractAmount ? "Prix de l'offre (fixe)" : "Marge attendue"}</span>
            <div style={{ fontSize: "1.3rem", fontWeight: 700 }}>
              {pricing.contractAmount
                ? `${ariary.format(pricing.contractAmount)} Ar`
                : pricing.settingsMarginPercent !== null
                  ? `${pricing.settingsMarginPercent} %`
                  : `${ariary.format(pricing.settingsMarginAmount ?? 0)} Ar (bénéfice)`}
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" className="ghostButton" disabled={busy} onClick={() => setEditingPricing(true)}>Modifier</button>
            <button type="button" className="ghostButton" disabled={busy} onClick={() => void deletePricing()} style={{ color: "#b3261e" }}>Supprimer</button>
          </div>
        </div>
      )}

      {isAdmin && !pricing.hasDevis && (!hasSavedPricing || editingPricing) && (
        <div className="panel" style={{ marginTop: "16px" }}>
          <h3 style={{ marginTop: 0 }}>Prix et marge de ce chantier</h3>
          <p style={{ fontSize: ".85rem", color: "#666" }}>
            Ce chantier n'a pas de devis chiffré. Choisis <strong>une seule</strong> des deux façons :
            le <strong>prix de l'offre</strong> (somme fixe que le client paie, seule ta marge change selon les dépenses ; on facture selon l'avancement du planning)
            ou la <strong>marge attendue</strong> (le prix suit alors les dépenses réelles).
          </p>
          <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", margin: "10px 0" }}>
            <label style={{ display: "flex", flexDirection: "row", gap: "8px", alignItems: "center", width: "auto" }}>
              <input type="radio" name="pricingKind" style={{ width: "auto", margin: 0 }} checked={pricingForm.kind === "price"} onChange={() => setPricingForm({ ...pricingForm, kind: "price" })} /> <span>Prix de l'offre (fixe)</span>
            </label>
            <label style={{ display: "flex", flexDirection: "row", gap: "8px", alignItems: "center", width: "auto" }}>
              <input type="radio" name="pricingKind" style={{ width: "auto", margin: 0 }} checked={pricingForm.kind === "margin"} onChange={() => setPricingForm({ ...pricingForm, kind: "margin" })} /> <span>Marge attendue</span>
            </label>
          </div>
          {pricingForm.kind === "price" ? (
            <label>Prix de l'offre (Ar)<input type="number" min="0" value={pricingForm.contract_amount} onChange={(e) => setPricingForm({ ...pricingForm, contract_amount: e.target.value })} placeholder="Ex : 10000000" /></label>
          ) : (
            <label>Marge attendue
              <span style={{ display: "flex", gap: "8px" }}>
                <input type="number" step="0.1" value={pricingForm.margin_value} onChange={(e) => setPricingForm({ ...pricingForm, margin_value: e.target.value })} placeholder={pricingForm.margin_kind === "percent" ? "Ex : 20" : "Ex : 2000000"} />
                <select value={pricingForm.margin_kind} onChange={(e) => setPricingForm({ ...pricingForm, margin_kind: e.target.value })}>
                  <option value="percent">%</option>
                  <option value="amount">Ar (bénéfice)</option>
                </select>
              </span>
            </label>
          )}
          <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
            <button type="button" className="button" disabled={busy} onClick={() => void savePricing()}>Enregistrer le prix / la marge</button>
            {editingPricing && <button type="button" className="ghostButton" disabled={busy} onClick={() => setEditingPricing(false)}>Annuler</button>}
          </div>
          {pricingMessage && <p className="notice" style={{ marginTop: "10px" }}>{pricingMessage}</p>}
        </div>
      )}

      {isAdmin && !pricing.hasDevis && (
        <div className="panel" style={{ marginTop: "16px" }}>
          <h3 style={{ marginTop: 0 }}>Importer les prix du devis (PDF)</h3>
          <p style={{ fontSize: ".85rem", color: "#666" }}>
            Si les prix du devis n'ont pas été lus à la création du chantier, donne ici le PDF du devis chiffré : l'application en extrait les catégories, sous-catégories et prix,
            tu les vérifies, puis la facture sera faite exactement comme le devis (avancement tiré du planning). Le planning du chantier n'est pas modifié.
          </p>
          {!importLines && (
            <input type="file" accept="application/pdf" disabled={importBusy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void readDevisPdf(file); e.target.value = ""; }} />
          )}
          {importBusy && !importLines && <p className="notice" style={{ marginTop: "10px" }}>Lecture du PDF en cours (cela peut prendre une minute)…</p>}
          {importLines && (
            <div style={{ marginTop: "10px" }}>
              <p><strong>{importLines.length} lignes chiffrées trouvées</strong>{importTotal ? ` · total écrit dans le devis : ${ariary.format(importTotal)} Ar` : ""} · total calculé : <strong>{ariary.format(importLines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0))} Ar</strong></p>
              <div style={{ maxHeight: "320px", overflow: "auto" }}>
                <table style={{ width: "100%", fontSize: ".85rem" }}>
                  <thead><tr><th>Catégorie</th><th>Sous-catégorie</th><th>Désignation</th><th>Qté</th><th>Prix unitaire</th><th>Montant</th></tr></thead>
                  <tbody>
                    {importLines.map((line, index) => (
                      <tr key={index}>
                        <td>{line.category}</td><td>{line.subcategory}</td><td>{line.designation}</td>
                        <td>{line.quantity} {line.unit}</td>
                        <td>{ariary.format(line.unit_price)}</td>
                        <td>{ariary.format(line.quantity * line.unit_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                <button type="button" className="button" disabled={importBusy} onClick={() => void saveImportedDevis()}>{importBusy ? "Enregistrement…" : "Enregistrer ces prix"}</button>
                <button type="button" className="ghostButton" disabled={importBusy} onClick={() => setImportLines(null)}>Annuler</button>
              </div>
            </div>
          )}
          {importMessage && <p className="notice" style={{ marginTop: "10px" }}>{importMessage}</p>}
        </div>
      )}

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
                    <th>Qté/montant réalisé</th><th>Avancement</th><th>Déjà facturé</th><th>À facturer</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((line, index) => {
                    const previous = draft.lines[index - 1];
                    const newCategory = Boolean(line.category) && line.category !== previous?.category;
                    const newSubcategory = Boolean(line.subcategory) && (newCategory || line.subcategory !== previous?.subcategory);
                    return (
                    <Fragment key={index}>
                    {newCategory && <tr><td colSpan={8} style={{ background: "#e3ebe5", fontWeight: 800 }}>{line.category}</td></tr>}
                    {newSubcategory && <tr><td colSpan={8} style={{ background: "#f0f4f1", fontWeight: 700, paddingLeft: "22px" }}>{line.subcategory}</td></tr>}
                    <tr>
                      <td>{line.designation}{line.needsReview && <span className="pill" style={{ marginLeft: "6px", background: "#fbeee0" }}>non reconnue</span>}</td>
                      <td>{line.unit}</td>
                      <td>{line.contractQuantity === null ? "—" : line.contractQuantity}</td>
                      <td>{line.unitPrice === null ? "—" : `${ariary.format(line.unitPrice)} Ar`}</td>
                      <td>{ariary.format(line.currentAmount)} Ar</td>
                      <td>{line.kind === "devis" && line.contractQuantity ? `${Math.max(0, Math.min(100, (line.currentQuantity / line.contractQuantity) * 100)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %` : "—"}</td>
                      <td>{ariary.format(line.previousAmount)} Ar</td>
                      <td><strong>{ariary.format(line.amountThisTime)} Ar</strong></td>
                    </tr>
                    </Fragment>
                    );
                  })}
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
                <td style={{ display: "flex", gap: "8px" }}>
                  {isAdmin && <button type="button" className="ghostButton" disabled={busy} onClick={() => startEditPayment(payment)}>Modifier</button>}
                  <button type="button" className="dangerButton" disabled={busy} onClick={() => void cancelPayment(payment.id)}>Annuler</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
          {editingPaymentId && (
            <div className="panel" style={{ marginTop: "12px", background: "#fbf6e8" }}>
              <strong>Modifier le paiement</strong>
              <div className="formPair" style={{ marginTop: "8px" }}>
                <label>Date<input type="date" value={editPayment.payment_date} onChange={(e) => setEditPayment({ ...editPayment, payment_date: e.target.value })} /></label>
                <label>Montant (Ar)<input type="number" min="0" value={editPayment.amount} onChange={(e) => setEditPayment({ ...editPayment, amount: e.target.value })} /></label>
              </div>
              <div className="formPair">
                <label>Origine<select value={editPayment.payment_type} onChange={(e) => setEditPayment({ ...editPayment, payment_type: e.target.value })}><option value="avancement">Avancement</option><option value="attachement">Attachement</option><option value="solde">Solde de fin de travaux</option></select></label>
                <label>Mode<select value={editPayment.method} onChange={(e) => setEditPayment({ ...editPayment, method: e.target.value })}><option value="bank_transfer">Virement bancaire</option><option value="cheque">Chèque</option><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="other">Autre</option></select></label>
              </div>
              <label>Référence<input value={editPayment.reference} onChange={(e) => setEditPayment({ ...editPayment, reference: e.target.value })} /></label>
              <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                <button type="button" className="button" disabled={busy} onClick={() => void saveEditedPayment()}>Enregistrer la modification</button>
                <button type="button" className="ghostButton" onClick={() => setEditingPaymentId(null)}>Annuler</button>
              </div>
            </div>
          )}
          {!payments.length && <p className="emptyState">Aucun paiement enregistré pour ce chantier.</p>}
        </div>
      </div>
    </section>
  );
}
