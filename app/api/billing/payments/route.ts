import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { claimRemainingAmount, syncClaimPaymentStatus } from "@/lib/billing/claim-status";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;

  if (!user) {
    return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!member?.organization_id) {
    return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  }

  const body = await request.json();
  const amount = Number(body.amount) || 0;

  if (!body.project_id || amount <= 0) {
    return NextResponse.json({ error: "Données de paiement invalides." }, { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", body.project_id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();

  if (!project) {
    return NextResponse.json({ error: "Chantier introuvable dans votre organisation." }, { status: 404 });
  }

  let progressClaimId: string | null = null;

  if (body.progress_claim_id) {
    const { data: claim } = await supabase
      .from("progress_claims")
      .select("id")
      .eq("id", body.progress_claim_id)
      .eq("project_id", project.id)
      .eq("organization_id", member.organization_id)
      .maybeSingle();

    if (!claim) {
      return NextResponse.json({ error: "Facture introuvable dans votre organisation." }, { status: 404 });
    }

    progressClaimId = claim.id;

    // Un paiement relié à une facture ne peut pas dépasser ce qui reste à payer dessus.
    const state = await claimRemainingAmount(supabase, member.organization_id, claim.id);
    if (state) {
      if (state.status === "rejected") return NextResponse.json({ error: "Cette facture est refusée : on ne peut pas enregistrer de paiement dessus." }, { status: 400 });
      if (state.remaining <= 0.5) return NextResponse.json({ error: "Cette facture est déjà entièrement payée." }, { status: 400 });
      if (amount > state.remaining + 0.5) {
        return NextResponse.json({ error: `Le montant dépasse le reste à payer sur cette facture (${Math.round(state.remaining).toLocaleString("fr-FR")} Ar).` }, { status: 400 });
      }
    }
  }

  const paymentType = ["avancement", "attachement", "solde"].includes(body.payment_type) ? body.payment_type : "avancement";

  const { data, error } = await supabase
    .from("payments")
    .insert({
      organization_id: member.organization_id,
      project_id: project.id,
      progress_claim_id: progressClaimId,
      payment_date: body.payment_date,
      amount,
      method: body.method,
      reference: body.reference || null,
      payment_type: paymentType,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // La facture passe en « Payée » ou « Partiellement payée » selon le total reçu.
  await syncClaimPaymentStatus(supabase, member.organization_id, progressClaimId);

  return NextResponse.json({ id: data.id }, { status: 201 });
}
