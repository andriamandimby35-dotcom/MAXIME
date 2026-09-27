"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
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
//
// Détail technique important n°2 (trouvé en testant réellement le rendu
// dans un vrai navigateur, pas juste en relisant le code) : pdf.js calcule
// la taille et la position de CHAQUE case à partir d'une variable CSS,
// --total-scale-factor, qui n'est définie QUE pour un élément qui a la
// classe "pdfViewer" (ou un de ses descendants) — voir pdf_viewer.css,
// règle ".pdfViewer .page". Sans cette classe sur notre conteneur, cette
// variable n'existe nulle part : toutes les cases s'affichaient alors
// minuscules (quelques pixels) et empilées dans le coin en haut à gauche de
// la page, impossibles à cliquer correctement — exactement le bug rapporté
// ("les champs à remplir sont juste des carrés dans le coin"). Ajouter
// `className="pdfViewer"` sur le conteneur qui reçoit toutes les pages
// suffit à corriger ÇA POUR TOUTES LES PAGES ET TOUS LES DOCUMENTS d'un
// coup, sans rien changer d'autre.
//
// Détail technique important n°3 (rendu de plusieurs pages) : dessiner
// TOUTES les pages d'un document dès l'ouverture (chacune son propre grand
// canevas, parfois en haute résolution pour des plans) pouvait saturer la
// mémoire du téléphone sur un document à beaucoup de pages ("Liste des
// plans") : l'écran devenait tout blanc et la fenêtre se refermait toute
// seule dès qu'on faisait défiler. Chaque page réserve maintenant tout de
// suite sa place (bonne taille, pour que le défilement soit fluide dès le
// départ) mais n'est réellement DESSINÉE (canevas + cases) qu'au moment où
// elle s'approche de l'écran, grâce à IntersectionObserver — la même
// technique que le vrai lecteur PDF de pdf.js utilise pour les documents
// longs.

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

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
// Marge de préchargement : une page à moins de 900px de l'écran (au-dessus
// ou en dessous) est dessinée en avance, pour qu'on ne voie jamais de trou
// vide pendant un défilement normal.
const PRELOAD_MARGIN = "900px 0px 900px 0px";

type PdfPageProxy = import("pdfjs-dist").PDFPageProxy;
type PageViewport = ReturnType<PdfPageProxy["getViewport"]>;
type PDFPageViewCtor = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs").PDFPageView;
type PDFPageViewInstance = InstanceType<PDFPageViewCtor>;

type PageEntry = {
  pageNumber: number;
  page: PdfPageProxy;
  wrapper: HTMLDivElement;
  pageView: PDFPageViewInstance | null;
  // Échelle "ajustée à l'écran" calculée une seule fois à l'ouverture
  // (avant tout zoom manuel) : le zoom se multiplie ensuite par-dessus.
  autoFitScale: number;
};

