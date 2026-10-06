"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatAr } from "@/components/money";
import { summarizeDevis } from "@/lib/devis/pricing";
import { isLaborLine } from "@/lib/compositions/labor";
import { openDevisPdf } from "@/components/estimates/openPdf";
import { confirmDeletion } from "@/components/deletion/confirmDeletion";

export type DevisLine = {
  id: string;
  position?: string | null;
  designation: string | null;
  unit: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  external_unit_price: number | string | null;
  is_internal: boolean | null;
  category?: string | null;
  subcategory?: string | null;
};

type Project = { id: string; name: string; createdAt: string | null; marginPercent: number | null };
type View = "external" | "internal";

type CalcPart = { designation: string; unit: string; quantity: number; unitPrice: number | null; amount: number; optional: boolean };
type CalcDetail = { id: string; designation: string; unit: string; status: "bibliothèque" | "composition" | "matériau manquant" | "sans composition"; price: number | null; title?: string; notes?: string[]; parts?: CalcPart[]; missing?: string[] };
type CalcResult = {
  saved: number; computed: number; fromLibrary: number; fromShared: number; laborLines: number;
  details: CalcDetail[];
  missingMaterials: Array<{ designation: string; search: string; unit: string; lines: number }>;
  noCompositionIds: string[];
};

const num = (value: unknown) => Number(value) || 0;

