"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatAr } from "@/components/money";
import { AddEstimateChooser } from "@/components/estimates/AddEstimateChooser";
import type { ImportedDevis } from "@/components/estimates/ImportedDevisTable";
import { confirmDeletion } from "@/components/deletion/confirmDeletion";
import { fetchDevisPdfUrl, openDevisPdf } from "@/components/estimates/openPdf";
import { isPhoneDevice } from "@/lib/is-phone-device";

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
  // Aperçu PDF affiché PAR-DESSUS la page (ordinateur) : aucune nouvelle fenêtre.
  const [viewer, setViewer] = useState<{ url: string; title: string } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  useEffect(() => setRows(estimates), [estimates]);
  useEffect(() => () => { if (viewer) URL.revokeObjectURL(viewer.url); }, [viewer]);
  useEffect(() => {
    if (!pdfBusy) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [pdfBusy]);

  const entries = useMemo<Entry[]>(() => [
    ...rows.map((row): Entry => ({ kind: "dao", id: row.id, createdAt: row.createdAt, row })),
    ...imported.map((row): Entry => ({ kind: "pdf", id: row.id, createdAt: row.createdAt, row })),
  ].sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))), [rows, imported]);

  async function openPdf(entry: Entry, mode: "external" | "internal") {
    const endpoint = entry.kind === "dao" ? `/api/estimates/${entry.id}/official-pdf` : `/api/devis/projects/${entry.id}/pdf`;
    const body = entry.kind === "dao" ? { save: false, mode } : { mode };
    // Téléphone : le PDF s'ouvre plein écran dans le lecteur du téléphone (seule façon de le lire correctement).
    if (isPhoneDevice()) {
      const error = await openDevisPdf(endpoint, body);
      if (error) setMessage(error);
      return;
    }
    if (pdfBusy) return;
    setPdfBusy(true); setMessage("Création de l’aperçu PDF…");
    const result = await fetchDevisPdfUrl(endpoint, body);
    setPdfBusy(false);
    if ("error" in result) { setMessage(result.error); return; }
    setMessage("");
    const label = entry.kind === "dao" ? entry.row.label : entry.row.name;
    setViewer({ url: result.url, title: `${mode === "internal" ? "Devis interne" : "Devis externe"} — ${label}` });
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

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const metricStrong: React.CSSProperties = { fontSize: ".9rem", wordBreak: "break-word" };
  const actionsStyle: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "14px 0" };
  const metricsStyle: React.CSSProperties = { gridTemplateColumns: "repeat(2,minmax(0,1fr))" };
  const cardProps = (href: string) => ({
    className: "projectDirectoryCard",
    style: { cursor: "pointer" } as React.CSSProperties,
    role: "link",
    tabIndex: 0,
    onClick: () => router.push(href),
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" && event.target === event.currentTarget) router.push(href); },
  });

  return <main className="estimateListPage">
    <div className="pageHead"><div><h1>Devis</h1><p>Un même chiffrage enregistre deux versions séparées : interne privée et soumission externe. Cliquez sur un devis pour l’ouvrir.</p></div><AddEstimateChooser /></div>
    {message && <p className="notice" style={{ overflowWrap: "anywhere" }}>{message}</p>}
    {viewer && (
      <div role="dialog" aria-modal="true" aria-label={viewer.title} style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(15,23,20,.72)", display: "flex", flexDirection: "column", padding: 16, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, color: "#fff", minWidth: 0 }}>
          <strong style={{ overflowWrap: "anywhere" }}>{viewer.title}</strong>
          <button type="button" className="tenderButton tenderButtonPrimary" onClick={() => setViewer(null)}>Fermer</button>
        </div>
        <iframe src={viewer.url} title={viewer.title} style={{ flex: 1, width: "100%", border: 0, borderRadius: 8, background: "#fff" }} />
      </div>
    )}
    {entries.length === 0 ? (
      <section className="projectEmptyCard"><h2>Aucun devis</h2><p>Créez un devis depuis un DAO analysé, ou ajoutez-en un par PDF.</p></section>
    ) : (
      <section className="projectDirectoryGrid" aria-label="Liste des devis">
        {entries.map((entry) => {
          if (entry.kind === "dao") {
            const row = entry.row;
            const profit = row.markupBase * row.margin / 100;
            const externalTotal = row.externalBase + profit;
            return <div key={`dao-${row.id}`} {...cardProps(`/estimates/${row.id}`)}>
              <span className="projectCardLabel">DEVIS · DAO</span>
              <h2 style={{ fontSize: "1.25rem" }}>{row.label}</h2>
              <p className="projectCardLocation" style={{ minHeight: 0 }}>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("fr-FR") : ""}</p>
              <div className="projectCardMetrics" style={metricsStyle}>
                <span><strong style={metricStrong}>{formatAr(row.internalTotal)}</strong>coût interne</span>
                <span onClick={stop} onKeyDown={stop}>
                  <strong style={metricStrong}><label className="estimateMargin"><input type="number" min="0" step="0.1" value={row.margin} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, margin: Number(event.target.value) || 0 } : item))} onBlur={(event) => void saveMargin(row.id, event.target.value)} /> %</label></strong>marge externe
                </span>
                <span><strong style={{ ...metricStrong, color: "#145b35" }}>{formatAr(profit)}</strong>bénéfice attendu</span>
                <span><strong style={metricStrong}>{formatAr(externalTotal)}</strong>montant soumission</span>
              </div>
              <div style={actionsStyle} onClick={stop} onKeyDown={stop}>
                <button type="button" className="tenderButton" onClick={() => void openPdf(entry, "internal")}>PDF interne</button>
                <button type="button" className="tenderButton tenderButtonPrimary" onClick={() => void openPdf(entry, "external")}>PDF externe</button>
                <button type="button" className="text-red-700 underline" onClick={() => void deleteEntry(entry)}>Supprimer</button>
              </div>
              <span className="projectOpenButton">Gérer les deux versions →</span>
            </div>;
          }
          const row = entry.row;
          return <div key={`pdf-${row.id}`} {...cardProps(`/estimates/imported/${row.id}`)}>
            <span className="projectCardLabel">DEVIS · PDF</span>
            <h2 style={{ fontSize: "1.25rem" }}>{row.name}</h2>
            <p className="projectCardLocation" style={{ minHeight: 0 }}>{row.createdAt ? new Date(row.createdAt).toLocaleDateString("fr-FR") : ""} · {row.lines} lignes</p>
            <div className="projectCardMetrics" style={metricsStyle}>
              <span><strong style={metricStrong}>{row.internalTotal > 0 ? formatAr(row.internalTotal) : "—"}</strong>coût interne{row.missingInternal > 0 ? ` · ${row.missingInternal} prix à remplir` : ""}</span>
              <span><strong style={metricStrong}>{row.marginPercent !== null ? `${row.marginPercent.toLocaleString("fr-FR")} %` : "—"}</strong>marge (calculée)</span>
              <span><strong style={{ ...metricStrong, color: "#145b35" }}>{row.profit !== null ? formatAr(row.profit) : "—"}</strong>bénéfice attendu</span>
              <span><strong style={metricStrong}>{row.externalTotal > 0 ? formatAr(row.externalTotal) : "—"}</strong>montant du devis importé</span>
            </div>
            <div style={actionsStyle} onClick={stop} onKeyDown={stop}>
              <button type="button" className="tenderButton" onClick={() => void openPdf(entry, "internal")}>PDF interne</button>
              <button type="button" className="tenderButton tenderButtonPrimary" onClick={() => void openPdf(entry, "external")}>PDF externe</button>
              <button type="button" className="text-red-700 underline" onClick={() => void deleteEntry(entry)}>Supprimer</button>
            </div>
            <span className="projectOpenButton">Gérer les deux versions →</span>
          </div>;
        })}
      </section>
    )}
  </main>;
}
