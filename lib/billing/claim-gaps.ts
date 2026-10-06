import type { SupabaseClient } from "@supabase/supabase-js";
import { computeGaps, todayKey, type ClaimPeriodRow, type Gap } from "@/lib/billing/claim-periods";

// Jours encore à facturer sur un chantier : début du chantier (le plus ancien
// entre sa création dans l'application et sa première tâche planifiée) jusqu'à
// la fin demandée, moins les périodes déjà couvertes par une facture.
export async function loadClaimGaps(
  supabase: SupabaseClient,
  params: { organizationId: string; projectId: string; start?: string; end?: string },
): Promise<{ gaps: Gap[]; rangeStart: string; rangeEnd: string; claims: Array<ClaimPeriodRow & { id: string }> }> {
  const { organizationId, projectId } = params;
  const { data: project } = await supabase.from("projects").select("created_at").eq("id", projectId).eq("organization_id", organizationId).maybeSingle();
  const withStart = await supabase.from("project_tasks").select("planned_start_date").eq("project_id", projectId);
  const taskStarts = (withStart.error ? [] : (withStart.data ?? []) as Array<{ planned_start_date?: string | null }>)
    .map((task) => String(task.planned_start_date ?? "").slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  const today = todayKey();
  const projectStart = [String(project?.created_at ?? today).slice(0, 10), ...taskStarts].sort()[0] || today;

  let claims: Array<ClaimPeriodRow & { id: string }> = [];
  const withPeriods = await supabase.from("progress_claims").select("id,issue_date,period_start,period_end,created_at,claim_number")
    .eq("project_id", projectId).eq("organization_id", organizationId).neq("status", "rejected");
  if (!withPeriods.error) claims = (withPeriods.data ?? []) as unknown as typeof claims;
  else {
    const plain = await supabase.from("progress_claims").select("id,issue_date,created_at,claim_number")
      .eq("project_id", projectId).eq("organization_id", organizationId).neq("status", "rejected");
    claims = (plain.data ?? []) as unknown as typeof claims;
  }
  const rangeStart = params.start && params.start > projectStart ? params.start : (params.start || projectStart);
  const rangeEnd = params.end && params.end < today ? params.end : today;
  return { gaps: computeGaps(claims, rangeStart, rangeEnd), rangeStart, rangeEnd, claims };
}
