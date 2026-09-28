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
import { splitPagesByOwnTitle, pagesContainingText, firstPageAnnexeNumber, pageHasReliableOwnTitle, resolveAnnexeTitleForPage, extendDaoItemPages } from "@/lib/submission/trim-to-relevant-pages";
import { knownPagesForItem } from "@/lib/submission/parse-page-reference";
import { titleSimilarity } from "@/lib/submission/title-match";
import type { Field, TemplateDetectedItem, TemplateTable } from "@/lib/submission/build-dossier-items";

// BUG corrigé (vérifié empiriquement, tests avec les vraies 30 lignes de la
// base de données de Maxime) : une première version appelait
// extendDaoItemPages AVANT splitPagesByOwnTitle, sur la plage encore
// non étendue — ce qui semblait logique (Annexe 6 devait bien s'étendre
// jusqu'à 261 avant d'être examinée) mais a provoqué une régression bien
// pire sur une autre pièce : "Annexe 1 - Liste des plans" (notée par l'IA
// "Page 119 et bloc plans 120-230", une formulation non standard que
// knownPagesForItem ne reconnaît que comme [119]) se faisait alors étendre
// automatiquement sur PLUS DE 100 pages de plans architecturaux (rien
// d'autre ne les revendiquait), et CETTE plage énorme, une fois repassée
// dans splitPagesByOwnTitle, se faisait fragmenter en une quinzaine de
// fausses pièces séparées : chaque légende de plan ("BATIMENT A 2 SALLES DE
// CLASSE", "VII - PEINTURE ET VITRERIE", un en-tête de colonnes de
// tableau...) prise à tort pour le titre d'un nouveau document, alors que
// splitPagesByOwnTitle n'a jamais été conçu pour trancher dans un territoire
// que l'IA n'a pas validé (voir son propre commentaire, "titre à la fois EN
// MAJUSCULES ET EN GRAS" — un plan architectural en est plein sans que ce
// soit jamais un vrai changement de pièce).
//
// La bonne séparation des deux rôles : splitPagesByOwnTitle DÉCOUVRE des
// pièces DISTINCTES à l'intérieur des pages QUE L'IA A DÉJÀ DÉCLARÉES pour
// cette pièce (territoire vérifié) ; extendDaoItemPages ALLONGE seulement la
// toute DERNIÈRE de ces pièces vers des pages suivantes non réclamées
// (territoire jamais vérifié par l'IA), sans jamais y rechercher de nouveau
// titre stylé. On applique donc désormais extendDaoItemPages TOUJOURS EN
// DERNIER, une fois splitPagesByOwnTitle déjà passé, et seulement sur le
// dernier segment obtenu — ses pages étendues ne sont plus jamais
// redonnées à splitPagesByOwnTitle.
//
// BUG corrigé (vérifié empiriquement sur un DAO réel, avec les vraies 30
// lignes de la base de Maxime) : "B2 - CAUTION PERSONNELLE ET SOLIDAIRE DE
// SOUMISSION" (page 20, une pièce qui n'a RIEN d'une annexe) s'est fait
// avaler à tort la page 21 SUIVANTE — le vrai début d'un tout autre document
// ("ANNEXE 1 MARCHE A PRIX FORFAITAIRE... BORDEREAU DETAIL QUANTITATIF")
// pourtant bien marqué "ANNEXE 1" en toutes lettres. Cause : la page 20 ne
// contient elle-même aucun numéro d'annexe, seule une correspondance de
// TITRE SEUL avec le sommaire du DAO (voir resolveAnnexeTitleForPage,
// allowTitleOnlyMatch) a deviné à tort le numéro 1 (vocabulaire de
// cautionnement partagé avec une autre Annexe 1, "Modèle de garantie
// bancaire", dans une partie différente du DAO) ; ce numéro deviné a ensuite
// été comparé au numéro 1 RÉELLEMENT écrit sur la page 21 — comme les deux
// coïncidaient, l'extension a cru qu'il s'agissait de la MÊME annexe qui
// continue, alors que les numéros d'annexe RECOMMENCENT à 1 dans chaque
// grande partie du DAO (vérifié ailleurs dans ce fichier) : "Annexe 1" peut
// donc légitimement désigner 2 ou 3 documents totalement différents selon
// l'endroit du DAO. Cette confusion n'est possible QUE parce que B2 n'est en
// réalité pas une annexe du tout — son titre ne contient ni "Annexe" ni
// "Chapitre". On limite donc désormais toute tentative d'extension aux
// pièces dont le TITRE (déjà donné par l'IA) mentionne déjà l'un de ces deux
// mots — exactement la consigne d'origine de Maxime ("trouver les annexe ou
// chapitre comme titre") : les formulaires B1, B2, CCAP, A1 à A5, Lettre de
// soumission... n'ont jamais souffert du problème de troncature que cette
// extension corrige, et échapper désormais à toute tentative d'extension sur
// eux élimine ce risque de collision de numéro sans rien retirer à la
// correction pour les vraies annexes/chapitres.
function looksLikeAnnexeOrChapitreTitle(title: string): boolean {
  return /\b(annexe|chapitre)\b/i.test(title);
}

