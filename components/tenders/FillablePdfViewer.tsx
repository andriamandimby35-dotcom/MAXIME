"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "pdfjs-dist/legacy/web/pdf_viewer.css";

// Affiche un PDF avec de VRAIES cases à remplir cliquables, directement dans
// notre propre fenêtre (au lieu d'un onglet séparé du navigateur ou d'un
// fichier téléchargé) : la personne tape la valeur ici même, et le bouton
// Enregistrer (piloté par le parent via getFilledPdfBytes) récupère ces
// valeurs pour les renvoyer, sans aucune étape manuelle de fichier.
//
// Fonctionne pareil sur téléphone que sur ordinateur, contrairement à
// l'ancien "PDF affiché dans une iframe" : le dessin (page + cases) est fait
// par ce composant lui-même (pdf.js), pas par le mini-lecteur intégré du
// téléphone — donc pas de limite de zoom/défilement liée à ce mini-lecteur.
//
// Détail technique important (trouvé en testant réellement le code, pas
// juste en le lisant) : pdf.js a besoin qu'on lui donne nous-mêmes
// `layerProperties.annotationStorage` au moment de créer chaque PDFPageView.
// Sans ça, les cases s'affichent et semblent fonctionner, mais tout ce que
// la personne tape part dans une mémoire "orpheline" que saveDocument()
// n'utilise jamais — le PDF enregistré ressortait alors vide de tout
// changement, sans aucune erreur visible.

export type FillablePdfViewerHandle = {
  /** Octets du PDF avec les cases telles que remplies à l'instant (via
   * saveDocument() de pdf.js). Lève une erreur si rien n'est encore chargé. */
  getFilledPdfBytes: () => Promise<Uint8Array>;
};

type Props = {
  // Les octets du PDF, DÉJÀ téléchargés par le composant parent (avec
  // fetchAndValidatePdf, la même fonction qui sert déjà ailleurs dans
  // l'appli pour ouvrir un PDF sur ce même iPhone) — plutôt que de laisser
  // pdf.js aller chercher lui-même l'URL avec ses propres en-têtes
  // d'authentification. pdf.js fait alors du pur AFFICHAGE (aucun réseau
  // de son côté), ce qui évite tout un système de chargement (requêtes par
  // morceaux, en-têtes personnalisés...) plus rarement testé sur Safari/iOS
  // que le fetch() tout simple déjà utilisé et déjà fiable ailleurs.
  pdfBytes: Uint8Array;
  onReady?: () => void;
  onError?: (message: string) => void;
};

const FillablePdfViewer = forwardRef<FillablePdfViewerHandle, Props>(function FillablePdfViewer(
  { pdfBytes, onReady, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pdfDocumentRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);

    async function renderAllPages() {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { EventBus, PDFPageView, PDFLinkService } = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf-worker/pdf.worker.min.mjs";

      const eventBus = new EventBus();
      const linkService = new PDFLinkService({ eventBus });
      // linkService.isInPresentationMode lit linkService.pdfViewer.* (prévu
      // pour le lecteur complet de pdf.js, qu'on n'utilise pas ici) : sans ce
      // petit substitut, l'affichage des cases plante dès la première page.
      linkService.pdfViewer = { isInPresentationMode: false, isChangingPresentationMode: false };

      // Une COPIE des octets (slice()) : pdf.js prend possession du buffer
      // qu'on lui donne et peut le détacher/vider — si jamais ce composant
      // était réutilisé avec le même Uint8Array (React StrictMode double
      // les effets en développement), pdf.js ne doit jamais voir un buffer
      // déjà consommé par le rendu précédent.
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      const pdfDocument = await loadingTask.promise;
      if (cancelled) return;
      linkService.setDocument(pdfDocument);
      pdfDocumentRef.current = pdfDocument;

      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = "";
      const containerWidth = Math.max(280, container.clientWidth || 680);
      const fieldObjectsPromise = pdfDocument.getFieldObjects();
      const hasJSActionsPromise = pdfDocument.hasJSActions();

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
        if (cancelled) return;
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;
        const unscaledViewport = page.getViewport({ scale: 1 });
        // Limite haute à 2x pour rester net sans dessiner un canevas énorme
        // et inutilement lourd sur un vieux téléphone.
        const scale = Math.min(2, Math.max(0.4, (containerWidth - 4) / unscaledViewport.width));
        const viewport = page.getViewport({ scale });

        const pageWrapper = document.createElement("div");
        pageWrapper.style.position = "relative";
        pageWrapper.style.margin = pageNumber === 1 ? "0 auto 12px auto" : "12px auto";
        pageWrapper.style.width = `${viewport.width}px`;
        pageWrapper.style.height = `${viewport.height}px`;
        pageWrapper.style.boxShadow = "0 1px 4px rgba(0,0,0,.25)";
        container.appendChild(pageWrapper);

        const pageView = new PDFPageView({
          container: pageWrapper,
          id: pageNumber,
          scale,
          defaultViewport: viewport,
          eventBus,
          linkService,
          textLayerMode: 0,
          annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
          layerProperties: {
            annotationStorage: pdfDocument.annotationStorage,
            downloadManager: null,
            enableScripting: false,
            fieldObjectsPromise,
            findController: null,
            hasJSActionsPromise,
            linkService,
          },
        });
        pageView.setPdfPage(page);
        await pageView.draw();
      }

      if (!cancelled) {
        setLoading(false);
        onReady?.();
      }
    }

    renderAllPages().catch((error) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : "Le PDF n’a pas pu être affiché ici.";
      setErrorMessage(message);
      setLoading(false);
      onError?.(message);
    });

    return () => {
      cancelled = true;
      pdfDocumentRef.current?.destroy().catch(() => {});
      pdfDocumentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes]);

  useImperativeHandle(ref, () => ({
    async getFilledPdfBytes() {
      if (!pdfDocumentRef.current) throw new Error("Le PDF n’est pas encore chargé.");
      return await pdfDocumentRef.current.saveDocument();
    },
  }), []);

  return <div style={{ position: "relative", width: "100%", height: "100%", overflow: "auto", background: "#f3f4f6", borderRadius: "10px" }}>
    {loading && !errorMessage && <p style={{ padding: 16, margin: 0, textAlign: "center" }}>Chargement du PDF…</p>}
    {errorMessage && <p style={{ padding: 16, margin: 0, textAlign: "center", color: "#b91c1c" }}>{errorMessage}</p>}
    <div ref={containerRef} style={{ width: "100%", padding: "8px 0" }} />
  </div>;
});

export default FillablePdfViewer;
