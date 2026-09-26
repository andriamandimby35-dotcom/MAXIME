// Logique de construction du dossier de soumission MAÎTRE (un par DAO),
// partagée entre la page qui l'affiche (app/(dashboard)/tenders/[id]/
// submission/page.tsx) et la route qui le GÉNÈRE explicitement (app/api/
// tenders/[id]/submission-dossier/generate/route.ts). Avant, cette liste
// était reconstruite automatiquement à chaque ouverture de la page, sans
// bouton "Générer" ni possibilité de suppression réelle (une suppression ne
// faisait que vider les cases, la liste réapparaissait aussitôt) : on la
// centralise ici pour que les deux endroits produisent exactement la même
// liste de pièces.
import { findBestTitleMatch } from "@/lib/submission/title-match";
import { parsePageNumbersFromReference } from "@/lib/submission/parse-page-reference";

export type Field = { key: string; label: string; required: boolean; description: string };

export type DetectedItem = {
  kind: "document_to_provide" | "form_to_complete";
  title: string;
  source_reference: string;
  instructions: string;
  required: boolean;
  fields: Field[];
  // Uniquement sur les pièces génériques de secours (standardSubmissionItems
  // ci-dessous) qui font presque toujours partie du DAO lui-même (CCAP,
  // plans, calendrier cultural, code de conduite...) plutôt que d'être un
  // document externe déjà en possession de l'entreprise (CIN, RIB...). Sert
  // uniquement à proposer un bouton "Ouvrir le document à imprimer" qui
  // tente de RETROUVER cette pièce dans le DAO (voir locateTitleInFullDocument)
  // quand l'IA ne l'a pas identifiée pour ce DAO précis — jamais pour un
  // document que le DAO ne contient de toute façon pas.
  likely_in_dao?: boolean;
};

export type TemplateTable = { title: string; columns: string[]; rows: string[][]; organization_column_indexes?: number[]; repeatable?: boolean };

export type TemplateDetectedItem = DetectedItem & {
  prefilled_values?: Array<{ key: string; value: string }>;
  template_origin?: "dao" | "internet" | "generated" | "none";
  template_page_numbers?: number[];
  // Transmis tel quel jusqu'au dossier affiché côté client, uniquement pour
  // qu'un éditeur à lignes ("+ Ajouter une ligne") puisse repérer les
  // tableaux marqués repeatable (voir le prompt d'analyse) et laisser
  // l'utilisateur y ajouter autant de lignes que nécessaire ; le contenu et
  // le rendu PDF réels restent construits côté serveur à partir de ces
  // mêmes lignes.
  template_tables?: TemplateTable[];
  // Titre de la grande division du sommaire du DAO (ex. "Partie II. Les
  // formulaires de soumission comprenant :") sous laquelle cette pièce se
  // trouve — calculé par buildMasterDetectedItems à partir des lignes
  // level=0 de submission_checklist (voir plus bas), uniquement pour
  // afficher un titre de section dans le dossier ; null si le sommaire du
  // DAO n'a pas de grandes divisions ou si cette pièce n'a pas pu y être
  // rattachée.
  dossierSection?: string | null;
};

// Une ligne level=0 est une grande division du sommaire (ex. "Partie I",
// "Partie II"...) qui sert de titre de section dans le dossier affiché ;
// une ligne level=1 est une pièce ou sous-annexe listée sous cette division.
// Un ancien résultat d'analyse enregistré avant l'ajout de ce champ n'a pas
// de level : il est alors traité comme une ligne ordinaire (level=1), donc
// sans titre de section affiché — comportement identique à avant.
export type ChecklistEntry = { title: string; sequence: number; source_reference?: string; level?: number };

export type MasterAnalysis = {
  submission_items?: DetectedItem[];
  // Sommaire propre au DAO (ex. son "Article 6 - Dossier d'Appel d'Offres")
  // qui énumère, dans l'ordre exact du document, toutes les pièces à
  // fournir — voir le prompt d'analyse. Sert UNIQUEMENT à ordonner
  // l'affichage ci-dessous ; jamais à modifier le contenu d'une pièce.
  submission_checklist?: ChecklistEntry[];
} | null;

