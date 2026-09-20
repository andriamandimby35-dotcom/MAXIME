import { notFound } from "next/navigation";
import SubmissionDossierManager from "@/components/tenders/SubmissionDossierManager";
import { GenerateSubmissionDossierButton } from "@/components/tenders/GenerateSubmissionDossierButton";
import { getContext } from "@/lib/organization";
import { buildMasterDetectedItems, type DetectedItem } from "@/lib/submission/build-dossier-items";

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

  // Le dossier maître (pas de estimateId) n'existe que si quelqu'un a
  // explicitement cliqué sur "Générer le dossier de soumission" : avant,
  // cette page reconstruisait toujours une liste de pièces à partir de
  // l'analyse IA, même sans aucune ligne en base, ce qui faisait réapparaître
  // aussitôt un dossier vide après une suppression. Le dossier lié à un devis
  // précis (estimateId) n'est pas concerné par ce changement pour l'instant.
  if (!estimateId) {
    const { count } = await supabase
      .from("tender_submission_items")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("tender_id", tender.id);
    if (!count) {
      return (
        <main className="submissionDossierPage p-8 max-w-3xl">
          <a className="tenderBackLink" href="/submissions">← Retour aux dossiers de soumission</a>
          <div className="mb-7">
            <h1 className="text-3xl font-bold">Dossier maître du DAO</h1>
            <p className="mt-2 text-gray-600">
              Ce dossier n’a pas encore été généré. Cliquez ci-dessous pour créer la liste des pièces à fournir, à partir de l’analyse IA du DAO déjà disponible (aucun nouvel appel IA, donc aucun coût supplémentaire).
            </p>
          </div>
          <GenerateSubmissionDossierButton tenderId={tender.id} />
        </main>
      );
    }
  }

  type TenderAnalysis = { submission_items?: DetectedItem[]; submission_checklist?: Array<{ title: string; sequence: number; source_reference?: string; level?: number }>; worksite_location?: string; execution_period_days?: number | null };
  let analysis: TenderAnalysis | null = null;
  try {
    analysis = typeof tender.ai_analysis === "string"
      ? JSON.parse(tender.ai_analysis) as TenderAnalysis
      : tender.ai_analysis as TenderAnalysis | null;
  } catch {
    analysis = null;
  }
  const detectedItems = buildMasterDetectedItems(analysis);

  const estimatedAmount = typeof tender.estimated_amount === "number" ? tender.estimated_amount : Number(tender.estimated_amount) || null;
  return <SubmissionDossierManager key={estimateId ?? "master"} tenderId={tender.id} tenderReference={tender.reference ?? ""} tenderLocation={analysis?.worksite_location ?? ""} tenderClientName={tender.client_name ?? ""} tenderExecutionPeriodDays={analysis?.execution_period_days ?? null} tenderEstimatedAmount={estimatedAmount} estimateId={estimateId ?? null} organizationId={organizationId} daoUrl={tender.document_url} detectedItems={detectedItems} />;
}
