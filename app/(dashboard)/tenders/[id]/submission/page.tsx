import { notFound } from "next/navigation";
import SubmissionDossierManager from "@/components/tenders/SubmissionDossierManager";
import { getContext } from "@/lib/organization";
import { findBestTitleMatch } from "@/lib/submission/title-match";

type DetectedItem = {
  kind: "document_to_provide" | "form_to_complete";
  title: string;
  source_reference: string;
  instructions: string;
  required: boolean;
  fields: Array<{ key: string; label: string; required: boolean; description: string }>;
};

const standardSubmissionItems: DetectedItem[] = [
  "Plan à parapher", "CCAP paraphé", "Certificats de bonnes fins ou procès-verbaux de réception", "Photocopie certifiée conforme de la carte d’immatriculation fiscale", "Photocopie certifiée conforme de la carte statistique", "Reçu d’achat du Dossier d’Appel d’Offres", "Attestation de disponibilité de liquidité ou de ligne de crédit", "Relevé d’identité bancaire", "CIN légalisée du signataire", "Certificat de résidence du signataire", "Pièces justificatives des matériels", "Calendrier cultural", "Code de conduite signé", "Cahier des clauses administratives particulières (CCAP) signé",
].map((title) => ({ kind: "document_to_provide", title, source_reference: "À confirmer dans le DAO", instructions: "Joignez le document signé ou certifié conforme demandé par le DAO.", required: true, fields: [] }));

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

export default async function SubmissionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ estimateId?: string }> }) {
  const { id } = await params;
  const { estimateId } = await searchParams;
  const { supabase, organizationId } = await getContext();
  if (!organizationId) notFound();

  const { data: tender } = await supabase
    .from("tenders")
    .select("id,reference,ai_analysis,document_url,client_name,estimated_amount")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!tender) notFound();

  let analysis: { submission_items?: DetectedItem[]; worksite_location?: string; execution_period_days?: number | null } | null = null;
  try {
    analysis = typeof tender.ai_analysis === "string"
      ? JSON.parse(tender.ai_analysis) as { submission_items?: DetectedItem[]; worksite_location?: string; execution_period_days?: number | null }
      : tender.ai_analysis as { submission_items?: DetectedItem[]; worksite_location?: string; execution_period_days?: number | null } | null;
  } catch {
    analysis = null;
  }
  const aiItems = Array.isArray(analysis?.submission_items) ? analysis.submission_items : [];
  // Un élément générique de la liste type (ex. "Garantie bancaire de
  // soumission B1") ne doit pas s'afficher en double à côté de la vraie pièce
  // trouvée par l'IA dans ce DAO précis ("Garantie bancaire de soumission") :
  // dès qu'un équivalent réel existe, on ne garde que celui-ci, avec ses
  // vraies pages/son vrai modèle. L'élément générique ne reste que pour ce
  // que l'IA n'a réellement pas trouvé dans ce DAO.
  const genericItemsWithoutRealMatch = standardSubmissionItems.filter((item) => !findBestTitleMatch(item.title, aiItems));
  const detectedItems = [...genericItemsWithoutRealMatch, ...aiItems];

  const estimatedAmount = typeof tender.estimated_amount === "number" ? tender.estimated_amount : Number(tender.estimated_amount) || null;
  return <SubmissionDossierManager key={estimateId ?? "master"} tenderId={tender.id} tenderReference={tender.reference ?? ""} tenderLocation={analysis?.worksite_location ?? ""} tenderClientName={tender.client_name ?? ""} tenderExecutionPeriodDays={analysis?.execution_period_days ?? null} tenderEstimatedAmount={estimatedAmount} estimateId={estimateId ?? null} organizationId={organizationId} daoUrl={tender.document_url} detectedItems={detectedItems} />;
}
