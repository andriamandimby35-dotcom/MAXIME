"use client";

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";

// Tous les PDF de l'application (DAO, devis, factures, dossiers de
// soumission...) s'ouvrent dans cette même carte, jamais dans un nouvel
// onglet/fenêtre : plus fiable sur mobile, et un seul bouton Imprimer qui
// n'imprime que ce document. Même principe que celui déjà utilisé dans
// SubmissionDossierManager pour les pièces du dossier de soumission.

type ViewingPdf = { title: string; objectUrl: string };

type PdfViewerContextValue = {
  openPdf: (title: string, documentUrl: string, options?: { method?: "GET" | "POST" }) => Promise<void>;
};

const PdfViewerContext = createContext<PdfViewerContextValue | null>(null);

export function usePdfViewer() {
  const context = useContext(PdfViewerContext);
  if (!context) throw new Error("usePdfViewer doit être utilisé sous PdfViewerProvider.");
  return context;
}

export function PdfViewerProvider({ children }: { children: ReactNode }) {
  const [viewingPdf, setViewingPdf] = useState<ViewingPdf | null>(null);
  const [loadingTitle, setLoadingTitle] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  function closePdf() {
    if (viewingPdf) URL.revokeObjectURL(viewingPdf.objectUrl);
    setViewingPdf(null);
    setErrorMessage("");
  }

  function printPdf() {
    try { iframeRef.current?.contentWindow?.print(); }
    catch { setErrorMessage("Impression impossible depuis cet aperçu."); }
  }

  async function openPdf(title: string, documentUrl: string, options?: { method?: "GET" | "POST" }) {
    setLoadingTitle(title);
    setErrorMessage("");
    try {
      const isLocal = (() => {
        try { return new URL(documentUrl, window.location.href).origin === window.location.origin; }
        catch { return false; }
      })();

      let blob: Blob;
      if (isLocal) {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        const response = await fetch(documentUrl, {
          method: options?.method || "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: session?.access_token ? {
            Authorization: `Bearer ${session.access_token}`,
            "X-Supabase-Access-Token": session.access_token,
            "X-PDF-Client-Fetch": "1",
          } : undefined,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const signature = new TextDecoder().decode(bytes.slice(0, 5));
        if (!response.ok || !signature.startsWith("%PDF-")) {
          const detail = new TextDecoder().decode(bytes.slice(0, 400)).replace(/\s+/g, " ").trim();
          throw new Error(detail || `Le serveur a répondu avec le statut ${response.status}.`);
        }
        blob = new Blob([bytes], { type: "application/pdf" });
      } else {
        blob = new Blob([], { type: "application/pdf" });
      }

      const objectUrl = isLocal ? URL.createObjectURL(blob) : documentUrl;
      setViewingPdf({ title, objectUrl });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Le PDF n’a pas pu être préparé.");
    } finally {
      setLoadingTitle((current) => (current === title ? null : current));
    }
  }

  const value = useMemo(() => ({ openPdf }), []);

  return (
    <PdfViewerContext.Provider value={value}>
      {children}
      {loadingTitle && !viewingPdf && (
        <div className="modalBackdrop"><div className="modal" style={{ width: "min(420px,90vw)" }}>
          <p style={{ margin: 0 }}>Préparation du PDF…</p>
          {errorMessage && <p className="notice" style={{ marginTop: "10px" }}>{errorMessage}</p>}
        </div></div>
      )}
      {!loadingTitle && errorMessage && !viewingPdf && (
        <div className="modalBackdrop" onClick={() => setErrorMessage("")}><div className="modal" style={{ width: "min(420px,90vw)" }} onClick={(event) => event.stopPropagation()}>
          <p className="notice">{errorMessage}</p>
          <button type="button" className="ghostButton" onClick={() => setErrorMessage("")}>Fermer</button>
        </div></div>
      )}
      {viewingPdf && typeof document !== "undefined" && createPortal(
        <div className="modalBackdrop" onClick={closePdf}>
          <div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(1000px,95vw)", height: "90vh", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "10px" }}>
              <h2 style={{ margin: 0, fontWeight: 800, fontSize: "1.125rem", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{viewingPdf.title}</h2>
              <div style={{ display: "flex", gap: "8px", flex: "0 0 auto" }}>
                <button type="button" className="button" onClick={printPdf}>Imprimer</button>
                <button type="button" className="ghostButton" onClick={closePdf}>Fermer</button>
              </div>
            </div>
            <iframe ref={iframeRef} title={viewingPdf.title} src={`${viewingPdf.objectUrl}#toolbar=0&navpanes=0`} style={{ flex: "1 1 auto", minHeight: 0, width: "100%", border: "1px solid #e1ece4", borderRadius: "10px" }} />
          </div>
        </div>,
        document.body,
      )}
    </PdfViewerContext.Provider>
  );
}
