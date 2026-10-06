import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeSituationDraft } from "@/lib/billing/generate-situation";
import { claimEnd } from "@/lib/billing/claim-periods";

// Met à jour la DERNIÈRE facture encore non payée quand un prix du devis, un
// avancement (rapport arrivé en retard) ou le classement d'une dépense a changé
// depuis sa création. Seule cette facture bouge : les factures payées (même
// partiellement) ou plus anciennes gardent leurs montants et leur PDF d'origine.
// La facture mise à jour reçoit une note (ligne orange à l'écran) et son ancien
// PDF est supprimé : il est refait à la prochaine ouverture.

const normalize = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase("fr-FR");
const round2 = (value: number) => Math.round(value * 100) / 100;

type ItemRow = { id: string; position: number; designation: string; unit: string; contract_quantity: number | string; unit_price: number | string; previous_quantity: number | string; current_quantity: number | string; category?: string | null; subcategory?: string | null };

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id,role").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  if (member.role !== "admin" && member.role !== "owner") return NextResponse.json({ updated: false });
  const organizationId = member.organization_id as string;

  // Colonnes de période absentes (SQL pas encore exécuté) : rien à mettre à jour.
  const claimsResult = await supabase
    .from("progress_claims")
    .select("id,claim_number,status,issue_date,period_start,period_end,client_name,retention_rate,advance_repayment,other_deductions,tax_rate,created_at")
    .eq("project_id", projectId).eq("organization_id", organizationId).neq("status", "rejected");
  if (claimsResult.error) return NextResponse.json({ updated: false });
  const claims = (claimsResult.data ?? []) as Array<{ id: string; claim_number: string; status: string; issue_date: string; period_start: string | null; period_end: string | null; client_name: string | null; retention_rate: number | string; advance_repayment: number | string; other_deductions: number | string; tax_rate: number | string; created_at: string }>;
  const latest = [...claims].sort((a, b) => claimEnd(b).localeCompare(claimEnd(a)) || String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!latest || latest.status !== "submitted" || !latest.period_start || !latest.period_end) return NextResponse.json({ updated: false });

  const { count: paymentCount } = await supabase.from("payments").select("id", { count: "exact", head: true }).eq("progress_claim_id", latest.id);
  if ((paymentCount ?? 0) > 0) return NextResponse.json({ updated: false });

  const itemsResult = await supabase
    .from("progress_claim_items")
    .select("id,position,designation,unit,contract_quantity,unit_price,previous_quantity,current_quantity,category,subcategory")
    .eq("progress_claim_id", latest.id).order("position", { ascending: true });
  if (itemsResult.error) return NextResponse.json({ updated: false });
  const oldItems = (itemsResult.data ?? []) as ItemRow[];
  const isDepenseRow = (item: ItemRow) => Number(item.unit_price) === 1 && Number(item.contract_quantity) === 0;

  // Une ligne du devis ne descend jamais sous la quantité déjà facturée sur cette facture.
  const floors = new Map<string, number>();
  for (const item of oldItems) if (!isDepenseRow(item)) floors.set(normalize(item.designation), Number(item.current_quantity) || 0);

  const draft = await computeSituationDraft(supabase, {
    organizationId, projectId, clientNameOverride: latest.client_name ?? undefined,
    periodStart: String(latest.period_start).slice(0, 10), periodEnd: String(latest.period_end).slice(0, 10),
    excludeClaimId: latest.id, minCurrentByDesignation: floors,
  });
  if ("error" in draft || "needsMarginInput" in draft || "needsClientInput" in draft) return NextResponse.json({ updated: false });

  const newRows = draft.lines.map((line) => {
    const isDepense = line.kind === "depense";
    return {
      position: line.position,
      designation: line.designation,
      unit: String(line.unit || "").trim() || "U",
      contract_quantity: isDepense ? 0 : Number(line.contractQuantity) || 0,
      unit_price: isDepense ? 1 : Number(line.unitPrice) || 0,
      previous_quantity: Math.max(0, line.previousQuantity),
      current_quantity: Math.max(line.previousQuantity, line.currentQuantity),
      category: line.category || null,
      subcategory: line.subcategory || null,
    };
  });

  // Y a-t-il une vraie différence ? (désignation, prix, quantités)
  const oldByKey = new Map(oldItems.map((item) => [normalize(item.designation), item]));
  let priceChanged = false; let progressChanged = false; let autreChanged = false; let structureChanged = oldItems.length !== newRows.length;
  for (const row of newRows) {
    const old = oldByKey.get(normalize(row.designation));
    if (!old) { structureChanged = true; continue; }
    const oldIsDepense = isDepenseRow(old);
    const newIsDepense = row.unit_price === 1 && row.contract_quantity === 0;
    if (oldIsDepense !== newIsDepense) { structureChanged = true; continue; }
    if (newIsDepense) {
      if (Math.abs(Number(old.current_quantity) - row.current_quantity) > 0.5 || Math.abs(Number(old.previous_quantity) - row.previous_quantity) > 0.5) autreChanged = true;
      continue;
    }
    if (Math.abs(Number(old.unit_price) - row.unit_price) > 0.01 || Math.abs(Number(old.contract_quantity) - row.contract_quantity) > 0.0005) priceChanged = true;
    if (Math.abs(Number(old.current_quantity) - row.current_quantity) > 0.0005 || Math.abs(Number(old.previous_quantity) - row.previous_quantity) > 0.0005) progressChanged = true;
  }
  if (!priceChanged && !progressChanged && !autreChanged && !structureChanged) return NextResponse.json({ updated: false });

  const reasons: string[] = [];
  if (priceChanged) reasons.push("prix du devis modifié");
  if (structureChanged) reasons.push("lignes du devis modifiées");
  if (progressChanged) reasons.push("avancement mis à jour");
  if (autreChanged) reasons.push("dépense classée ou ajoutée (ligne Autre)");
  const note = `Mise à jour : ${reasons.join(", ")}.`;

  // Nouvelles lignes d'abord, anciennes supprimées ensuite : jamais de facture sans ligne.
  const insertRows = newRows.map((row) => ({ organization_id: organizationId, progress_claim_id: latest.id, ...row }));
  let { error: insertError } = await supabase.from("progress_claim_items").insert(insertRows);
  if (insertError && /category|subcategory/.test(insertError.message)) {
    ({ error: insertError } = await supabase.from("progress_claim_items").insert(insertRows.map(({ category: _c, subcategory: _s, ...rest }) => rest)));
  }
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 400 });
  await supabase.from("progress_claim_items").delete().in("id", oldItems.map((item) => item.id));

  const gross = round2(newRows.reduce((sum, row) => sum + (row.current_quantity - row.previous_quantity) * row.unit_price, 0));
  const retentionRate = Math.max(0, Number(latest.retention_rate) || 0);
  const retention = Number(latest.retention_rate) > 0 ? round2(gross * retentionRate / 100) : 0;
  const advance = Math.max(0, Number(latest.advance_repayment) || 0);
  const other = Math.max(0, Number(latest.other_deductions) || 0);
  const taxable = Math.max(0, gross - retention - advance - other);
  const taxRate = Math.max(0, Number(latest.tax_rate) || 0);
  const tax = round2(taxable * taxRate / 100);
  const net = round2(Math.max(0, taxable - tax));

  const totals = { gross_amount: gross, retention_amount: retention, tax_amount: tax, net_amount: net, updated_at: new Date().toISOString() };
  let { error: updateError } = await supabase.from("progress_claims").update({ ...totals, refresh_note: note, refreshed_at: new Date().toISOString() }).eq("id", latest.id).eq("organization_id", organizationId);
  if (updateError && /refresh_note|refreshed_at/.test(updateError.message)) {
    ({ error: updateError } = await supabase.from("progress_claims").update(totals).eq("id", latest.id).eq("organization_id", organizationId));
  }
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 400 });

  // L'ancien PDF ne correspond plus : il sera refait à la prochaine ouverture.
  await supabase.storage.from("billing-pdfs").remove([`${organizationId}/${projectId}/${latest.id}.pdf`]);
  return NextResponse.json({ updated: true, note, claimNumber: latest.claim_number });
}
