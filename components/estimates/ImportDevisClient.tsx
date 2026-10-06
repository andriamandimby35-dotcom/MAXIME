"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatAr } from "@/components/money";

type Line = { category: string; subcategory: string; designation: string; unit: string; quantity: number; unit_price: number; ref?: string; description?: string; concerne?: string };
type Extraction = { project_name: string; location: string; works: string[]; lines: Line[]; devis_total: number | null; tmp_percent?: number | null };

// « Ajouter un devis » à partir d'un PDF : lecture par l'IA (une seule fois),
// vérification à l'écran, puis création du chantier, du planning et des prix.
export function ImportDevisClient({ kind }: { kind: "internal" | "external" }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [margin, setMargin] = useState("");
  const [created, setCreated] = useState<{ projectId: string; count: number; needsInternalPrices: number; addedTasks: number; warning?: string } | null>(null);

  const isInternal = kind === "internal";
  const stats = useMemo(() => {
    const lines = extraction?.lines ?? [];
    const priced = lines.filter((line) => line.unit_price > 0);
    return { total: lines.length, priced: priced.length, unpriced: lines.length - priced.length, sum: priced.reduce((sum, line) => sum + line.quantity * line.unit_price, 0) };
  }, [extraction]);

  async function readPdf() {
    if (!file) return;
    setBusy(true); setMessage(""); setExtraction(null); setCreated(null);
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/devis/import/extract", { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setMessage(result.error ?? "Lecture du PDF impossible."); return; }
    setExtraction(result as Extraction);
    setName(String(result.project_name ?? "") || file.name.replace(/\.pdf$/i, ""));
    setLocation(String(result.location ?? ""));
  }

  async function create() {
    if (!extraction) return;
    if (!name.trim()) { setMessage("Donne un nom au chantier."); return; }
    if (isInternal && stats.priced > 0 && !margin.trim()) { setMessage("Indique la marge à appliquer pour fabriquer le devis externe."); return; }
    setBusy(true); setMessage("");
    const response = await fetch("/api/devis/import/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name, location, works: extraction.works, lines: extraction.lines, tmp_percent: extraction.tmp_percent ?? null, margin_percent: margin }),
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setMessage(result.error ?? "Création impossible."); return; }
    setCreated(result);
  }

  const totalMatches = extraction?.devis_total ? Math.abs(stats.sum - extraction.devis_total) <= Math.max(1, extraction.devis_total * 0.001) : null;

  return (
    <main className="estimateListPage">
      <div className="pageHead">
        <div>
          <h1>{isInternal ? "Ajouter un devis interne (PDF)" : "Ajouter un devis externe (PDF)"}</h1>
          <p>{isInternal
            ? "Les prix du PDF sont tes coûts. Avec des prix, indique ta marge : le devis externe, le planning et la facturation en sont tirés. Sans prix, les prix seront cherchés (bibliothèque puis internet)."
            : "Les prix du PDF sont ceux du client : ils servent directement à la facturation et au planning. Les prix internes seront ensuite cherchés (bibliothèque puis internet) et la marge calculée."}</p>
        </div>
        <Link className="tenderButton" href="/estimates">← Retour aux devis</Link>
      </div>

      {message && <p className="notice">{message}</p>}

      {!created && (
        <section className="panel" style={{ padding: "16px", marginBottom: "16px" }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <input type="file" accept="application/pdf" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setMessage(""); }} />
            <button type="button" className="tenderButton tenderButtonPrimary" disabled={busy || !file} onClick={() => void readPdf()}>
              {busy && !extraction ? "Lecture en cours…" : "Lire le devis (utilise l'IA)"}
            </button>
          </div>
          {busy && !extraction && <p style={{ fontSize: ".85rem", color: "#555", marginTop: "10px" }}>Lecture en cours : cela peut prendre une minute.</p>}
        </section>
      )}

      {extraction && !created && (
        <section className="panel" style={{ padding: "16px" }}>
          <p>
            <strong>{stats.total} lignes</strong> lues · {stats.priced} avec prix{stats.unpriced > 0 ? ` · ${stats.unpriced} sans prix (les prix seront cherchés ensuite)` : ""}
            {stats.priced > 0 ? <> · total des lignes chiffrées : <strong>{formatAr(stats.sum)}</strong></> : null}
          </p>
          {extraction.devis_total && totalMatches === false && (
            <p className="notice" style={{ background: "#fbeee0" }}>⚠ Total écrit dans le devis : {formatAr(extraction.devis_total)}. Il diffère du total des lignes lues : une ligne manque peut-être. Tu pourras tout corriger ensuite.</p>
          )}
          {extraction.devis_total && totalMatches === true && <p className="notice" style={{ background: "#e5f8eb" }}>✔ Le total des lignes correspond au total du devis.</p>}

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", margin: "12px 0" }}>
            <label style={{ display: "grid", gap: "4px", flex: "2 1 260px" }}>Nom du chantier
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label style={{ display: "grid", gap: "4px", flex: "1 1 200px" }}>Localisation
              <input value={location} onChange={(event) => setLocation(event.target.value)} />
            </label>
            {isInternal && stats.priced > 0 && (
              <label style={{ display: "grid", gap: "4px", flex: "0 1 160px" }}>Marge à appliquer (%)
                <input type="number" step="0.1" value={margin} onChange={(event) => setMargin(event.target.value)} />
              </label>
            )}
          </div>

          <div style={{ maxHeight: "360px", overflow: "auto", border: "1px solid #e0e8e2", borderRadius: "10px" }}>
            <table style={{ width: "100%", fontSize: ".8rem", minWidth: "760px" }}>
              <thead><tr><th>Catégorie</th><th>Sous-catégorie</th><th>Désignation</th><th>Unité</th><th>Qté</th><th>Prix unitaire</th></tr></thead>
              <tbody>
                {extraction.lines.map((line, index) => (
                  <tr key={index} style={!(line.unit_price > 0) ? { background: "#fff6e8" } : undefined}>
                    <td>{line.category}</td><td>{line.subcategory}</td><td>{line.designation}</td><td>{line.unit}</td><td>{line.quantity}</td>
                    <td>{line.unit_price > 0 ? formatAr(line.unit_price) : "— à chercher"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: "12px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button type="button" className="tenderButton tenderButtonPrimary" disabled={busy} onClick={() => void create()}>
              {busy ? "Création…" : "Créer le chantier, le planning et les prix"}
            </button>
            <button type="button" className="tenderButton" disabled={busy} onClick={() => { setExtraction(null); setFile(null); }}>Recommencer</button>
          </div>
        </section>
      )}

      {created && (
        <section className="panel" style={{ padding: "16px" }}>
          <p className="notice" style={{ background: "#e5f8eb" }}>✔ Chantier créé avec {created.count} lignes de devis{created.addedTasks ? ` (${created.addedTasks} tâche(s) ajoutée(s) au planning)` : ""}.</p>
          {created.warning && <p className="notice" style={{ background: "#fbeee0" }}>{created.warning}</p>}
          {created.needsInternalPrices > 0 && (
            <p>{created.needsInternalPrices} ligne(s) n'ont pas encore de prix interne : dans la liste des devis, clique sur « Remplir les prix (IA) » pour les chercher (bibliothèque puis internet).</p>
          )}
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <Link className="tenderButton tenderButtonPrimary" href="/estimates">Voir dans les devis</Link>
            <Link className="tenderButton" href={`/billing/${created.projectId}`}>Ouvrir la facturation du chantier</Link>
          </div>
        </section>
      )}
    </main>
  );
}
