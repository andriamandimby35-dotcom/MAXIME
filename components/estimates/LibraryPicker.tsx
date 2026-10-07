"use client";

import { useEffect, useRef, useState } from "react";

type Result = { id: string; designation: string; unit: string; category: string; price: number | null };

// Mots utiles d'une désignation pour la première recherche (sans petits mots ni verbes courants).
const STOP = new Set(["de", "des", "du", "la", "le", "les", "et", "en", "au", "aux", "sur", "pour", "avec", "une", "fourniture", "pose", "mise", "oeuvre", "œuvre", "travaux", "existant", "existants", "toute", "toutes"]);
function firstQuery(designation: string) {
  return designation.toLowerCase().replace(/['’]/g, " ").split(/[^a-zà-öø-ÿ0-9]+/).filter((word) => word.length >= 3 && !STOP.has(word)).slice(0, 3).join(" ");
}

const formatAr = (value: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value)} Ar`;

// Carte (pas une fenêtre) qui s'ouvre sous une ligne du devis : l'administrateur cherche lui-même
// dans la bibliothèque et choisit le prix quand la recherche automatique n'a rien trouvé.
export function LibraryPicker({ projectId, searchUrl, designation, unit, onPick, onClose }: { projectId?: string; searchUrl?: string; designation: string; unit: string; onPick: (price: number, label: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(() => firstQuery(designation));
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestRef = useRef(0);

  async function search(text = query) {
    const ticket = ++requestRef.current;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`${searchUrl ?? `/api/devis/projects/${projectId}/library-search`}?q=${encodeURIComponent(text)}`);
      const data = await response.json().catch(() => ({})) as { results?: Result[]; error?: string };
      if (ticket !== requestRef.current) return;
      if (!response.ok) { setMessage(data.error ?? "Recherche impossible."); setResults([]); return; }
      setResults(data.results ?? []);
    } catch { if (ticket === requestRef.current) { setMessage("Recherche impossible : vérifie ta connexion."); setResults([]); } }
    finally { if (ticket === requestRef.current) setBusy(false); }
  }

  useEffect(() => { void search(firstQuery(designation)); /* première recherche à l'ouverture */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Curseur « travail » pendant la recherche.
  useEffect(() => {
    if (!busy) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [busy]);

  return (
    <div className="card" style={{ position: "sticky", left: 8, maxWidth: "calc(100vw - 48px)", boxSizing: "border-box", padding: 12, margin: "6px 0", border: "1px solid #d1d5db", borderRadius: 10, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div>
          <strong>Choisir dans la bibliothèque</strong>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>Ligne : {designation} ({unit || "sans unité"}). Le prix choisi ne vaut que pour ce devis : la bibliothèque ne change pas.</p>
        </div>
        <button type="button" className="estimateSecondaryAction" onClick={onClose}>Fermer</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void search(); }} style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Mots à chercher (ex. peinture ardoisine)" style={{ flex: "1 1 200px", minWidth: 0 }} />
        <button type="submit" className="estimatePrimaryAction" disabled={busy}>{busy ? "Recherche…" : "Chercher"}</button>
      </form>
      {busy && <div className="appProgress appProgressCompact isIndeterminate" style={{ marginTop: 8 }}><span /></div>}
      {message && <p style={{ margin: "8px 0 0", color: "#b91c1c", fontSize: 13 }}>{message}</p>}
      {results && results.length === 0 && !busy && !message && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280" }}>Rien dans la bibliothèque avec ces mots. Essaie un seul mot (ex. « ardoisine »), ou écris le prix directement dans la case.</p>}
      {results && results.length > 0 && (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {results.map((result) => {
            const sameUnit = !unit || !result.unit || result.unit.trim().toLowerCase() === unit.trim().toLowerCase();
            return (
              <li key={result.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", padding: "6px 8px", border: "1px solid #e5e7eb", borderRadius: 8, flexWrap: "wrap" }}>
                <span style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere", fontSize: 13 }}>
                  {result.designation}
                  <small style={{ display: "block", color: sameUnit ? "#6b7280" : "#b45309" }}>{result.unit || "sans unité"}{sameUnit ? "" : ` — attention : le devis est en ${unit}`}{result.category ? ` · ${result.category}` : ""}</small>
                </span>
                <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{result.price ? formatAr(result.price) : "—"}</span>
                <button type="button" className="estimatePrimaryAction" disabled={!result.price} onClick={() => result.price && onPick(result.price, result.designation)}>Choisir</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
