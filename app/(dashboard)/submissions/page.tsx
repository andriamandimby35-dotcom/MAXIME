import Link from "next/link";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";

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
  const byTender = new Map<string, StoredItem[]>();
  for (const item of stored ?? []) byTender.set(item.tender_id, [...(byTender.get(item.tender_id) ?? []), item as StoredItem]);
  const rows = await Promise.all((tenders ?? []).map(async (tender) => {
    const items = byTender.get(tender.id) ?? [];
    const missing = items.filter((item) => item.required && !generated(item.title) && (readingOnly(item.title) ? !item.form_data?.__acknowledgedAt : !item.form_data?.__attachmentPath));
    const listed = await supabase.storage.from("btp-documents").list(`${organizationId}/submission/${tender.id}/master`, { search: "dossier-soumission-final.pdf" });
    const finalReady = Boolean(listed.data?.some((file) => file.name === "dossier-soumission-final.pdf"));
    let analysis: Analysis | null = null;
    try { analysis = typeof tender.ai_analysis === "string" ? JSON.parse(tender.ai_analysis) as Analysis : tender.ai_analysis as Analysis | null; } catch { analysis = null; }
    return { tender, count: items.length || (Array.isArray(analysis?.submission_items) ? analysis.submission_items.length : 0), finalReady, valid: finalReady && !missing.length };
  }));
  return <main className="submissionPage p-8 max-w-7xl">
    {organizationId && <RealtimeRefresh channelName="submissions-list" tables={[
      { table: "tenders", filter: `organization_id=eq.${organizationId}` },
      { table: "tender_submission_items", filter: `organization_id=eq.${organizationId}` },
    ]} />}
    <h1 className="text-3xl font-bold">Dossiers de soumission</h1>
    <p className="mt-2 text-gray-600">Un dossier maître par DAO, avec vérification finale et PDF enregistré.</p>
    <section className="submissionTable mt-6 overflow-hidden rounded-2xl border bg-white">
      <table className="w-full"><thead><tr><th className="text-left p-4">DAO / chantier</th><th className="text-left p-4">Échéance</th><th className="text-left p-4">Pièces trouvées</th><th className="text-left p-4">État</th><th className="text-left p-4">Dossier</th><th className="text-left p-4">PDF final</th></tr></thead>
        <tbody>{rows.map(({ tender, count, finalReady, valid }) => <tr key={tender.id} className="submissionRow"><td className="p-4 font-semibold">{tender.reference ? `${tender.reference} — ` : ""}{tender.title}</td><td className="p-4">{tender.deadline ? new Date(tender.deadline).toLocaleDateString("fr-FR") : "—"}</td><td className="p-4"><span className="submissionCount">{count || "À analyser"}</span></td><td className="p-4"><span className={`submissionStatus ${valid ? "isValid" : "isInvalid"}`}>{valid ? "Validé — prêt à imprimer" : "Non validé"}</span></td><td className="p-4"><Link className="tenderButton" href={`/tenders/${tender.id}/submission`}>Ouvrir</Link></td><td className="p-4">{finalReady ? <a className="tenderButton submissionPdfReady" href={`/pdf-viewer?document=${encodeURIComponent(`/api/tenders/${tender.id}/final-submission-pdf`)}`} target="_blank" rel="noreferrer">Ouvrir le PDF final</a> : <button type="button" disabled className="tenderButton submissionPdfDisabled">PDF final à générer</button>}</td></tr>)}</tbody>
      </table>
      {!tenders?.length && <p className="p-6 text-gray-600">Aucun DAO enregistré.</p>}
    </section>
  </main>;
}
