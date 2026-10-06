import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { claimRemainingAmount, syncClaimPaymentStatus } from "@/lib/billing/claim-status";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

  // Facture reliée à ce paiement (pour remettre son statut à jour après l'annulation).
  const { data: existing } = await supabase.from("payments").select("progress_claim_id").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();

  const { error } = await supabase
    .from("payments")
    .delete()
    .eq("id", id)
    .eq("organization_id", member.organization_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Si le paiement annulé était celui d'une facture, elle revient dans la liste
  // des factures à payer (« Émise » ou « Partiellement payée »).
  await syncClaimPaymentStatus(supabase, member.organization_id, existing?.progress_claim_id);

  return NextResponse.json({ success: true });
}

// Modification d'un paiement déjà enregistré (réservée à l'administrateur) :
// sert notamment à corriger un montant saisi par erreur quand le reçu dépasse
// le certifié (carte rouge dans Factures & paiements).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  if (member.role !== "admin" && member.role !== "owner") {
    return NextResponse.json({ error: "Seul l'administrateur peut modifier un paiement." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Le montant doit être supérieur à 0." }, { status: 400 });
  }
  const paymentType = ["avancement", "attachement", "solde"].includes(body.payment_type) ? body.payment_type : "avancement";
  const method = ["bank_transfer", "cheque", "cash", "mobile_money", "other"].includes(body.method) ? body.method : "other";
  const paymentDate = typeof body.payment_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.payment_date) ? body.payment_date.slice(0, 10) : null;
  if (!paymentDate) return NextResponse.json({ error: "Date invalide." }, { status: 400 });

  const { data: existingPayment } = await supabase.from("payments").select("progress_claim_id").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (existingPayment?.progress_claim_id) {
    const state = await claimRemainingAmount(supabase, member.organization_id, existingPayment.progress_claim_id, id);
    if (state && amount > state.remaining + 0.5) {
      return NextResponse.json({ error: `Le montant dépasse le reste à payer sur cette facture (${Math.round(state.remaining).toLocaleString("fr-FR")} Ar).` }, { status: 400 });
    }
  }

  const { error } = await supabase
    .from("payments")
    .update({
      amount,
      payment_date: paymentDate,
      payment_type: paymentType,
      method,
      reference: String(body.reference ?? "").trim() || null,
    })
    .eq("id", id)
    .eq("organization_id", member.organization_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await syncClaimPaymentStatus(supabase, member.organization_id, existingPayment?.progress_claim_id);
  return NextResponse.json({ success: true });
}
