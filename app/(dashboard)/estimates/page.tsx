import { EstimateList } from "@/components/estimates/EstimateList";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";

type LineData = Record<string, unknown>;

function numberFrom(line: LineData, keys: string[]) {
  for (const key of keys) {
    const raw = line[key];
    const value = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function lineTotal(line: LineData) {
  const stored = numberFrom(line, ["Total", "total"]);
  return stored || numberFrom(line, ["Quantité", "Quantite", "quantite"]) * numberFrom(line, ["Prix unitaire", "prix_unitaire"]);
}

function isItem(line: LineData) {
  return !["section", "subtotal"].includes(String(line.__daoRowType ?? "item"));
}

function isInternal(line: LineData) {
  return line.__internalOnly === true || line.__internalOnly === "true" || line.__disabledInternal === true;
}

function isMaterial(line: LineData) {
  const category = String(line.__daoCategory ?? line.__priceCategory ?? line.__internalCostKind ?? "").toLocaleLowerCase("fr-FR");
  return /materiau|matériau|material/.test(category);
}

export default async function EstimatesPage() {
  const { supabase, organizationId } = await getContext();
  if (!organizationId) return <EstimateList estimates={[]} />;

  const { data: estimates } = await supabase
    .from("estimates")
    .select("id,created_at,source_tender_id,profit_margin_percent")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  const estimateIds = (estimates ?? []).map((estimate) => estimate.id);
  const tenderIds = [...new Set((estimates ?? []).map((estimate) => estimate.source_tender_id).filter(Boolean))];
  const [{ data: lines }, { data: tenders }] = await Promise.all([
    estimateIds.length ? supabase.from("estimate_lines").select("estimate_id,data").in("estimate_id", estimateIds) : Promise.resolve({ data: [] }),
    tenderIds.length ? supabase.from("tenders").select("id,reference,title").in("id", tenderIds) : Promise.resolve({ data: [] }),
  ]);
  const tendersById = new Map((tenders ?? []).map((tender) => [tender.id, tender]));

  const rows = (estimates ?? []).map((estimate) => {
    const estimateLines = (lines ?? []).filter((line) => line.estimate_id === estimate.id).map((line) => (line.data ?? {}) as LineData).filter(isItem);
    const tender = estimate.source_tender_id ? tendersById.get(estimate.source_tender_id) : undefined;
    const externalLines = estimateLines.filter((line) => !isInternal(line));
    const materialTotal = externalLines.filter(isMaterial).reduce((total, line) => total + lineTotal(line), 0);
    const markupBase = externalLines.filter((line) => !isMaterial(line)).reduce((total, line) => total + lineTotal(line), 0);
    return {
      id: estimate.id,
      createdAt: estimate.created_at,
      label: tender ? `${tender.reference || "DAO"} — ${tender.title || "Sans titre"}` : `Devis ${estimate.id.slice(0, 8)}`,
      internalTotal: estimateLines.reduce((total, line) => total + lineTotal(line), 0),
      externalBase: materialTotal + markupBase,
      markupBase,
      margin: Number(estimate.profit_margin_percent) || 0,
    };
  });
  return <>
    <RealtimeRefresh channelName="estimates-list" tables={[{ table: "estimates", filter: `organization_id=eq.${organizationId}` }, "estimate_lines"]} />
    <EstimateList estimates={rows} />
  </>;
}