function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Pièces génériques de secours qui font presque toujours partie du DAO
// lui-même (paraphées/signées sur ses propres pages) : quand l'IA ne les a
// pas retrouvées pour un DAO précis, le bouton "Ouvrir le document à
// imprimer" tente automatiquement de les localiser dans le document (voir
// locateTitleInFullDocument et likely_in_dao ci-dessus) au lieu de rester
// une carte sans aucun PDF.
//
// Exportée (pas seulement un Set interne) pour que la route qui génère
// vraiment le PDF (printable-submission-document/route.ts) reconnaisse CES
// MÊMES pièces : si aucune des méthodes de recherche ne retrouve l'une
// d'elles nulle part dans le DAO, ce n'est presque toujours pas une panne de
// l'extraction, mais le signe que ce DAO précis ne demande simplement pas ce
// document — mieux vaut le dire clairement que fabriquer un faux PDF vide
// avec juste les coordonnées de l'entreprise et des lignes de signature.
export const daoSourcedGenericTitles = [
  "Plan à parapher", "Cahier des clauses administratives particulières (CCAP) signé", "Calendrier cultural", "Code de conduite signé",
];
const daoSourcedGenericTitleSet = new Set(daoSourcedGenericTitles);

// DEUX catégories bien différentes dans la liste de secours (demandé par
// Maxime après avoir vu trop de cartes génériques "va le chercher toi-même"
// pour des pièces que le DAO ne demande en fait pas du tout) :
//
// 1) companyStandardItems : des documents que L'ENTREPRISE possède déjà (CIN,
//    NIF, STAT, registre du commerce, RIB, attestations bancaires,
//    certificats...) — jamais un vrai modèle imprimé du DAO. Un dossier de
//    soumission BTP à Madagascar les exige presque toujours en pratique,
//    même quand le DAO précis ne les cite pas mot pour mot : on continue donc
//    de toujours les proposer comme rappel, que l'IA les ait retrouvées ou
//    non dans CE DAO.
//
// 2) daoFormStandardItems : de VRAIS formulaires/modèles qui doivent venir du
//    DAO lui-même (garantie bancaire, pouvoir, litiges, planning...). Pour
//    ceux-là, on n'affiche PLUS de carte générique quand l'IA ne les a pas
//    retrouvés pour ce DAO précis (voir buildMasterDetectedItems plus bas) :
//    si l'analyse (renforcée côté analyze-dao pour bien chercher dans tout le
//    document, pas seulement dans le sommaire) ne trouve vraiment rien, la
//    pièce n'apparaît pas du tout plutôt que d'encombrer le dossier d'une
//    pièce que ce DAO ne demande simplement pas.
export const companyStandardItems: DetectedItem[] = [
  "Certificats de bonnes fins ou procès-verbaux de réception", "Photocopie certifiée conforme de la carte d’immatriculation fiscale", "Photocopie certifiée conforme de la carte statistique", "Registre du commerce (ou des métiers)", "Reçu d’achat du Dossier d’Appel d’Offres", "Attestation de disponibilité de liquidité ou de ligne de crédit", "Relevé d’identité bancaire", "CIN légalisée du signataire", "Certificat de résidence du signataire", "Pièces justificatives des matériels",
].map((title) => ({ kind: "document_to_provide" as const, title, source_reference: "À confirmer dans le DAO", instructions: "Joignez le document signé ou certifié conforme demandé par le DAO.", required: true, fields: [] }));

export const daoFormStandardItems: DetectedItem[] = [
  "Plan à parapher", "Calendrier cultural", "Code de conduite signé", "Cahier des clauses administratives particulières (CCAP) signé",
].map((title) => ({ kind: "document_to_provide" as const, title, source_reference: "À confirmer dans le DAO", instructions: "Joignez le document signé ou certifié conforme demandé par le DAO.", required: true, fields: [], ...(daoSourcedGenericTitleSet.has(title) ? { likely_in_dao: true } : {}) }));