async function extendTailPages(pdfBytes: Uint8Array, itemTitle: string, referencePageForNumber: number, lastKnownPage: number, claimedPages: Set<number>): Promise<number[]> {
  if (!looksLikeAnnexeOrChapitreTitle(itemTitle)) return [];
  try {
    // allowTitleOnlyMatch reste à son défaut (true) ici : cet usage est
    // interne, jamais montré à Maxime tel quel (voir le commentaire de
    // resolveAnnexeTitleForPage) — un faux numéro trouvé ne fait au pire que
    // mal régler ce repère interne, jamais un titre affiché. Le garde-fou
    // looksLikeAnnexeOrChapitreTitle ci-dessus limite déjà cet usage aux
    // pièces où une confusion de numéro entre deux "Annexe 1" différentes
    // n'a jamais posé de problème observé (toujours dans la même grande
    // partie du DAO que les autres annexes déjà listées).
    const startResolved = await resolveAnnexeTitleForPage(pdfBytes, referencePageForNumber);
    const extra = await extendDaoItemPages(pdfBytes, lastKnownPage, claimedPages, startResolved?.number ?? null);
    for (const page of extra) claimedPages.add(page);
    return extra;
  } catch {
    return [];
  }
}

export async function splitMergedDaoItems<T extends TemplateDetectedItem>(items: T[], pdfBytes: Uint8Array | null): Promise<T[]> {
  if (!pdfBytes) return items;
  // Plage de pages DÉJÀ connue de chaque pièce DAO, calculée une seule fois
  // pour toutes AVANT tout traitement — sert de garde-fou à
  // extendTailPages plus bas : jamais étendre une pièce sur des pages qui
  // appartiennent déjà à une AUTRE pièce, même si cette autre pièce n'a pas
  // encore été traitée dans la boucle ci-dessous.
  const claimedPages = new Set<number>();
  for (const other of items) if (other.template_origin === "dao") for (const page of knownPagesForItem(other)) claimedPages.add(page);

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
    // séparée. On combine donc toujours les deux sources via
    // knownPagesForItem (fonction partagée, voir parse-page-reference.ts) —
    // jamais une union réécrite à la main ici.
    const pages = knownPagesForItem(item);
    // Un item qui ne vient pas d'une vraie page du DAO ne peut par définition
    // pas avoir fusionné deux pièces différentes : rien à vérifier. Une seule
    // page déclarée ne suffit PAS à elle seule à l'exclure : l'IA compte
    // parfois les pages en dessous de la réalité (une seule page notée alors
    // que le DAO en utilise deux, une par tableau) — quand la pièce a
    // PLUSIEURS tableaux, on laisse une chance à splitPagesByOwnTitle de
    // retrouver la vraie page manquante (voir son extension de recherche).
    const hasMultipleTables = (item.template_tables?.length ?? 0) > 1;
    if (item.template_origin !== "dao" || (pages.length < 2 && !hasMultipleTables)) {
      // Pas de découpage nécessaire ici, mais une pièce DAO isolée peut quand
      // même avoir été tronquée par l'IA (cas de l'Annexe 6/7/8) : on tente
      // toujours l'extension de la queue avant de la garder telle quelle.
      if (item.template_origin === "dao" && pages.length) {
        const sortedKnown = [...new Set(pages)].sort((a, b) => a - b);
        const extra = await extendTailPages(pdfBytes, item.title, sortedKnown[0], sortedKnown[sortedKnown.length - 1], claimedPages);
        if (extra.length) {
          const mergedPages = [...sortedKnown, ...extra];
          result.push({ ...item, template_page_numbers: mergedPages, source_reference: `Pages ${mergedPages.join(", ")}` });
          continue;
        }
      }
      result.push(item);
      continue;
    }
    const sortedPages = [...new Set(pages)].sort((a, b) => a - b);
    // Les intitulés des tableaux déjà connus de CETTE pièce (jamais codés en
    // dur) aident à repérer une limite de page même sans titre stylé détecté
    // — voir le commentaire dans splitPagesByOwnTitle.
    const ownTableTitles = (item.template_tables ?? []).map((table) => table.title);
    let segments: Awaited<ReturnType<typeof splitPagesByOwnTitle>> = [];
    try {
      // IMPORTANT : toujours sortedPages (la plage déclarée par l'IA, JAMAIS
      // étendue) — voir le commentaire d'extendTailPages plus haut sur la
      // raison de cet ordre.
      segments = await splitPagesByOwnTitle(pdfBytes, sortedPages, ownTableTitles);
    } catch {
      segments = [];
    }
    // Un seul segment trouvé : aucune autre pièce détectée dans cette plage.
    // On tente quand même l'extension de la queue (même logique que la
    // branche ci-dessus) avant de garder l'item d'origine inchangé (cas
    // normal, largement majoritaire).
    if (segments.length < 2) {
      const extra = await extendTailPages(pdfBytes, item.title, sortedPages[0], sortedPages[sortedPages.length - 1], claimedPages);
      if (extra.length) {
        const mergedPages = [...sortedPages, ...extra];
        result.push({ ...item, template_page_numbers: mergedPages, source_reference: `Pages ${mergedPages.join(", ")}` });
      } else {
        result.push(item);
      }
      continue;
    }

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

    // Extension de la queue (voir extendTailPages plus haut) : appliquée
    // SEULEMENT au DERNIER segment obtenu ci-dessus — jamais avant le
    // découpage, jamais sur un segment intermédiaire (dont la page suivante
    // appartient déjà, par définition, au segment suivant).
    const lastSegment = segments[segments.length - 1];
    const extraTailPages = await extendTailPages(pdfBytes, item.title, lastSegment.pages[0], lastSegment.pages[lastSegment.pages.length - 1], claimedPages);

    segments.forEach((segment, index) => {
      const isLastSegment = index === segments.length - 1;
      const segmentPages = isLastSegment && extraTailPages.length ? [...segment.pages, ...extraTailPages] : segment.pages;
      result.push({
        ...item,
        title: segment.title || item.title,
        template_page_numbers: segmentPages,
        source_reference: `Pages ${segmentPages.join(", ")}`,
        fields: fieldsBySegment[index],
        template_tables: tablesBySegment[index],
        template_text: textBySegment[index],
      });
    });
  }

  // PASSE FINALE (généralisée, pour n'importe quel DAO) : deux corrections
  // après-coup supplémentaires sur la liste COMPLÈTE des pièces, une fois
  // chaque pièce déjà fusionnée séparée ci-dessus — s'appliquent aussi à une
  // pièce que l'IA avait DÉJÀ détectée comme une pièce à part entière (une
  // seule page connue), jamais seulement aux pièces qui viennent d'être
  // séparées plus haut.
  //
  // 1) Numéro d'annexe explicite (ou titre retrouvé via le sommaire du DAO,
  // voir resolveAnnexeTitleForPage) mal repris comme titre — deux cas déjà
  // observés par Maxime : une pièce "ANNEXE 7" affichée sous le titre du
  // ministère qui apparaît juste en dessous sur la même page ; et une pièce
  // "Annexe 6" absente de la liste car sa propre page de début (la
  // convention elle-même) ne contient NULLE PART le mot "annexe", seul le
  // sommaire du DAO le sait. On corrige le titre affiché dès que l'un ou
  // l'autre est trouvé sur la PROPRE première page connue de la pièce, quel
  // que soit le titre que l'IA lui avait donné.
  //
  // 2) Fragment isolé sans titre propre fiable (signalé par Maxime : "COULEUR"
  // affiché comme une pièce à part entière, avec EXACTEMENT les mêmes
  // instructions que la pièce juste avant elle) : une pièce DAO d'une seule
  // page qui suit IMMÉDIATEMENT la dernière page d'une AUTRE pièce déjà
  // détectée, sans numéro d'annexe ni titre stylé fiable sur sa propre page
  // (voir pageHasReliableOwnTitle, qui applique déjà le filtre "un mot seul
  // n'est pas un titre" — voir pageHeadingLine), et dont les instructions
  // sont identiques à celles de la pièce précédente, est en réalité un
  // simple fragment de cette pièce précédente (une étiquette de champ, la
  // fin d'un tableau...) — on la fusionne dans la pièce précédente plutôt que
  // de l'afficher comme une pièce séparée.
  if (pdfBytes) {
    for (let index = 0; index < result.length; index += 1) {
      const item = result[index];
      if (item.template_origin !== "dao") continue;
      const ownPages = knownPagesForItem(item);
      if (!ownPages.length) continue;
      try {
        // allowTitleOnlyMatch=false ICI (contrairement à l'amorçage de
        // extendDaoItemPages plus haut) : cette passe RENOMME le titre
        // affiché à Maxime, et une correspondance par titre seul (sans
        // aucun numéro d'annexe explicite trouvé sur la page) s'est révélée
        // trop peu fiable en pratique (vérifié : "B2 - Caution personnelle"
        // renommée à tort en "Annexe 1 : Modèle de garantie bancaire", les
        // deux textes partageant assez de vocabulaire de cautionnement/
        // garantie bancaire pour dépasser le seuil de similarité). On ne
        // renomme donc plus ici que lorsqu'un numéro d'annexe est VRAIMENT
        // écrit sur la propre page de la pièce.
        const resolved = await resolveAnnexeTitleForPage(pdfBytes, ownPages[0], null, false);
        if (resolved) {
          const canonicalTitle = resolved.title ? `Annexe ${resolved.number} : ${resolved.title}` : `Annexe ${resolved.number}`;
          // BUG corrigé (vérifié directement en base par Maxime : une pièce
          // "Annexe 5 - Liste des plans" alors que "Liste des plans" est en
          // réalité l'Annexe 1 — le numéro 5 est déjà pris par "Code de
          // conduite"). titleSimilarity ne compare que les MOTS du titre
          // (significantWords ignore les nombres, trop courts) : un mauvais
          // numéro accolé au bon titre descriptif ("Annexe 5" au lieu
          // d'"Annexe 1", "Liste des plans" inchangé) obtenait donc une
          // similarité proche de 100%, jamais assez basse pour déclencher la
          // correction. On compare aussi explicitement le numéro déjà écrit
          // dans le titre actuel (s'il y en a un) au numéro retrouvé : un
          // simple désaccord de numéro suffit à lui seul à corriger le
          // titre, même quand le reste du texte se ressemble beaucoup.
          const currentNumberMatch = /\bannexe\s*(?:n[o°]?\.?\s*)?(\d{1,2})\b/i.exec(item.title);
          const currentNumber = currentNumberMatch ? Number(currentNumberMatch[1]) : null;
          const numberMismatch = currentNumber !== null && currentNumber !== resolved.number;
          if (numberMismatch || titleSimilarity(item.title, canonicalTitle) < 0.6) result[index] = { ...item, title: canonicalTitle };
        }
      } catch {
        // Page illisible pour cette vérification : titre laissé tel quel.
      }
    }
    for (let index = result.length - 1; index > 0; index -= 1) {
      const current = result[index];
      const previous = result[index - 1];
      if (current.template_origin !== "dao" || previous.template_origin !== "dao") continue;
      const currentPages = knownPagesForItem(current);
      const previousPages = knownPagesForItem(previous);
      if (currentPages.length !== 1 || !previousPages.length) continue;
      if (currentPages[0] !== previousPages[previousPages.length - 1] + 1) continue;
      if (current.instructions.trim() !== previous.instructions.trim()) continue;
      try {
        const hasOwnAnnexe = (await firstPageAnnexeNumber(pdfBytes, currentPages[0])) !== null;
        const hasOwnTitle = await pageHasReliableOwnTitle(pdfBytes, currentPages[0]);
        if (hasOwnAnnexe || hasOwnTitle) continue;
      } catch {
        continue; // Page illisible pour cette vérification : jamais fusionnée par prudence.
      }
      const mergedPages = [...previousPages, ...currentPages];
      result[index - 1] = {
        ...previous,
        template_page_numbers: mergedPages,
        source_reference: `Pages ${mergedPages.join(", ")}`,
        fields: [...previous.fields, ...current.fields],
        template_tables: [...(previous.template_tables ?? []), ...(current.template_tables ?? [])],
      };
      result.splice(index, 1);
    }
  }
  return result;
}
