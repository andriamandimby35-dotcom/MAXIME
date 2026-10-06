import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { SubmissionCard } from "@/components/tenders/SubmissionCard";

type Analysis = { submission_items?: unknown[] };
type StoredItem = { title: string; required: boolean; form_data: Record<string, string> };
const generated = (title: string) => /planning|mat.riaux.*transport|liste des plans/i.test(title);
const readingOnly = (title: string) => /charte de déontologie|fraude|corruption/i.test(title);

export default async function SubmissionsPage() {
  const { supabase, organizationId } = await getContext();
  const { data: tenders, error } = await supabase.from("tenders").select("id,reference,title,deadline,ai_analysis").eq("organization_id", organizationId).order("created_at", { ascending: false });
  if (error) return <main className="p-8"><h1 className="text-3xl font-bold">Dossiers de soumission</h1><p className="mt-4">Impossible de charger les DAO.</p></main>;
  const ids = (tenders ?? []).map((tender) => tender.id);
  const { data: stored } = ids.length ? await supabase.from("tender_submission_items").select("tender_id,title,required,form_data").eq("organization_id", organizationId).in("tender_id", ids) : { data: [] };
  // "Valider la complétion" (voir SubmissionDossierManager) enregistre juste
  // une date de verrouillage pour le dossier maître, dans cette petite table
  // dédiée — table facultative : si sa migration n'a pas encore été
  // appliquée, on continue simplement sans savoir quels dossiers sont
  // verrouillés plutôt que de faire échouer toute la page.
  const locksResult = ids.length ? await supabase.from("tender_submission_dossier_locks").select("tender_id,locked_at").eq("organization_id", organizationId).in("tender_id", ids) : { data: [] };
  const lockedByTender = new Set((locksResult.data ?? []).filter((lock) => lock.locked_at).map((lock) => lock.tender_id));
  const byTender = new Map<string, StoredItem[]>();
  for (const item of stored ?? []) byTender.set(item.tender_id, [...(byTender.get(item.tender_id) ?? []), item as StoredItem]);
  const rows = (tenders ?? []).map((tender) => {
    const items = byTender.get(tender.id) ?? [];
    const missing = items.filter((item) => item.required && !generated(item.title) && (readingOnly(item.title) ? !item.form_data?.__acknowledgedAt : !item.form_data?.__readyAt));
    const locked = lockedByTender.has(tender.id);
    let analysis: Analysis | null = null;
    try { analysis = typeof tender.ai_analysis === "string" ? JSON.parse(tender.ai_analysis) as Analysis : tender.ai_analysis as Analysis | null; } catch { analysis = null; }
    return { tender, count: items.length || (Array.isArray(analysis?.submission_items) ? analysis.submission_items.length : 0), valid: locked && !missing.length, hasStoredItems: items.length > 0 };
  });
  return <main className="submissionPage p-8 max-w-7xl">
    {organizationId && <RealtimeRefresh channelName="submissions-list" tables={[
      { table: "tenders", filter: `organization_id=eq.${organizationId}` },
      { table: "tender_submission_items", filter: `organization_id=eq.${organizationId}` },
      { table: "tender_submission_dossier_locks", filter: `organization_id=eq.${organizationId}` },
    ]} />}
    <h1 className="text-3xl font-bold">Dossiers de soumission</h1>
    <p className="mt-2 text-gray-600">Un dossier maître par DAO, à vérifier et valider avant dépôt physique.</p>
    {!tenders?.length ? <section className="projectEmptyCard"><h2>Aucun DAO enregistré</h2><p>Ajoutez un appel d’offres : son dossier de soumission apparaîtra ici.</p></section> : <section className="projectDirectoryGrid mt-6" aria-label="Dossiers de soumission">
      {rows.map(({ tender, count, valid, hasStoredItems }) => <SubmissionCard key={tender.id} dossier={{ id: tender.id, reference: tender.reference ?? null, title: tender.title ?? null, deadline: tender.deadline ?? null, count, valid, hasStoredItems }} />)}
    </section>}
  </main>;
}
