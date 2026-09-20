// Doit rester le tout premier import de ce fichier : il installe la
// variable globale DOMMatrix dont pdfjs-dist a besoin dès son propre
// chargement (voir le commentaire dans dommatrix-polyfill.ts). Si l'import
// de pdfjs-dist juste en dessous passait avant celui-ci, le polyfill
// arriverait trop tard et pdfjs-dist planterait quand même.
import "@/lib/submission/dommatrix-polyfill";
import path from "path";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

// pdfjs-dist tente de charger son fichier "worker" par un chemin calculé à
// l'exécution ; le bundler de Next.js le réécrit alors vers un module
// virtuel qui n'existe pas sur le disque et getDocument() échoue à chaque
// appel avec "Setting up fake worker failed: Cannot find module...". Marquer
// pdfjs-dist externe (next.config.ts) empêche déjà SES propres imports
// d'être touchés, mais require.resolve(...) ICI, dans notre propre code
// applicatif, reste lui-même analysé et réécrit par le bundler dès qu'on lui
// passe une chaîne littérale — d'où ce chemin recalculé à la main avec
// path.join plutôt qu'un require.resolve, pour qu'aucun outil de
// regroupement ne puisse le réécrire.
const workerPath = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
if (existsSync(workerPath)) {
  GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
}
