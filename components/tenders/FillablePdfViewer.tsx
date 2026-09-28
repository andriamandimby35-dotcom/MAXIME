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
//
// Détail technique important n°4 (mode "Ajuster", déplacer/redimensionner/
// changer la police d'une case, et ajouter une case oubliée) : pdf.js
// positionne chaque case avec un pourcentage (left/top/width/height en %,
// relatif à la page) — ce qui tombe bien, car ça permet de suivre le zoom
// automatiquement sans aucun calcul supplémentaire. On déplace/redimensionne
// donc directement ces pourcentages à la souris/au doigt, et on retient
// chaque changement dans fieldOverridesRef (indépendant du zoom). Attention
// : pdf.js RECONSTRUIT entièrement la case (nouvel élément DOM) à chaque
// redessin (changement de zoom) — nos changements doivent donc être
// réappliqués après CHAQUE dessin, pas seulement au premier (voir afterDraw).
// Autre point vérifié par un vrai test (avant de construire cette
// fonctionnalité) : pdf.js lui-même ne sait PAS enregistrer une case
// déplacée dans le PDF (saveDocument() ignore silencieusement un "rect"
// modifié dans annotationStorage — testé, confirmé) : la position/taille/
// police finales sont donc réappliquées nous-mêmes avec pdf-lib (déjà
// utilisé côté serveur dans ce projet) juste avant de renvoyer les octets
// finaux, par-dessus ce que saveDocument() a déjà rempli comme valeurs.
// Une case "ajoutée" (bouton "+ Ajouter une case", pour un endroit oublié
// par le repérage automatique) n'existe que dans le navigateur pendant la
// modification (un simple <input> par-dessus la page, pas une vraie case
// pdf.js) : elle ne devient une vraie case du PDF qu'au moment d'Enregistrer,
// avec form.createTextField() (même méthode que dao-template-pdf.ts).

export type FillablePdfViewerHandle = {
  /** Octets du PDF avec les cases telles que remplies, déplacées,
   * redimensionnées et ajoutées à l'instant. Lève une erreur si rien n'est
   * encore chargé. */
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
  // true quand pdfBytes vient d'une version DÉJÀ remplie et enregistrée par
  // la personne (voir __filledPdfPath côté SubmissionDossierManager),
  // jamais du modèle vierge. Dans ce cas, la case démarre avec sa VRAIE
  // taille/couleur/gras déjà enregistrés (on les relit sur la case telle
  // que pdf.js vient de la dessiner), au lieu du réglage par défaut (11pt,
  // Times, noir, normal) qui ne convient qu'à une case jamais encore
  // personnalisée — sinon rouvrir un document déjà rempli et juste TOUCHER
  // une case (même sans rien changer) réécrivait sa taille/couleur d'origine
  // avec les valeurs par défaut au prochain Enregistrer.
  restoreSavedStyle?: boolean;
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
const MIN_FONT_SIZE_PT = 6;
const MAX_FONT_SIZE_PT = 24;
const FONT_SIZE_STEP_PT = 1;

// Les styles de police proposés, de 2 sortes différentes :
// - kind "embed" : une VRAIE police (fichier .ttf dans public/fonts/),
//   embarquée telle quelle dans le PDF final — rendu identique partout
//   (téléphone, ordinateur, n'importe quel lecteur PDF), pas de surprise.
//   "times" = une vraie police "façon Times New Roman" (Liberation Serif,
//   gratuite et prévue exactement pour remplacer Times New Roman à
//   l'identique, même mesures) : Microsoft ne permet pas de redistribuer sa
//   propre police Times New Roman dans un site web, donc on utilise ce
//   remplaçant, visuellement indiscernable. C'est le choix PAR DÉFAUT
//   (voir plus bas) car la plupart des DAO (documents administratifs
//   exportés depuis Word) utilisent ce style pour leur texte — confirmé par
//   une vraie capture d'écran envoyée : le texte du "modèle" autour des
//   cases est à empattements (Times), pas la police "document" ci-dessous.
//   "document" = la police que CE PROJET dessine lui-même pour reconstruire
//   certaines zones d'un DAO (DejaVu Sans — voir lib/submission/
//   pdf-font.ts) : utile seulement quand la case tombe exactement sur une
//   zone déjà redessinée par l'appli, pas pour le texte d'origine du DAO
//   (Word) qui l'entoure la plupart du temps.
// - kind "standard" : une police "standard PDF" (Helvetica, Courier) NON
//   embarquée par pdf-lib — c'est le LECTEUR PDF de la personne qui choisit
//   quoi afficher à sa place, ce qui peut donc varier légèrement d'un
//   appareil à l'autre (c'est justement ce qui causait "les polices ne sont
//   pas les mêmes").
// Sans un choix "embed" par défaut, un simple déplacement/redimensionnement
// d'une case déjà présente sur le modèle (donc SANS toucher au style)
// suffisait à lui faire perdre discrètement sa vraie police une fois le PDF
// enregistré : pdf-lib retombe sur Helvetica dès qu'une case est retouchée
// (voir PDFForm.embedDefaultFont dans pdf-lib — non configurable).
// `cssFamily` sert seulement à l'aperçu à l'écran (dans le navigateur).
type FontFamilyKey = "times" | "document" | "helvetica" | "courier";
const FONT_FAMILIES: Record<FontFamilyKey, {
  label: string;
  cssFamily: string;
} & (
  | { kind: "embed"; regularUrl: string; boldUrl: string }
  | { kind: "standard"; pdf: string; pdfBold: string }
)> = {
  times: {
    label: "Times New Roman", cssFamily: "'Times New Roman', 'Liberation Serif', Times, serif",
    kind: "embed", regularUrl: "/fonts/LiberationSerif-Regular.ttf", boldUrl: "/fonts/LiberationSerif-Bold.ttf",
  },
  document: {
    label: "Police de l'appli (DejaVu Sans)", cssFamily: "'DejaVu Sans', Verdana, sans-serif",
    kind: "embed", regularUrl: "/fonts/DejaVuSans.ttf", boldUrl: "/fonts/DejaVuSans-Bold.ttf",
  },
  helvetica: {
    label: "Standard", cssFamily: "Helvetica, Arial, sans-serif",
    kind: "standard", pdf: "Helvetica", pdfBold: "HelveticaBold",
  },
  courier: {
    label: "Machine à écrire", cssFamily: "'Courier New', Courier, monospace",
    kind: "standard", pdf: "Courier", pdfBold: "CourierBold",
  },
};

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
  // Taille de police et couleur VRAIMENT enregistrées dans le PDF pour
  // chaque case de cette page (lues une seule fois via page.getAnnotations(),
  // voir le commentaire détaillé plus bas près de son remplissage) — null
  // tant que restoreSavedStyle est faux (rien à restaurer). Sert de source
  // fiable à ensureOverride, indépendante de la hauteur de la case (voir
  // commentaire n°4bis).
  savedFieldStyles: Map<string, { fontSizePt: number; color: string | null }> | null;
};

// Position/taille (en % de la page, comme pdf.js lui-même — voir le
// commentaire n°4) et taille de police (en points PDF, indépendante du
// zoom) d'une case, une fois que la personne l'a déplacée/redimensionnée/
// changé sa police au moins une fois. Sert aussi bien pour une case déjà
// présente sur le modèle que pour une case ajoutée à la main.
type FieldOverride = {
  pageNumber: number;
  leftPercent: number;
  topPercent: number;
  widthPercent: number;
  heightPercent: number;
  fontSizePt: number;
  bold: boolean;
  fontFamily: FontFamilyKey;
  // Couleur du texte en hexadécimal ("#rrggbb"), le format que comprend
  // directement <input type="color">.
  color: string;
};