daoFormStandardItems.push(
  { kind: "form_to_complete", title: "Lettre de soumission / acte d’engagement", source_reference: "À confirmer dans le DAO", instructions: "Complétez, imprimez, signez puis insérez la version signée.", required: true, fields: [{ key: "legal_name", label: "Entreprise soumissionnaire", required: true, description: "Raison sociale" }, { key: "representative_name", label: "Signataire", required: true, description: "Nom du signataire" }] },
  { kind: "form_to_complete", title: "Pouvoir du signataire", source_reference: "À confirmer dans le DAO", instructions: "Complétez le pouvoir puis joignez la version signée.", required: true, fields: [{ key: "representative_name", label: "Signataire", required: true, description: "Nom complet" }, { key: "representative_role", label: "Fonction", required: true, description: "Fonction du signataire" }] },
  { kind: "form_to_complete", title: "Fiches de renseignements du candidat A1 à A5", source_reference: "À confirmer dans le DAO", instructions: "Complétez les fiches avec les informations de l’entreprise, puis joignez-les.", required: true, fields: [{ key: "legal_name", label: "Raison sociale", required: true, description: "Entreprise" }, { key: "address", label: "Adresse", required: true, description: "Adresse complète" }, { key: "nif", label: "NIF", required: true, description: "NIF" }, { key: "stat", label: "STAT", required: true, description: "STAT" }] },
  { kind: "form_to_complete", title: "Garantie bancaire de soumission B1", source_reference: "À confirmer dans le DAO", instructions: "Renseignez la garantie puis joignez le justificatif bancaire.", required: true, fields: [] },
  { kind: "form_to_complete", title: "Caution personnelle", source_reference: "À confirmer dans le DAO", instructions: "Complétez et joignez la caution demandée.", required: true, fields: [] },
  { kind: "form_to_complete", title: "Liste des travaux similaires déjà exécutés", source_reference: "À confirmer dans le DAO", instructions: "Complétez le tableau des références de travaux similaires selon le modèle DAO, puis joignez la version signée.", required: true, fields: [] },
  { kind: "form_to_complete", title: "Planning d’exécution des travaux", source_reference: "À confirmer dans le DAO", instructions: "Vérifiez le planning proposé par l’IA, imprimez-le si nécessaire et joignez la version validée.", required: true, fields: [] },
  { kind: "form_to_complete", title: "Liste du personnel et de leurs fonctions", source_reference: "À confirmer dans le DAO", instructions: "Ajoutez la liste nominative et les fonctions, puis joignez le document final.", required: true, fields: [] },
  { kind: "form_to_complete", title: "Liste et poids des matériaux estimés à transporter", source_reference: "À confirmer dans le DAO", instructions: "Vérifiez les quantités déduites du devis puis joignez la liste validée.", required: true, fields: [] },
  { kind: "form_to_complete", title: "Liste des plans", source_reference: "À confirmer dans le DAO", instructions: "Liste générée par l’IA à partir des plans et annexes présents dans le DAO.", required: true, fields: [] },
);

// Conservé pour compatibilité (rien d'autre dans le projet ne l'importe
// directement aujourd'hui, mais mieux vaut ne pas supprimer un export
// public sans y être obligé) : la réunion des deux catégories ci-dessus.
export const standardSubmissionItems: DetectedItem[] = [...companyStandardItems, ...daoFormStandardItems];

const hasAppComputedContent = (title: string) => /planning.*ex.cution/i.test(title)
  || /mat.riaux.*transport/i.test(title) || /\bplans?\b/i.test(title) || /personnel/i.test(title);

