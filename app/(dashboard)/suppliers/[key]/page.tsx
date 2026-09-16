import Link from "next/link";
import { getContext } from "@/lib/organization";
import { supplierGroup } from "@/lib/material-normalization";
import PriceSearch from "@/components/prices/PriceSearch";
import { RealtimeRefresh } from "@/components/realtime-refresh";

export default async function SupplierDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { supabase, organizationId } = await getContext();

  const { data: prices } = organizationId
    ? await supabase.from("price_library").select("*").eq("organization_id", organizationId)
    : { data: [] };

  const matches = (prices ?? []).flatMap((row) => {
    const raw = String(row.fournisseur || "").trim();
    if (!raw) return key === "autre" ? [{ row, label: "Autre" }] : [];
    const group = supplierGroup(raw, row.ville, row.region);
    return group.key === key ? [{ row, label: group.label }] : [];
  });
  const filtered = matches.map((match) => match.row);
  const label = matches[0]?.label ?? (key === "autre" ? "Autre" : key);

  return (
    <section>
      {organizationId && <RealtimeRefresh channelName={`supplier-${key}`} tables={["price_library"]} filter={`organization_id=eq.${organizationId}`} />}
      <Link href="/suppliers" className="tenderBackLink">← Retour aux fournisseurs</Link>

      <div className="pageHead">
        <div><h1>{label}</h1><p>{filtered.length} matériau{filtered.length > 1 ? "x" : ""} chez ce fournisseur.</p></div>
      </div>

      <div style={{ marginTop: "20px" }}>
        <PriceSearch prices={filtered} />
      </div>
    </section>
  );
}
