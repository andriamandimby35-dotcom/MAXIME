import { createClient } from "@/lib/supabase/server";
import { BillingManager } from "./billing-manager";

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
  const [projectsResult, claimsResult, paymentsResult] = organizationId
    ? await Promise.all([
        supabase
          .from("projects")
          .select("id,project_code,name,budget_amount")
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false }),
        supabase
          .from("progress_claims")
          .select("id,project_id,claim_number,issue_date,status,gross_amount,retention_amount,tax_amount,net_amount,projects(name,project_code)")
          .eq("organization_id", organizationId)
          .order("issue_date", { ascending: false }),
        supabase
          .from("payments")
          .select("id,project_id,progress_claim_id,payment_date,amount,method,reference")
          .eq("organization_id", organizationId)
          .order("payment_date", { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  return (
    <BillingManager
      organizationId={organizationId}
      projects={projectsResult.data ?? []}
      initialClaims={(claimsResult.data ?? []).map((claim) => ({
  ...claim,
  projects: Array.isArray(claim.projects)
    ? claim.projects[0] ?? null
    : claim.projects,
}))}
      initialPayments={paymentsResult.data ?? []}
    />
  );
}