// Reproduit exactement la logique de app/(dashboard)/tenders/[id]/submission/
// page.tsx : un élément générique de la liste type ne s'affiche que si l'IA
// n'a pas trouvé de vraie pièce correspondante dans CE DAO précis.
export function buildMasterDetectedItems(analysis: MasterAnalysis): TemplateDetectedItem[] {
  const aiItems = Array.isArray(analysis?.submission_items) ? analysis.submission_items : [];
  // Une pièce générique de secours ("Cahier des clauses administratives
  // particulières (CCAP) signé") et la VRAIE pièce que l'IA a détectée dans
  // CE DAO précis (ex. "CCAP / Contrat des Travaux") sont souvent formulées
  // de façon si différente que la comparaison directe de leurs titres
  // (findBestTitleMatch juste en dessous) ne les reconnaît pas comme le même
  // document : elles ne partagent presque aucun mot ("cahier", "clauses",
  // "administratives", "particulières" d'un côté, "contrat", "travaux" de
  // l'autre — seul "ccap" est commun). Le résultat était un doublon affiché
  // : la vraie pièce ET la pièce générique côte à côte, alors qu'il ne faut
  // la demander qu'une seule fois.
  //
  // On ne rajoute PAS de cas particulier pour "CCAP" ou un autre sigle (déjà
  // essayé, rejeté : ça ne se concentre plus sur le titre et ça provoque
  // d'autres erreurs ailleurs). On utilise à la place le sommaire officiel
  // du DAO (submission_checklist, déjà utilisé juste plus bas pour ordonner
  // les pièces) comme pont entre les deux formulations : si la pièce
  // générique ET une pièce IA se rapprochent chacune de la MÊME ligne de ce
  // sommaire (avec le même outil de rapprochement de titres partout,
  // findBestTitleMatch), c'est que ce sommaire les désigne comme UNE seule
  // et même pièce du DAO, même si leurs titres ne se ressemblent pas
  // directement entre eux.
  //
  // Le contrôle visuel (vérifier une par une les pièces demandées par le
  // DAO — voir son propre sommaire, ex. "Article 6 - Dossier d'Appel
  // d'Offres") est bien plus simple quand l'application affiche les pièces
  // EXACTEMENT dans l'ordre où le DAO les liste lui-même, plutôt que
  // regroupées par catégorie ou dans l'ordre où l'IA les a rencontrées en
  // lisant le document (souvent proche de l'ordre des pages, mais pas de
  // l'ordre du sommaire officiel du DAO). submission_checklist recopie ce
  // sommaire officiel tel quel (voir le prompt d'analyse) : c'est la source
  // de vérité pour l'ordre — ET, comme expliqué au-dessus, le pont utilisé
  // pour repérer les doublons entre une pièce générique et sa vraie pièce IA.
  const checklist = Array.isArray(analysis?.submission_checklist) ? analysis.submission_checklist : [];
  // Seules les lignes level=1 (pièces réelles) servent à rapprocher un titre
  // détecté de sa place dans le sommaire ; une ligne level=0 (titre de
  // grande division, ex. "Partie II. Les formulaires de soumission...") ne
  // désigne aucune pièce précise et ne doit jamais être proposée comme
  // correspondance de titre.
  const orderableChecklist = checklist.filter((entry) => entry.level !== 0);
  // Première page connue d'une pièce : template_page_numbers (renseigné
  // seulement pour les pièces avec un vrai modèle imprimable), sinon la page
  // lue dans source_reference (renseigné pour chaque pièce, via
  // parsePageNumbersFromReference, déjà utilisé pour savoir si un PDF est
  // imprimable). Number.POSITIVE_INFINITY si aucune page n'est connue.
  const firstKnownPage = (item: TemplateDetectedItem) => {
    const templatePages = item.template_page_numbers;
    const fromTemplate = Array.isArray(templatePages) && templatePages.length ? templatePages[0] : undefined;
    const fromReference = parsePageNumbersFromReference(item.source_reference)[0];
    const known = [fromTemplate, fromReference].filter((page): page is number => typeof page === "number");
    return known.length ? Math.min(...known) : Number.POSITIVE_INFINITY;
  };
  // Repli par PAGE quand le titre ne suffit pas à rapprocher une pièce d'une
  // ligne du sommaire (formulation trop différente de part et d'autre pour
  // findBestTitleMatch — c'est ce qui faisait retomber "Lettre de
  // soumission" et d'autres pièces pourtant bien identifiées par l'IA tout
  // en bas, dans "Autres pièces (position non repérée dans le sommaire du
  // DAO)", même quand le DAO les liste clairement à un endroit précis).
  // Repère chaque ligne du sommaire dont la page est elle-même connue
  // (source_reference), triée par sequence, et intercale une pièce non
  // reconnue par titre ENTRE les deux repères qui encadrent sa propre page.
  // Aucun nouvel appel à l'IA n'est nécessaire : tout vient de l'analyse déjà
  // enregistrée (submission_checklist et submission_items existants).
  //
  // Utilise le sommaire COMPLET (checklist, pas orderableChecklist) : les
  // grandes divisions (level=0, ex. "Partie II. Les formulaires...") sont
  // exclues du rapprochement PAR TITRE (une pièce ne doit jamais sembler
  // "correspondre" à un simple titre de section), mais ce sont justement
  // elles qui indiquent le plus souvent une page fiable dans le sommaire —
  // les lignes de détail (level=1) n'en ont pas toujours. Les exclure ici
  // aurait privé l'intercalation par page de ses meilleurs repères.
  const checklistPageAnchors = checklist
    .map((entry) => ({ sequence: entry.sequence, page: parsePageNumbersFromReference(entry.source_reference)[0] }))
    .filter((anchor): anchor is { sequence: number; page: number } => typeof anchor.page === "number")
    .sort((a, b) => a.sequence - b.sequence);
  const interpolatedSequenceForPage = (page: number): number | null => {
    if (!checklistPageAnchors.length) return null;
    let previous: { sequence: number; page: number } | null = null;
    let next: { sequence: number; page: number } | null = null;
    for (const anchor of checklistPageAnchors) {
      if (anchor.page <= page) previous = anchor;
      else { next = anchor; break; }
    }
    if (previous && next && previous !== next) return (previous.sequence + next.sequence) / 2;
    if (previous) return previous.sequence + 0.5;
    if (next) return next.sequence - 0.5;
    return null;
  };
  // RÈGLE GÉNÉRALE (pour tout DAO, pas seulement celui qui a révélé ce
  // problème) : un intitulé d'IA ("Lettre de soumission") et sa ligne dans
  // le sommaire officiel du DAO ("Le modèle de soumission et d'engagement")
  // partagent souvent SEULEMENT un mot ("soumission"), ce qui reste sous le
  // seuil strict 0.6 utilisé par ailleurs pour la déduplication — la pièce
  // se retrouvait alors reléguée tout en bas sous "Autres pièces" alors
  // qu'elle est bien présente et bien identifiée. On tente donc TROIS
  // méthodes dans l'ordre, chacune ne servant que si la précédente échoue :
  // 1) rapprochement de titre STRICT (fiable, le même seuil qu'ailleurs) ;
  // 2) rapprochement par PAGE RÉELLE (voir interpolatedSequenceForPage plus
  // haut) quand la page de la pièce et celle d'au moins une ligne du
  // sommaire sont toutes les deux connues ; 3) en tout dernier recours,
  // rapprochement de titre TOLÉRANT (seuil très abaissé, un seul mot-clé
  // partagé suffit) — utilisé UNIQUEMENT ici pour ordonner l'affichage,
  // jamais pour fusionner un doublon générique/IA ailleurs (qui reste au
  // seuil strict), donc un rapprochement imprécis ne coûte au pire qu'un
  // classement légèrement décalé au sein de la bonne grande partie du DAO —
  // jamais une pièce qui disparaît ou qui se fait fusionner à tort.
  const checklistSequence = (item: DetectedItem) => {
    if (!orderableChecklist.length) return null;
    const strictMatch = findBestTitleMatch(item.title, orderableChecklist);
    if (strictMatch) return strictMatch.sequence;
    const page = firstKnownPage(item as TemplateDetectedItem);
    if (page !== Number.POSITIVE_INFINITY) {
      const byPage = interpolatedSequenceForPage(page);
      if (byPage !== null) return byPage;
    }
    const looseMatch = findBestTitleMatch(item.title, orderableChecklist, 0.34);
    return looseMatch ? looseMatch.sequence : null;
  };
  const aiChecklistSequences = new Set(
    aiItems
      .map((item) => checklistSequence(item))
      .filter((sequence): sequence is number => sequence !== null),
  );
  // SEULEMENT companyStandardItems ici (jamais daoFormStandardItems) : c'est
  // le changement demandé par Maxime après avoir vu trop de cartes
  // génériques "va le chercher toi-même" pour des pièces que le DAO ne
  // demande en fait pas du tout. Un vrai formulaire du DAO (garantie
  // bancaire, pouvoir, litiges, planning...) que l'IA n'a pas retrouvé pour
  // CE DAO précis ne doit plus jamais apparaître comme une carte de secours
  // : soit l'IA l'a trouvé (aiItems, plus bas), soit ce DAO précis ne le
  // demande simplement pas et la pièce n'apparaît pas du tout. Seuls les
  // documents que l'entreprise possède déjà (CIN, NIF, STAT, RIB...)
  // continuent d'apparaître systématiquement en rappel.
  const genericItemsWithoutRealMatch = companyStandardItems
    .filter((item) => {
      if (findBestTitleMatch(item.title, aiItems)) return false;
      const sequence = checklistSequence(item);
      return sequence === null || !aiChecklistSequences.has(sequence);
    })
    .map((item) => (item.kind === "form_to_complete" && item.fields.length === 0 && !hasAppComputedContent(item.title)
      ? { ...item, kind: "document_to_provide" as const, instructions: "Récupérez le modèle correspondant dans le DAO, complétez-le à la main avec vos informations, faites-le signer si nécessaire, puis joignez la version scannée." }
      : item));
  // Une pièce toujours sans aucune séquence connue (ni titre reconnu dans le
  // sommaire, ni page exploitable pour l'intercaler — voir checklistSequence
  // plus haut) reste en repli tout à la fin, ordonnée par sa première page
  // connue puis par son ordre d'origine, pour rester visible sans fausser le
  // contrôle.
  // Titres des grandes divisions (level=0), triés par ordre d'apparition
  // dans le sommaire, pour retrouver sous quelle division se trouve une
  // séquence donnée : la dernière division dont le numéro précède ou égale
  // cette séquence. Sert uniquement à afficher un titre de section dans le
  // dossier (voir SubmissionDossierManager.tsx) ; n'affecte jamais l'ordre
  // ni le contenu des pièces.
  const sectionHeaders = checklist
    .filter((entry) => entry.level === 0)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const sectionTitleForSequence = (sequence: number): string | null => {
    if (!sectionHeaders.length || sequence === Number.POSITIVE_INFINITY) return null;
    let current: string | null = null;
    for (const header of sectionHeaders) {
      if (header.sequence <= sequence) current = header.title; else break;
    }
    return current;
  };
  return [...genericItemsWithoutRealMatch, ...aiItems]
    .map((item, index) => ({
      item,
      index,
      sequence: checklistSequence(item) ?? Number.POSITIVE_INFINITY,
      page: firstKnownPage(item as TemplateDetectedItem),
    }))
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : a.page !== b.page ? a.page - b.page : a.index - b.index))
    .map((entry) => ({ ...entry.item, dossierSection: sectionTitleForSequence(entry.sequence) }));
}

