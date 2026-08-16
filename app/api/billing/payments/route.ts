import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const body = await request.json();
  const amount = Number(body.amount) || 0;
  if (!body.organization_id || !body.project_id || amount <= 0) {
    return NextResponse.json({ error: "Données de paiement invalides." }, { status: 400 });
  }

  const { data, error } = await supabase.from("payments").insert({
    organization_id: body.organization_id,
    project_id: body.project_id,
    progress_claim_id: body.progress_claim_id || null,
    payment_date: body.payment_date,
    amount,
    method: body.method,
    reference: body.reference || null,
    created_by: user.id,
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data.id }, { status: 201 });
}
