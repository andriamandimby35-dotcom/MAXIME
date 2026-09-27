// Corrige après coup une erreur d'analyse IA déjà observée (le prompt
// d'analyse-dao.ts interdit pourtant déjà explicitement de fusionner
// plusieurs pages ayant chacune leur propre titre en un seul submission_item
// — typiquement des fiches A1, A2, A3, A4, A5... — mais une analyse déjà
// faite peut avoir ignoré cette consigne). Générique par construction :
// AUCUN titre ni numéro n'est codé en dur ici, seule la MISE EN FORME de
// chaque page réelle du DAO est regardée (voir splitPagesByOwnTitle, qui
// réutilise le même signal majuscules+gras que le reste de l'application) —
// s'applique donc pareil à n'importe quel DAO. Tourne à chaque ouverture du
// dossier (jamais un nouvel appel IA, donc jamais de coût supplémentaire), ce
// qui corrige aussi bien un DAO déjà analysé dans le passé qu'un DAO analysé
// demain, sans jamais avoir besoin d'une correction manuelle au cas par cas.
//
// Dans un fichier À PART de build-dossier-items.ts exprès : cette fonction
// dépend de trim-to-relevant-pages.ts, qui lit le PDF avec pdf.js côté Node
// (fs/path) — du code strictement SERVEUR, qui ne doit jamais être importé,
// même indirectement, par un composant CLIENT (navigateur). Comme
// build-dossier-items.ts est lui aussi utilisé par SubmissionDossierManager
// (un composant client), garder splitMergedDaoItems ici évite d'embarquer ce
// code Node dans le paquet envoyé au navigateur (ce que Vercel refuse de
// construire). N'importer ce fichier QUE depuis du code serveur (pages,
// routes API) — jamais depuis un composant "use client".
import { splitPagesByOwnTitle, pagesContainingText } from "@/lib/submission/trim-to-relevant-pages";
import { parsePageNumbersFromReference } from "@/lib/submission/parse-page-reference";
import type { Field, TemplateDetectedItem, TemplateTable } from "@/lib/submission/build-dossier-items";

