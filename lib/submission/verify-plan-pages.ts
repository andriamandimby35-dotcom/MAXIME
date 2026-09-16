import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Un vrai plan/dessin technique (fondation, façade, ferraillage...) contient
// très peu de texte extractible — juste quelques légendes et cotes, souvent
// aucun s'il s'agit d'un scan. Une page de tableau (liste des plans, poids
// des matériaux, liste du personnel...) contient au contraire beaucoup de
// texte structuré. Ce n'est pas une simple comparaison de numéros de page
// (déjà faite ailleurs) mais une vérification du contenu réel de la page,
// pour détecter les cas où l'IA a indiqué un numéro de page qui n'appartient
// à aucun autre poste identifié mais qui n'est malgré tout pas un plan.
const MAX_TEXT_LENGTH_FOR_DRAWING = 300;

export async function keepPagesThatLookLikePlans(pdfBytes: Uint8Array, candidatePages: number[]): Promise<number[]> {
  if (!candidatePages.length) return [];
  try {
    // pdf.js prend possession du buffer qu'on lui passe (il le vide/détache) —
    // sans cette copie, toute lecture ultérieure du même buffer (pdf-lib, pour
    // annexer les pages) échoue avec "No PDF header found".
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const kept: number[] = [];
    for (const pageNumber of candidatePages) {
      const page1Indexed = Math.floor(pageNumber);
      if (page1Indexed < 1 || page1Indexed > doc.numPages) continue;
      try {
        const page = await doc.getPage(page1Indexed);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .trim();
        if (text.length <= MAX_TEXT_LENGTH_FOR_DRAWING) kept.push(page1Indexed);
      } catch {
        // Page illisible : on ne l'inclut pas plutôt que de risquer un mélange.
      }
    }
    return kept;
  } catch {
    // Le PDF n'a pas pu être chargé pour vérification : par prudence,
    // n'annexer aucune page non vérifiée.
    return [];
  }
}
