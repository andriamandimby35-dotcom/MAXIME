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
};

export type TemplateDetectedItem = DetectedItem & {
  prefilled_values?: Array<{ key: string; value: string }>;
  template_origin?: "dao" | "internet" | "generated" | "none";
  template_page_numbers?: number[];
};

export type ChecklistEntry = { title: string; sequence: number; source_reference?: string };

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

export const standardSubmissionItems: DetectedItem[] = [
  "Plan à parapher", "CCAP paraphé", "Certificats de bonnes fins ou procès-verbaux de réception", "Photocopie certifiée conforme de la carte d’immatriculation fiscale", "Photocopie certifiée conforme de la carte statistique", "Reçu d’achat du Dossier d’Appel d’Offres", "Attestation de disponibilité de liquidité ou de ligne de crédit", "Relevé d’identité bancaire", "CIN légalisée du signataire", "Certificat de résidence du signataire", "Pièces justificatives des matériels", "Calendrier cultural", "Code de conduite signé", "Cahier des clauses administratives particulières (CCAP) signé",
].map((title) => ({ kind: "document_to_provide" as const, title, source_reference: "À confirmer dans le DAO", instructions: "Joignez le document signé ou certifié conforme demandé par le DAO.", required: true, fields: [] }));

standardSubmissionItems.push(
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

const hasAppComputedContent = (title: string) => /planning.*ex.cution/i.test(title)
  || /mat.riaux.*transport/i.test(title) || /\bplans?\b/i.test(title) || /personnel/i.test(title);

// Reproduit exactement la logique de app/(dashboard)/tenders/[id]/submission/
// page.tsx : un élément générique de la liste type ne s'affiche que si l'IA
// n'a pas trouvé de vraie pièce correspondante dans CE DAO précis.
export function buildMasterDetectedItems(analysis: MasterAnalysis): TemplateDetectedItem[] {
  const aiItems = Array.isArray(analysis?.submission_items) ? analysis.submission_items : [];
  const genericItemsWithoutRealMatch = standardSubmissionItems
    .filter((item) => !findBestTitleMatch(item.title, aiItems))
    .map((item) => (item.kind === "form_to_complete" && item.fields.length === 0 && !hasAppComputedContent(item.title)
      ? { ...item, kind: "document_to_provide" as const, instructions: "Récupérez le modèle correspondant dans le DAO, complétez-le à la main avec vos informations, faites-le signer si nécessaire, puis joignez la version scannée." }
      : item));
  // Le contrôle visuel (vérifier une par une les pièces demandées par le
  // DAO — voir son propre sommaire, ex. "Article 6 - Dossier d'Appel
  // d'Offres") est bien plus simple quand l'application affiche les pièces
  // EXACTEMENT dans l'ordre où le DAO les liste lui-même, plutôt que
  // regroupées par catégorie ou dans l'ordre où l'IA les a rencontrées en
  // lisant le document (souvent proche de l'ordre des pages, mais pas de
  // l'ordre du sommaire officiel du DAO). submission_checklist recopie ce
  // sommaire officiel tel quel (voir le prompt d'analyse) : c'est la source
  // de vérité pour l'ordre. On rapproche chaque pièce détectée de sa ligne
  // du sommaire avec le même outil de rapprochement de titres que le reste
  // de l'application (findBestTitleMatch, déjà utilisé pour relier une
  // pièce générique à sa vraie pièce IA).
  //
  // Une pièce absente de ce sommaire (générique non confirmée dans ce DAO
  // précis, ou pièce ajoutée par l'application comme le BDQE externe) est
  // ordonnée en repli par sa première page connue : template_page_numbers
  // (renseigné seulement pour les pièces avec un vrai modèle imprimable),
  // sinon la page lue dans source_reference (renseigné pour chaque pièce,
  // via parsePageNumbersFromReference, déjà utilisé pour savoir si un PDF
  // est imprimable). Une pièce sans aucune page connue reste tout à la fin,
  // dans son ordre d'origine, pour rester visible sans fausser le contrôle.
  const checklist = Array.isArray(analysis?.submission_checklist) ? analysis.submission_checklist : [];
  const checklistSequence = (item: DetectedItem) => {
    if (!checklist.length) return null;
    const match = findBestTitleMatch(item.title, checklist);
    return match ? match.sequence : null;
  };
  const firstKnownPage = (item: TemplateDetectedItem) => {
    const templatePages = item.template_page_numbers;
    const fromTemplate = Array.isArray(templatePages) && templatePages.length ? templatePages[0] : undefined;
    const fromReference = parsePageNumbersFromReference(item.source_reference)[0];
    const known = [fromTemplate, fromReference].filter((page): page is number => typeof page === "number");
    return known.length ? Math.min(...known) : Number.POSITIVE_INFINITY;
  };
  return [...genericItemsWithoutRealMatch, ...aiItems]
    .map((item, index) => ({
      item,
      index,
      sequence: checklistSequence(item) ?? Number.POSITIVE_INFINITY,
      page: firstKnownPage(item as TemplateDetectedItem),
    }))
    .sort((a, b) => (a.sequence !== b.sequence ? a.sequence - b.sequence : a.page !== b.page ? a.page - b.page : a.index - b.index))
    .map((entry) => entry.item);
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
