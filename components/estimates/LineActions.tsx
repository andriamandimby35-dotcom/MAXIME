"use client";

import { useEffect, useState } from "react";
import { LibraryPicker } from "@/components/estimates/LibraryPicker";

type Part = { designation: string; unit: string; quantity: number; unitPrice: number | null; amount: number; optional: boolean };
type Detail = { status: "bibliothèque" | "composition" | "matériau manquant" | "sans composition"; price: number | null; current: number | null; title?: string; notes?: string[]; parts?: Part[]; missing?: string[] };

export type LineForActions = {
  id: string; designation: string | null; unit: string | null; quantity: number | string | null;
  unit_price: number | string | null; external_unit_price: number | string | null;
  description?: string | null; concerne?: string | null;
};

const num = (value: unknown) => Number(value) || 0;
const fmt = (value: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value)} Ar`;
const field: React.CSSProperties = { width: "100%", padding: 8, border: "1px solid #9ca3af", borderRadius: 6 };

// Actions d'UNE ligne d'un devis importé, comme dans le DAO : elles n'apparaissent que quand on clique sur la ligne.
// Modifier · Détail du prix (matériau de la bibliothèque ou composition) · Bibliothèque (ligne sans prix) · Supprimer.
// Rien de ce qui est fait ici ne change la bibliothèque : le choix ne vaut que pour ce devis.
export function LineActions({ projectId, line, view, isAdmin, canPickLibrary, onSave, onSetPrice, onDelete }: {
  projectId: string; line: LineForActions; view: "internal" | "external"; isAdmin: boolean; canPickLibrary: boolean;
  onSave: (patch: Record<string, string>) => Promise<boolean>;
  onSetPrice: (price: number, label: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"edit" | "detail" | "library" | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    designation: String(line.designation ?? ""), unit: String(line.unit ?? ""), quantity: String(num(line.quantity) || 1),
    unit_price: num(line.unit_price) > 0 ? String(num(line.unit_price)) : "", external_unit_price: num(line.external_unit_price) > 0 ? String(num(line.external_unit_price)) : "",
    description: String(line.description ?? ""), concerne: String(line.concerne ?? ""),
  });

  useEffect(() => {
    if (!busy) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [busy]);

  async function openDetail() {
    setMode("detail"); setDetail(null); setError(""); setBusy(true);
    try {
      const response = await fetch(`/api/devis/projects/${projectId}/lines/${line.id}/detail`, { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as Detail & { error?: string };
      if (!response.ok) { setError(data.error ?? "Détail impossible à lire."); return; }
      setDetail(data);
    } catch { setError("Connexion interrompue."); } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError("");
    const patch: Record<string, string> = {
      designation: form.designation, unit: form.unit, quantity: form.quantity, unit_price: form.unit_price, external_unit_price: form.external_unit_price,
    };
    if (line.description !== undefined) patch.description = form.description;
    if (line.concerne !== undefined) patch.concerne = form.concerne;
    const ok = await onSave(patch);
    setBusy(false);
    if (ok) setMode(null); else setError("Modification non enregistrée.");
  }

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div onClick={stop} style={{ padding: 10, background: "#f9fafb", borderTop: "1px dashed #d1d5db" }}>
      <div className="buttonRow" style={{ marginBottom: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isAdmin && <button type="button" className="ghostButton" onClick={() => { setError(""); setMode(mode === "edit" ? null : "edit"); }}>{mode === "edit" ? "Fermer la modification" : "Modifier"}</button>}
        {view === "internal" && <button type="button" className="ghostButton" onClick={() => (mode === "detail" ? setMode(null) : void openDetail())}>Détail du prix</button>}
        {isAdmin && view === "internal" && canPickLibrary && <button type="button" className="ghostButton" onClick={() => { setError(""); setMode(mode === "library" ? null : "library"); }}>Bibliothèque</button>}
        {isAdmin && <button type="button" className="dangerButton" disabled={busy} onClick={() => { if (window.confirm("Supprimer cette ligne du devis ?")) void onDelete(); }}>Supprimer</button>}
      </div>
      {error && <p role="alert" style={{ margin: "8px 0 0", color: "#b91c1c", fontSize: 13 }}>{error}</p>}

      {mode === "edit" && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <label><span style={{ fontWeight: 700 }}>Désignation</span><input style={field} value={form.designation} onChange={(event) => setForm({ ...form, designation: event.target.value })} /></label>
          {line.description !== undefined && <label><span style={{ fontWeight: 700 }}>Texte complet du devis (celui du PDF)</span><textarea rows={5} style={field} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>}
          {line.concerne !== undefined && <label><span style={{ fontWeight: 700 }}>Ligne « Concerne »</span><input style={field} value={form.concerne} onChange={(event) => setForm({ ...form, concerne: event.target.value })} /></label>}
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
            <label><span style={{ fontWeight: 700 }}>Unité</span><input style={field} value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} /></label>
            <label><span style={{ fontWeight: 700 }}>Quantité</span><input style={field} inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
            <label><span style={{ fontWeight: 700 }}>PU interne</span><input style={field} inputMode="decimal" placeholder="à remplir" value={form.unit_price} onChange={(event) => setForm({ ...form, unit_price: event.target.value })} /></label>
            <label><span style={{ fontWeight: 700 }}>PU externe</span><input style={field} inputMode="decimal" placeholder="—" value={form.external_unit_price} onChange={(event) => setForm({ ...form, external_unit_price: event.target.value })} /></label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="estimatePrimaryAction" disabled={busy} onClick={() => void save()}>{busy ? "Enregistrement…" : "Enregistrer"}</button>
            <button type="button" className="estimateSecondaryAction" disabled={busy} onClick={() => setMode(null)}>Annuler</button>
          </div>
        </div>
      )}

      {mode === "detail" && (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid #d1d5db", borderRadius: 8, background: "#fff" }}>
          {busy && <><p style={{ margin: 0 }}>Lecture de la bibliothèque…</p><div className="appProgress appProgressCompact isIndeterminate" style={{ marginTop: 8 }}><span /></div></>}
          {detail && (
            <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
              <strong>{detail.status === "bibliothèque" ? "Matériau de la bibliothèque" : detail.status === "composition" ? "Prix calculé par composition" : detail.status === "matériau manquant" ? "Composition connue, mais il manque le prix de matériaux" : "Aucun matériau ni composition connus pour cette ligne"}</strong>
              {detail.title && <span>{detail.title}</span>}
              <span>Prix interne actuel de la ligne : {detail.current ? fmt(detail.current) : "pas encore rempli"}{detail.price ? ` · prix proposé : ${fmt(detail.price)}` : ""}</span>
              {(detail.parts?.length ?? 0) > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full border mobileCards">
                    <thead><tr><th className="border p-2">Matériau</th><th className="border p-2">Unité</th><th className="border p-2">Quantité</th><th className="border p-2">Prix unitaire</th><th className="border p-2">Montant</th></tr></thead>
                    <tbody>
                      {detail.parts!.map((part, index) => (
                        <tr key={index} style={part.unitPrice === null ? { background: "#fff7ed" } : undefined}>
                          <td className="border p-2" data-label="Matériau">{part.designation}{part.optional ? " (facultatif)" : ""}</td>
                          <td className="border p-2" data-label="Unité">{part.unit}</td>
                          <td className="border p-2" data-label="Quantité" style={{ textAlign: "right" }}>{part.quantity.toLocaleString("fr-FR", { maximumFractionDigits: 3 })}</td>
                          <td className="border p-2" data-label="Prix unitaire" style={{ textAlign: "right" }}>{part.unitPrice === null ? "manque" : fmt(part.unitPrice)}</td>
                          <td className="border p-2" data-label="Montant" style={{ textAlign: "right" }}>{part.unitPrice === null ? "—" : fmt(part.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(detail.notes ?? []).map((note, index) => <span key={index} style={{ color: "#6b7280" }}>{note}</span>)}
              {(detail.missing?.length ?? 0) > 0 && <span style={{ color: "#b45309" }}>Prix manquant : {detail.missing!.join(", ")}</span>}
              {isAdmin && detail.price && detail.price !== detail.current && (
                <div><button type="button" className="estimatePrimaryAction" onClick={() => void onSetPrice(detail.price as number, detail.title ?? "")}>Utiliser ce prix pour cette ligne</button></div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "library" && (
        <LibraryPicker projectId={projectId} designation={String(line.designation ?? "")} unit={String(line.unit ?? "")} onClose={() => setMode(null)} onPick={(price, label) => { setMode(null); void onSetPrice(price, label); }} />
      )}
    </div>
  );
}