const FillablePdfViewer = forwardRef<FillablePdfViewerHandle, Props>(function FillablePdfViewer(
  { pdfBytes, restoreSavedStyle, onReady, onError },
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
  // Dernière largeur de conteneur utilisée pour calculer autoFitScale (voir
  // resizeObserverRef plus bas) — sert à ne recalculer/redessiner QUE quand
  // cette largeur a vraiment changé, jamais à chaque minuscule variation.
  const lastContainerWidthRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [zoomDisplay, setZoomDisplay] = useState(1);

  // Mode "Ajuster" (déplacer/redimensionner/police) et mode "Ajouter une
  // case" — des refs (lues dans des gestionnaires DOM directs, hors du cycle
  // React) doublées d'un state (pour redessiner la barre d'outils).
  const editModeRef = useRef(false);
  const [editModeOn, setEditModeOn] = useState(false);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  // Juste pour AFFICHER dans la barre d'outils la police/taille/couleur
  // actuelle de la case sélectionnée (fieldOverridesRef, lui, reste la seule
  // source de vérité utilisée pour l'enregistrement) — séparé du zoom : le
  // zoom (zoomDisplay) ne change jamais ces valeurs, seulement l'affichage à
  // l'écran, exactement ce qui manquait pour que ce soit clair.
  const [selectedFontSizePt, setSelectedFontSizePt] = useState(11);
  const [selectedBold, setSelectedBold] = useState(false);
  const [selectedColor, setSelectedColor] = useState("#000000");
  const [selectedFontFamily, setSelectedFontFamily] = useState<FontFamilyKey>("times");
  // Quand le clavier du téléphone est ouvert (pour taper dans une case),
  // Safari iOS réduit la zone visible SANS redimensionner la fenêtre : notre
  // barre d'outils "Ajuster"/"+ Ajouter une case", positionnée en bas de la
  // fenêtre entière, se retrouvait alors cachée DERRIÈRE le clavier —
  // invisible et impossible à toucher tant que le clavier restait ouvert.
  // window.visualViewport donne la vraie zone visible ; on décale la barre
  // d'autant que le clavier prend de place.
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    function update() {
      const vv = window.visualViewport;
      if (!vv) return;
      const inset = window.innerHeight - vv.height - vv.offsetTop;
      setKeyboardInsetPx(Math.max(0, Math.round(inset)));
    }
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  const fieldOverridesRef = useRef<Map<string, FieldOverride>>(new Map());
  // Cases ajoutées à la main : elles n'existent que dans le navigateur (pas
  // encore de vraie case pdf.js/PDF) tant qu'on n'a pas Enregistré.
  const customFieldNamesRef = useRef<Set<string>>(new Set());
  const customFieldValuesRef = useRef<Map<string, string>>(new Map());
  const customFieldCounterRef = useRef(0);
  // BUG corrigé (signalé par Maxime : une case tout juste ajoutée "bute"
  // contre une case déjà présente plus bas et ne peut pas être déplacée
  // au-delà — comme si cette case déjà là faisait office de mur) : ce n'est
  // pas un vrai blocage de déplacement (le code de glisser-déposer plus bas
  // ne limite le mouvement qu'aux bords de la PAGE, jamais par rapport aux
  // autres cases), mais un problème d'EMPILEMENT visuel — une case native du
  // PDF garde un z-index "auto" et une case ajoutée gardait toujours le même
  // z-index fixe (2), donc dès qu'une case en croisait une autre déjà
  // présente au même niveau d'empilement, l'ordre d'affichage final pouvait
  // la laisser cachée derrière : invisible et donc impossible à re-sélectionner
  // ou à continuer de déplacer une fois passée "derrière", ce qui donnait
  // l'impression d'un mur infranchissable. Solution générale (s'applique à
  // TOUTE case, native ou ajoutée, sur N'IMPORTE QUEL PDF de l'application,
  // pas seulement celle qui a révélé le problème) : la case que l'utilisateur
  // est en train de toucher (déplacer, redimensionner, ou tout juste créer)
  // reçoit systématiquement le z-index le plus élevé du moment, via ce
  // compteur commun toujours croissant — elle passe donc TOUJOURS au premier
  // plan dès qu'on la manipule et ne peut plus jamais se retrouver bloquée
  // visuellement derrière une autre case.
  const topFieldZIndexRef = useRef(100);
  function bringFieldToFront(section: HTMLElement) {
    topFieldZIndexRef.current += 1;
    section.style.zIndex = String(topFieldZIndexRef.current);
  }

  // --- Applique/retient la position, taille et police d'une case --------

  function ensureOverride(entry: PageEntry, section: HTMLElement, input: HTMLInputElement, fieldName: string): FieldOverride {
    const existing = fieldOverridesRef.current.get(fieldName);
    if (existing) return existing;
    // Une case qui vient d'une version DÉJÀ remplie et enregistrée doit
    // repartir de ce qui a VRAIMENT été enregistré (taille, gras, couleur),
    // pas d'un réglage par défaut — sinon simplement toucher une case après
    // réouverture, sans rien changer, remplaçait discrètement sa taille/
    // couleur d'origine par 11pt/noir/normal au prochain Enregistrer. Une
    // case jamais encore personnalisée (modèle vierge, ou nouvelle case
    // ajoutée à la main) n'a rien à "restaurer" : elle garde le réglage par
    // défaut demandé par Maxime (11pt, Times, noir, normal).
    //
    // La taille de police et la couleur viennent de savedFieldStyles (lu
    // depuis page.getAnnotations(), la VRAIE valeur du PDF) et non plus du
    // DOM (input.style.fontSize/.color) — voir le commentaire n°4bis plus
    // haut : le DOM peut afficher une taille RÉTRÉCIE par pdf.js si la case
    // est plus petite que la police, alors que savedFieldStyles garde la
    // valeur exacte enregistrée, quelle que soit la taille de la case.
    const savedStyle = restoreSavedStyle ? entry.savedFieldStyles?.get(fieldName) : undefined;
    const created: FieldOverride = {
      pageNumber: entry.pageNumber,
      leftPercent: parseFloat(section.style.left) || 0,
      topPercent: parseFloat(section.style.top) || 0,
      widthPercent: parseFloat(section.style.width) || 20,
      heightPercent: parseFloat(section.style.height) || 3,
      fontSizePt: savedStyle?.fontSizePt ?? 11,
      bold: restoreSavedStyle ? input.style.fontWeight === "bold" || input.style.fontWeight === "700" : false,
      // La police exacte (Times/DejaVu/Machine à écrire...) n'est pas
      // relisible de façon fiable depuis le rendu pdf.js (elle mappe le nom
      // de police du PDF vers sa propre police d'écran, pas vers une de nos
      // 4 options) : elle reste "times" par défaut même en restauration —
      // seul le VISUEL affiché reste fidèle (vraie police déjà incrustée
      // dans le PDF), un futur changement de taille/couleur réappliquera
      // alors Times si la police d'origine était différente.
      fontFamily: "times",
      color: savedStyle?.color ?? "#000000",
    };
    fieldOverridesRef.current.set(fieldName, created);
    return created;
  }

  // Cherche la case (entrée de page + <section> + <input>) qui correspond à
  // un nom de case donné, parmi les pages déjà dessinées — sert pour tout ce
  // qui agit sur "la case actuellement sélectionnée" (police, gras, couleur,
  // suppression).
  function findFieldElements(fieldName: string): { entry: PageEntry; section: HTMLElement; input: HTMLInputElement } | null {
    for (const entry of pagesRef.current) {
      const input = entry.wrapper.querySelector<HTMLInputElement>(`input[name="${CSS.escape(fieldName)}"]`);
      const section = input?.closest<HTMLElement>(".textWidgetAnnotation");
      if (input && section) return { entry, section, input };
    }
    return null;
  }

  // Affiche dans la barre d'outils la police/taille/couleur RÉELLE de la
  // case qu'on vient de sélectionner (pas des valeurs par défaut figées).
  function refreshSelectedDisplay(fieldName: string) {
    const found = findFieldElements(fieldName);
    if (!found) return;
    const override = ensureOverride(found.entry, found.section, found.input, fieldName);
    // Réapplique aussi le VISUEL (pas seulement les valeurs affichées dans
    // la barre d'outils) : sans ça, une case pas encore touchée cette
    // session (donc pas encore repassée par applyOverride dans afterDraw)
    // pouvait afficher "11" dans les réglages tout en restant à sa taille
    // d'origine à l'écran tant qu'on n'y touchait pas pour de vrai — l'écran
    // et les réglages désaccordés l'un de l'autre.
    applyOverride(found.section, found.input, override);
    setSelectedFontSizePt(override.fontSizePt);
    setSelectedBold(override.bold);
    setSelectedColor(override.color);
    setSelectedFontFamily(override.fontFamily);
  }

  // Empêche Safari/iOS de proposer sa propre suggestion "Préremplir le
  // contact" (nom, société, adresse, tél...) au-dessus du clavier pour ces
  // cases : ce n'est pas notre code qui l'affiche (rien dans ce composant ne
  // le déclenche), c'est une fonctionnalité automatique du navigateur basée
  // sur le nom/type de la case — autocomplete="off" est la façon officielle
  // de la désactiver, sans toucher au nom de la case (dont on a besoin par
  // ailleurs pour la retrouver).
  function disableAutofillHeuristics(input: HTMLInputElement) {
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
  }

  function applyOverride(section: HTMLElement, input: HTMLInputElement, override: FieldOverride) {
    section.style.left = `${override.leftPercent}%`;
    section.style.top = `${override.topPercent}%`;
    section.style.width = `${override.widthPercent}%`;
    section.style.height = `${override.heightPercent}%`;
    input.style.fontSize = `calc(${override.fontSizePt}px * var(--total-scale-factor))`;
    input.style.fontWeight = override.bold ? "bold" : "normal";
    input.style.color = override.color;
    input.style.fontFamily = FONT_FAMILIES[override.fontFamily].cssFamily;
  }

  function applyEditVisual(section: HTMLElement, input: HTMLInputElement, handle: HTMLElement | null, on: boolean) {
    section.style.outline = on ? "1px dashed #2563eb" : "";
    section.style.cursor = on ? "move" : "";
    input.style.pointerEvents = on ? "none" : "";
    // touch-action: "none" est INDISPENSABLE sur téléphone : sans ça, Safari
    // iOS interprète un glisser du doigt sur la case comme un geste de
    // défilement de la page (elle scrolle au lieu de bouger la case, et le
    // geste de glissement est parfois carrément annulé en cours de route) —
    // trouvé en cherchant pourquoi "pas de déplacement" pouvait arriver même
    // avec des gestionnaires pointerdown/pointermove tout à fait corrects.
    section.style.touchAction = on ? "none" : "";
    if (handle) {
      handle.style.pointerEvents = on ? "auto" : "none";
      handle.style.display = on ? "block" : "none";
      handle.style.touchAction = "none";
    }
  }

  // Ajoute (une seule fois par élément — un nouvel élément est créé par
  // pdf.js à chaque redessin, voir le commentaire n°4) la poignée de
  // redimensionnement et les gestionnaires de glisser/déposer.
  function attachFieldEditing(entry: PageEntry, section: HTMLElement, input: HTMLInputElement, fieldName: string) {
    let handle = section.querySelector<HTMLDivElement>(".field-resize-handle");
    if (!handle) {
      handle = document.createElement("div");
      handle.className = "field-resize-handle";
      handle.style.position = "absolute";
      handle.style.right = "-7px";
      handle.style.bottom = "-7px";
      handle.style.width = "16px";
      handle.style.height = "16px";
      handle.style.background = "#2563eb";
      handle.style.border = "2px solid #fff";
      handle.style.borderRadius = "3px";
      handle.style.cursor = "nwse-resize";
      handle.style.zIndex = "10";
      section.appendChild(handle);
    }
    applyEditVisual(section, input, handle, editModeRef.current);

    type DragState = {
      mode: "move" | "resize";
      pointerId: number;
      startX: number;
      startY: number;
      startLeft: number;
      startTop: number;
      startWidth: number;
      startHeight: number;
      moved: boolean;
    };
    let dragState: DragState | null = null;

    function begin(e: PointerEvent, mode: "move" | "resize") {
      if (!editModeRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      // Passe cette case au premier plan DÈS qu'on commence à la toucher —
      // voir le commentaire sur topFieldZIndexRef plus haut : sans ça, une
      // case pouvait rester cachée derrière une autre dès qu'on la déplaçait
      // à son niveau.
      bringFieldToFront(section);
      const wrapperRect = entry.wrapper.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      dragState = {
        mode,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: sectionRect.left - wrapperRect.left,
        startTop: sectionRect.top - wrapperRect.top,
        startWidth: sectionRect.width,
        startHeight: sectionRect.height,
        moved: false,
      };
      (mode === "move" ? section : handle!).setPointerCapture(e.pointerId);
    }

    function move(e: PointerEvent) {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
      const wrapperRect = entry.wrapper.getBoundingClientRect();
      if (dragState.mode === "move") {
        const newLeft = Math.max(0, Math.min(wrapperRect.width - dragState.startWidth, dragState.startLeft + dx));
        const newTop = Math.max(0, Math.min(wrapperRect.height - dragState.startHeight, dragState.startTop + dy));
        section.style.left = `${(newLeft / wrapperRect.width) * 100}%`;
        section.style.top = `${(newTop / wrapperRect.height) * 100}%`;
      } else {
        const newWidth = Math.max(24, dragState.startWidth + dx);
        const newHeight = Math.max(14, dragState.startHeight + dy);
        section.style.width = `${(newWidth / wrapperRect.width) * 100}%`;
        section.style.height = `${(newHeight / wrapperRect.height) * 100}%`;
      }
    }

    function end(e: PointerEvent) {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      const wasMoved = dragState.moved;
      dragState = null;
      const override = ensureOverride(entry, section, input, fieldName);
      override.leftPercent = parseFloat(section.style.left) || override.leftPercent;
      override.topPercent = parseFloat(section.style.top) || override.topPercent;
      override.widthPercent = parseFloat(section.style.width) || override.widthPercent;
      override.heightPercent = parseFloat(section.style.height) || override.heightPercent;
      if (!wasMoved) {
        setSelectedField(fieldName);
        refreshSelectedDisplay(fieldName);
      }
    }

    section.onpointerdown = (e) => begin(e, "move");
    section.onpointermove = move;
    section.onpointerup = end;
    section.onpointercancel = end;
    handle.onpointerdown = (e) => begin(e, "resize");
    handle.onpointermove = move;
    handle.onpointerup = end;
    handle.onpointercancel = end;
  }

  // Réapplique les cases déjà déplacées/redimensionnées/changées de police,
  // et (ré)installe les gestionnaires de glisser/déposer — à appeler après
  // CHAQUE dessin d'une page (premier dessin, ou redessin dû au zoom).
  function afterDraw(entry: PageEntry) {
    const sections = entry.wrapper.querySelectorAll<HTMLElement>(".textWidgetAnnotation");
    sections.forEach((section) => {
      const input = section.querySelector<HTMLInputElement>("input, textarea");
      if (!input || !input.name) return;
      const fieldName = input.name;
      disableAutofillHeuristics(input);
      // ensureOverride (pas seulement une lecture du Map) : sinon une case
      // JAMAIS encore touchée par l'utilisateur restait affichée avec le
      // rendu natif de pdf.js (police par défaut du PDF, ou taille rétrécie
      // par pdf.js si la case est petite — voir le commentaire n°4bis) tant
      // que personne n'avait cliqué dessus au moins une fois. Maxime devait
      // alors passer en mode "Ajuster" et toucher chaque case pour forcer
      // l'affichage correct (11pt par défaut, ou la vraie taille/couleur
      // enregistrée) — ça doit être automatique dès l'ouverture, sans aucun
      // clic.
      const override = ensureOverride(entry, section, input, fieldName);
      applyOverride(section, input, override);
      attachFieldEditing(entry, section, input, fieldName);
    });
  }

  // Crée une nouvelle case (bouton "+ Ajouter une case") à l'endroit touché
  // — un simple <input> par-dessus la page tant que ce n'est pas enregistré
  // (voir le commentaire n°4 en haut du fichier).
  function createCustomField(entry: PageEntry, leftPercent: number, topPercent: number) {
    customFieldCounterRef.current += 1;
    const fieldName = `custom_field_${customFieldCounterRef.current}`;
    const widthPercent = 30;
    const heightPercent = 3;
    const fontSizePt = 11;

    const section = document.createElement("section");
    section.className = "textWidgetAnnotation customField";
    section.style.position = "absolute";
    section.style.left = `${leftPercent}%`;
    section.style.top = `${topPercent}%`;
    section.style.width = `${widthPercent}%`;
    section.style.height = `${heightPercent}%`;
    bringFieldToFront(section);

    const input = document.createElement("input");
    input.type = "text";
    input.name = fieldName;
    input.style.width = "100%";
    input.style.height = "100%";
    input.style.boxSizing = "border-box";
    input.style.border = "1px solid #2563eb";
    input.style.background = "#fff";
    input.style.padding = "0 2px";
    input.style.fontSize = `calc(${fontSizePt}px * var(--total-scale-factor))`;
    disableAutofillHeuristics(input);
    input.addEventListener("input", () => {
      customFieldValuesRef.current.set(fieldName, input.value);
    });
    section.appendChild(input);
    entry.wrapper.appendChild(section);

    fieldOverridesRef.current.set(fieldName, {
      pageNumber: entry.pageNumber, leftPercent, topPercent, widthPercent, heightPercent, fontSizePt,
      bold: false, color: "#000000", fontFamily: "times",
    });
    customFieldNamesRef.current.add(fieldName);
    attachFieldEditing(entry, section, input, fieldName);
    applyEditVisual(section, input, section.querySelector<HTMLElement>(".field-resize-handle"), editModeRef.current);
    setSelectedField(fieldName);
    refreshSelectedDisplay(fieldName);
  }

  // Bouton "+ Ajouter une case" : ajoute la case TOUT DE SUITE (avant, il
  // fallait d'abord toucher la page pour choisir l'endroit — source de
  // confusion : "je clique et ça n'ajoute pas de case", car le clic sur le
  // bouton lui-même ne comptait jamais comme le "clic sur la page"). On la
  // fait apparaître au milieu de ce qui est actuellement visible à l'écran
  // (sur la page la plus visible), puis on la déplace ensuite au bon endroit
  // avec le doigt — déjà possible depuis le dernier correctif.
  function addFieldNow() {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || pagesRef.current.length === 0) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const viewportCenterY = containerRect.top + containerRect.height / 2;

    let targetEntry: PageEntry | null = null;
    let bestDistance = Infinity;
    for (const entry of pagesRef.current) {
      const rect = entry.wrapper.getBoundingClientRect();
      if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenterY);
      if (distance < bestDistance) {
        bestDistance = distance;
        targetEntry = entry;
      }
    }
    if (!targetEntry) targetEntry = pagesRef.current[0];

    const rect = targetEntry.wrapper.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, containerRect.top);
    const visibleBottom = Math.min(rect.bottom, containerRect.bottom);
    const targetY = (visibleTop + visibleBottom) / 2;
    const topPercent = Math.max(2, Math.min(90, ((targetY - rect.top) / rect.height) * 100));
    createCustomField(targetEntry, 35, topPercent);
  }

  function removeSelectedCustomField() {
    if (!selectedField || !customFieldNamesRef.current.has(selectedField)) return;
    for (const entry of pagesRef.current) {
      const input = entry.wrapper.querySelector<HTMLInputElement>(`input[name="${CSS.escape(selectedField)}"]`);
      input?.closest(".customField")?.remove();
    }
    fieldOverridesRef.current.delete(selectedField);
    customFieldNamesRef.current.delete(selectedField);
    customFieldValuesRef.current.delete(selectedField);
    setSelectedField(null);
  }

  function toggleEditMode() {
    const next = !editModeRef.current;
    editModeRef.current = next;
    setEditModeOn(next);
    if (!next) {
      setSelectedField(null);
    }
    const container = pagesContainerRef.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>(".textWidgetAnnotation").forEach((section) => {
      const input = section.querySelector<HTMLInputElement>("input, textarea");
      const handle = section.querySelector<HTMLElement>(".field-resize-handle");
      if (input) applyEditVisual(section, input, handle, next);
    });
  }

  // Taille de police, gras, couleur : trois réglages SÉPARÉS du zoom (le
  // zoom — zoomDisplay/zoomRef — ne change QUE l'affichage à l'écran, jamais
  // ces valeurs, qui sont en points PDF réels et s'appliquent pareil quel
  // que soit le zoom).
  function adjustSelectedFontSize(deltaPt: number) {
    if (!selectedField) return;
    const found = findFieldElements(selectedField);
    if (!found) return;
    const override = ensureOverride(found.entry, found.section, found.input, selectedField);
    override.fontSizePt = Math.max(MIN_FONT_SIZE_PT, Math.min(MAX_FONT_SIZE_PT, override.fontSizePt + deltaPt));
    applyOverride(found.section, found.input, override);
    setSelectedFontSizePt(override.fontSizePt);
  }

  function toggleSelectedBold() {
    if (!selectedField) return;
    const found = findFieldElements(selectedField);
    if (!found) return;
    const override = ensureOverride(found.entry, found.section, found.input, selectedField);
    override.bold = !override.bold;
    applyOverride(found.section, found.input, override);
    setSelectedBold(override.bold);
  }

  function setSelectedColorValue(hex: string) {
    if (!selectedField) return;
    const found = findFieldElements(selectedField);
    if (!found) return;
    const override = ensureOverride(found.entry, found.section, found.input, selectedField);
    override.color = hex;
    applyOverride(found.section, found.input, override);
    setSelectedColor(hex);
  }

  function setSelectedFontFamilyValue(family: FontFamilyKey) {
    if (!selectedField) return;
    const found = findFieldElements(selectedField);
    if (!found) return;
    const override = ensureOverride(found.entry, found.section, found.input, selectedField);
    override.fontFamily = family;
    applyOverride(found.section, found.input, override);
    setSelectedFontFamily(family);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    zoomRef.current = 1;
    setZoomDisplay(1);
    editModeRef.current = false;
    setEditModeOn(false);
    setSelectedField(null);
    fieldOverridesRef.current = new Map();
    customFieldNamesRef.current = new Set();
    customFieldValuesRef.current = new Map();

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
      lastContainerWidthRef.current = containerWidth;
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
          afterDraw(entry);
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
        afterDraw(entry);
      }

      const entries: PageEntry[] = [];
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
        if (cancelled) return;
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;
        // Commentaire n°4bis — pourquoi ne PAS lire la taille de police dans
        // le DOM (input.style.fontSize) : pdf.js RÉTRÉCIT toujours l'affichage
        // à min(taille_déclarée, (hauteur_case - 2) / 1.35) (relu directement
        // dans son code source, _setTextStyle) — donc si la case est plus
        // petite que ce que la police demande, input.style.fontSize montre une
        // taille plus PETITE que celle vraiment enregistrée dans le PDF. Comme
        // Maxime a demandé de ne plus jamais faire grandir la case pour
        // "loger" la police (aucune corrélation entre les deux), ce
        // rétrécissement visuel devient courant — il ne faut donc plus du tout
        // se fier au DOM pour restaurer la police/couleur. La VRAIE valeur
        // enregistrée (celle du PDF, jamais rétrécie) vient de
        // page.getAnnotations() : chaque annotation expose
        // defaultAppearanceData.fontSize/fontColor, exactement ce que pdf.js
        // lui-même lit avant de rétrécir l'affichage. On la lit une seule fois
        // par page, ici, pendant le chargement (async), et on la garde en
        // mémoire pour que ensureOverride (lui, synchrone) puisse s'en servir
        // instantanément au moment où l'utilisateur touche une case.
        let savedFieldStyles: PageEntry["savedFieldStyles"] = null;
        if (restoreSavedStyle) {
          try {
            const annotations = await page.getAnnotations();
            const map = new Map<string, { fontSizePt: number; color: string | null }>();
            for (const annotation of annotations as Array<Record<string, unknown>>) {
              const fieldName = typeof annotation.fieldName === "string" ? annotation.fieldName : null;
              if (!fieldName) continue;
              const da = annotation.defaultAppearanceData as
                | { fontSize?: number; fontColor?: ArrayLike<number> }
                | undefined;
              if (!da) continue;
              const fontSizePt = typeof da.fontSize === "number" && da.fontSize > 0 ? da.fontSize : null;
              let color: string | null = null;
              if (da.fontColor && da.fontColor.length >= 3) {
                const toHex = (component: number) =>
                  Math.max(0, Math.min(255, Math.round(component))).toString(16).padStart(2, "0");
                color = `#${toHex(da.fontColor[0])}${toHex(da.fontColor[1])}${toHex(da.fontColor[2])}`;
              }
              if (fontSizePt != null || color != null) {
                map.set(fieldName, { fontSizePt: fontSizePt ?? 11, color });
              }
            }
            savedFieldStyles = map;
          } catch {
            // Si la lecture échoue pour une raison quelconque, ensureOverride
            // retombe sur les valeurs par défaut (11pt/noir) — jamais pire
            // qu'avant cette amélioration.
            savedFieldStyles = null;
          }
        }
        if (cancelled) return;
        const unscaledViewport = page.getViewport({ scale: 1 });
        // Limite haute à 2x pour rester net sans dessiner un canevas énorme
        // et inutilement lourd sur un vieux téléphone (le zoom manuel peut
        // ensuite dépasser cette limite s'il le faut, volontairement).
        const autoFitScale = Math.min(2, Math.max(0.4, (containerWidth - 4) / unscaledViewport.width));
        const viewport = page.getViewport({ scale: autoFitScale });

        const pageWrapper = document.createElement("div");
        pageWrapper.dataset.pageNumber = String(pageNumber);
        pageWrapper.style.position = "relative";
        // BUG corrigé (généralisé à TOUT document de plus d'une page ouvert
        // dans ce lecteur, signalé sur "Annexe 6" mais pas spécifique à cette
        // pièce) : "coupure bizarre" du texte à la fin de chaque page. Le
        // contenu du PDF généré est pourtant complet et dans le bon ordre
        // (vérifié directement page par page) — le vrai problème est que la
        // fin d'une page et le début de la suivante étaient trop rapprochées
        // (à peine 12px, presque collées visuellement), sans réelle séparation
        // visible entre les deux : le blanc naturel de fin de page 1 se
        // confondait avec le blanc naturel de début de page 2, donnant
        // l'impression d'un texte coupé/manquant pile à cet endroit. On
        // agrandit l'espace entre chaque page et on renforce son ombre pour
        // que la limite entre deux pages soit toujours nette, quel que soit
        // le document. Écart encore augmenté (28px -> 48px, ombre plus
        // marquée) suite au retour de Maxime : les pages restaient encore
        // trop proches visuellement à 28px.
        pageWrapper.style.margin = pageNumber === 1 ? "0 auto 48px auto" : "48px auto";
        pageWrapper.style.width = `${viewport.width}px`;
        pageWrapper.style.height = `${viewport.height}px`;
        pageWrapper.style.background = "#fff";
        pageWrapper.style.boxShadow = "0 4px 16px rgba(0,0,0,.45)";
        pagesContainer.appendChild(pageWrapper);

        entries.push({ pageNumber, page, wrapper: pageWrapper, pageView: null, autoFitScale, savedFieldStyles });
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

      // BUG corrigé (généralisé à TOUT document, pas seulement "A5 -
      // Litiges") : scrollbarGutter:"stable" (voir le style du conteneur
      // plus bas) suffit sur les navigateurs qui le comprennent, mais ce
      // réglage CSS n'est pas encore reconnu partout (Safari, en particulier,
      // ne l'applique pas de façon fiable) — sur ces navigateurs, le même
      // problème qu'avant revient : la largeur mesurée ICI (containerWidth,
      // juste au-dessus) ne tient pas compte de l'ascenseur vertical qui
      // n'apparaît qu'une fois toutes les pages ajoutées au DOM, et coupe
      // alors le bord droit du tableau. Un ResizeObserver posé sur le
      // conteneur des pages détecte ce rétrécissement APRÈS coup (quel que
      // soit le navigateur, aucune dépendance à scrollbarGutter) et
      // redessine chaque page déjà affichée à la bonne taille — filet de
      // sécurité qui fonctionne même quand le CSS ci-dessus ne suffit pas.
      function refit() {
        const container = pagesContainerRef.current;
        if (!container || cancelled) return;
        const newWidth = Math.max(280, container.clientWidth || 680);
        if (Math.abs(newWidth - lastContainerWidthRef.current) < 2) return;
        lastContainerWidthRef.current = newWidth;
        pagesRef.current.forEach((entry) => {
          const unscaledViewport = entry.page.getViewport({ scale: 1 });
          entry.autoFitScale = Math.min(2, Math.max(0.4, (newWidth - 4) / unscaledViewport.width));
          const scale = entry.autoFitScale * zoomRef.current;
          const viewport = entry.page.getViewport({ scale });
          entry.wrapper.style.width = `${viewport.width}px`;
          entry.wrapper.style.height = `${viewport.height}px`;
          if (entry.pageView) {
            entry.pageView.update({ scale });
            entry.pageView.draw().then(() => afterDraw(entry)).catch(() => {});
          }
        });
      }
      const resizeObserver = new ResizeObserver(() => refit());
      resizeObserverRef.current = resizeObserver;
      resizeObserver.observe(pagesContainer);

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
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
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
        entry.pageView.draw().then(() => afterDraw(entry)).catch(() => {});
      }
    });
  }

  useImperativeHandle(ref, () => ({
    async getFilledPdfBytes() {
      if (!pdfDocumentRef.current) throw new Error("Le PDF n’est pas encore chargé.");
      const baseBytes = await pdfDocumentRef.current.saveDocument();
      // Rien à déplacer/ajouter : pas besoin de repasser par pdf-lib.
      if (fieldOverridesRef.current.size === 0) return baseBytes;
      try {
        const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
        const doc = await PDFDocument.load(baseBytes);
        const form = doc.getForm();
        // Une police pdf-lib embarquée par combinaison (style, gras) —
        // réutilisée pour toutes les cases qui partagent la même combinaison,
        // inutile d'en embarquer une par case.
        const fontCache = new Map<string, Awaited<ReturnType<typeof doc.embedFont>>>();
        let fontkitRegistered = false;
        // "document"/"times" (kind "embed") : PAS une police standard
        // pdf-lib — on va chercher un vrai fichier .ttf servi tel quel
        // depuis /public/fonts/ (donc accessible ici par un simple fetch,
        // exactement comme le fait déjà le serveur — voir
        // lib/submission/pdf-font.ts) et on l'embarque nous-mêmes avec
        // fontkit, pour un rendu identique partout (téléphone, ordinateur,
        // n'importe quel lecteur PDF) au lieu de dépendre de ce que CHAQUE
        // lecteur choisit d'afficher à la place d'une police "standard" —
        // c'est justement ce qui causait "les polices ne sont pas les
        // mêmes" pour Times New Roman.
        async function embedTtfFont(regularUrl: string, boldUrl: string, bold: boolean) {
          if (!fontkitRegistered) {
            const fontkit = (await import("@pdf-lib/fontkit")).default;
            doc.registerFontkit(fontkit);
            fontkitRegistered = true;
          }
          const url = bold ? boldUrl : regularUrl;
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Police introuvable : ${url}`);
          const fontBytes = new Uint8Array(await response.arrayBuffer());
          return doc.embedFont(fontBytes, { subset: false });
        }
        async function getFont(family: FontFamilyKey, bold: boolean) {
          const key = `${family}:${bold}`;
          let font = fontCache.get(key);
          if (!font) {
            const spec = FONT_FAMILIES[family];
            try {
              font = spec.kind === "embed"
                ? await embedTtfFont(spec.regularUrl, spec.boldUrl, bold)
                : await doc.embedFont(StandardFonts[(bold ? spec.pdfBold : spec.pdf) as keyof typeof StandardFonts]);
            } catch {
              // Repli : si le fichier .ttf n'est pas joignable pour une
              // raison quelconque (réseau...), Helvetica reste un repli
              // correct plutôt que de faire échouer tout l'enregistrement
              // des positions/tailles déjà en cours.
              font = await doc.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
            }
            fontCache.set(key, font);
          }
          return font;
        }
        // Convertit "#rrggbb" en 0..1 (rgb() de pdf-lib) pour l'écrire dans
        // la chaîne "DA" (apparence par défaut) de la case, au format PDF
        // "r g b rg" — vérifié par un vrai test d'aller-retour (écrire,
        // enregistrer, relire) avant d'écrire ce code : la couleur ET la
        // police (gras, Times, machine à écrire...) ressortent bien telles
        // quelles après enregistrement.
        function hexToRgbOperator(hex: string): string {
          const clean = hex.replace("#", "");
          const r = parseInt(clean.slice(0, 2), 16) / 255;
          const g = parseInt(clean.slice(2, 4), 16) / 255;
          const b = parseInt(clean.slice(4, 6), 16) / 255;
          return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`;
        }
        // Applique couleur + style de police + gras à une case texte déjà
        // positionnée/dont la taille de police est déjà posée (setFontSize
        // doit être appelé AVANT, car il reconstruit une partie de la chaîne
        // DA — voir PDFAcroField.setFontSize dans pdf-lib, qui garde
        // heureusement tout ce qui suit "Tf", dont notre couleur, si on
        // l'ajoute après).
        async function applyTextStyle(field: Awaited<ReturnType<typeof form.getTextField>>, override: FieldOverride) {
          const da = field.acroField.getDefaultAppearance() ?? "";
          const fontMatch = /\/(\S+)\s+([\d.]+)\s+Tf/.exec(da);
          const fontName = fontMatch ? fontMatch[1] : "Helv";
          const fontSize = fontMatch ? fontMatch[2] : String(Math.max(4, Math.round(override.fontSizePt)));
          field.acroField.setDefaultAppearance(`/${fontName} ${fontSize} Tf ${hexToRgbOperator(override.color)}`);
          // updateAppearances() dessine tout de suite l'aperçu avec LA police
          // choisie (style + gras) ET marque la case "propre" : le passage
          // générique form.updateFieldAppearances() plus bas ne la
          // retouchera donc pas avec la police par défaut par-dessus
          // (vérifié par un aller-retour enregistrer/relire).
          field.updateAppearances(await getFont(override.fontFamily, override.bold));
        }
        for (const [fieldName, override] of fieldOverridesRef.current) {
          try {
            const page = doc.getPage(override.pageNumber - 1);
            const { width: pageWidth, height: pageHeight } = page.getSize();
            const widthPt = (override.widthPercent / 100) * pageWidth;
            const fontSizePt = Math.max(4, Math.round(override.fontSizePt));
            // Pas de corrélation entre la hauteur de la case et la taille de
            // police (demande explicite de Maxime) : la case garde EXACTEMENT
            // la hauteur qu'il a réglée, même si pdf.js l'affichera alors plus
            // petite à l'écran qu'elle n'est réellement enregistrée (voir le
            // commentaire n°4bis plus haut, près de savedFieldStyles) — la
            // restauration lit désormais la vraie valeur enregistrée via
            // page.getAnnotations() plutôt que ce rendu visuel, donc ce
            // rétrécissement à l'écran n'efface plus jamais la vraie taille.
            const heightPt = (override.heightPercent / 100) * pageHeight;
            const xPt = (override.leftPercent / 100) * pageWidth;
            // top% est mesuré depuis le HAUT (convention CSS) ; /Rect PDF
            // mesure y depuis le BAS de la page — même conversion que
            // positionRect côté serveur (dao-template-pdf.ts).
            const yPt = pageHeight - (override.topPercent / 100) * pageHeight - heightPt;
            if (customFieldNamesRef.current.has(fieldName)) {
              const value = customFieldValuesRef.current.get(fieldName) ?? "";
              const field = form.createTextField(fieldName);
              // ORDRE IMPORTANT (déjà vérifié ailleurs dans ce projet) :
              // addToPage() avant setFontSize()/setText().
              field.addToPage(page, {
                x: xPt, y: yPt, width: widthPt, height: heightPt,
                borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92), backgroundColor: rgb(1, 1, 1),
              });
              field.setFontSize(fontSizePt);
              if (value) field.setText(value);
              await applyTextStyle(field, override);
            } else {
              const field = form.getTextField(fieldName);
              field.acroField.getWidgets().forEach((widget) => widget.setRectangle({ x: xPt, y: yPt, width: widthPt, height: heightPt }));
              field.setFontSize(fontSizePt);
              await applyTextStyle(field, override);
            }
          } catch {
            // Une case qu'on ne retrouve plus (nom introuvable...) ne doit
            // jamais faire échouer tout l'enregistrement : on passe celle-là.
          }
        }
        try {
          form.updateFieldAppearances();
        } catch {
          // Repli silencieux : la position/le texte restent quand même
          // enregistrés même si la régénération de l'aperçu échoue.
        }
        return await doc.save();
      } catch {
        // Si pdf-lib échoue ici pour une raison quelconque, on renvoie quand
        // même les valeurs déjà tapées (baseBytes) plutôt que de faire
        // échouer complètement l'enregistrement à cause du repositionnement.
        return baseBytes;
      }
    },
  }), []);

  return <div style={{ position: "relative", width: "100%", height: "100%" }}>
    {/* pdf.js teinte par défaut (en bleu clair, via une image de fond CSS)
        toute case encore vide, pour aider à les repérer dans son propre
        lecteur complet — un réglage qu'il n'expose nulle part pour notre
        usage (juste ce composant, sans sa barre d'outils). Nos cases ont
        déjà un fond blanc bien à elles (voir dao-template-pdf.ts /
        generated-document-pdf.ts, backgroundColor blanc à la création) :
        cette teinte s'affichait PAR-DESSUS, donnant l'impression d'une
        couleur différente de la page. On neutralise ici uniquement cette
        teinte par défaut (jamais touché ailleurs dans pdf_viewer.css), et on
        force en plus un fond blanc directement sur chaque case affichée. */}
    <style>{`
      .fillable-pdf-viewer .annotationLayer {
        --annotation-unfocused-field-background: none !important;
        --annotation-unfocused-field-filter: none !important;
        --input-hover-border-color: transparent !important;
        --input-focus-border-color: transparent !important;
      }
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea) {
        background-color: #fff !important;
      }
      /* BUG corrigé (généralisé à TOUTE case de TEXTE de TOUT document ouvert
         dans ce lecteur — signalé sur le tableau "A2 - Planning d'exécution
         des travaux" mais Maxime a confirmé que d'autres PDF ont le même
         problème) : petits "crochets" gris qui apparaissent dans le coin de
         chaque case, absents du DAO d'origine — pas les carrés déjà corrigés
         plus haut (survol/saisie), ceux-là restent visibles même au repos, y
         compris une case déjà remplie et jamais survolée. Confirmé en
         régénérant ce même tableau et en l'ouvrant tel quel (sans navigateur,
         juste le PDF) : ce crochet n'existe pas du tout dans le PDF généré,
         donc ce n'est ni notre code de génération ni pdf.js — c'est
         l'habillage NATIF du navigateur pour une case de texte ordinaire
         (petit relief/ombre que Chrome/Safari dessinent eux-mêmes autour de
         tout <input> de type texte, indépendamment de toute bordure CSS).
         pdf.js retire déjà cet habillage natif pour les cases à cocher (voir
         plus haut dans pdf_viewer.css, appearance:none sur
         .buttonWidgetAnnotation) mais pas pour les cases de texte : on
         applique donc ici la même suppression à TOUTE case de texte ou liste
         déroulante de ce lecteur. */
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea),
      .fillable-pdf-viewer .choiceWidgetAnnotation select {
        -webkit-appearance: none !important;
        -moz-appearance: none !important;
        appearance: none !important;
      }
      /* BUG corrigé (généralisé à TOUTE case de TOUT document ouvert dans ce
         lecteur — signalé sur un tableau de "A2 - Planning d'exécution des
         travaux" mais pas spécifique à cette pièce ni aux tableaux) : "carré
         noir" qui apparaît devant une case, absent du DAO d'origine. Ce
         n'est pas notre CSS ni un défaut de génération du PDF : c'est pdf.js
         qui dessine par défaut un contour de 2px sur TOUTE case (texte, case
         à cocher, liste déroulante), aussi bien au survol qu'en train d'être
         remplie (via --input-hover-border-color/--input-focus-border-color,
         voir pdf_viewer.css), pour montrer qu'elle est cliquable/active dans
         son propre lecteur complet avec barre d'outils. Un premier correctif
         n'avait neutralisé que le survol (en gardant le contour pendant la
         saisie, pensé comme un repère utile) : mais la case reste entourée
         de ce carré aussi bien AVANT qu'APRÈS la saisie sur cette
         application (pas seulement pendant, comme le montrent les captures
         envoyées avec une valeur déjà tapée) — on neutralise donc maintenant
         ce contour dans tous les cas (survol, pendant la saisie, et après),
         partout dans ce lecteur. Les cases restent déjà bien visibles par
         leur fond blanc (juste au-dessus), sans avoir besoin de ce carré. */
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea):hover,
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea):focus,
      .fillable-pdf-viewer .choiceWidgetAnnotation select:hover,
      .fillable-pdf-viewer .choiceWidgetAnnotation select:focus,
      .fillable-pdf-viewer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:hover,
      .fillable-pdf-viewer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:focus {
        border-color: transparent !important;
        outline: none !important;
      }
      /* Le "blob" bleu/mauve arrondi qui apparaissait au toucher sur iPhone
         (visible sur la capture d'écran envoyée) n'est ni la teinte pdf.js
         ci-dessus (déjà neutralisée) ni une case mal positionnée : c'est le
         reflet de surbrillance que Safari affiche par défaut sur tout
         élément touché (-webkit-tap-highlight-color), ici en plus déformé
         car il se superpose sur la case ET sur le champ texte à l'intérieur.
         On le désactive uniquement dans ce lecteur. */
      .fillable-pdf-viewer, .fillable-pdf-viewer * {
        -webkit-tap-highlight-color: transparent;
      }
      /* Fond bleu qui apparaît APRÈS avoir tapé dans une case (visible sur
         ordinateur, pas avant d'écrire dedans) : ce n'est ni notre CSS ni
         pdf.js — c'est Chrome/Edge qui reconnaît un nom/une adresse et
         applique SA PROPRE coloration de "champ auto-rempli", même avec
         autocomplete="off" (Chrome ignore volontairement ce réglage pour ce
         genre de champ). Ce fond n'est pas modifiable directement en CSS
         (Chrome l'impose) : l'astuce reconnue consiste à peindre un immense
         "box-shadow" intérieur blanc PAR-DESSUS, en boucle infinie via une
         transition très longue pour qu'il ne réapparaisse jamais. */
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea):-webkit-autofill,
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea):-webkit-autofill:hover,
      .fillable-pdf-viewer .textWidgetAnnotation :is(input, textarea):-webkit-autofill:focus {
        -webkit-box-shadow: 0 0 0 1000px #fff inset !important;
        box-shadow: 0 0 0 1000px #fff inset !important;
        transition: background-color 999999s ease-in-out 0s;
      }
    `}</style>
    <div
      ref={scrollContainerRef}
      className="fillable-pdf-viewer"
      // BUG corrigé (généralisé à TOUT document ouvert dans ce lecteur,
      // signalé sur "A5 - Litiges" mais pas spécifique à cette pièce) :
      // "texte à moitié caché", ascenseur horizontal en trop, alors que la
      // page elle-même n'est pourtant pas plus large que prévu. Cause :
      // containerWidth (voir plus bas, "pagesContainer.clientWidth") est
      // mesuré AVANT que les pages ne soient ajoutées à ce conteneur — donc
      // avant que l'ascenseur VERTICAL (qui n'apparaît qu'une fois tout le
      // contenu ajouté, si le document est assez long/a plusieurs tableaux)
      // ne réserve sa place. Le zoom "Ajuster" calculé à ce moment-là est
      // donc systématiquement un peu trop large dès qu'un document a besoin
      // de défiler verticalement — l'ascenseur vertical grignote alors
      // cette largeur après coup, sans que le zoom ne soit recalculé,
      // coupant le bord droit de la page. scrollbarGutter:"stable" réserve
      // TOUJOURS cette place à l'avance (que l'ascenseur soit affiché ou
      // non), donc la largeur mesurée est toujours la bonne, sur n'importe
      // quel document, dans toute l'application (ce lecteur est le seul
      // utilisé partout où "Ouvrir" est cliqué).
      style={{ position: "relative", width: "100%", height: "100%", overflow: "auto", scrollbarGutter: "stable", background: "#f3f4f6", borderRadius: "10px" }}
    >
      {loading && !errorMessage && <p style={{ padding: 16, margin: 0, textAlign: "center" }}>Chargement du PDF…</p>}
      {errorMessage && <p style={{ padding: 16, margin: 0, textAlign: "center", color: "#b91c1c" }}>{errorMessage}</p>}
      {/* La classe "pdfViewer" est INDISPENSABLE : voir le commentaire n°2
          en haut du fichier — sans elle, pdf.js ne sait pas où placer les
          cases à remplir. */}
      <div ref={pagesContainerRef} className="pdfViewer" style={{ width: "100%", padding: "8px 0", position: "relative" }} />
    </div>
    {!loading && !errorMessage && (
      <div style={{ position: "absolute", bottom: 12 + keyboardInsetPx, left: 12, right: 12, display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        {editModeOn && (
          <button type="button" onClick={addFieldNow} className="tenderButton tenderButtonPrimary" style={{ fontSize: 13 }}>
            + Ajouter une case
          </button>
        )}
        {editModeOn && selectedField && (
          <div style={toolbarCardStyle}>
            {/* Style de police (la police elle-même, pas sa taille) — 3 choix standards, suffisants pour ne pas ajouter de fichier de police au projet. */}
            <select
              value={selectedFontFamily}
              onChange={(e) => setSelectedFontFamilyValue(e.target.value as FontFamilyKey)}
              aria-label="Style de police"
              style={selectStyle}
            >
              {(Object.keys(FONT_FAMILIES) as FontFamilyKey[]).map((key) => (
                <option key={key} value={key}>{FONT_FAMILIES[key].label}</option>
              ))}
            </select>
            {/* Taille de police : en points PDF réels, séparée du zoom — zoomer/dézoomer l'écran ne change jamais ce nombre. */}
            <button type="button" onClick={() => adjustSelectedFontSize(-FONT_SIZE_STEP_PT)} className="tenderButton" style={compactButtonStyle} aria-label="Police plus petite">A−</button>
            <span style={{ fontSize: 12, minWidth: 34, textAlign: "center", color: "#153f2b", fontWeight: 750 }}>{selectedFontSizePt}pt</span>
            <button type="button" onClick={() => adjustSelectedFontSize(FONT_SIZE_STEP_PT)} className="tenderButton" style={compactButtonStyle} aria-label="Police plus grande">A+</button>
            <button
              type="button"
              onClick={toggleSelectedBold}
              className={`tenderButton${selectedBold ? " tenderButtonPrimary" : ""}`}
              style={{ ...compactButtonStyle, width: "auto", padding: "0 12px", fontWeight: 800 }}
              aria-label="Gras"
            >
              G
            </button>
            <input
              type="color"
              value={selectedColor}
              onChange={(e) => setSelectedColorValue(e.target.value)}
              aria-label="Couleur du texte"
              style={{ width: 34, height: 34, padding: 0, border: "1px solid #b8c9bd", borderRadius: 8, background: "#fff", cursor: "pointer" }}
            />
            {customFieldNamesRef.current.has(selectedField) && (
              <button type="button" onClick={removeSelectedCustomField} className="tenderButton tenderButtonDanger" style={{ ...compactButtonStyle, width: "auto", padding: "0 12px" }} aria-label="Supprimer cette case">✕</button>
            )}
            <button type="button" onClick={() => setSelectedField(null)} className="tenderButton" style={{ ...compactButtonStyle, width: "auto", padding: "0 14px" }} aria-label="Fermer">OK</button>
          </div>
        )}
        <div style={toolbarCardStyle}>
          <button
            type="button"
            onClick={toggleEditMode}
            className={`tenderButton${editModeOn ? " tenderButtonPrimary" : ""}`}
            style={{ fontSize: 13 }}
          >
            {editModeOn ? "Terminé" : "Ajuster"}
          </button>
          <button type="button" onClick={() => applyZoom(zoomRef.current - ZOOM_STEP)} className="tenderButton" style={compactButtonStyle} aria-label="Zoom arrière">−</button>
          <span style={{ alignSelf: "center", fontSize: 13, minWidth: 42, textAlign: "center", color: "#153f2b", fontWeight: 750 }}>
            {Math.round(zoomDisplay * 100)}%
          </span>
          <button type="button" onClick={() => applyZoom(zoomRef.current + ZOOM_STEP)} className="tenderButton" style={compactButtonStyle} aria-label="Zoom avant">+</button>
          <button type="button" onClick={() => applyZoom(1)} className="tenderButton" style={{ ...compactButtonStyle, width: "auto", padding: "0 12px", fontSize: 12 }} aria-label="Taille normale">100%</button>
        </div>
      </div>
    )}
  </div>;
});

