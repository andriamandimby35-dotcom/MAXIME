"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatAr } from "@/components/money";

type Estimate = { id: string; label: string; createdAt: string | null; internalTotal: number; externalBase: number; markupBase: number; margin: number };

export function EstimateList({ estimates }: { estimates: Estimate[] }) {
  const [rows, setRows] = useState(estimates);
  const [message, setMessage] = useState("");
  useEffect(() => setRows(estimates), [estimates]);
  async function openExternalPdf(id: string) {
    const preview = window.open("about:blank", "_blank");
    if (!preview) { setMessage("Le navigateur a bloqué la fenêtre PDF. Autorisez les fenêtres surgissantes puis réessayez."); return; }
    preview.document.title = "Préparation du PDF…";
    preview.document.body.innerHTML = "<p style='font-family:system-ui;padding:24px'>Préparation du PDF…</p>";
    try {
      const response = await fetch(`/api/estimates/${id}/official-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PDF-Client-Fetch": "1" },
        body: JSON.stringify({ save: false, mode: "external" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.pdfBase64) throw new Error(payload.error || "Le PDF externe ne peut pas être ouvert.");
      const bytes = Uint8Array.from(atob(payload.pdfBase64), (character) => character.charCodeAt(0));
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      preview.location.replace(objectUrl);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 60 * 1000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Le PDF externe ne peut pas être ouvert.";
      preview.document.title = "PDF indisponible";
      preview.document.body.innerHTML = `<p style="font-family:system-ui;padding:24px">${detail.replace(/[<>&]/g, "")}</p>`;
      setMessage(detail);
    }
  }
  async function deleteEstimate(id: string, label: string) {
    if (!window.confirm(`Supprimer définitivement le devis « ${label} » et toutes ses lignes ?`)) return;
    const response = await fetch(`/api/estimates/${id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(payload.error || "Suppression du devis impossible."); return; }
    setRows((current) => current.filter((row) => row.id !== id));
    setMessage("Devis supprimé.");
  }
  async function saveMargin(id: string, raw: string) {
    const margin = Math.max(0, Number(raw) || 0);
    const response = await fetch(`/api/estimates/${id}/margin`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profit_margin_percent: margin }) });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.error || "Marge non enregistrée."); return; }
    setRows((current) => current.map((row) => row.id === id ? { ...row, margin } : row));
    const pdfResponse = await fetch(`/api/estimates/${id}/official-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ save: true, mode: "external" }),
    });
    const pdfPayload = await pdfResponse.json().catch(() => ({}));
    setMessage(pdfResponse.ok
      ? "Marge enregistrée et PDF externe remplacé. Les prix des matériaux n'ont pas été modifiés."
      : `Marge enregistrée, mais le PDF externe n'a pas été remplacé : ${pdfPayload.error || "erreur inconnue"}`);
  }
  return <main className="estimateListPage"><div className="pageHead"><div><h1>Devis</h1><p>Un même chiffrage enregistre deux versions séparées : interne privée et soumission externe.</p></div><Link className="tenderButton tenderButtonPrimary tenderAddButton" href="/estimates/new">+ Créer un devis</Link></div>{message && <p className="notice">{message}</p>}<section className="panel tablePanel estimateListTable"><table><thead><tr><th>Devis / DAO</th><th>Coût interne</th><th>Marge externe</th><th>Bénéfice attendu</th><th>Montant soumission</th><th>Versions</th></tr></thead><tbody>{rows.length ? rows.map((row) => { const profit = row.markupBase * row.margin / 100; const externalTotal = row.externalBase + profit; return <tr key={row.id} className="estimateListRow"><td><strong>{row.label}</strong><br /><small>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("fr-FR") : ""}</small></td><td>{formatAr(row.internalTotal)}</td><td><label className="estimateMargin"><input type="number" min="0" step="0.1" value={row.margin} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, margin: Number(event.target.value) || 0 } : item))} onBlur={(event) => void saveMargin(row.id, event.target.value)} /> %</label></td><td className="estimateProfit">{formatAr(profit)}</td><td><strong>{formatAr(externalTotal)}</strong><small className="estimateUnitNote">prix des matériaux non majorés</small></td><td><div className="estimateActions"><Link className="tenderButton" href={`/estimates/${row.id}`}>Gérer les deux versions</Link><button type="button" className="tenderButton tenderButtonPrimary" onClick={() => void openExternalPdf(row.id)}>PDF externe</button><button type="button" className="text-red-700 underline" onClick={() => void deleteEstimate(row.id, row.label)}>Supprimer</button></div></td></tr>; }) : <tr><td colSpan={6} className="empty">Aucun devis. Créez un devis depuis un DAO analysé.</td></tr>}</tbody></table></section></main>;
}
