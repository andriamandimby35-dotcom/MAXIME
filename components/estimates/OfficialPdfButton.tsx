"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isPhoneDevice } from "@/lib/is-phone-device";
import ConfirmSaveDialog from "@/components/ConfirmSaveDialog";
import { findSavedEstimatePdf, openSavedEstimatePdf, rememberSavedEstimatePdf, type SavedPdfInfo } from "@/components/estimates/savedPdf";

export default function OfficialPdfButton({ estimateId, mode = "external" }: { estimateId: string; mode?: "external" | "internal" }) {
  const [working, setWorking] = useState<"preview" | "save" | "open" | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [message, setMessage] = useState("");
  // Ordinateur : l'aperçu s'affiche DANS la carte, juste sous les boutons (aucune nouvelle fenêtre) ; bouton « Fermer » pour le masquer.
  // Téléphone : plein écran dans son onglet (inchangé).
  const [showInline, setShowInline] = useState(false);
  const [phone, setPhone] = useState(false);
  useEffect(() => { setPhone(isPhoneDevice() || window.matchMedia("(max-width: 640px)").matches); }, []);
  // PDF déjà enregistré pour ce devis (une toute petite requête, aucun fichier téléchargé) : « Ouvrir » le rouvre directement,
  // sans « Prévisualiser » et sans refabrication.
  const [saved, setSaved] = useState<SavedPdfInfo | null>(null);
  // Le PDF affiché est la version ENREGISTRÉE (et non un nouvel aperçu pas encore enregistré).
  const [shownIsSaved, setShownIsSaved] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  useEffect(() => {
    let cancelled = false;
    findSavedEstimatePdf(estimateId, mode).then((info) => { if (!cancelled) setSaved(info); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [estimateId, mode]);
  useEffect(() => {
    if (!working) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => { document.body.style.cursor = previous; };
  }, [working]);

  async function authenticatedHeaders(): Promise<Record<string, string>> {
    const { data: { session } } = await createClient().auth.getSession();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
      headers["X-Supabase-Access-Token"] = session.access_token;
    }
    return headers;
  }

  // Le PDF d'aperçu est fabriqué UNE fois, gardé en mémoire dans le navigateur (aucun fichier temporaire dans Supabase),
  // puis réouvert sans rien refaire tant que « Actualiser l'aperçu PDF » n'est pas cliqué.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);

  function openPreviewWindow() {
    const preview = window.open("about:blank", "_blank");
    if (!preview) {
      setMessage("Le navigateur a bloqué la fenêtre PDF. Autorisez les fenêtres surgissantes puis réessayez.");
      return null;
    }
    preview.document.title = "Préparation du PDF…";
    preview.document.body.innerHTML = "<p style='font-family:system-ui;padding:24px'>Préparation du PDF…</p>";
    return preview;
  }

  function blobUrlFrom(pdfBase64: string) {
    const bytes = Uint8Array.from(atob(pdfBase64), (character) => character.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }

  function showPdf(preview: Window, pdfBase64: string) {
    const objectUrl = blobUrlFrom(pdfBase64);
    preview.location.replace(objectUrl);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 60 * 1000);
  }

  async function requestPdf(save: boolean) {
    const headers = await authenticatedHeaders();
    headers["X-PDF-Client-Fetch"] = "1";
    const response = await fetch(`/api/estimates/${estimateId}/official-pdf`, {
      method: "POST",
      headers,
      body: JSON.stringify({ save, mode }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.pdfBase64) {
      // Même en cas d'échec, le serveur a pu créer le chantier : on le garde en mémoire pour l'afficher.
      if (save) lastSaveRef.current = { projectId: (result.projectId as string | null) ?? null, projectError: (result.projectError as string | null) ?? null, documentWarning: null };
      throw new Error(result.error || "Le PDF n’a pas pu être préparé.");
    }
    if (save) lastSaveRef.current = { projectId: (result.projectId as string | null) ?? null, projectError: (result.projectError as string | null) ?? null, documentWarning: (result.documentWarning as string | null) ?? null };
    return result.pdfBase64 as string;
  }

  // Après l'enregistrement : le chantier du devis (créé ou rafraîchi par le serveur) reçoit ses dépenses et sa facturation —
  // la dernière facture non payée reprend les nouveaux prix.
  const lastSaveRef = useRef<{ projectId: string | null; projectError: string | null; documentWarning: string | null }>({ projectId: null, projectError: null, documentWarning: null });
  async function finishProjectUpdate(): Promise<string> {
    const { projectId, projectError, documentWarning } = lastSaveRef.current;
    const warning = documentWarning ? ` Attention : ${documentWarning}.` : "";
    if (projectError) return ` ATTENTION : le chantier n'a PAS pu être créé/mis à jour (${projectError}).${warning}`;
    if (!projectId) return ` ATTENTION : aucun chantier n'a été renvoyé par le serveur (la mise en ligne n'est peut-être pas terminée : attends « Ready » sur Vercel puis Ctrl+F5).${warning}`;
    const claim = await fetch(`/api/billing/projects/${projectId}/refresh-claim`, { method: "POST" }).then((response) => response.json().catch(() => ({}))).catch(() => ({})) as { updated?: boolean; claimNumber?: string };
    return ` Chantier, dépenses et facturation mis à jour${claim.updated ? ` (facture ${claim.claimNumber ?? ""} non payée recalculée)` : ""}.${warning}`;
  }

  async function previewPdf() {
    if (working) return;
    setWorking("preview");
    setMessage("Création de l’aperçu PDF…");
    try {
      const pdfBase64 = await requestPdf(false);
      const url = blobUrlFrom(pdfBase64);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setPreviewReady(true);
      setShownIsSaved(false);
      setShowInline(!phone);
      setMessage(phone
        ? "Aperçu prêt. Touchez « Ouvrir l’aperçu PDF » pour l’afficher en plein écran."
        : "Aperçu prêt. Vérifiez-le ci-dessous, puis enregistrez.");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Prévisualisation impossible.";
      setMessage(errorMessage);
    } finally {
      setWorking(null);
    }
  }

  async function openPreviewPdf() {
    if (working) return;
    // 1) Un nouvel aperçu (pas encore enregistré) ou le PDF enregistré déjà chargé : on le réaffiche, rien n'est refait.
    if (previewUrl && (previewReady || shownIsSaved)) {
      if (!phone) { setShowInline(true); return; }
      const opened = window.open(previewUrl, "_blank");
      if (!opened) setMessage("Le navigateur a bloqué la fenêtre PDF. Autorisez les fenêtres surgissantes puis réessayez.");
      else setMessage("PDF ouvert dans le lecteur PDF du téléphone.");
      return;
    }
    // 2) Un PDF est déjà enregistré : on l'ouvre tel quel (téléchargé une seule fois par visite).
    if (!saved) { setMessage("Préparez d’abord l’aperçu PDF."); return; }
    const phoneWindow = phone ? openPreviewWindow() : null;
    if (phone && !phoneWindow) return;
    setWorking("open");
    setMessage("Ouverture du PDF enregistré…");
    const result = await openSavedEstimatePdf(estimateId, mode, saved);
    setWorking(null);
    if ("error" in result) {
      phoneWindow?.close();
      setMessage(result.error);
      return;
    }
    if (phoneWindow) {
      phoneWindow.location.replace(result.url);
      window.setTimeout(() => URL.revokeObjectURL(result.url), 60 * 60 * 1000);
      setMessage("PDF enregistré ouvert dans le lecteur PDF du téléphone.");
      return;
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = result.url;
    setPreviewUrl(result.url);
    setShownIsSaved(true);
    setShowInline(true);
    setMessage(`PDF enregistré${saved.createdAt ? ` le ${new Date(saved.createdAt).toLocaleDateString("fr-FR")}` : ""}. Pour le mettre à jour : « Prévisualiser », puis « Confirmer et enregistrer ».`);
  }

  // « Fermer » : si un nouvel aperçu n'a pas encore été enregistré, on demande d'abord (Enregistrer / Ne pas enregistrer / Continuer).
  function closeInline() {
    if (previewReady && !shownIsSaved) { setClosePrompt(true); return; }
    setShowInline(false);
  }

  async function savePdf(skipConfirm = false, closeAfter = false) {
    if (working || !previewReady) return;
    const confirmed = skipConfirm || window.confirm(
      `Enregistrer ce ${mode === "internal" ? "PDF interne" : "PDF de soumission"} ? L’ancienne version sera remplacée.`,
    );
    if (!confirmed) {
      setMessage("Enregistrement annulé. Vous pouvez encore modifier le devis.");
      return;
    }
    setWorking("save");
    setMessage("Enregistrement privé du PDF officiel…");
    try {
      if (phone) {
        // Téléphone : une fenêtre doit être ouverte avant l'attente réseau, sinon elle est bloquée.
        const preview = openPreviewWindow();
        if (!preview) return;
        try {
          const savedBase64 = await requestPdf(true);
          showPdf(preview, savedBase64);
          void rememberSavedEstimatePdf(estimateId, mode, new Blob([Uint8Array.from(atob(savedBase64), (character) => character.charCodeAt(0))], { type: "application/pdf" })).then((info) => { if (info) setSaved(info); });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Ouverture du PDF impossible.";
          preview.document.title = "PDF indisponible";
          preview.document.body.innerHTML = `<p style="font-family:system-ui;padding:24px">${detail.replace(/[<>&]/g, "")}</p>`;
          throw error;
        }
        setPreviewReady(false);
      } else {
        // Ordinateur : le PDF enregistré remplace l'aperçu, dans la carte (pas de nouvelle fenêtre).
        const savedBase64 = await requestPdf(true);
        const url = blobUrlFrom(savedBase64);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setShowInline(!closeAfter);
        setPreviewReady(false);
        setShownIsSaved(true);
        void rememberSavedEstimatePdf(estimateId, mode, new Blob([Uint8Array.from(atob(savedBase64), (character) => character.charCodeAt(0))], { type: "application/pdf" })).then((info) => { if (info) setSaved(info); });
      }
      setMessage(`PDF enregistré. Il remplace l’ancienne version de ce type de devis.${await finishProjectUpdate()}`);
    } catch (error) {
      const failure = lastSaveRef.current;
      setMessage(`${error instanceof Error ? error.message : "Enregistrement impossible."}${failure.projectError ? ` Chantier : ${failure.projectError}` : ""}`);
    } finally {
      setWorking(null);
    }
  }

  const hasError = /impossible|expirée|introuvable|attention/i.test(message);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9, maxWidth: "100%", minWidth: 0 }}>
      <button
        type="button"
        onClick={previewPdf}
        disabled={Boolean(working)}
        aria-busy={working === "preview"}
        style={{
          border: "1px solid #14532d", borderRadius: 6, padding: "9px 14px",
          background: working === "preview" ? "#d1fae5" : "#166534",
          color: working === "preview" ? "#14532d" : "white",
          cursor: working ? "wait" : "pointer", fontWeight: 700,
        }}
      >
        {working === "preview" ? "Création de l’aperçu…" : previewReady ? "Actualiser l’aperçu PDF" : mode === "internal" ? "Prévisualiser le devis interne" : "Prévisualiser le PDF de soumission"}
      </button>
      <button
        type="button"
        onClick={() => void openPreviewPdf()}
        disabled={(!previewReady && !saved && !shownIsSaved) || Boolean(working)}
        aria-busy={working === "open"}
        style={{
          border: "1px solid #0f766e", borderRadius: 6, padding: "9px 14px",
          background: (previewReady || saved || shownIsSaved) && !working ? "#0f766e" : "#ccfbf1",
          color: (previewReady || saved || shownIsSaved) && !working ? "white" : "#115e59",
          cursor: working ? "wait" : (previewReady || saved || shownIsSaved) ? "pointer" : "not-allowed", fontWeight: 700,
        }}
      >
        {working === "open" ? "Ouverture…" : !previewReady && (saved || shownIsSaved) ? "Ouvrir le PDF enregistré" : "Ouvrir l’aperçu PDF"}
      </button>
      {previewReady && (
        <button
          type="button"
          onClick={() => void savePdf()}
          disabled={Boolean(working)}
          aria-busy={working === "save"}
          style={{
            border: "1px solid #1d4ed8", borderRadius: 6, padding: "9px 14px",
            background: working === "save" ? "#dbeafe" : "#1d4ed8",
            color: working === "save" ? "#1e3a8a" : "white",
            cursor: working ? "wait" : "pointer", fontWeight: 700,
          }}
        >
          {working === "save" ? "Enregistrement…" : "Confirmer et enregistrer ce PDF"}
        </button>
      )}
      {!phone && showInline && previewUrl && (
        <button type="button" onClick={closeInline} style={{ border: "1px solid #6b7280", borderRadius: 6, padding: "9px 14px", background: "#fff", color: "#374151", cursor: "pointer", fontWeight: 700 }}>
          Fermer
        </button>
      )}
      {working && (
        <div
          className="appProgress appProgressCompact isIndeterminate"
          role="progressbar"
          aria-label="Préparation du PDF en cours"
          aria-valuetext="Préparation en cours"
        >
          <span />
        </div>
      )}
      {message && <small role="status" style={{ flexBasis: "100%", color: hasError ? "#b91c1c" : "#166534", maxWidth: "min(720px, 100%)", overflowWrap: "anywhere" }}>{message}</small>}
      {closePrompt && <ConfirmSaveDialog
        message={`Ce ${mode === "internal" ? "PDF interne" : "PDF de soumission"} vient d’être prévisualisé mais n’est pas encore enregistré. Voulez-vous l’enregistrer avant de fermer ?`}
        busy={working === "save"}
        onSave={() => { setClosePrompt(false); void savePdf(true, true); }}
        onDiscard={() => { setClosePrompt(false); setShowInline(false); }}
        onCancel={() => setClosePrompt(false)}
      />}
      {!phone && showInline && previewUrl && (
        <div style={{ flexBasis: "100%", minWidth: 0 }}>
          <iframe src={previewUrl} title={mode === "internal" ? "Aperçu du devis interne" : "Aperçu du devis externe"} style={{ width: "100%", height: "70vh", minHeight: 420, border: "1px solid #b8d7c0", borderRadius: 8, background: "#fff" }} />
        </div>
      )}
    </div>
  );
}