// Habillage repris tel quel du reste de l'application (voir app/globals.css :
// .tenderButton/.tenderButtonPrimary/.tenderButtonDanger — pilule blanche à
// bordure verte pâle, remplissage vert dégradé pour l'action principale/l'état
// "activé", rouge pour une action destructive) plutôt que les carrés gris
// génériques d'avant : cette barre d'outils flottante doit avoir le même
// habillage que "+ Ajouter une ligne"/"Ouvrir"/etc. ailleurs dans l'appli, pas
// un style qui lui est propre.
const toolbarCardStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  background: "rgba(255,255,255,.97)",
  border: "1px solid #e2e8e3",
  borderRadius: 14,
  padding: 8,
  boxShadow: "0 6px 16px rgba(11,58,38,.12)",
};

// Variante compacte de .tenderButton pour les boutons "icône seule" (A−, A+,
// zoom −/+) : garde la forme/couleur/bordure de .tenderButton (définies dans
// la classe CSS), ajuste seulement la taille pour un bouton carré plutôt
// qu'une pilule large.
const compactButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  padding: 0,
  fontSize: 16,
  lineHeight: 1,
};

const selectStyle: CSSProperties = {
  height: 36,
  borderRadius: 10,
  border: "1px solid #b8c9bd",
  background: "#fff",
  color: "#153f2b",
  fontSize: 12,
  fontWeight: 750,
  padding: "0 6px",
  cursor: "pointer",
};

export default FillablePdfViewer;