export async function splitMergedDaoItems<T extends TemplateDetectedItem>(items: T[], pdfBytes: Uint8Array | null): Promise<T[]> {
  if (!pdfBytes) return items;
  const result: T[] = [];
  for (const item of items) {
    // BUG corrigé (pièce "A3 - Chiffres d'affaires" signalée par Maxime :
    // toujours affichée comme UNE seule pièce, sans tableau ni bouton
    // "Ajouter une ligne", alors que ses pages "16, 267-268" montrent bien
    // deux tableaux distincts et éloignés dans le DAO). Cause : l'IA note
    // parfois une page réelle SEULEMENT sous forme de texte dans
    // source_reference ("Pages 16, 267-268"), sans la répéter aussi dans
    // template_page_numbers (ex. resté à [16] tout seul) — déjà rencontré et
    // corrigé ailleurs (route.ts, "detectedTemplateKnownPages") mais pas
    // encore ici : cette pièce ne voyait donc jamais sa page 267/268, et le
    // découpage ci-dessous ne pouvait jamais la détecter comme une pièce
    // séparée. On combine donc toujours les deux sources, exactement comme
    // route.ts le fait déjà pour la génération du PDF.
    const pages = [...new Set([
      ...(item.template_page_numbers ?? []),
      ...parsePageNumbersFromReference(item.source_reference),
    ])];
    // Un item qui ne vient pas d'une vraie page du DAO ne peut par définition
    // pas avoir fusionné deux pièces différentes : rien à vérifier. Une seule
    // page déclarée ne suffit PAS à elle seule à l'exclure : l'IA compte
    // parfois les pages en dessous de la réalité (une seule page notée alors
    // que le DAO en utilise deux, une par tableau) — quand la pièce a
    // PLUSIEURS tableaux, on laisse une chance à splitPagesByOwnTitle de
    // retrouver la vraie page manquante (voir son extension de recherche).
    const hasMultipleTables = (item.template_tables?.length ?? 0) > 1;
    if (item.template_origin !== "dao" || (pages.length < 2 && !hasMultipleTables)) { result.push(item); continue; }
    const sortedPages = [...new Set(pages)].sort((a, b) => a - b);
    // Les intitulés des tableaux déjà connus de CETTE pièce (jamais codés en
    // dur) aident à repérer une limite de page même sans titre stylé détecté
    // — voir le commentaire dans splitPagesByOwnTitle.
    const ownTableTitles = (item.template_tables ?? []).map((table) => table.title);
    let segments: Awaited<ReturnType<typeof splitPagesByOwnTitle>> = [];
    try {
      segments = await splitPagesByOwnTitle(pdfBytes, sortedPages, ownTableTitles);
    } catch {
      segments = [];
    }
    // Un seul segment trouvé : aucune autre pièce détectée dans cette plage,
    // l'item d'origine reste inchangé (cas normal, largement majoritaire).
    if (segments.length < 2) { result.push(item); continue; }

    // Répartit chaque champ connu (fields) vers le bon segment, grâce à la
    // page où l'IA avait situé sa position (template_fill_positions). Un
    // champ sans position connue (rare) reste sur le TOUT PREMIER segment
    // plutôt que de disparaître silencieusement.
    const positions = item.template_fill_positions ?? [];
    const fieldsBySegment: Field[][] = segments.map(() => []);
    for (const field of item.fields) {
      const matchingPositions = positions.filter((position) => position.field_key === field.key);
      const segmentIndex = matchingPositions.length
        ? segments.findIndex((segment) => matchingPositions.some((position) => segment.pages.includes(position.page)))
        : -1;
      fieldsBySegment[segmentIndex === -1 ? 0 : segmentIndex].push(field);
    }

    // Même principe pour les tableaux : on cherche sur quelles pages du
    // segment le TEXTE de son intitulé apparaît réellement (aucun tableau
    // n'a de numéro de page stocké directement). Un tableau qu'aucun segment
    // ne revendique reste lui aussi sur le premier segment, jamais perdu.
    const tablesBySegment: TemplateTable[][] = segments.map(() => []);
    for (const table of item.template_tables ?? []) {
      let placedIndex = -1;
      for (let index = 0; index < segments.length; index += 1) {
        const matches = await pagesContainingText(pdfBytes, segments[index].pages, table.title);
        if (matches.size > 0) { placedIndex = index; break; }
      }
      tablesBySegment[placedIndex === -1 ? 0 : placedIndex].push(table);
    }

    // Le texte complet du modèle (template_text) couvrait jusqu'ici TOUTE la
    // pièce fusionnée à tort : sans le répartir lui aussi, chaque morceau
    // séparé continuait de recevoir le texte des 5 fiches à la fois, d'où le
    // mélange/débordement observé à l'impression (mots coupés, colonnes de
    // tableau écrasées dans un paragraphe). On repère où le titre de CHAQUE
    // segment apparaît dans ce texte (déjà écrit dans l'ordre du DAO), puis
    // on découpe entre deux titres consécutifs — jamais de mot recherché en
    // dur, seulement les titres déjà détectés page par page ci-dessus.
    const templateText = item.template_text?.trim() ?? "";
    const textBySegment: (string | undefined)[] = segments.map(() => undefined);
    if (templateText) {
      const lowerText = templateText.toLowerCase();
      const found = segments
        .map((segment, index) => ({ index, start: segment.title ? lowerText.indexOf(segment.title.toLowerCase()) : -1 }))
        .filter((entry) => entry.start !== -1)
        .sort((a, b) => a.start - b.start);
      if (found.length) {
        found.forEach((entry, orderIndex) => {
          const nextStart = orderIndex + 1 < found.length ? found[orderIndex + 1].start : templateText.length;
          textBySegment[entry.index] = templateText.slice(entry.start, nextStart).trim();
        });
        // Texte avant le tout premier titre retrouvé (souvent un en-tête
        // commun aux 5 fiches, ex. "Nom ou raison sociale du candidat :")
        // rattaché au premier segment plutôt que perdu.
        const leadingText = templateText.slice(0, found[0].start).trim();
        if (leadingText) textBySegment[0] = textBySegment[0] ? `${leadingText}\n\n${textBySegment[0]}` : leadingText;
      } else {
        // Aucun des titres détectés sur les vraies pages ne se retrouve mot
        // pour mot dans template_text (formulation légèrement différente) :
        // on garde tout le texte d'origine sur le premier segment plutôt que
        // de le perdre ou de le deviner.
        textBySegment[0] = templateText;
      }
    }

    segments.forEach((segment, index) => {
      result.push({
        ...item,
        title: segment.title || item.title,
        template_page_numbers: segment.pages,
        source_reference: `Pages ${segment.pages.join(", ")}`,
        fields: fieldsBySegment[index],
        template_tables: tablesBySegment[index],
        template_text: textBySegment[index],
      });
    });
  }
  return result;
}
