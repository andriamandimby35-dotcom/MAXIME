import Link from "next/link";
import { notFound } from "next/navigation";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";

export default async function TenderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, organizationId } = await getContext();
  const { data: tender } = await supabase.from("tenders").select("*").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (!tender) notFound();

  return <main className="tenderDetailPage">
    <RealtimeRefresh channelName={`tender-${tender.id}`} tables={["tenders"]} filter={`id=eq.${tender.id}`} />
    <Link href="/tenders" className="tenderBackLink">← Retour aux appels d’offres</Link>
    <div className="tenderDetailHead">
      <div><p className="tenderEyebrow">Appel d’offres</p><h1>{tender.title}</h1><p>{tender.reference || "Sans référence"} · {statusLabel(tender.status)}</p></div>
      <Link href={`/tenders/${tender.id}/analyze`} className="tenderButton tenderButtonPrimary">Analyser le DAO</Link>
    </div>
    <section className="tenderInfoCard">
      <h2>Informations générales</h2>
      <dl><div><dt>Client</dt><dd>{tender.client_name || "—"}</dd></div><div><dt>Date limite</dt><dd>{tender.deadline || "—"}</dd></div><div><dt>Montant estimé</dt><dd>{Number(tender.estimated_amount || 0).toLocaleString("fr-FR")} Ar</dd></div><div><dt>Statut</dt><dd>{statusLabel(tender.status)}</dd></div></dl>
      {tender.description && <p className="tenderDescription">{tender.description}</p>}
    </section>
    <section className="tenderDaoCard"><div><h2>Document DAO</h2><p>Après l’analyse, le dossier apparaît dans « Dossiers de soumission ».</p></div>{tender.document_url ? <a href={`/pdf-viewer?url=${encodeURIComponent(tender.document_url)}`} target="_blank" rel="noreferrer" className="tenderButton">Ouvrir le PDF</a> : <span>PDF indisponible</span>}</section>
  </main>;
}

function statusLabel(status?: string | null) {
  const labels: Record<string, string> = { draft: "Brouillon", analyzed: "Analysé par l’IA", ready: "Prêt à déposer", submitted: "Déposé", won: "Attribué", lost: "Non retenu", archived: "Archivé" };
  return labels[String(status ?? "").toLowerCase()] ?? status ?? "Brouillon";
}
