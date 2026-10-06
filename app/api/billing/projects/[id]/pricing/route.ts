import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Enregistre le prix de l'offre et/ou la marge attendue d'un chantier qui n'a
// pas de devis chiffré (réservé à l'administrateur). Ces valeurs servent à
// calculer le "Certifié" et à répartir la facture (voir lib/billing/pricing.ts).
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
    return NextResponse.json({ error: "Seul l'administrateur peut modifier le prix et la marge." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const parse = (value: unknown) => {
    const text = String(value ?? "").replace(/\s/g, "").replace(",", ".");
    if (text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : NaN;
  };
  const contract = parse(body.contract_amount);
  const marginValue = parse(body.margin_value);
  if (Number.isNaN(contract) || Number.isNaN(marginValue)) {
    return NextResponse.json({ error: "Un des montants n'est pas un nombre valide." }, { status: 400 });
  }
  if (contract !== null && contract <= 0) return NextResponse.json({ error: "Le prix de l'offre doit être supérieur à 0." }, { status: 400 });
  if (contract !== null && marginValue !== null) {
    return NextResponse.json({ error: "Donne soit le prix de l'offre, soit la marge attendue, pas les deux : l'application ne saurait pas lequel garder fixe." }, { status: 400 });
  }
  if (contract === null && marginValue === null) {
    return NextResponse.json({ error: "Indique le prix de l'offre ou la marge attendue." }, { status: 400 });
  }
  if (marginValue !== null && body.margin_kind === "percent" && marginValue <= -100) {
    return NextResponse.json({ error: "Marge en % invalide." }, { status: 400 });
  }

  const { error } = await supabase
    .from("projects")
    .update({
      contract_amount: contract,
      expected_margin_percent: marginValue !== null && body.margin_kind !== "amount" ? marginValue : null,
      expected_margin_amount: marginValue !== null && body.margin_kind === "amount" ? marginValue : null,
    })
    .eq("id", id)
    .eq("organization_id", member.organization_id);
  if (error) {
    const missing = /contract_amount|expected_margin/.test(error.message);
    return NextResponse.json({
      error: missing
        ? "La base de données n'est pas encore à jour : exécute d'abord le fichier SQL « 20261006_project_pricing.sql » dans Supabase."
        : error.message,
    }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}

// Supprime le prix de l'offre et la marge attendue d'un chantier (admin).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    return NextResponse.json({ error: "Seul l'administrateur peut supprimer le prix et la marge." }, { status: 403 });
  }

  const { error } = await supabase
    .from("projects")
    .update({ contract_amount: null, expected_margin_percent: null, expected_margin_amount: null })
    .eq("id", id)
    .eq("organization_id", member.organization_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
