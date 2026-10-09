"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ConfirmSaveDialog from "@/components/ConfirmSaveDialog";
import { findSavedProjectPdf, openSavedProjectPdf, saveProjectPdf, type SavedPdfInfo } from "@/components/estimates/savedPdf";

// Carte PDF d'un devis importé — MÊME présentation que le devis du DAO :
// « Prévisualiser » → l'aperçu s'affiche DANS la carte (pas de nouvelle fenêtre) →
// « Confirmer et enregistrer » met à jour le chantier (planning) puis la facturation.
// « Confirmer et enregistrer » garde aussi le PDF : ensuite « Ouvrir le PDF enregistré » le rouvre tel quel (sans le refaire, téléchargé
// une seule fois par visite) ; « Prévisualiser » le refait à la demande, et l'enregistrement remplace l'ancien.
export default function DevisPdfCard({ projectId, mode, isAdmin, version }: { projectId: string; mode: "external" | "internal"; isAdmin: boolean; version?: string }) {
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  // PDF déjà enregistré pour ce devis (simple liste de dossier, aucun fichier téléchargé) ; shownIsSaved = c'est lui qui est affiché.
  const [savedInfo, setSavedInfo] = useState<SavedPdfInfo | null>(null);
  const [shownIsSaved, setShownIsSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    findSavedProjectPdf(projectId, mode).then((info) => { if (!cancelled) setSavedInfo(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, mode]);
  const [closed, setClosed] = useState(false); // « Fermer » masque l'aperçu (le PDF reste prêt, « Aperçu PDF à jour » le réaffiche)
  const urlRef = useRef<string | null>(null);
  // Contenu du devis au moment où l'aperçu a été fabriqué : le PDF n'est refait que si le devis a changé depuis.
  const builtVersionRef = useRef<string | null>(null);
  const stale = Boolean(objectUrl) && !shownIsSaved && version !== undefined && builtVersionRef.current !== version;
  // Sur téléphone, un PDF ne s'affiche pas bien dans la page : on propose de l'ouvrir en plein écran.
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  useEffect(() => {
    if (!working) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [working]);

  async function preview() {
    if (working) return;
    if (objectUrl && version !== undefined && builtVersionRef.current === version) {
      setClosed(false);
      setMessage("Le devis n’a pas changé depuis cet aperçu : il est déjà à jour (rien n’est refait).");
      return;
    }
    setWorking("preview"); setSaved(false); setClosed(false); setMessage("Création de l’aperçu PDF…");
    try {
      const response = await fetch(`/api/devis/projects/${projectId}/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PDF-Client-Fetch": "1" },
        body: JSON.stringify({ mode }),
      });
      const payload = await response.json().catch(() => ({})) as { pdfBase64?: string; error?: string };
      if (!response.ok || !payload.pdfBase64) throw new Error(payload.error || "Prévisualisation impossible.");
      const bytes = Uint8Array.from(atob(payload.pdfBase64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      builtVersionRef.current = version ?? null;
      setShownIsSaved(false);
      setObjectUrl(url);
      setMessage("Aperçu prêt. Vérifiez-le, puis enregistrez pour mettre à jour le chantier et la facturation.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prévisualisation impossible.");
    } finally { setWorking(null); }
  }

  // Ouvre le PDF DÉJÀ enregistré tel quel (sans « Prévisualiser », sans le refaire).
  async function openSaved() {
    if (working) return;
    if (objectUrl && shownIsSaved) { setClosed(false); return; }
    setWorking("preview"); setClosed(false); setMessage("Ouverture du PDF enregistré…");
    const result = await openSavedProjectPdf(projectId, mode, savedInfo);
    setWorking(null);
    if ("error" in result) { setMessage(result.error); return; }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = result.url;
    builtVersionRef.current = null;
    setObjectUrl(result.url);
    setShownIsSaved(true);
    setMessage(`PDF enregistré${result.createdAt ? ` le ${new Date(result.createdAt).toLocaleDateString("fr-FR")}` : ""}. Pour le mettre à jour : « Prévisualiser », puis « Confirmer et enregistrer ».`);
  }

  // « Fermer » : si l'aperçu n'a pas été enregistré (chantier pas mis à jour), on demande d'abord.
  function closePreview() {
    if (objectUrl && isAdmin && !saved && !shownIsSaved && !working) { setClosePrompt(true); return; }
    setClosed(true);
  }

  async function save(skipConfirm = false, closeAfter = false) {
    if (working || !objectUrl) return;
    if (!skipConfirm && !window.confirm("Enregistrer et mettre à jour le chantier ? Chaque ligne du devis est reliée au planning, puis la facturation est actualisée.")) {
      setMessage("Enregistrement annulé. Vous pouvez encore modifier le devis.");
      return;
    }
    setWorking("save"); setMessage("Mise à jour du chantier…");
    try {
      const response = await fetch(`/api/devis/projects/${projectId}/sync`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as { error?: string; linked?: number; createdTasks?: number; total?: number; taskLinkMissing?: boolean };
      if (!response.ok) throw new Error(result.error || "Enregistrement impossible.");
      // La dernière facture non payée reprend les nouveaux prix (sans effet si aucune).
      await fetch(`/api/billing/projects/${projectId}/refresh-claim`, { method: "POST" }).catch(() => null);
      setSaved(true);
      // Le PDF vu à l'écran est aussi conservé (envoyé directement par le navigateur, il remplace l'ancien).
      let pdfNote = "";
      try {
        const blob = await (await fetch(objectUrl)).blob();
        const stored = await saveProjectPdf(projectId, mode, blob);
        if ("error" in stored) pdfNote = ` (PDF non conservé : ${stored.error})`;
        else { setSavedInfo(stored); setShownIsSaved(true); }
      } catch { pdfNote = " (PDF non conservé)"; }
      if (closeAfter) setClosed(true);
      const added = result.createdTasks ? ` · ${result.createdTasks} tâche(s) ajoutée(s) au planning` : "";
      setMessage(result.taskLinkMissing
        ? `Chantier mis à jour (${result.total ?? 0} lignes, rapprochées du planning par leur texte${added}). La facturation est prête.${pdfNote}`
        : `Chantier mis à jour (${result.total ?? 0} lignes reliées au planning${added}). La facturation est prête.${pdfNote}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible.");
    } finally { setWorking(null); }
  }

  const hasError = /impossible|expirée|introuvable|erreur/i.test(message);
  const primary: React.CSSProperties = { border: "1px solid #14532d", borderRadius: 6, padding: "9px 14px", fontWeight: 700 };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9, maxWidth: "100%", minWidth: 0 }}>
      <button type="button" onClick={() => void preview()} disabled={Boolean(working)} aria-busy={working === "preview"}
        style={{ ...primary, background: working === "preview" ? "#d1fae5" : "#166534", color: working === "preview" ? "#14532d" : "white", cursor: working ? "wait" : "pointer" }}>
        {working === "preview" ? "Création de l’aperçu…" : objectUrl && shownIsSaved ? "Prévisualiser (mettre à jour)" : objectUrl ? (stale ? "Actualiser l’aperçu PDF (devis modifié)" : "Aperçu PDF à jour") : mode === "internal" ? "Prévisualiser le devis interne" : "Prévisualiser le devis externe"}
      </button>
      {savedInfo && !(objectUrl && shownIsSaved && !closed) && (
        <button type="button" onClick={() => void openSaved()} disabled={Boolean(working)}
          style={{ ...primary, border: "1px solid #0f766e", background: working ? "#ccfbf1" : "#0f766e", color: working ? "#115e59" : "white", cursor: working ? "wait" : "pointer" }}>
          Ouvrir le PDF enregistré
        </button>
      )}
      {objectUrl && isAdmin && !shownIsSaved && (
        <button type="button" onClick={() => void save()} disabled={Boolean(working)} aria-busy={working === "save"}
          style={{ ...primary, border: "1px solid #1d4ed8", background: working === "save" ? "#dbeafe" : "#1d4ed8", color: working === "save" ? "#1e3a8a" : "white", cursor: working ? "wait" : "pointer" }}>
          {working === "save" ? "Enregistrement…" : "Confirmer et enregistrer"}
        </button>
      )}
      {objectUrl && !phone && !closed && (
        <button type="button" onClick={closePreview} style={{ ...primary, border: "1px solid #6b7280", background: "#fff", color: "#374151", cursor: "pointer" }}>
          Fermer
        </button>
      )}
      {saved && <Link href={`/billing/${projectId}`} style={{ ...primary, border: "1px solid #0f766e", background: "#0f766e", color: "white", textDecoration: "none" }}>Ouvrir la facturation</Link>}
      {working && (
        <div className="appProgress appProgressCompact isIndeterminate" role="progressbar" aria-label="Préparation du PDF en cours" aria-valuetext="Préparation en cours"><span /></div>
      )}
      {closePrompt && <ConfirmSaveDialog
        message="Ce devis vient d’être prévisualisé mais le chantier n’a pas encore été mis à jour avec lui. Voulez-vous l’enregistrer avant de fermer ?"
        busy={working === "save"}
        onSave={() => { setClosePrompt(false); void save(true, true); }}
        onDiscard={() => { setClosePrompt(false); setClosed(true); }}
        onCancel={() => setClosePrompt(false)}
      />}
      {message && <small role="status" style={{ flexBasis: "100%", color: hasError ? "#b91c1c" : "#166534", maxWidth: "min(720px, 100%)", overflowWrap: "anywhere" }}>{message}</small>}
      {objectUrl && (phone ? (
        <div style={{ flexBasis: "100%" }}>
          <a href={objectUrl} target="_blank" rel="noreferrer" className="estimateSecondaryAction" style={{ textDecoration: "none" }}>Ouvrir le PDF (plein écran)</a>
        </div>
      ) : !closed ? (
        <div style={{ flexBasis: "100%", minWidth: 0 }}>
          <iframe src={objectUrl} title={mode === "internal" ? "Aperçu du devis interne" : "Aperçu du devis externe"} style={{ width: "100%", height: "70vh", minHeight: 420, border: "1px solid #b8d7c0", borderRadius: 8, background: "#fff" }} />
        </div>
      ) : null)}
    </div>
  );
}
