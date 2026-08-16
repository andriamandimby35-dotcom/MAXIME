"use client";

import { useEffect, useState } from "react";

export default function OfficialPdfButton({ estimateId }: { estimateId: string }) {
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function previewPdf() {
    if (working) return;
    setWorking("preview");
    setPreviewReady(false);
    setMessage("Création de l’aperçu fidèle au DAO…");
    try {
      const response = await fetch(`/api/estimates/${estimateId}/official-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: false }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Prévisualisation impossible.");
      }
      const blob = await response.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const nextUrl = URL.createObjectURL(blob);
      setPreviewUrl(nextUrl);
      setPreviewReady(true);
      setMessage("Aperçu créé. Vérifiez-le, puis revenez modifier le devis ou confirmez son enregistrement.");
      window.open(nextUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prévisualisation impossible.");
    } finally {
      setWorking(null);
    }
  }

  async function savePdf() {
    if (working || !previewReady) return;
    const confirmed = window.confirm(
      "Enregistrer ce PDF officiel ? L’ancien PDF officiel enregistré pour ce devis sera remplacé.",
    );
    if (!confirmed) {
      setMessage("Enregistrement annulé. Vous pouvez encore modifier le devis.");
      return;
    }
    setWorking("save");
    setMessage("Enregistrement privé du PDF officiel…");
    try {
      const response = await fetch(`/api/estimates/${estimateId}/official-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.downloadUrl) throw new Error(result.error || "Enregistrement impossible.");
      setPreviewReady(false);
      setMessage("PDF officiel enregistré. Il remplace l’ancienne version de ce devis.");
      window.open(result.downloadUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible.");
    } finally {
      setWorking(null);
    }
  }

  const hasError = /impossible|expirée|introuvable/i.test(message);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9 }}>
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
        {working === "preview" ? "Création de l’aperçu…" : previewReady ? "Actualiser l’aperçu PDF" : "Prévisualiser le PDF officiel DAO"}
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
        <div style={{ width: 220, height: 7, overflow: "hidden", borderRadius: 99, background: "#d1d5db" }}>
          <div style={{ width: "65%", height: "100%", borderRadius: 99, background: "#16a34a", animation: "pdfProgress 1.1s ease-in-out infinite alternate" }} />
          <style>{`@keyframes pdfProgress { from { transform: translateX(-55%); } to { transform: translateX(80%); } }`}</style>
        </div>
      )}
      {message && <small role="status" style={{ flexBasis: "100%", color: hasError ? "#b91c1c" : "#166534", maxWidth: 720 }}>{message}</small>}
    </div>
  );
}
