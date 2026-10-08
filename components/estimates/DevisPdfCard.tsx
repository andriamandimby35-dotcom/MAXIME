"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Carte PDF d'un devis importé — MÊME présentation que le devis du DAO :
// « Prévisualiser » → l'aperçu s'affiche DANS la carte (pas de nouvelle fenêtre) →
// « Confirmer et enregistrer » met à jour le chantier (planning) puis la facturation.
// Le PDF est refait à la demande et n'est jamais stocké (aucun stockage Supabase).
export default function DevisPdfCard({ projectId, mode, isAdmin, version }: { projectId: string; mode: "external" | "internal"; isAdmin: boolean; version?: string }) {
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const urlRef = useRef<string | null>(null);
  // Contenu du devis au moment où l'aperçu a été fabriqué : le PDF n'est refait que si le devis a changé depuis.
  const builtVersionRef = useRef<string | null>(null);
  const stale = Boolean(objectUrl) && version !== undefined && builtVersionRef.current !== version;
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
      setMessage("Le devis n’a pas changé depuis cet aperçu : il est déjà à jour (rien n’est refait).");
      return;
    }
    setWorking("preview"); setSaved(false); setMessage("Création de l’aperçu PDF…");
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
      setObjectUrl(url);
      setMessage("Aperçu prêt. Vérifiez-le, puis enregistrez pour mettre à jour le chantier et la facturation.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prévisualisation impossible.");
    } finally { setWorking(null); }
  }

  async function save() {
    if (working || !objectUrl) return;
    if (!window.confirm("Enregistrer et mettre à jour le chantier ? Chaque ligne du devis est reliée au planning, puis la facturation est actualisée.")) {
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
      const added = result.createdTasks ? ` · ${result.createdTasks} tâche(s) ajoutée(s) au planning` : "";
      setMessage(result.taskLinkMissing
        ? `Chantier mis à jour (${result.total ?? 0} lignes, rapprochées du planning par leur texte${added}). La facturation est prête.`
        : `Chantier mis à jour (${result.total ?? 0} lignes reliées au planning${added}). La facturation est prête.`);
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
        {working === "preview" ? "Création de l’aperçu…" : objectUrl ? (stale ? "Actualiser l’aperçu PDF (devis modifié)" : "Aperçu PDF à jour") : mode === "internal" ? "Prévisualiser le devis interne" : "Prévisualiser le devis externe"}
      </button>
      {objectUrl && isAdmin && (
        <button type="button" onClick={() => void save()} disabled={Boolean(working)} aria-busy={working === "save"}
          style={{ ...primary, border: "1px solid #1d4ed8", background: working === "save" ? "#dbeafe" : "#1d4ed8", color: working === "save" ? "#1e3a8a" : "white", cursor: working ? "wait" : "pointer" }}>
          {working === "save" ? "Enregistrement…" : "Confirmer et enregistrer"}
        </button>
      )}
      {saved && <Link href={`/billing/${projectId}`} style={{ ...primary, border: "1px solid #0f766e", background: "#0f766e", color: "white", textDecoration: "none" }}>Ouvrir la facturation</Link>}
      {working && (
        <div className="appProgress appProgressCompact isIndeterminate" role="progressbar" aria-label="Préparation du PDF en cours" aria-valuetext="Préparation en cours"><span /></div>
      )}
      {message && <small role="status" style={{ flexBasis: "100%", color: hasError ? "#b91c1c" : "#166534", maxWidth: "min(720px, 100%)", overflowWrap: "anywhere" }}>{message}</small>}
      {objectUrl && (
        <div style={{ flexBasis: "100%" }}>
          {phone ? (
            <a href={objectUrl} target="_blank" rel="noreferrer" className="estimateSecondaryAction" style={{ textDecoration: "none" }}>Ouvrir le PDF (plein écran)</a>
          ) : (
            <>
              <iframe src={objectUrl} title={mode === "internal" ? "Aperçu du devis interne" : "Aperçu du devis externe"} style={{ width: "100%", height: "70vh", minHeight: 420, border: "1px solid #b8d7c0", borderRadius: 8, background: "#fff" }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
