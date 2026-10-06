import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

  const { error } = await supabase
    .from("payments")
    .delete()
    .eq("id", id)
    .eq("organization_id", member.organization_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

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
  return NextResponse.json({ success: true });
}
