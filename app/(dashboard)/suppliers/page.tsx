import { getContext } from "@/lib/organization";
import { supplierGroup } from "@/lib/material-normalization";
import { SupplierList } from "./supplier-list";
import { RealtimeRefresh } from "@/components/realtime-refresh";

export default async function SuppliersPage(){
  const { supabase, organizationId } = await getContext();

  const { data: prices } = organizationId
    ? await supabase.from("price_library").select("fournisseur,ville,region").eq("organization_id", organizationId)
    : { data: [] };

  const groups = new Map<string, { key: string; label: string; count: number }>();
  for (const row of prices ?? []) {
    const raw = String(row.fournisseur || "").trim();
    const { key, label } = raw
      ? supplierGroup(raw, row.ville, row.region)
      : { key: "autre", label: "Autre" };
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { key, label, count: 1 });
  }

  const suppliers = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));

  return <>
    {organizationId && <RealtimeRefresh channelName="suppliers-list" tables={["price_library"]} filter={`organization_id=eq.${organizationId}`} />}
    <SupplierList suppliers={suppliers} />
  </>;
}
