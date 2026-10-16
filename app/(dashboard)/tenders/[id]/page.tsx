import Link from "next/link";
import { notFound } from "next/navigation";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { OpenPdfButton } from "@/components/OpenPdfButton";

export default async function TenderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, organizationId } = await getContext();
  const { data: tender } = await supabase.from("tenders").select("*").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (!tender) notFound();

  // DAO à plusieurs lots : les lots déjà créés (chaque lot est un appel d'offres à part entière).
  const { data: lotChildren } = await supabase
    .from("tenders")
    .select("id,title,lot_number,lot_label,status")
    .eq("parent_tender_id", tender.id)
    .eq("organization_id", organizationId)
    .order("lot_number", { ascending: true });
  const lots = (lotChildren ?? []) as Array<{ id: string; title: string | null; lot_number: number | null; lot_label: string | null; status: string | null }>;
  const isLotParent = Boolean(tender.is_multi_lot) || lots.length > 0;
  const isLot = Boolean(tender.parent_tender_id);

  return <main className="tenderDetailPage">
    <RealtimeRefresh channelName={`tender-${tender.id}`} tables={["tenders"]} filter={`id=eq.${tender.id}`} />
    <Link href="/tenders" className="tenderBackLink">← Retour aux appels d’offres</Link>
    <div className="tenderDetailHead">
      <div><p className="tenderEyebrow">Appel d’offres</p><h1>{tender.title}</h1><p>{tender.reference || "Sans référence"} · {statusLabel(tender.status)}</p></div>
      {isLotParent
        ? <Link href={`/tenders/${tender.id}/lots`} className="tenderButton tenderButtonPrimary">Choisir les lots</Link>
        : <Link href={`/tenders/${tender.id}/analyze`} className="tenderButton tenderButtonPrimary">Analyser le DAO</Link>}
    </div>
    {isLot && <section className="tenderInfoCard">
      <h2>Lot {tender.lot_number}</h2>
      <p className="tenderDescription">{tender.lot_label || "Ce lot est un extrait du DAO complet : seuls les tableaux de prix de ce lot sont gardés."}</p>
      <p><Link href={`/tenders/${tender.parent_tender_id}`}>← Voir le DAO complet et ses autres lots</Link></p>
    </section>}
    {isLotParent && <section className="tenderInfoCard">
      <h2>Lots de ce DAO</h2>
      <p className="tenderDescription">Ce DAO est divisé en plusieurs lots. Chaque lot choisi devient un appel d’offres à part entière : analyse, devis, dossier de soumission, chantier, factures et dépenses. Le PDF complet reste conservé ici.</p>
      {lots.length === 0 ? <p>Aucun lot choisi pour le moment.</p> : <ul style={{ display: "grid", gap: 8, marginTop: 10 }}>
        {lots.map((lot) => <li key={lot.id}><Link href={`/tenders/${lot.id}`}>Lot {lot.lot_number}{lot.lot_label ? ` — ${lot.lot_label}` : ""}</Link> · {statusLabel(lot.status)}</li>)}
      </ul>}
    </section>}
    <section className="tenderInfoCard">
      <h2>Informations générales</h2>
      <dl><div><dt>Client</dt><dd>{tender.client_name || "—"}</dd></div><div><dt>Date limite</dt><dd>{tender.deadline || "—"}</dd></div><div><dt>Montant estimé</dt><dd>{Number(tender.estimated_amount || 0).toLocaleString("fr-FR")} Ar</dd></div><div><dt>Statut</dt><dd>{statusLabel(tender.status)}</dd></div></dl>
      {tender.description && <p className="tenderDescription">{tender.description}</p>}
    </section>
    <section className="tenderDaoCard"><div><h2>Document DAO</h2><p>Après l’analyse, le dossier apparaît dans « Dossiers de soumission ».</p></div>{tender.document_url ? <OpenPdfButton title="Document DAO" url={tender.document_url} className="tenderButton">Ouvrir le PDF</OpenPdfButton> : <span>PDF indisponible</span>}</section>
    {!isLot && !isLotParent && tender.document_url && <p style={{ marginTop: 12, fontSize: 14 }}><Link href={`/tenders/${tender.id}/lots`}>Ce DAO a plusieurs lots ? Choisir les lots</Link></p>}
  </main>;
}

function statusLabel(status?: string | null) {
  const labels: Record<string, string> = { draft: "Brouillon", analyzed: "Analysé par l’IA", ready: "Prêt à déposer", submitted: "Déposé", won: "Attribué", lost: "Non retenu", archived: "Archivé" };
  return labels[String(status ?? "").toLowerCase()] ?? status ?? "Brouillon";
}
