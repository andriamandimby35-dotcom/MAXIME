"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";

type Step = "choice" | "upload" | "review";

export function CreateProjectFlow() {
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [step, setStep] = useState<Step>("choice");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [taskInput, setTaskInput] = useState("");
  const [fromPdf, setFromPdf] = useState(false);

  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  function closeModal() {
    setShowModal(false);
    setStep("choice");
    setBusy(false);
    setError("");
    setName("");
    setLocation("");
    setTasks([]);
    setTaskInput("");
    setFromPdf(false);
    setPdfFile(null);
    setAnalyzing(false);
  }

  function addTask() {
    const value = taskInput.trim();
    if (!value) return;
    setTasks((current) => [...current, value]);
    setTaskInput("");
  }

  function removeTask(index: number) {
    setTasks((current) => current.filter((_, i) => i !== index));
  }

  async function analyzePdf() {
    if (!pdfFile) return;
    setAnalyzing(true);
    setError("");
    const form = new FormData();
    form.append("file", pdfFile);
    const response = await fetch("/api/projects/extract-tasks-from-pdf", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({})) as { error?: string; works?: string[]; project_name?: string; location?: string; upstream_status?: number; details?: string };
    setAnalyzing(false);
    if (!response.ok || !payload.works) {
      // Diagnostic temporaire : on affiche aussi la réponse brute du moteur IA
      // pour comprendre pourquoi l'analyse échoue.
      const diag = payload.upstream_status ? ` [DIAG: status=${payload.upstream_status} — ${payload.details ?? ""}]` : "";
      setError((payload.error || "L'analyse du PDF a échoué.") + diag);
      return;
    }
    setName(payload.project_name || "");
    setLocation(payload.location || "");
    setTasks(payload.works);
    setFromPdf(true);
    setStep("review");
  }

  async function submitProject() {
    if (!name.trim()) { setError("Le nom du chantier est obligatoire."); return; }
    setBusy(true);
    setError("");
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual", name, location, tasks }),
    });
    const payload = await response.json().catch(() => ({})) as {
      error?: string; code?: string; details?: string; hint?: string; projectId?: string;
      diagAppUserId?: string; diagDbSees?: unknown; diagRpcError?: string | null;
    };
    if (!response.ok || !payload.projectId) {
      setBusy(false);
      // Diagnostic temporaire : on affiche aussi le code/détail Postgres et la
      // comparaison d'identifiant (app vs base) pour comprendre le blocage.
      const extra = [payload.code, payload.details, payload.hint].filter(Boolean).join(" — ");
      const diag = `app=${payload.diagAppUserId ?? "?"} | db=${JSON.stringify(payload.diagDbSees) ?? "?"} | rpcErr=${payload.diagRpcError ?? "aucune"}`;
      setError((payload.error || "Création du chantier impossible.") + (extra ? ` (${extra})` : "") + ` [DIAG: ${diag}]`);
      return;
    }
    router.push(`/projects/${payload.projectId}`);
  }

  return <>
    <button type="button" className="tenderButton tenderButtonPrimary tenderAddButton" onClick={() => setShowModal(true)}>
      + Ajouter un chantier
    </button>

    {showModal && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={closeModal}>
      <div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(560px,100%)" }}>

        {step === "choice" && <>
          <h2 className="font-bold text-xl mb-4">Nouveau chantier</h2>
          <p style={{ marginBottom: 14, color: "#6b776f" }}>Comment voulez-vous créer ce chantier ?</p>
          <div style={{ display: "grid", gap: 12 }}>
            <button type="button" className="tenderButton tenderButtonPrimary" style={{ textAlign: "left", padding: "14px 16px", height: "auto" }} onClick={() => { setFromPdf(false); setStep("review"); }}>
              <strong style={{ display: "block" }}>Manuel</strong>
              <small>Je saisis moi-même la liste des travaux à réaliser.</small>
            </button>
            <button type="button" className="tenderButton" style={{ textAlign: "left", padding: "14px 16px", height: "auto" }} onClick={() => setStep("upload")}>
              <strong style={{ display: "block" }}>Automatique</strong>
              <small>J&apos;ajoute le PDF d&apos;un devis : les travaux à réaliser sont extraits automatiquement.</small>
            </button>
          </div>
          <div style={{ marginTop: 18 }}>
            <button type="button" className="ghostButton" onClick={closeModal}>Annuler</button>
          </div>
        </>}

        {step === "upload" && <>
          <h2 className="font-bold text-xl mb-4">Nouveau chantier — depuis un PDF</h2>
          <p style={{ marginBottom: 14, color: "#6b776f" }}>
            Ajoutez le PDF d&apos;un devis déjà fait. Les travaux à réaliser en seront extraits automatiquement ; les prix ne sont pas utilisés.
          </p>
          <input
            type="file"
            accept="application/pdf"
            onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)}
          />

          {error && <p className="notice danger" style={{ marginTop: 12 }}>{error}</p>}
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button type="button" className="tenderButton tenderButtonPrimary" disabled={!pdfFile || analyzing} onClick={() => void analyzePdf()}>
              {analyzing ? "Analyse en cours…" : "Analyser le PDF"}
            </button>
            <button type="button" className="ghostButton" onClick={() => setStep("choice")}>Retour</button>
          </div>
        </>}

        {step === "review" && <>
          <h2 className="font-bold text-xl mb-4">{fromPdf ? "Travaux extraits du PDF" : "Nouveau chantier — manuel"}</h2>
          {fromPdf && <p style={{ marginBottom: 10, color: "#6b776f", fontSize: 13 }}>Vérifiez la liste avant de créer le chantier : vous pouvez corriger le nom et ajouter ou retirer des travaux.</p>}
          <div className="formGrid" style={{ gridTemplateColumns: "1fr" }}>
            <label>Nom du chantier
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Villa Analakely" autoFocus={!fromPdf} />
            </label>
            <label>Localisation (optionnel)
              <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Ex. Antananarivo" />
            </label>
          </div>

          <strong style={{ display: "block", margin: "6px 0 8px" }}>Travaux à réaliser</strong>
          {tasks.length > 0 && <ul style={{ display: "grid", gap: 6, marginBottom: 10, paddingLeft: 0, listStyle: "none" }}>
            {tasks.map((task, index) => <li key={index} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", border: "1px solid #e2e8e3", borderRadius: 10, background: "#fbfefc" }}>
              <span>{task}</span>
              <button type="button" className="text-red-700 underline" onClick={() => removeTask(index)}>Retirer</button>
            </li>)}
          </ul>}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={taskInput}
              onChange={(event) => setTaskInput(event.target.value)}
              placeholder="Ex. Terrassement"
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTask(); } }}
            />
            <button type="button" className="tenderButton" onClick={addTask}>+ Ajouter un travail</button>
          </div>

          {error && <p className="notice danger" style={{ marginTop: 12 }}>{error}</p>}
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button type="button" className="tenderButton tenderButtonPrimary" disabled={busy} onClick={() => void submitProject()}>
              {busy ? "Création…" : "Créer le chantier"}
            </button>
            <button type="button" className="ghostButton" onClick={() => setStep(fromPdf ? "upload" : "choice")}>Retour</button>
          </div>
        </>}

      </div>
    </div>, document.body)}
  </>;
}
