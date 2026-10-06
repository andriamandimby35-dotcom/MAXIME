import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BillingProjectDetail } from "./billing-project-detail";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { loadProjectFinance } from "@/lib/billing/project-finance";
import { getContext } from "@/lib/organization";

export default async function BillingProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;

  const { data: membership } = userId
    ? await supabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId)
        .eq("active", true)
        .limit(1)
        .maybeSingle()
    : { data: null };

  const organizationId = membership?.organization_id ?? null;
  if (!organizationId) notFound();

  const { data: project } = await supabase
    .from("projects")
    .select("id,project_code,name,location,budget_amount,status,source_tender_id,source_estimate_id,manual_margin_percent")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!project) notFound();

  const { memberRole } = await getContext();
  const isAdmin = memberRole === "admin" || memberRole === "owner";
  const finance = await loadProjectFinance(supabase, organizationId, id);

  const [tenderResult, paymentsResult, claimsResult] = await Promise.all([
    project.source_tender_id
      ? supabase.from("tenders").select("client_name,reference,title").eq("id", project.source_tender_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("payments")
      .select("id,progress_claim_id,payment_date,amount,method,reference,payment_type")
      .eq("organization_id", organizationId)
      .eq("project_id", id)
      .order("payment_date", { ascending: false }),
    // Colonnes de période / « facture mise à jour » ajoutées par un fichier SQL :
    // tant qu'il n'est pas exécuté, on relit sans elles.
    (async () => {
      const base = "id,claim_number,issue_date,status,gross_amount,retention_amount,tax_amount,net_amount";
      const full = await supabase.from("progress_claims").select(`${base},period_start,period_end,refresh_note,refreshed_at`)
        .eq("organization_id", organizationId).eq("project_id", id)
        .order("issue_date", { ascending: false }).order("created_at", { ascending: false });
      if (!full.error) return full;
      return supabase.from("progress_claims").select(base)
        .eq("organization_id", organizationId).eq("project_id", id)
        .order("issue_date", { ascending: false }).order("created_at", { ascending: false });
    })(),
  ]);

  return (
    <>
      <RealtimeRefresh channelName={`billing-${id}`} tables={[
        { table: "payments", filter: `project_id=eq.${id}` },
        { table: "projects", filter: `id=eq.${id}` },
        { table: "progress_claims", filter: `project_id=eq.${id}` },
      ]} />
      <BillingProjectDetail
        project={project}
        tender={tenderResult.data ?? null}
        payments={paymentsResult.data ?? []}
        claims={claimsResult.data ?? []}
        isAdmin={isAdmin}
        pricing={{
          mode: finance.pricing.mode,
          certified: finance.pricing.certified,
          realCost: finance.pricing.realCost,
          margin: finance.pricing.margin,
          marginPercent: finance.pricing.marginPercent,
          expectedCost: finance.pricing.expectedCost,
          hasDevis: finance.devisTotal > 0,
          contractAmount: finance.settings.contractAmount ?? null,
          settingsMarginPercent: finance.settings.marginPercent ?? null,
          settingsMarginAmount: finance.settings.marginAmount ?? null,
        }}
      />
    </>
  );
}