// Reproduit exactement deduplicate() de SubmissionDossierManager.tsx : ajoute
// le BDQE externe s'il manque, retire les doublons de titre, et calcule le
// statut de départ + les valeurs déjà connues (prefilled_values). Utilisée
// à la fois pour l'aperçu côté client ET pour l'enregistrement initial en
// base lors d'une génération explicite, afin que les deux ne divergent
// jamais.
export function buildDossierRecordsForInsert<T extends TemplateDetectedItem>(items: T[]) {
  const known = new Set<string>();
  const candidates: TemplateDetectedItem[] = [...items];
  if (!candidates.some((item) => /bdqe|bordereau.*quantitatif|bordereau.*estimatif/i.test(item.title))) {
    candidates.push({
      kind: "document_to_provide",
      title: "BDQE externe signé",
      source_reference: "Devis externe généré pour ce DAO",
      instructions: "Imprimez le BDQE externe, signez et paraphez les pages demandées, puis joignez sa version signée.",
      required: true,
      fields: [],
    });
  }
  return candidates.filter((item) => {
    const key = `${item.kind}:${normalize(item.title)}`;
    if (!item.title.trim() || known.has(key)) return false;
    known.add(key);
    return true;
  }).map((item) => ({
    ...item,
    status: (item.kind === "form_to_complete" ? "needs_information" : "missing") as "missing" | "needs_information",
    form_data: Object.fromEntries((item.prefilled_values ?? []).filter((value) => value.key && value.value).map((value) => [value.key, value.value])),
  }));
}
