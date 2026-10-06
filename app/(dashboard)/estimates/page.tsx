import { EstimateList } from "@/components/estimates/EstimateList";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { summarizeDevis, type DevisItem } from "@/lib/devis/pricing";

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
  // Devis ajoutés par PDF (ou chantiers sans devis du DAO) : leur devis vit dans
  // le bordereau du chantier, avec prix externe (client) et prix interne (coût).
  const { data: importedProjects } = await supabase
    .from("projects")
    .select("id,name,created_at")
    .eq("organization_id", organizationId)
    .is("source_estimate_id", null)
    .order("created_at", { ascending: false });
  const importedIds = (importedProjects ?? []).map((project) => project.id);
  const itemsByProject = new Map<string, DevisItem[]>();
  if (importedIds.length > 0) {
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from("project_price_items")
        .select("project_id,quantity,unit_price,external_unit_price,is_internal")
        .in("project_id", importedIds)
        .range(from, from + 999);
      if (error || !page || page.length === 0) break;
      for (const row of page as Array<DevisItem & { project_id: string }>) itemsByProject.set(row.project_id, [...(itemsByProject.get(row.project_id) ?? []), row]);
      if (page.length < 1000) break;
    }
  }
  const imported = (importedProjects ?? [])
    .map((project) => ({ project, summary: summarizeDevis(itemsByProject.get(project.id) ?? []) }))
    .filter(({ summary }) => summary.lines > 0)
    .map(({ project, summary }) => ({ id: project.id, name: project.name, createdAt: project.created_at ?? null, ...summary }));
  return <>
    <RealtimeRefresh channelName="estimates-list" tables={[{ table: "estimates", filter: `organization_id=eq.${organizationId}` }, "estimate_lines"]} />
    <EstimateList estimates={rows} imported={imported} />
  </>;
}
