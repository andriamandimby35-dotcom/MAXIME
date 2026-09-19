"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toFriendlyPdfError } from "@/lib/submission/friendly-pdf-error";

function isLocalDocument(url: string) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function closePdfViewer(router: ReturnType<typeof useRouter>) {
  window.close();
  // Si l'onglet n'a pas pu être fermé (ex : ouvert sans le bouton "Ouvrir le DAO"),
  // on revient simplement à la page précédente.
  window.setTimeout(() => {
    if (!window.closed) router.back();
  }, 150);
}

function PdfViewerContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const documentUrl = searchParams.get("document") || searchParams.get("url") || "";
  const requestMethod = searchParams.get("method") === "POST" ? "POST" : "GET";
  const [viewerUrl, setViewerUrl] = useState("");
  const [message, setMessage] = useState("Préparation du PDF…");
  const [loading, setLoading] = useState(Boolean(documentUrl));

  useEffect(() => {
    if (!documentUrl) {
      return;
    }

    let active = true;
    let objectUrl = "";

    async function preparePdf() {
      // Les API de l'application nécessitent la session : on les lit avec la
      // session active, puis on affiche un objet PDF local fiable dans l'iframe.
      if (!isLocalDocument(documentUrl)) {
        if (active) {
          setViewerUrl(documentUrl);
          setMessage("Zoom, impression et téléchargement sont disponibles dans le lecteur.");
          setLoading(false);
        }
        return;
      }

      try {
        const supabase = createClient();
        const { data: sessionData } = await supabase.auth.getSession();
        const response = await fetch(documentUrl, {
          method: requestMethod,
          credentials: "same-origin",
          cache: "no-store",
          headers: sessionData.session?.access_token ? {
            Authorization: `Bearer ${sessionData.session.access_token}`,
            "X-Supabase-Access-Token": sessionData.session.access_token,
          } : undefined,
        });
        const contentType = response.headers.get("content-type") || "";
        const bytes = new Uint8Array(await response.arrayBuffer());
        const signature = new TextDecoder().decode(bytes.slice(0, 5));

        if (!response.ok || !signature.startsWith("%PDF-")) {
          const detail = new TextDecoder().decode(bytes.slice(0, 400)).replace(/\s+/g, " ").trim();
          throw new Error(detail || `Le serveur a répondu avec le statut ${response.status}.`);
        }

        objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType.includes("pdf") ? contentType : "application/pdf" }));
        if (active) {
          setViewerUrl(objectUrl);
          setMessage("Zoom, impression et téléchargement sont disponibles dans le lecteur.");
          setLoading(false);
        }
      } catch (error) {
        if (active) {
          const raw = error instanceof Error ? error.message : "Le PDF n’a pas pu être préparé.";
          if (raw !== "Le PDF n’a pas pu être préparé.") console.error("Échec de préparation du PDF :", raw);
          setViewerUrl("");
          setMessage(toFriendlyPdfError(raw));
          setLoading(false);
        }
      }
    }

    void preparePdf();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentUrl, requestMethod]);

  if (!documentUrl || (!viewerUrl && !loading)) return <main className="pdfViewerError"><h1>PDF indisponible</h1><p>{message}</p><p>Revenez à l’application puis ouvrez de nouveau le document.</p><button type="button" className="ghostButton mt-3" onClick={() => closePdfViewer(router)}>Fermer</button></main>;
  if (!viewerUrl) return <main className="pdfViewerError"><h1>Préparation du PDF…</h1><p>{message}</p></main>;
  return <main className="pdfViewerPage"><header><strong>Lecteur PDF</strong><span>{message}</span><button type="button" className="pdfViewerCloseButton" onClick={() => closePdfViewer(router)}>Fermer ✕</button></header><iframe title="Lecteur PDF" src={viewerUrl} /></main>;
}

export default function PdfViewerPage() {
  return <Suspense fallback={<main className="pdfViewerError"><h1>Préparation du PDF…</h1></main>}><PdfViewerContent /></Suspense>;
}
