import CSSMatrix from "dommatrix";

// pdfjs-dist (depuis sa version 5/6) référence l'API navigateur "DOMMatrix"
// dès le chargement de son propre module — une API qui n'existe pas du tout
// dans Node.js (elle est fournie par le navigateur, jamais par le serveur).
// Sans elle, le simple fait d'IMPORTER pdfjs-dist plante immédiatement avec
// "ReferenceError: DOMMatrix is not defined", avant même d'avoir pu ouvrir
// un seul PDF — ce qui faisait échouer TOUTES les pièces passant par
// rebuild-template-pdf.ts, systématiquement, sur le serveur déployé
// (Vercel), même si tout semblait correct en local.
//
// Le paquet "dommatrix" fournit une implémentation de secours en JavaScript
// pur, sans dépendance native (donc sans risque à l'installation sur
// Vercel), compatible avec l'API DOMMatrix : on l'installe ici comme
// variable globale.
//
// Ce réglage est volontairement dans SON PROPRE fichier, importé EN PREMIER
// (avant tout import de pdfjs-dist) : en JavaScript (modules ES), les
// imports d'un fichier sont chargés entièrement AVANT le reste de son
// propre code, dans l'ordre où ils sont écrits. Si ce réglage avait été
// placé dans le même fichier qui importe aussi pdfjs-dist, les deux
// auraient démarré leur chargement "en parallèle" et pdfjs-dist aurait
// quand même planté avant que la variable globale soit posée.
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = CSSMatrix;
}
