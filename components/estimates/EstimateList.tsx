"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatAr } from "@/components/money";
import { AddEstimateChooser } from "@/components/estimates/AddEstimateChooser";
import type { ImportedDevis } from "@/components/estimates/ImportedDevisTable";
import { confirmDeletion } from "@/components/deletion/confirmDeletion";
import { openDevisPdf } from "@/components/estimates/openPdf";

type Estimate = { id: string; label: string; createdAt: string | null; internalTotal: number; externalBase: number; markupBase: number; margin: number };

// Une seule liste pour tous les devis : ceux qui viennent d'un DAO et ceux
// ajoutés par PDF ont la même carte (mêmes colonnes, mêmes boutons). Seule
// l'origine change (étiquette « DAO » ou « PDF »), et la marge d'un devis PDF
// est calculée (externe ÷ interne − 1) au lieu d'être saisie.
type Entry =
  | { kind: "dao"; id: string; createdAt: string | null; row: Estimate }
  | { kind: "pdf"; id: string; createdAt: string | null; row: ImportedDevis };

export function EstimateList({ estimates, imported = [] }: { estimates: Estimate[]; imported?: ImportedDevis[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(estimates);
  const [message, setMessage] = useState("");
  useEffect(() => setRows(estimates), [estimates]);

  const entries = useMemo<Entry[]>(() => [
    ...rows.map((row): Entry => ({ kind: "dao", id: row.id, createdAt: row.createdAt, row })),
    ...imported.map((row): Entry => ({ kind: "pdf", id: row.id, createdAt: row.createdAt, row })),
  ].sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))), [rows, imported]);

  async function openPdf(entry: Entry, mode: "external" | "internal") {
    const error = entry.kind === "dao"
      ? await openDevisPdf(`/api/estimates/${entry.id}/official-pdf`, { save: false, mode })
      : await openDevisPdf(`/api/devis/projects/${entry.id}/pdf`, { mode });
    if (error) setMessage(error);
  }
  async function deleteEntry(entry: Entry) {
    // Supprime le devis ET, en chaîne, son chantier (dépenses, factures non payées) ; les factures payées sont gardées.
    const label = entry.kind === "dao" ? entry.row.label : entry.row.name;
    if (!(await confirmDeletion(entry.kind === "dao" ? "estimate" : "project", entry.id))) return;
    const response = await fetch(entry.kind === "dao" ? `/api/estimates/${entry.id}` : `/api/projects/${entry.id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setMessage(payload.error || "Suppression du devis impossible."); return; }
    if (entry.kind === "dao") setRows((current) => current.filter((row) => row.id !== entry.id));
    setMessage(`Devis « ${label} » supprimé.`);
    router.refresh();
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

  const badge = (text: string) => <span style={{ display: "inline-block", marginLeft: 8, padding: "1px 8px", borderRadius: 999, background: "#e7f3ec", color: "#14532d", fontSize: ".68rem", fontWeight: 700, verticalAlign: "middle" }}>{text}</span>;

  return <main className="estimateListPage">
    <div className="pageHead"><div><h1>Devis</h1><p>Un même chiffrage enregistre deux versions séparées : interne privée et soumission externe.</p></div><AddEstimateChooser /></div>
    {message && <p className="notice">{message}</p>}
    <section className="panel tablePanel estimateListTable">
      <table>
        <thead><tr><th>Devis / DAO</th><th>Coût interne</th><th>Marge externe</th><th>Bénéfice attendu</th><th>Montant soumission</th><th>Versions</th></tr></thead>
        <tbody>
          {entries.length ? entries.map((entry) => {
            if (entry.kind === "dao") {
              const row = entry.row;
              const profit = row.markupBase * row.margin / 100;
              const externalTotal = row.externalBase + profit;
              return <tr key={`dao-${row.id}`} className="estimateListRow">
                <td data-label="Devis / DAO"><Link href={`/estimates/${row.id}`}><strong>{row.label}</strong></Link>{badge("DAO")}<br /><small>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("fr-FR") : ""}</small></td>
                <td data-label="Coût interne">{formatAr(row.internalTotal)}</td>
                <td data-label="Marge externe"><label className="estimateMargin"><input type="number" min="0" step="0.1" value={row.margin} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, margin: Number(event.target.value) || 0 } : item))} onBlur={(event) => void saveMargin(row.id, event.target.value)} /> %</label></td>
                <td className="estimateProfit" data-label="Bénéfice attendu">{formatAr(profit)}</td>
                <td data-label="Montant soumission"><strong>{formatAr(externalTotal)}</strong><small className="estimateUnitNote">prix des matériaux non majorés</small></td>
                <td data-label="Versions"><div className="estimateActions">
                  <Link className="tenderButton" href={`/estimates/${row.id}`}>Gérer les deux versions</Link>
                  <button type="button" className="tenderButton" onClick={() => void openPdf(entry, "internal")}>PDF interne</button>
                  <button type="button" className="tenderButton tenderButtonPrimary" onClick={() => void openPdf(entry, "external")}>PDF externe</button>
                  <button type="button" className="text-red-700 underline" onClick={() => void deleteEntry(entry)}>Supprimer</button>
                </div></td>
              </tr>;
            }
            const row = entry.row;
            const partial = row.missingInternal > 0 && row.internalTotal > 0;
            return <tr key={`pdf-${row.id}`} className="estimateListRow">
              <td data-label="Devis / DAO"><Link href={`/estimates/imported/${row.id}`}><strong>{row.name}</strong></Link>{badge("PDF")}<br /><small>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("fr-FR") : ""} · {row.lines} lignes</small></td>
              <td data-label="Coût interne">{row.internalTotal > 0 ? formatAr(row.internalTotal) : "—"}{partial ? <small className="estimateUnitNote">{row.missingInternal} prix à remplir</small> : null}{row.internalTotal <= 0 && row.missingInternal > 0 ? <small className="estimateUnitNote">{row.missingInternal} prix à remplir</small> : null}</td>
              <td data-label="Marge externe">{row.marginPercent !== null ? `${row.marginPercent.toLocaleString("fr-FR")} %` : "—"}<small className="estimateUnitNote">calculée</small></td>
              <td className="estimateProfit" data-label="Bénéfice attendu">{row.profit !== null ? formatAr(row.profit) : "—"}</td>
              <td data-label="Montant soumission"><strong>{row.externalTotal > 0 ? formatAr(row.externalTotal) : "—"}</strong><small className="estimateUnitNote">devis importé</small></td>
              <td data-label="Versions"><div className="estimateActions">
                <Link className="tenderButton" href={`/estimates/imported/${row.id}`}>Gérer les deux versions</Link>
                <button type="button" className="tenderButton" onClick={() => void openPdf(entry, "internal")}>PDF interne</button>
                <button type="button" className="tenderButton tenderButtonPrimary" onClick={() => void openPdf(entry, "external")}>PDF externe</button>
                <button type="button" className="text-red-700 underline" onClick={() => void deleteEntry(entry)}>Supprimer</button>
              </div></td>
            </tr>;
          }) : <tr><td colSpan={6} className="empty">Aucun devis. Créez un devis depuis un DAO analysé, ou ajoutez-en un par PDF.</td></tr>}
        </tbody>
      </table>
    </section>
  </main>;
}
