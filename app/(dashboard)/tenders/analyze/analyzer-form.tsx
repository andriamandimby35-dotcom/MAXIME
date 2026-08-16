"use client";

import { useState } from "react";

type Tender = { id: string; reference: string | null; title: string };
type Analysis = {
  summary: string;
  eligibility: string[];
  administrative_documents: string[];
  technical_requirements: string[];
  financial_requirements: string[];
  deadlines: string[];
  risks: string[];
  missing_documents: string[];
  recommended_actions: string[];
};

export function AnalyzerForm({ tenders }: { tenders: Tender[] }) {
  const [tenderId, setTenderId] = useState(tenders[0]?.id ?? "");
  const [documentText, setDocumentText] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setAnalysis(null);
    setLoading(true);

    try {
      const response = await fetch("/api/tenders/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenderId, documentText }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Analyse impossible");
      setAnalysis(payload.analysis);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analyse impossible");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="analysisGrid">
      <form className="panel analysisForm" onSubmit={submit}>
        <label>
          Appel d’offres
          <select value={tenderId} onChange={(event) => setTenderId(event.target.value)} required>
            {tenders.map((tender) => (
              <option key={tender.id} value={tender.id}>
                {tender.reference ? `${tender.reference} — ` : ""}{tender.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Texte du DAO
          <textarea
            value={documentText}
            onChange={(event) => setDocumentText(event.target.value)}
            rows={20}
            minLength={200}
            placeholder="Collez ici le texte extrait du dossier d’appel d’offres…"
            required
          />
        </label>
        <button disabled={loading || !tenderId}>
          {loading ? "Analyse en cours…" : "Analyser et enregistrer"}
        </button>
        <small>Le texte est envoyé au moteur IA configuré côté serveur. La clé API n’est jamais exposée au navigateur.</small>
        {error && <p className="error">{error}</p>}
      </form>

      <section className="panel analysisResult">
        <h3>Résultat de l’analyse</h3>
        {!analysis && <p className="muted">La synthèse, les exigences et la checklist apparaîtront ici.</p>}
        {analysis && (
          <>
            <div className="analysisSummary"><strong>Synthèse</strong><p>{analysis.summary}</p></div>
            <ResultList title="Éligibilité" items={analysis.eligibility} />
            <ResultList title="Pièces administratives" items={analysis.administrative_documents} />
            <ResultList title="Exigences techniques" items={analysis.technical_requirements} />
            <ResultList title="Exigences financières" items={analysis.financial_requirements} />
            <ResultList title="Échéances" items={analysis.deadlines} />
            <ResultList title="Risques" items={analysis.risks} />
            <ResultList title="Pièces potentiellement manquantes" items={analysis.missing_documents} warning />
            <ResultList title="Actions recommandées" items={analysis.recommended_actions} />
          </>
        )}
      </section>
    </div>
  );
}

function ResultList({ title, items, warning = false }: { title: string; items: string[]; warning?: boolean }) {
  return (
    <div className={warning ? "resultBlock warningBlock" : "resultBlock"}>
      <strong>{title}</strong>
      {items.length ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul> : <p className="muted">Aucun élément détecté.</p>}
    </div>
  );
}
