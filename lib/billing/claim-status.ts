import type { SupabaseClient } from "@supabase/supabase-js";

// Statut d'une facture selon ce qui a été payé dessus :
//  rien payé → « Émise » ; une partie → « Partiellement payée » ; tout → « Payée ».
// Appelé après chaque paiement enregistré, modifié ou annulé.
export async function syncClaimPaymentStatus(supabase: SupabaseClient, organizationId: string, claimId: string | null | undefined) {
  if (!claimId) return;
  const { data: claim } = await supabase.from("progress_claims").select("id,status,net_amount").eq("id", claimId).eq("organization_id", organizationId).maybeSingle();
  if (!claim || claim.status === "rejected") return;
  const { data: payments } = await supabase.from("payments").select("amount").eq("progress_claim_id", claimId).eq("organization_id", organizationId);
  const paid = (payments ?? []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const net = Number(claim.net_amount) || 0;
  const next = paid <= 0 ? "submitted" : paid >= net - 0.5 ? "paid" : "partially_paid";
  // Un brouillon / une facture approuvée sans paiement garde son statut.
  if (paid <= 0 && (claim.status === "draft" || claim.status === "approved" || claim.status === "submitted")) return;
  if (claim.status !== next) {
    await supabase.from("progress_claims").update({ status: next, updated_at: new Date().toISOString() }).eq("id", claimId).eq("organization_id", organizationId);
  }
}

/** Reste à payer d'une facture (net moins les paiements déjà reliés), hors un paiement éventuel à ignorer. */
export async function claimRemainingAmount(supabase: SupabaseClient, organizationId: string, claimId: string, ignorePaymentId?: string): Promise<{ net: number; paid: number; remaining: number; status: string } | null> {
  const { data: claim } = await supabase.from("progress_claims").select("id,status,net_amount").eq("id", claimId).eq("organization_id", organizationId).maybeSingle();
  if (!claim) return null;
  const { data: payments } = await supabase.from("payments").select("id,amount").eq("progress_claim_id", claimId).eq("organization_id", organizationId);
  const paid = (payments ?? []).filter((row) => row.id !== ignorePaymentId).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const net = Number(claim.net_amount) || 0;
  return { net, paid, remaining: Math.max(0, net - paid), status: String(claim.status) };
}