const FillablePdfViewer = forwardRef<FillablePdfViewerHandle, Props>(function FillablePdfViewer(
  { pdfBytes, onReady, onError },
  ref,
) {
  // Conteneur qui défile (overflow:auto) — sert aussi de "root" pour
  // IntersectionObserver, pour que la détection "page proche de l'écran"
  // se base sur CE cadre de défilement, pas sur toute la fenêtre du
  // téléphone.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Conteneur direct des pages (classe "pdfViewer", voir commentaire en
  // haut du fichier) : chaque page y est ajoutée comme enfant.
  const pagesContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfDocumentRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  // destroy() n'existe QUE sur la tâche de chargement (loadingTask), jamais
  // sur le document résolu (PDFDocumentProxy) — vérifié directement dans le
  // code source de pdf.js, pas seulement dans ses types. L'ancien code
  // appelait pdfDocumentRef.current.destroy(), une méthode qui n'a jamais
  // existé : ça levait une erreur synchrone à chaque nettoyage (fermeture de
  // la fenêtre, changement de document, double-montage de React en
  // développement), AVANT même d'atteindre le .catch() censé l'avaler.
  const loadingTaskRef = useRef<import("pdfjs-dist").PDFDocumentLoadingTask | null>(null);
  const pagesRef = useRef<PageEntry[]>([]);
  const zoomRef = useRef(1);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [zoomDisplay, setZoomDisplay] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    zoomRef.current = 1;
    setZoomDisplay(1);

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
      loadingTaskRef.current = loadingTask;
      const pdfDocument = await loadingTask.promise;
      if (cancelled) return;
      linkService.setDocument(pdfDocument);
      pdfDocumentRef.current = pdfDocument;

      const pagesContainer = pagesContainerRef.current;
      const scrollContainer = scrollContainerRef.current;
      if (!pagesContainer || !scrollContainer) return;
      pagesContainer.innerHTML = "";
      const containerWidth = Math.max(280, pagesContainer.clientWidth || 680);
      const fieldObjectsPromise = pdfDocument.getFieldObjects();
      const hasJSActionsPromise = pdfDocument.hasJSActions();

      async function drawEntry(entry: PageEntry) {
        if (cancelled) return;
        const scale = entry.autoFitScale * zoomRef.current;
        const viewport = entry.page.getViewport({ scale });
        entry.wrapper.style.width = `${viewport.width}px`;
        entry.wrapper.style.height = `${viewport.height}px`;
        if (entry.pageView) {
          // Le zoom a changé : on redessine la page déjà affichée à la
          // nouvelle taille au lieu d'en recréer une — les valeurs déjà
          // tapées ne sont pas perdues, elles vivent dans
          // pdfDocument.annotationStorage, pas dans la page elle-même.
          entry.pageView.update({ scale });
          await entry.pageView.draw();
          return;
        }
        const pageViewOptions = {
          container: entry.wrapper,
          id: entry.pageNumber,
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
        };
        // Cast nécessaire : les types fournis par pdfjs-dist pour
        // PDFPageViewOptions ne déclarent pas `linkService` au niveau
        // supérieur (seulement dans layerProperties), alors que
        // l'implémentation réelle de pdf.js le lit bien à cet endroit aussi
        // (vérifié en lisant son code source, et confirmé par nos propres
        // tests réels en navigateur) — un simple oubli dans ses déclarations
        // de types, pas une vraie erreur de notre code. On garde la valeur
        // telle quelle plutôt que de la retirer, pour ne rien changer au
        // comportement déjà testé et fonctionnel.
        const pageView = new PDFPageView(pageViewOptions as ConstructorParameters<typeof PDFPageView>[0]);
        entry.pageView = pageView;
        pageView.setPdfPage(entry.page);
        await pageView.draw();
      }

      const entries: PageEntry[] = [];
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
        if (cancelled) return;
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;
        const unscaledViewport = page.getViewport({ scale: 1 });
        // Limite haute à 2x pour rester net sans dessiner un canevas énorme
        // et inutilement lourd sur un vieux téléphone (le zoom manuel peut
        // ensuite dépasser cette limite s'il le faut, volontairement).
        const autoFitScale = Math.min(2, Math.max(0.4, (containerWidth - 4) / unscaledViewport.width));
        const viewport = page.getViewport({ scale: autoFitScale });

        const pageWrapper = document.createElement("div");
        pageWrapper.style.position = "relative";
        pageWrapper.style.margin = pageNumber === 1 ? "0 auto 12px auto" : "12px auto";
        pageWrapper.style.width = `${viewport.width}px`;
        pageWrapper.style.height = `${viewport.height}px`;
        pageWrapper.style.background = "#fff";
        pageWrapper.style.boxShadow = "0 1px 4px rgba(0,0,0,.25)";
        pagesContainer.appendChild(pageWrapper);

        entries.push({ pageNumber, page, wrapper: pageWrapper, pageView: null, autoFitScale });
      }
      if (cancelled) return;
      pagesRef.current = entries;

      // On dessine réellement une page seulement quand elle s'approche de
      // l'écran (voir PRELOAD_MARGIN plus haut) — jamais toutes d'un coup.
      const observer = new IntersectionObserver((observedEntries) => {
        for (const observed of observedEntries) {
          if (!observed.isIntersecting) continue;
          const entry = entries.find((candidate) => candidate.wrapper === observed.target);
          if (entry && !entry.pageView) drawEntry(entry).catch(() => {});
        }
      }, { root: scrollContainer, rootMargin: PRELOAD_MARGIN });
      observerRef.current = observer;
      entries.forEach((entry) => observer.observe(entry.wrapper));

      // La toute première page doit être visible tout de suite (avant même
      // que le navigateur ait eu le temps de déclencher l'observateur), pour
      // que l'ouverture du document ne montre jamais un cadre vide.
      if (entries[0]) await drawEntry(entries[0]);

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
      observerRef.current?.disconnect();
      observerRef.current = null;
      pagesRef.current = [];
      // loadingTask.destroy() (jamais pdfDocument.destroy(), qui n'existe pas
      // — voir le commentaire sur loadingTaskRef plus haut) libère aussi le
      // pdfDocument résolu qu'il a produit.
      loadingTaskRef.current?.destroy().catch(() => {});
      loadingTaskRef.current = null;
      pdfDocumentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes]);

  // Zoom manuel (boutons − / + / réinitialiser) : jusqu'ici, aucun mécanisme
  // de zoom n'existait dans ce lecteur (contrairement à l'ancien affichage
  // en iframe, où le mini-lecteur du téléphone gérait le pincement-zoom
  // lui-même) — d'où "le zoom ne marche nulle part". Change l'échelle de
  // TOUTES les pages (dessinées ou pas encore) : celles déjà affichées sont
  // redessinées tout de suite à la nouvelle taille, les autres seront
  // simplement dessinées à cette taille-là quand elles apparaîtront.
  function applyZoom(next: number) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next * 100) / 100));
    if (clamped === zoomRef.current) return;
    zoomRef.current = clamped;
    setZoomDisplay(clamped);
    pagesRef.current.forEach((entry) => {
      const scale = entry.autoFitScale * clamped;
      const viewport = entry.page.getViewport({ scale });
      entry.wrapper.style.width = `${viewport.width}px`;
      entry.wrapper.style.height = `${viewport.height}px`;
      if (entry.pageView) {
        entry.pageView.update({ scale });
        entry.pageView.draw().catch(() => {});
      }
    });
  }

  useImperativeHandle(ref, () => ({
    async getFilledPdfBytes() {
      if (!pdfDocumentRef.current) throw new Error("Le PDF n’est pas encore chargé.");
      return await pdfDocumentRef.current.saveDocument();
    },
  }), []);

  return <div style={{ position: "relative", width: "100%", height: "100%" }}>
    <div
      ref={scrollContainerRef}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "auto", background: "#f3f4f6", borderRadius: "10px" }}
    >
      {loading && !errorMessage && <p style={{ padding: 16, margin: 0, textAlign: "center" }}>Chargement du PDF…</p>}
      {errorMessage && <p style={{ padding: 16, margin: 0, textAlign: "center", color: "#b91c1c" }}>{errorMessage}</p>}
      {/* La classe "pdfViewer" est INDISPENSABLE : voir le commentaire n°2
          en haut du fichier — sans elle, pdf.js ne sait pas où placer les
          cases à remplir. */}
      <div ref={pagesContainerRef} className="pdfViewer" style={{ width: "100%", padding: "8px 0", position: "relative" }} />
    </div>
    {!loading && !errorMessage && (
      <div style={zoomToolbarStyle}>
        <button type="button" onClick={() => applyZoom(zoomRef.current - ZOOM_STEP)} style={zoomButtonStyle} aria-label="Zoom arrière">
          −
        </button>
        <span style={{ alignSelf: "center", fontSize: 13, minWidth: 42, textAlign: "center", color: "#111" }}>
          {Math.round(zoomDisplay * 100)}%
        </span>
        <button type="button" onClick={() => applyZoom(zoomRef.current + ZOOM_STEP)} style={zoomButtonStyle} aria-label="Zoom avant">
          +
        </button>
        <button type="button" onClick={() => applyZoom(1)} style={{ ...zoomButtonStyle, fontSize: 12 }} aria-label="Taille normale">
          100%
        </button>
      </div>
    )}
  </div>;
});

const zoomToolbarStyle: CSSProperties = {
  position: "absolute",
  bottom: 12,
  right: 12,
  display: "flex",
  gap: 6,
  background: "rgba(255,255,255,.96)",
  borderRadius: 8,
  padding: 6,
  boxShadow: "0 1px 6px rgba(0,0,0,.3)",
  zIndex: 5,
};

const zoomButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  border: "1px solid #d1d5db",
  background: "#fff",
  color: "#111",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
};

export default FillablePdfViewer;
