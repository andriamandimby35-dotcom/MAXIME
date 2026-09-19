import { createClient } from "@/lib/supabase/server";
import { BillingProjectList } from "./billing-project-list";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { certifiedAmount } from "@/lib/billing";

export default async function BillingPage() {
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
  const [projectsResult, paymentsResult, claimsResult] = organizationId
    ? await Promise.all([
        supabase
          .from("projects")
          .select("id,project_code,name,budget_amount")
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false }),
        supabase
          .from("payments")
          .select("project_id,amount")
          .eq("organization_id", organizationId),
        supabase
          .from("progress_claims")
          .select("project_id,net_amount,status")
          .eq("organization_id", organizationId),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const receivedByProject = new Map<string, number>();
  for (const payment of paymentsResult.data ?? []) {
    const key = String(payment.project_id);
    receivedByProject.set(key, (receivedByProject.get(key) ?? 0) + Number(payment.amount || 0));
  }

  // Le montant "certifié" vient désormais des vraies factures générées
  // (situations de travaux) quand il en existe ; à défaut (aucune facture
  // pour ce chantier), on retombe sur l'ancienne estimation provisoire.
  const claimsCountByProject = new Map<string, number>();
  const certifiedByProject = new Map<string, number>();
  for (const claim of claimsResult.data ?? []) {
    if (claim.status === "rejected") continue;
    const key = String(claim.project_id);
    claimsCountByProject.set(key, (claimsCountByProject.get(key) ?? 0) + 1);
    certifiedByProject.set(key, (certifiedByProject.get(key) ?? 0) + Number(claim.net_amount || 0));
  }

  const projects = (projectsResult.data ?? []).map((project) => ({
    ...project,
    received: receivedByProject.get(project.id) ?? 0,
    certified: (claimsCountByProject.get(project.id) ?? 0) > 0
      ? certifiedByProject.get(project.id) ?? 0
      : certifiedAmount(Number(project.budget_amount) || 0),
  }));

  return <>
    {organizationId && <RealtimeRefresh channelName="billing-list" tables={[
      { table: "projects", filter: `organization_id=eq.${organizationId}` },
      { table: "payments", filter: `organization_id=eq.${organizationId}` },
      { table: "progress_claims", filter: `organization_id=eq.${organizationId}` },
    ]} />}
    <BillingProjectList projects={projects} />
  </>;
}
