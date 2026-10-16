"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DetectedLot, LotDetection } from "@/lib/dao/lot-detection";
import { parseRanges } from "@/lib/dao/lot-detection";

type Props = {
  tenderId: string;
  tenderTitle: string;
  /** Lots déjà créés pour ce DAO : numéro du lot → identifiant de l'appel d'offres du lot. */
  existing: Record<number, string>;
};

type Row = DetectedLot & { manual?: boolean };

const rangeText = (ranges: Array<[number, number]>) => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");

export default function LotChooser({ tenderId, tenderTitle, existing }: Props) {
  const [detection, setDetection] = useState<LotDetection | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [rangeInputs, setRangeInputs] = useState<Record<number, string>>({});
  const [edited, setEdited] = useState<Record<number, boolean>>({});
  const [dropCcag, setDropCcag] = useState(true);
  const [readable, setReadable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Array<{ number: number; id: string }> | null>(null);
  const [newNumber, setNewNumber] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newRanges, setNewRanges] = useState("");

  // Curseur « travail » dès que l'appli lit le PDF ou crée les lots.
  useEffect(() => {
    document.body.style.cursor = loading || creating ? "progress" : "";
    return () => { document.body.style.cursor = ""; };
  }, [loading, creating]);

  async function load(force = false) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/tenders/lots/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenderId, force }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Lecture des lots impossible.");
      const found = data.detection as LotDetection;
      setDetection(found);
      setReadable(data.readable !== false);
      setRows(found.lots);
      setRangeInputs(Object.fromEntries(found.lots.map((lot) => [lot.number, rangeText(lot.ranges)])));
      setEdited({});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Lecture des lots impossible.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const ccagPages = useMemo(() => (detection?.ccagRanges ?? []).reduce((sum, [a, b]) => sum + (b - a + 1), 0), [detection]);
  const toggle = (number: number) => setSelected((current) => (current.includes(number) ? current.filter((n) => n !== number) : [...current, number].sort((a, b) => a - b)));

  function applyEdit(number: number) {
    if (!detection) return;
    const ranges = parseRanges(rangeInputs[number] ?? "", detection.pageCount);
    if (ranges.length === 0) { setError(`Lot ${number} : pages non valides (exemple : 54-59, 62).`); return; }
    setError("");
    setRows((current) => current.map((row) => (row.number === number ? { ...row, ranges, pageCount: ranges.reduce((sum, [a, b]) => sum + (b - a + 1), 0) } : row)));
    setEdited((current) => ({ ...current, [number]: true }));
    setEditing(null);
  }

  function addManual() {
    if (!detection) return;
    const number = Number(newNumber);
    const ranges = parseRanges(newRanges, detection.pageCount);
    if (!Number.isInteger(number) || number < 1 || number > 99) { setError("Numéro de lot non valide."); return; }
    if (rows.some((row) => row.number === number)) { setError(`Le lot ${number} existe déjà dans la liste : utilise « Modifier les pages » sur sa ligne.`); return; }
    if (ranges.length === 0) { setError("Indique les pages de prix de ce lot (exemple : 54-59)."); return; }
    setError("");
    const row: Row = { number, label: newLabel.trim(), ranges, pageCount: ranges.reduce((sum, [a, b]) => sum + (b - a + 1), 0), bidSecurity: null, manual: true };
    setRows((current) => [...current, row].sort((a, b) => a.number - b.number));
    setRangeInputs((current) => ({ ...current, [number]: rangeText(ranges) }));
    setEdited((current) => ({ ...current, [number]: true }));
    setNewNumber(""); setNewLabel(""); setNewRanges("");
  }

  async function create() {
    setCreating(true);
    setError("");
    try {
      const lots = selected.map((number) => {
        const row = rows.find((item) => item.number === number)!;
        return edited[number] ? { number, label: row.label, ranges: row.ranges } : { number };
      });
      const response = await fetch("/api/tenders/lots/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenderId, lots, dropCcag }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Création des lots impossible.");
      setDone([...(data.created ?? []), ...(data.alreadyCreated ?? [])].sort((a: { number: number }, b: { number: number }) => a.number - b.number));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Création des lots impossible.");
    } finally {
      setCreating(false);
    }
  }

  if (done) {
    return (
      <section className="tenderInfoCard">
        <h2>Lots prêts</h2>
        <p>Chaque lot est maintenant un appel d&apos;offres à part entière (analyse, devis, dossier de soumission, chantier). Le PDF complet d&apos;origine est conservé.</p>
        <ul style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {done.map((lot) => <li key={lot.number}><Link className="tenderButton tenderButtonPrimary" href={`/tenders/${lot.id}`}>Ouvrir le lot {lot.number}</Link></li>)}
        </ul>
        <p style={{ marginTop: 12 }}><Link href={`/tenders/${tenderId}`}>← Retour au DAO complet</Link></p>
      </section>
    );
  }

  const tooMany = selected.length > 2;

  return (
    <section className="tenderInfoCard" style={{ maxWidth: "100%" }}>
      <h2>Choisir les lots à traiter</h2>
      <p style={{ opacity: 0.8 }}>{tenderTitle}</p>

      {loading && <p style={{ marginTop: 12 }}>Lecture du PDF pour repérer les lots… (quelques secondes, sans crédit IA)</p>}
      {error && <p role="alert" style={{ marginTop: 12, color: "#b91c1c", fontWeight: 600 }}>{error}</p>}

      {!loading && detection && (
        <>
          {rows.length === 0 && (
            <p style={{ marginTop: 12 }}>
              {readable ? "Aucun lot n'a été reconnu dans ce PDF." : "Ce PDF est un scan : le texte n'est pas lisible, les lots ne peuvent pas être reconnus automatiquement."}{" "}
              Ajoute les lots à la main plus bas en donnant les pages de leurs tableaux de prix.
            </p>
          )}

          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            {rows.map((lot) => {
              const already = existing[lot.number];
              return (
                <div key={lot.number} style={{ border: "1px solid #d1d5db", borderRadius: 10, padding: 12, overflowWrap: "anywhere" }}>
                  <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontWeight: 700, cursor: already ? "default" : "pointer" }}>
                    <input type="checkbox" style={{ width: "auto", marginTop: 4 }} disabled={Boolean(already)} checked={selected.includes(lot.number)} onChange={() => toggle(lot.number)} />
                    <span>
                      Lot {lot.number}{lot.label ? ` — ${lot.label}` : ""}
                      <small style={{ display: "block", fontWeight: 400, opacity: 0.8, marginTop: 4 }}>
                        {lot.pageCount} page(s) de prix : {rangeText(lot.ranges)}{lot.bidSecurity ? ` · garantie de soumission ${lot.bidSecurity}` : ""}{lot.manual || edited[lot.number] ? " · pages modifiées à la main" : ""}
                      </small>
                    </span>
                  </label>
                  {already && <p style={{ marginTop: 8 }}>Déjà créé · <Link href={`/tenders/${already}`}>Ouvrir ce lot</Link></p>}
                  {!already && (
                    editing === lot.number ? (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <input value={rangeInputs[lot.number] ?? ""} onChange={(e) => setRangeInputs((c) => ({ ...c, [lot.number]: e.target.value }))} placeholder="Pages de prix, ex : 54-59" style={{ flex: "1 1 200px" }} />
                        <button type="button" className="button" onClick={() => applyEdit(lot.number)}>Valider</button>
                        <button type="button" className="ghostButton" onClick={() => setEditing(null)}>Annuler</button>
                      </div>
                    ) : (
                      <button type="button" className="ghostButton" style={{ marginTop: 8 }} onClick={() => setEditing(lot.number)}>Modifier les pages</button>
                    )
                  )}
                </div>
              );
            })}
          </div>

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Un lot manque ou ses pages sont fausses ? Ajouter un lot à la main</summary>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <input value={newNumber} onChange={(e) => setNewNumber(e.target.value)} placeholder="N° du lot" inputMode="numeric" style={{ flex: "0 1 90px" }} />
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Lieu du lot (facultatif)" style={{ flex: "1 1 200px" }} />
              <input value={newRanges} onChange={(e) => setNewRanges(e.target.value)} placeholder="Pages de prix, ex : 54-59" style={{ flex: "1 1 160px" }} />
              <button type="button" className="button" onClick={addManual}>Ajouter</button>
            </div>
          </details>

          {ccagPages > 0 && (
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14 }}>
              <input type="checkbox" style={{ width: "auto", marginTop: 4 }} checked={dropCcag} onChange={(e) => setDropCcag(e.target.checked)} />
              <span>Retirer le CCAG ({ccagPages} pages) : cahier général standard, inutile pour la soumission</span>
            </label>
          )}

          {tooMany && (
            <p role="status" style={{ marginTop: 12, color: "#b45309", fontWeight: 600 }}>
              Tu as choisi {selected.length} lots. Vérifie dans les instructions du DAO si le nombre de lots par candidat est limité (c&apos;est souvent 2). Tu peux continuer, ce n&apos;est qu&apos;un avertissement.
            </p>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button type="button" className="button" disabled={creating || selected.length === 0} onClick={create}>
              {creating ? "Création des lots…" : selected.length === 0 ? "Choisis au moins un lot" : `Créer ${selected.length} lot${selected.length > 1 ? "s" : ""}`}
            </button>
            <button type="button" className="ghostButton" disabled={loading || creating} onClick={() => void load(true)}>Relire le PDF</button>
            <Link href={`/tenders/${tenderId}`} className="ghostButton">Retour</Link>
          </div>
        </>
      )}
    </section>
  );
}