// Page d'un devis ajouté par PDF. Même organisation que la page d'un devis du
// DAO : un résumé, deux versions (externe = devis importé, interne = tes coûts),
// la génération des PDF, la recherche des prix par l'IA et, en bas, le devis
// affiché au choix (interne ou externe).
export function ImportedDevisDetail({ project, lines, isAdmin }: { project: Project; lines: DevisLine[]; isAdmin: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(lines);
  const [view, setView] = useState<View>("external");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [marginInput, setMarginInput] = useState("");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [calc, setCalc] = useState<CalcResult | null>(null);
  const [pdfBusy, setPdfBusy] = useState<View | null>(null);
  const stopRef = useRef(false);
  useEffect(() => setRows(lines), [lines]);

  const summary = useMemo(() => summarizeDevis(rows), [rows]);
  const pairedProfit = useMemo(() => {
    let internal = 0; let external = 0;
    for (const row of rows) {
      if (row.is_internal) continue;
      const quantity = num(row.quantity) || 1;
      if (num(row.unit_price) > 0 && num(row.external_unit_price) > 0) { internal += quantity * num(row.unit_price); external += quantity * num(row.external_unit_price); }
    }
    return external - internal;
  }, [rows]);
  // Autres dépenses internes (lignes « interne seulement » : salaires et transport des matériaux).
  const otherCosts = useMemo(() => {
    const labor = rows.find((row) => row.is_internal && row.designation === "Main-d'œuvre (salaires)");
    const transport = rows.find((row) => row.is_internal && row.designation === "Transport des matériaux");
    const amountOf = (row?: DevisLine) => (row ? (num(row.unit_price) * (num(row.quantity) || 1)) : 0);
    return { labor: amountOf(labor), transport: amountOf(transport), total: amountOf(labor) + amountOf(transport) };
  }, [rows]);
  const [laborInput, setLaborInput] = useState("");
  const [transportInput, setTransportInput] = useState("");
  const [laborPercent, setLaborPercent] = useState("30");
  const [transportPercent, setTransportPercent] = useState("8");
  const [costsBusy, setCostsBusy] = useState(false);
  useEffect(() => { setLaborInput(otherCosts.labor > 0 ? String(Math.round(otherCosts.labor)) : ""); setTransportInput(otherCosts.transport > 0 ? String(Math.round(otherCosts.transport)) : ""); }, [otherCosts.labor, otherCosts.transport]);

  async function saveOtherCosts(values: { labor?: string; transport?: string }) {
    setCostsBusy(true);
    try {
      const response = await fetch(`/api/devis/projects/${project.id}/other-costs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setMessage(result.error ?? "Dépenses non enregistrées."); return; }
      setMessage("Salaires et transport enregistrés dans le devis interne.");
      router.refresh();
    } finally { setCostsBusy(false); }
  }
  function estimateOtherCosts() {
    const base = summary.internalTotal;
    if (!(base > 0)) { setMessage("Calcule d'abord les prix internes : l'estimation part du coût des matériaux."); return; }
    const labor = Math.round(base * (Number(laborPercent.replace(",", ".")) || 0) / 100);
    const transport = Math.round(base * (Number(transportPercent.replace(",", ".")) || 0) / 100);
    setLaborInput(String(labor)); setTransportInput(String(transport));
    void saveOtherCosts({ labor: String(labor), transport: String(transport) });
  }
  const visibleRows = view === "external" ? rows.filter((row) => !row.is_internal) : rows;
  const canGiveMargin = summary.missingExternal > 0 && summary.lines - summary.missingInternal > 0;

  async function applyMargin(value?: string) {
    const response = await fetch(`/api/devis/projects/${project.id}/margin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ margin_percent: value ?? null }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string; marginPercent?: number | null };
    if (!response.ok) { setMessage(result.error ?? "Marge non enregistrée."); return false; }
    setMessage(result.marginPercent !== null && result.marginPercent !== undefined
      ? `Marge du devis : ${Number(result.marginPercent).toLocaleString("fr-FR")} %.`
      : "Marge pas encore calculable (il manque des prix).");
    return true;
  }

  // Étape 1, GRATUITE : main-d'œuvre à 0, prix déjà connus (bibliothèque +
  // catalogue partagé), puis calcul par compositions de matériaux (ciment +
  // sable + eau…, main-d'œuvre non comptée). Aucun crédit IA.
  async function calculatePrices(quiet = false) {
    setLibraryBusy(true);
    if (!quiet) setMessage("Calcul des prix internes à partir de la bibliothèque…");
    try {
      const response = await fetch(`/api/devis/projects/${project.id}/compositions`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as Partial<CalcResult> & { error?: string; updates?: Array<{ id: string; unit_price: number }> };
      if (!response.ok) { setMessage(result.error ?? "Calcul impossible."); return null; }
      const updates = result.updates ?? [];
      if (updates.length > 0) setRows((current) => current.map((row) => { const update = updates.find((item) => item.id === row.id); return update ? { ...row, unit_price: update.unit_price } : row; }));
      const next: CalcResult = {
        saved: result.saved ?? 0, computed: result.computed ?? 0, fromLibrary: result.fromLibrary ?? 0, fromShared: result.fromShared ?? 0, laborLines: result.laborLines ?? 0,
        details: result.details ?? [], missingMaterials: result.missingMaterials ?? [], noCompositionIds: result.noCompositionIds ?? [],
      };
      setCalc(next);
      if (next.saved > 0) await applyMargin();
      const parts: string[] = [];
      if (next.computed > 0) parts.push(`${next.computed} calculé(s) par compositions de matériaux`);
      if (next.fromLibrary + next.fromShared > 0) parts.push(`${next.fromLibrary + next.fromShared} repris de la bibliothèque`);
      if (next.laborLines > 0) parts.push(`${next.laborLines} ligne(s) de main-d'œuvre / chantier comptées 0 (déjà dans les salaires)`);
      const blocked = next.details.filter((item) => item.status === "matériau manquant").length;
      const notes: string[] = [];
      if (blocked > 0) notes.push(`${blocked} ligne(s) attendent le prix de ${next.missingMaterials.length} matériau(x) (étape 2)`);
      if (next.noCompositionIds.length > 0) notes.push(`${next.noCompositionIds.length} ligne(s) sans composition connue (étape 3 ou saisie à la main)`);
      setMessage(`${next.saved} prix remplis${parts.length ? " : " + parts.join(", ") : ""}.${notes.length ? " Reste : " + notes.join(" ; ") + "." : " Tous les prix internes sont remplis."}`);
      router.refresh();
      return next;
    } finally {
      setLibraryBusy(false);
    }
  }

  // Étape 2 (crédits IA) : cherche sur internet SEULEMENT le prix des matériaux
  // manquants (ciment, sable, parpaing…), puis relance le calcul gratuit.
  async function searchMissingMaterials() {
    const materials = calc?.missingMaterials ?? [];
    if (materials.length === 0) return;
    const info = await fetch(`/api/devis/projects/${project.id}/prices`, { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { project?: { location?: string } };
    const location = String(info.project?.location ?? "").trim() || "Antananarivo, Analamanga";
    if (!window.confirm(`${materials.length} matériau(x) vont être cherchés sur internet (${materials.map((item) => item.search).join(", ")}). Cela utilise des crédits IA, mais chaque prix trouvé servira ensuite à TOUS tes devis. Lancer ?`)) return;
    stopRef.current = false;
    let found = 0; let failed = "";
    for (let index = 0; index < materials.length; index += 1) {
      if (stopRef.current || failed) break;
      const material = materials[index];
      setProgress({ current: index + 1, total: materials.length, label: material.search });
      try {
        const response = await fetch("/api/prices/internet-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ designation: material.search, categorie: "Composants de prix", unite: material.unit, daoQuantity: 0, pricingContext: "", worksiteName: project.name, worksiteLocation: location }),
        });
        const result = await response.json().catch(() => ({})) as { error?: string; found?: boolean; selected_price?: number };
        if (!response.ok) { failed = result.error || "La recherche de prix est momentanément indisponible."; break; }
        if (result.found && Number(result.selected_price) > 0) found += 1;
      } catch { failed = "Connexion interrompue pendant la recherche des prix."; break; }
    }
    setProgress(null);
    const next = await calculatePrices(true);
    setMessage(`${found}/${materials.length} matériau(x) trouvé(s) sur internet. ${next ? `${next.saved} prix de lignes remplis.` : ""}${failed ? ` Arrêt : ${failed}` : ""}${next && next.missingMaterials.length > 0 ? ` Il manque encore : ${next.missingMaterials.map((item) => item.search).join(", ")} (à saisir dans la bibliothèque de prix).` : ""}`);
  }

  async function fillInternalPrices(onlyIds?: string[]) {
    setMessage("");
    const listResponse = await fetch(`/api/devis/projects/${project.id}/prices`, { cache: "no-store" });
    const list = await listResponse.json().catch(() => ({})) as { error?: string; project?: { location?: string }; missing?: Array<{ id: string; designation: string; unit: string; quantity: number; category: string }> };
    if (!listResponse.ok) { setMessage(list.error ?? "Lecture du devis impossible."); return; }
    const missing = (list.missing ?? []).filter((line) => !onlyIds || onlyIds.includes(line.id));
    if (missing.length === 0) { setMessage("Tous les prix internes sont déjà remplis."); return; }
    // La recherche de prix a besoin du lieu du chantier (transport, fournisseurs proches).
    // Si le chantier n'a pas de localisation, les prix sont cherchés à Antananarivo (Analamanga).
    const location = String(list.project?.location ?? "").trim() || "Antananarivo, Analamanga";
    if (!window.confirm(`${missing.length} ligne(s) sans composition connue vont être cherchées directement sur internet. Cela utilise des crédits IA (les lignes calculables par matériaux ne sont pas concernées). Lancer ?`)) return;

    stopRef.current = false;
    let pending: Array<{ id: string; unit_price: number }> = [];
    let found = 0; let notFound = 0; let failed = "";
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending; pending = [];
      const response = await fetch(`/api/devis/projects/${project.id}/prices`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ updates: batch }) });
      if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; failed = result.error ?? "Enregistrement des prix impossible."; return; }
      // Le prix apparaît tout de suite dans le tableau du devis interne.
      setRows((current) => current.map((row) => { const update = batch.find((item) => item.id === row.id); return update ? { ...row, unit_price: update.unit_price } : row; }));
    };

    for (let index = 0; index < missing.length; index += 1) {
      if (stopRef.current || failed) break;
      const line = missing[index];
      setProgress({ current: index + 1, total: missing.length, label: line.designation });
      if (!line.designation || !line.unit) { notFound += 1; continue; }
      try {
        const response = await fetch("/api/prices/internet-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ designation: line.designation, categorie: line.category, unite: line.unit, daoQuantity: line.quantity, pricingContext: "", worksiteName: project.name, worksiteLocation: location }),
        });
        const result = await response.json().catch(() => ({})) as { error?: string; found?: boolean; selected_price?: number };
        if (!response.ok) { failed = result.error || "La recherche de prix est momentanément indisponible."; break; }
        const price = Number(result.selected_price);
        if (result.found && Number.isFinite(price) && price > 0) { pending.push({ id: line.id, unit_price: price }); found += 1; } else notFound += 1;
      } catch { failed = "Connexion interrompue pendant la recherche des prix."; break; }
      if (pending.length >= 5) await flush();
    }
    await flush();
    setProgress(null);
    await applyMargin();
    setMessage(`${found} prix trouvé(s), ${notFound} à saisir ou à relancer${failed ? ` — arrêt : ${failed}` : stopRef.current ? " — arrêté à ta demande" : ""}.`);
    router.refresh();
  }

  async function savePrice(line: DevisLine, raw: string) {
    const value = Number(raw.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(value) || value <= 0 || value === num(line.unit_price)) return;
    const response = await fetch(`/api/devis/projects/${project.id}/prices`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ updates: [{ id: line.id, unit_price: value }] }) });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setMessage(result.error ?? "Prix non enregistré."); return; }
    setRows((current) => current.map((row) => row.id === line.id ? { ...row, unit_price: value } : row));
    await applyMargin();
    router.refresh();
  }

  async function giveMargin() {
    if (!marginInput.trim()) { setMessage("Indique la marge à appliquer (en %)."); return; }
    if (await applyMargin(marginInput)) router.refresh();
  }

  async function showPdf(mode: View) {
    setPdfBusy(mode);
    setMessage("Préparation du PDF…");
    const error = await openDevisPdf(`/api/devis/projects/${project.id}/pdf`, { mode });
    setPdfBusy(null);
    setMessage(error ?? "PDF ouvert dans un nouvel onglet.");
  }

  async function deleteDevis() {
    if (!(await confirmDeletion("project", project.id))) return;
    const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setMessage(result.error ?? "Suppression impossible."); return; }
    router.push("/estimates");
    router.refresh();
  }

  useEffect(() => {
    if (!progress && !pdfBusy) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [progress, pdfBusy]);

  const small: React.CSSProperties = { fontSize: ".78rem", color: "#666" };
  const margin = summary.marginPercent ?? project.marginPercent;
  let lastSection = "";
  let grandTotal = 0;

  return (
    <div>
      <button type="button" onClick={() => router.push("/estimates")} className="estimateBackButton">← Retour aux devis</button>
      <div style={{ margin: "12px 0" }}>
        <p className="estimatePanelEyebrow">Devis ajouté par PDF</p>
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <p style={small}>{project.createdAt ? new Date(project.createdAt).toLocaleDateString("fr-FR") : ""} · {summary.lines} lignes</p>
      </div>
      {message && !progress && <p role="status" className="rounded border p-3" style={{ marginBottom: 12 }}>{message}</p>}

      <section className="estimateVersionsPanel" style={{ marginBottom: 16 }}>
        <div className="estimateVersionsHeading"><p className="estimatePanelEyebrow">Résumé</p><h3>Deux versions du devis</h3></div>
        <p className="estimatePanelDescription">Le devis externe est celui que tu as importé (prix du client, utilisé pour la facture). Le devis interne garde tes coûts. La marge est calculée : externe ÷ interne − 1.</p>
        <div className="estimateFinancialSummary">
          <div><span>Coût interne (matériaux)</span><strong>{summary.internalTotal > 0 ? formatAr(summary.internalTotal) : "—"}</strong></div>
          <div><span>Salaires + transport</span><strong>{otherCosts.total > 0 ? formatAr(otherCosts.total) : "à renseigner"}</strong></div>
          <div><span>Marge (calculée)</span><strong>{margin !== null ? `${margin.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %` : "—"}</strong></div>
          <div><span>Bénéfice attendu (après salaires et transport)</span><strong>{summary.internalTotal > 0 && summary.externalTotal > 0 ? formatAr(pairedProfit - otherCosts.total) : "—"}</strong></div>
          <div className="estimateClientTotal"><span>Montant externe (client)</span><strong>{summary.externalTotal > 0 ? formatAr(summary.externalTotal) : "—"}</strong></div>
        </div>
        {(summary.missingInternal > 0 || summary.missingExternal > 0) && <p style={{ ...small, marginTop: 8 }}>
          À compléter : {summary.missingInternal > 0 ? `${summary.missingInternal} prix interne(s)` : ""}{summary.missingInternal > 0 && summary.missingExternal > 0 ? " et " : ""}{summary.missingExternal > 0 ? `${summary.missingExternal} prix externe(s)` : ""}.
        </p>}
        <div className="estimatePdfCards" style={{ marginTop: 12 }}>
          <div className="estimatePdfCard"><strong>Devis interne</strong><span>Coûts réels et résumé marge / bénéfice</span>
            <button type="button" className="estimatePrimaryAction" disabled={pdfBusy !== null} onClick={() => void showPdf("internal")}>{pdfBusy === "internal" ? "Préparation…" : "Générer / ouvrir le PDF interne"}</button></div>
          <div className="estimatePdfCard"><strong>Devis externe</strong><span>Version importée, prix du client</span>
            <button type="button" className="estimatePrimaryAction" disabled={pdfBusy !== null} onClick={() => void showPdf("external")}>{pdfBusy === "external" ? "Préparation…" : "Générer / ouvrir le PDF externe"}</button></div>
        </div>
      </section>

      {isAdmin && (
        <section className="estimateVersionsPanel" style={{ marginBottom: 16 }}>
          <p className="estimatePanelEyebrow">Prix du devis</p>
          <h3>Compléter les prix manquants</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
            {summary.missingInternal > 0 && !progress && <button type="button" className="estimatePrimaryAction" disabled={libraryBusy} onClick={() => void calculatePrices()}>{libraryBusy ? "Calcul en cours…" : "1. Calculer les prix internes (gratuit)"}</button>}
            {calc && calc.missingMaterials.length > 0 && !progress && <button type="button" className="estimateSecondaryAction" disabled={libraryBusy} onClick={() => void searchMissingMaterials()}>{`2. Chercher le prix de ${calc.missingMaterials.length} matériau(x) manquant(s) sur internet (crédits IA)`}</button>}
            {calc && calc.noCompositionIds.length > 0 && !progress && <button type="button" className="estimateSecondaryAction" disabled={libraryBusy} onClick={() => void fillInternalPrices(calc.noCompositionIds)}>{`3. Chercher ${calc.noCompositionIds.length} ligne(s) sans composition sur internet (crédits IA)`}</button>}
            {progress && <button type="button" className="estimateSecondaryAction" onClick={() => { stopRef.current = true; }}>Arrêter</button>}
            {summary.missingInternal === 0 && <span style={{ color: "#1f7a46", fontWeight: 700 }}>Prix internes complets</span>}
            {canGiveMargin && !progress && (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input type="number" step="0.1" placeholder="Marge %" style={{ width: 96 }} value={marginInput} onChange={(event) => setMarginInput(event.target.value)} />
                <button type="button" className="estimateSecondaryAction" onClick={() => void giveMargin()}>Appliquer la marge aux prix externes manquants</button>
              </span>
            )}
          </div>
          {progress && <>
            <p style={{ ...small, marginTop: 8 }}>Recherche {progress.current}/{progress.total} : {progress.label}</p>
            <div className="appProgress appProgressCompact" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.current}><span style={{ width: `${Math.round(progress.current / progress.total * 100)}%` }} /></div>
          </>}
          {summary.laborLines > 0 && <p style={{ ...small, marginTop: 8 }}>{summary.laborLines} ligne(s) de main-d'œuvre / chantier (installation, repli, dépose, démolition, nettoyage…) comptent 0 : leur coût est déjà dans les salaires.</p>}
          {calc && calc.details.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>Détail des calculs ({calc.details.length} ligne(s))</summary>
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                {calc.details.map((item) => (
                  <div key={item.id} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: 8, background: "#fff" }}>
                    <strong>{item.designation}</strong> <span style={small}>({item.unit}) — {item.status}{item.price !== null ? ` — ${formatAr(item.price)} / ${item.unit}` : ""}</span>
                    {item.title && <div style={small}>{item.title}</div>}
                    {item.notes?.map((note) => <div key={note} style={small}>{note}</div>)}
                    {item.parts && item.parts.length > 0 && (
                      <table style={{ width: "100%", marginTop: 4, fontSize: ".78rem" }}>
                        <tbody>
                          {item.parts.map((part) => (
                            <tr key={part.designation}>
                              <td>{part.designation}</td>
                              <td style={{ textAlign: "right" }}>{part.quantity.toLocaleString("fr-FR")} {part.unit}</td>
                              <td style={{ textAlign: "right" }}>{part.unitPrice !== null ? formatAr(part.unitPrice) : part.optional ? "non compté" : "prix manquant"}</td>
                              <td style={{ textAlign: "right" }}>{part.unitPrice !== null ? formatAr(part.amount) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="estimateVersionsPanel" style={{ marginBottom: 16 }}>
          <p className="estimatePanelEyebrow">Dépenses internes</p>
          <h3>Salaires et transport des matériaux</h3>
          <p className="estimatePanelDescription">Les lignes du devis ne contiennent que les matériaux. Ajoute ici les salaires (main-d'œuvre) et le transport des matériaux : ils apparaissent dans le devis interne (PDF compris) et réduisent le bénéfice, mais jamais dans le devis externe ni la facture.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginTop: 8 }}>
            <label style={{ display: "grid", gap: 4, fontSize: ".85rem" }}>Salaires — main-d'œuvre (Ar)
              <input type="text" inputMode="decimal" value={laborInput} placeholder="0" onChange={(event) => setLaborInput(event.target.value)} style={{ width: 170, textAlign: "right" }} /></label>
            <label style={{ display: "grid", gap: 4, fontSize: ".85rem" }}>Transport des matériaux (Ar)
              <input type="text" inputMode="decimal" value={transportInput} placeholder="0" onChange={(event) => setTransportInput(event.target.value)} style={{ width: 170, textAlign: "right" }} /></label>
            <button type="button" className="estimatePrimaryAction" disabled={costsBusy} onClick={() => void saveOtherCosts({ labor: laborInput, transport: transportInput })}>{costsBusy ? "Enregistrement…" : "Enregistrer"}</button>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
            <label style={{ display: "grid", gap: 4, fontSize: ".85rem" }}>Salaires = % des matériaux
              <input type="number" step="1" value={laborPercent} onChange={(event) => setLaborPercent(event.target.value)} style={{ width: 90 }} /></label>
            <label style={{ display: "grid", gap: 4, fontSize: ".85rem" }}>Transport = % des matériaux
              <input type="number" step="1" value={transportPercent} onChange={(event) => setTransportPercent(event.target.value)} style={{ width: 90 }} /></label>
            <button type="button" className="estimateSecondaryAction" disabled={costsBusy} onClick={estimateOtherCosts}>Estimer d'après le coût des matériaux</button>
          </div>
          <p style={{ ...small, marginTop: 8 }}>L'estimation est un point de départ à ajuster avec tes vrais salaires et tes vrais transports (les pourcentages sont modifiables). Les dépenses réelles restent dans la page Dépenses du chantier.</p>
        </section>
      )}

      <section className="estimateDetailPanel">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
          <h3 className="text-lg font-bold">Détail du devis affiché</h3>
          <div role="tablist" aria-label="Version du devis affichée" style={{ display: "flex", gap: 8 }}>
            <button type="button" role="tab" aria-selected={view === "external"} className={view === "external" ? "estimatePrimaryAction" : "estimateSecondaryAction"} onClick={() => setView("external")}>Devis externe (importé)</button>
            <button type="button" role="tab" aria-selected={view === "internal"} className={view === "internal" ? "estimatePrimaryAction" : "estimateSecondaryAction"} onClick={() => setView("internal")}>Devis interne</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="mb-8 mt-3 w-full border">
            <thead>
              <tr>
                <th className="border p-2">N°</th><th className="border p-2">Désignation</th><th className="border p-2">Unité</th><th className="border p-2">Quantité</th>
                {view === "internal" ? <><th className="border p-2">PU interne</th><th className="border p-2">Montant interne</th></> : <><th className="border p-2">PU externe</th><th className="border p-2">Montant externe HT</th></>}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && <tr><td colSpan={6} className="border p-4 text-center text-gray-600">Aucune ligne.</td></tr>}
              {visibleRows.map((row, index) => {
                const section = [String(row.category ?? "").trim(), String(row.subcategory ?? "").trim()].filter(Boolean).join(" — ");
                const header = section && section !== lastSection ? section : null;
                if (section) lastSection = section;
                const quantity = num(row.quantity) || 1;
                const internal = num(row.unit_price);
                const external = num(row.external_unit_price);
                const amount = quantity * (view === "internal" ? internal : external);
                grandTotal += amount;
                const labor = internal <= 0 && isLaborLine(row.designation);
                const missing = view === "internal" ? internal <= 0 && !labor : external <= 0;
                return (
                  <FragmentRows key={row.id} header={header} colSpan={6}>
                    <tr style={missing ? { background: "#fff7ed" } : undefined}>
                      <td className="border p-2">{String(row.position ?? "").trim() || index + 1}</td>
                      <td className="border p-2">{row.designation}</td>
                      <td className="border p-2">{row.unit}</td>
                      <td className="border p-2" style={{ textAlign: "right" }}>{quantity.toLocaleString("fr-FR")}</td>
                      {view === "internal" ? <>
                        <td className="border p-2" style={{ textAlign: "right" }}>
                          {isAdmin && !row.is_internal
                            ? <input key={`${row.id}-${internal}`} type="text" inputMode="decimal" defaultValue={internal > 0 ? String(internal) : ""} placeholder={labor ? "main-d'œuvre" : "à remplir"} onBlur={(event) => void savePrice(row, event.target.value)} style={{ width: 110, textAlign: "right" }} />
                            : internal > 0 ? formatAr(internal) : labor ? "main-d'œuvre" : "—"}
                        </td>
                        <td className="border p-2" style={{ textAlign: "right" }}>{internal > 0 ? formatAr(quantity * internal) : "—"}</td>
                      </> : <>
                        <td className="border p-2" style={{ textAlign: "right" }}>{external > 0 ? formatAr(external) : "—"}</td>
                        <td className="border p-2" style={{ textAlign: "right" }}>{external > 0 ? formatAr(quantity * external) : "—"}</td>
                      </>}
                    </tr>
                  </FragmentRows>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 800, background: "#f3f4f6" }}>
                <td className="border p-2" colSpan={5} style={{ textAlign: "right" }}>{view === "internal" ? "Total interne (lignes chiffrées)" : "Total externe HT"}</td>
                <td className="border p-2" style={{ textAlign: "right" }}>{formatAr(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {isAdmin && <p style={{ marginTop: 8 }}><button type="button" className="text-red-700 underline" onClick={() => void deleteDevis()}>Supprimer ce devis (et son chantier)</button></p>}
    </div>
  );
}

function FragmentRows({ header, colSpan, children }: { header: string | null; colSpan: number; children: React.ReactNode }) {
  return (
    <>
      {header && <tr><td colSpan={colSpan} style={{ padding: "10px", background: "#e5e7eb", border: "1px solid #9ca3af", fontWeight: 800, textTransform: "uppercase" }}>{header}</td></tr>}
      {children}
    </>
  );
}
