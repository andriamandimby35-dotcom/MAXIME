"use client";

import { useMemo, useState } from "react";

type Tender = {
  id: string;
  reference: string | null;
  title: string;
  status: string;
  summary: string | null;
  requirements: unknown;
  missing_documents: unknown;
};

type Memoire = {
  cover_title: string;
  executive_summary: string;
  understanding_of_need: string;
  methodology: string[];
  organization_and_staffing: string[];
  equipment_and_materials: string[];
  quality_plan: string[];
  health_safety_environment: string[];
  schedule_and_milestones: string[];
  risk_management: string[];
  local_context: string[];
  assumptions_and_reservations: string[];
  submission_checklist: Array<{ item: string; status: "à préparer" | "à vérifier" | "prêt"; note: string }>;
};

export function MemoireGenerator({ tenders }: { tenders: Tender[] }) {
  const [tenderId, setTenderId] = useState(tenders[0]?.id ?? "");
  const [companyName, setCompanyName] = useState("");
  const [duration, setDuration] = useState("");
  const [memoire, setMemoire] = useState<Memoire | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selected = useMemo(() => tenders.find((tender) => tender.id === tenderId), [tenderId, tenders]);

  async function generate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMemoire(null);
    try {
      const response = await fetch("/api/tenders/generate-memoire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenderId, companyName, proposedDuration: duration }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Génération impossible");
      setMemoire(payload.memoire);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Génération impossible");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="memoireLayout">
      <form className="panel memoireControls noPrint" onSubmit={generate}>
        <label>
          Appel d’offres analysé
          <select value={tenderId} onChange={(event) => setTenderId(event.target.value)} required>
            {tenders.map((tender) => (
              <option key={tender.id} value={tender.id}>
                {tender.reference ? `${tender.reference} — ` : ""}{tender.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nom de l’entreprise soumissionnaire
          <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Ex. Sébastien BTP SARL" required />
        </label>
        <label>
          Durée proposée
          <input value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="Ex. 8 mois" />
        </label>
        <button disabled={loading}>{loading ? "Génération en cours…" : "Générer le mémoire"}</button>
        <small>Le document généré est une trame à valider par le responsable technique avant soumission.</small>
        {error && <p className="error">{error}</p>}
      </form>

      <article className="panel memoireDocument" id="memoire-document">
        {!memoire ? (
          <div className="memoireEmpty">
            <span>SB</span>
            <h3>Mémoire technique</h3>
            <p className="muted">Sélectionnez un appel d’offres analysé pour créer une trame adaptée aux exigences du DAO.</p>
            {selected?.summary && <blockquote>{selected.summary}</blockquote>}
          </div>
        ) : (
          <>
            <div className="documentToolbar noPrint">
              <button type="button" onClick={() => window.print()}>Imprimer / Enregistrer en PDF</button>
            </div>
            <header className="documentCover">
              <span className="documentBrand">SÉBASTIEN BTP</span>
              <h1>{memoire.cover_title}</h1>
              <p>{selected?.reference || "Appel d’offres"} — {selected?.title}</p>
              <strong>{companyName}</strong>
            </header>
            <DocumentSection number="1" title="Résumé exécutif" paragraphs={[memoire.executive_summary]} />
            <DocumentSection number="2" title="Compréhension du besoin" paragraphs={[memoire.understanding_of_need]} />
            <DocumentSection number="3" title="Méthodologie d’exécution" items={memoire.methodology} />
            <DocumentSection number="4" title="Organisation et personnel" items={memoire.organization_and_staffing} />
            <DocumentSection number="5" title="Matériels et approvisionnements" items={memoire.equipment_and_materials} />
            <DocumentSection number="6" title="Plan qualité" items={memoire.quality_plan} />
            <DocumentSection number="7" title="Hygiène, sécurité et environnement" items={memoire.health_safety_environment} />
            <DocumentSection number="8" title="Planning et jalons" items={memoire.schedule_and_milestones} />
            <DocumentSection number="9" title="Gestion des risques" items={memoire.risk_management} />
            <DocumentSection number="10" title="Prise en compte du contexte local" items={memoire.local_context} />
            <DocumentSection number="11" title="Hypothèses et réserves" items={memoire.assumptions_and_reservations} />
            <section className="documentSection checklistSection">
              <h2><span>12</span> Checklist de soumission</h2>
              <table>
                <thead><tr><th>Élément</th><th>Statut</th><th>Note</th></tr></thead>
                <tbody>{memoire.submission_checklist.map((row, index) => (
                  <tr key={`${row.item}-${index}`}><td>{row.item}</td><td><span className="pill">{row.status}</span></td><td>{row.note}</td></tr>
                ))}</tbody>
              </table>
            </section>
            <footer className="documentFooter">Document de travail généré par Sébastien BTP — validation humaine obligatoire.</footer>
          </>
        )}
      </article>
    </div>
  );
}

function DocumentSection({ number, title, paragraphs, items }: { number: string; title: string; paragraphs?: string[]; items?: string[] }) {
  return (
    <section className="documentSection">
      <h2><span>{number}</span> {title}</h2>
      {paragraphs?.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      {items?.length ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul> : null}
    </section>
  );
}
