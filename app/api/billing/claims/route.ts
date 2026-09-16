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
  const gross = Number(body.gross_amount) || 0;
  const retentionRate = Number(body.retention_rate) || 0;
  const retention = (gross * retentionRate) / 100;
  const advance = Number(body.advance_repayment) || 0;
  const other = Number(body.other_deductions) || 0;
  const taxable = Math.max(0, gross - retention - advance - other);
  const taxRate = Number(body.tax_rate) || 0;
  const tax = (taxable * taxRate) / 100;
  const net = taxable + tax;

  if (!body.project_id || !body.claim_number || gross < 0) {
    return NextResponse.json({ error: "Données de situation invalides." }, { status: 400 });
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

  const { data, error } = await supabase
    .from("progress_claims")
    .insert({
      organization_id: member.organization_id,
      project_id: project.id,
      claim_number: String(body.claim_number).trim(),
      issue_date: body.issue_date,
      status: "draft",
      gross_amount: gross,
      retention_rate: retentionRate,
      retention_amount: retention,
      advance_repayment: advance,
      other_deductions: other,
      tax_rate: taxRate,
      tax_amount: tax,
      net_amount: net,
      notes: body.notes || null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ id: data.id }, { status: 201 });
}
