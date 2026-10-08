"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isPhoneDevice } from "@/lib/is-phone-device";
import { usePdfViewer } from "@/components/PdfViewerProvider";

export default function OfficialPdfButton({ estimateId, mode = "external" }: { estimateId: string; mode?: "external" | "internal" }) {
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [message, setMessage] = useState("");
  // Lecteur PDF commun à toute l'appli (même fenêtre, mêmes boutons Imprimer / Fermer) ; sur téléphone, plein écran dans son onglet.
  const { showPdf: showInViewer } = usePdfViewer();
  const viewerTitle = mode === "internal" ? "Devis interne (aperçu)" : "Devis externe (aperçu)";
  const [phone, setPhone] = useState(false);
  useEffect(() => { setPhone(isPhoneDevice() || window.matchMedia("(max-width: 640px)").matches); }, []);

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
    if (!response.ok || !result.pdfBase64) throw new Error(result.error || "Le PDF n’a pas pu être préparé.");
    return result.pdfBase64 as string;
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
      if (!phone) showInViewer(viewerTitle, url);
      setMessage(phone
        ? "Aperçu prêt. Touchez « Ouvrir l’aperçu PDF » pour l’afficher en plein écran."
        : "Aperçu prêt. Vérifiez-le, fermez-le, puis enregistrez.");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Prévisualisation impossible.";
      setMessage(errorMessage);
    } finally {
      setWorking(null);
    }
  }

  function openPreviewPdf() {
    if (!previewReady || !previewUrl) {
      setMessage("Préparez d’abord l’aperçu PDF.");
      return;
    }
    // Aucune nouvelle fabrication : on réaffiche le PDF déjà créé, dans la carte (ordinateur) ou plein écran (téléphone).
    if (!phone) { showInViewer(viewerTitle, previewUrl); return; }
    const opened = window.open(previewUrl, "_blank");
    if (!opened) setMessage("Le navigateur a bloqué la fenêtre PDF. Autorisez les fenêtres surgissantes puis réessayez.");
    else setMessage("Aperçu ouvert dans le lecteur PDF du téléphone.");
  }

  async function savePdf() {
    if (working || !previewReady) return;
    const confirmed = window.confirm(
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
          showPdf(preview, await requestPdf(true));
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Ouverture du PDF impossible.";
          preview.document.title = "PDF indisponible";
          preview.document.body.innerHTML = `<p style="font-family:system-ui;padding:24px">${detail.replace(/[<>&]/g, "")}</p>`;
          throw error;
        }
        setPreviewReady(false);
      } else {
        // Ordinateur : le PDF enregistré remplace l'aperçu, dans la carte (pas de nouvelle fenêtre).
        const url = blobUrlFrom(await requestPdf(true));
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setPreviewReady(false);
        showInViewer(mode === "internal" ? "Devis interne (enregistré)" : "Devis externe (enregistré)", url);
      }
      setMessage("PDF enregistré. Il remplace l’ancienne version de ce type de devis.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible.");
    } finally {
      setWorking(null);
    }
  }

  const hasError = /impossible|expirée|introuvable/i.test(message);
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
        onClick={openPreviewPdf}
        disabled={!previewReady || Boolean(working)}
        style={{
          border: "1px solid #0f766e", borderRadius: 6, padding: "9px 14px",
          background: previewReady && !working ? "#0f766e" : "#ccfbf1",
          color: previewReady && !working ? "white" : "#115e59",
          cursor: previewReady && !working ? "pointer" : "not-allowed", fontWeight: 700,
        }}
      >
        Ouvrir l’aperçu PDF
      </button>
      {previewReady && (
        <button
          type="button"
          onClick={savePdf}
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
    </div>
  );
}
