import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getContext } from "@/lib/organization";
import LotChooser from "@/components/tenders/LotChooser";

export default async function TenderLotsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, organizationId } = await getContext();
  const { data: tender } = await supabase.from("tenders").select("*").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (!tender) notFound();
  // Un lot est déjà un mini-DAO : on choisit les lots depuis le DAO complet.
  if (tender.parent_tender_id) redirect(`/tenders/${tender.parent_tender_id}/lots`);

  const { data: children } = await supabase
    .from("tenders")
    .select("id,lot_number")
    .eq("parent_tender_id", tender.id)
    .eq("organization_id", organizationId);
  const existing: Record<number, string> = {};
  for (const child of (children ?? []) as Array<{ id: string; lot_number: number | null }>) {
    if (child.lot_number) existing[child.lot_number] = child.id;
  }

  return <main className="tenderDetailPage">
    <Link href={`/tenders/${tender.id}`} className="tenderBackLink">← Retour au DAO</Link>
    <div className="tenderDetailHead">
      <div><p className="tenderEyebrow">DAO à plusieurs lots</p><h1>Choisir les lots</h1></div>
    </div>
    <LotChooser tenderId={tender.id} tenderTitle={String(tender.title ?? "")} existing={existing} />
  </main>;
}
