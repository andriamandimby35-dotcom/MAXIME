import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

  return NextResponse.json({ id: data.id }, { status: 201 });
}
