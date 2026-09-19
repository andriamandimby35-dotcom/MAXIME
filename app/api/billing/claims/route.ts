import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type LinePayload = {
  kind?: "devis" | "depense";
  position?: number;
  designation?: string;
  unit?: string;
  contract_quantity?: number | null;
  unit_price?: number | null;
  previous_quantity?: number;
  current_quantity?: number;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const body = await request.json();
  const lines: LinePayload[] = Array.isArray(body.lines) ? body.lines : [];
  if (!body.project_id || !body.claim_number || lines.length === 0) {
    return NextResponse.json({ error: "Données de facture invalides." }, { status: 400 });
  }

  const { data: project } = await supabase.from("projects").select("id,source_estimate_id,source_tender_id,manual_margin_percent,manual_client_name,next_claim_seq").eq("id", body.project_id).eq("organization_id", member.organization_id).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable dans votre organisation." }, { status: 404 });

  // Si ce chantier n'a pas de devis d'origine et qu'aucune marge n'est
  // encore retenue, on enregistre celle indiquée à l'écran maintenant, pour
  // ne plus la redemander la prochaine fois.
  if (!project.source_estimate_id && (project.manual_margin_percent === null || project.manual_margin_percent === undefined) && Number.isFinite(Number(body.margin_percent))) {
    await supabase.from("projects").update({ manual_margin_percent: Number(body.margin_percent) }).eq("id", project.id);
  }
  // Même logique pour le nom du client quand ce chantier n'a pas de DAO
  // d'origine : on le retient une fois pour ne plus le redemander.
  const clientName = String(body.client_name || "").trim();
  if (!project.source_tender_id && !project.manual_client_name && clientName) {
    await supabase.from("projects").update({ manual_client_name: clientName }).eq("id", project.id);
  }

  // Les montants ne sont jamais repris tels quels depuis le navigateur : on
  // les recalcule ici à partir des lignes et des taux, pour qu'aucun montant
  // final ne dépende d'une valeur modifiable côté client.
  const normalizedLines = lines.map((line, index) => {
    const isDepense = line.kind === "depense";
    const contractQuantity = isDepense ? 0 : Number(line.contract_quantity) || 0;
    const unitPrice = isDepense ? 1 : Number(line.unit_price) || 0;
    const previousQuantity = Math.max(0, Number(line.previous_quantity) || 0);
    const currentQuantity = Math.max(previousQuantity, Number(line.current_quantity) || 0);
    return {
      position: Number.isFinite(line.position) ? Number(line.position) : index + 1,
      designation: String(line.designation || "").trim() || "Poste sans désignation",
      unit: String(line.unit || "").trim() || "U",
      contract_quantity: contractQuantity,
      unit_price: unitPrice,
      previous_quantity: previousQuantity,
      current_quantity: currentQuantity,
    };
  });

  const gross = Math.round(normalizedLines.reduce((sum, line) => sum + (line.current_quantity - line.previous_quantity) * line.unit_price, 0) * 100) / 100;
  const retentionRate = Math.max(0, Number(body.retention_rate) || 0);
  const retention = Math.round(gross * retentionRate / 100 * 100) / 100;
  const advance = Math.max(0, Number(body.advance_repayment) || 0);
  const other = Math.max(0, Number(body.other_deductions) || 0);
  const taxable = Math.max(0, gross - retention - advance - other);
  const taxRate = Math.max(0, Number(body.tax_rate) || 0);
  const tax = Math.round(taxable * taxRate / 100 * 100) / 100;
  const net = Math.round((taxable + tax) * 100) / 100;

  const { data: claim, error } = await supabase.from("progress_claims").insert({
    organization_id: member.organization_id,
    project_id: project.id,
    claim_number: String(body.claim_number).trim(),
    client_name: clientName || null,
    period_start: body.period_start || null,
    period_end: body.period_end || null,
    issue_date: body.issue_date || new Date().toISOString().slice(0, 10),
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
  }).select("id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Le compteur n'avance qu'à cet instant, une fois la facture vraiment
  // enregistrée (jamais sur un simple aperçu) : il ne recule jamais, même si
  // cette facture ou une précédente est supprimée ensuite.
  await supabase.from("projects").update({ next_claim_seq: (Number(project.next_claim_seq) || 1) + 1 }).eq("id", project.id);

  const { error: itemsError } = await supabase.from("progress_claim_items").insert(
    normalizedLines.map((line) => ({
      organization_id: member.organization_id,
      progress_claim_id: claim.id,
      position: line.position,
      designation: line.designation,
      unit: line.unit,
      contract_quantity: line.contract_quantity,
      unit_price: line.unit_price,
      previous_quantity: line.previous_quantity,
      current_quantity: line.current_quantity,
    })),
  );
  if (itemsError) {
    // On retire l'entête déjà créée plutôt que de laisser une facture sans
    // aucune ligne, impossible à corriger depuis l'écran normal.
    await supabase.from("progress_claims").delete().eq("id", claim.id);
    return NextResponse.json({ error: itemsError.message }, { status: 400 });
  }

  return NextResponse.json({ id: claim.id }, { status: 201 });
}
