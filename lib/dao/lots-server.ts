import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import type { PageText } from "@/lib/dao/lot-detection";

// Partie « serveur » de la gestion des DAO à plusieurs lots : lecture du texte de chaque page (gratuite, sans IA)
// et fabrication du mini-PDF d'un lot. La logique de choix des pages est dans lot-detection.ts (fonctions pures).

/** Texte de chaque page, ligne par ligne (de haut en bas). Une page illisible (scan) donne simplement zéro ligne. */
export async function readPageTexts(pdfBytes: Uint8Array): Promise<PageText[]> {
  const loadingTask = getDocument({ data: pdfBytes.slice(), useSystemFonts: true });
  const doc = await loadingTask.promise;
  const pages: PageText[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    try {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items
        .flatMap((item) => ("str" in item && item.str.trim() !== "" ? [{ s: item.str, x: item.transform[4] as number, y: item.transform[5] as number }] : []))
        .sort((a, b) => b.y - a.y || a.x - b.x);
      const lines: Array<{ y: number; parts: typeof items }> = [];
      for (const item of items) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - item.y) <= 3) last.parts.push(item);
        else lines.push({ y: item.y, parts: [item] });
      }
      pages.push({
        page: pageNumber,
        lines: lines.map((line) => line.parts.sort((a, b) => a.x - b.x).map((part) => part.s).join(" ").replace(/\s+/g, " ").trim()),
      });
      page.cleanup();
    } catch {
      pages.push({ page: pageNumber, lines: [] });
    }
  }
  await loadingTask.destroy();
  return pages;
}

/** Nouveau PDF contenant uniquement les pages demandées (numéros du PDF d'origine, dans l'ordre). */
export async function buildMiniPdf(pdfBytes: Uint8Array, pageNumbers: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, pageNumbers.map((page) => page - 1));
  copied.forEach((page) => output.addPage(page));
  return output.save({ useObjectStreams: true });
}
