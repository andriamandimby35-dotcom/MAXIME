import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCompanyProfileForPdf } from "@/lib/organization-profile";
import { generateProgressClaimPdf } from "@/lib/billing/situation-pdf";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function safeName(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "facture";
}

// Régénère et ouvre le PDF d'une facture déjà enregistrée : sert à la fois
// pour l'impression immédiate et pour rouvrir l'historique plus tard — le
// PDF est reconstruit à chaque appel à partir des lignes enregistrées, donc
// toujours fidèle même si le style du document est amélioré par la suite.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id,organizations(id,name)").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: claim, error: claimError } = await supabase
    .from("progress_claims")
    .select("id,project_id,claim_number,client_name,issue_date,period_start,period_end,gross_amount,retention_rate,retention_amount,advance_repayment,other_deductions,tax_rate,tax_amount,net_amount")
    .eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (claimError || !claim) return NextResponse.json({ error: "Facture introuvable dans votre organisation." }, { status: 404 });

  const { data: items } = await supabase
    .from("progress_claim_items")
    .select("position,designation,unit,contract_quantity,unit_price,previous_quantity,current_quantity")
    .eq("progress_claim_id", id)
    .order("position", { ascending: true });

  // Le nom du client est figé sur la facture au moment de sa création (voir
  // POST /api/billing/claims) : on ne le relit plus depuis le DAO ici, pour
  // qu'une modification ultérieure du DAO ne change jamais une facture déjà
  // émise.
  const { data: project } = await supabase.from("projects").select("id,name,location,source_tender_id").eq("id", claim.project_id).maybeSingle();
  const clientName = claim.client_name || "";
  let daoReference = "";
  if (project?.source_tender_id) {
    const { data: tender } = await supabase.from("tenders").select("reference").eq("id", project.source_tender_id).maybeSingle();
    daoReference = tender?.reference || "";
  }

  const organization = Array.isArray(member.organizations) ? member.organizations[0] : member.organizations;
  const profile = await getCompanyProfileForPdf(supabase, member.organization_id, organization?.name);
  // Une ligne "dépense diverse" (Transport, Main d'œuvre, Autre) a été
  // enregistrée avec un prix unitaire fixé à 1 : sa quantité EST le montant
  // en Ariary. On la reconnaît ici pour l'afficher sans quantité/prix inutiles.
  const lines = (items ?? []).map((item) => {
    const unitPrice = Number(item.unit_price) || 0;
    const isDepense = unitPrice === 1 && Number(item.contract_quantity) === 0;
    const previousAmount = Math.round(Number(item.previous_quantity) * unitPrice * 100) / 100;
    const currentAmount = Math.round(Number(item.current_quantity) * unitPrice * 100) / 100;
    return {
      kind: (isDepense ? "depense" : "devis") as "depense" | "devis",
      position: item.position,
      designation: item.designation,
      unit: item.unit,
      contractQuantity: isDepense ? null : Number(item.contract_quantity) || 0,
      unitPrice: isDepense ? null : unitPrice,
      previousQuantity: Number(item.previous_quantity) || 0,
      currentQuantity: Number(item.current_quantity) || 0,
      previousAmount,
      currentAmount,
      amountThisTime: Math.round((currentAmount - previousAmount) * 100) / 100,
    };
  });

  const periodLabel = claim.period_start && claim.period_end
    ? `${new Intl.DateTimeFormat("fr-FR").format(new Date(claim.period_start))} au ${new Intl.DateTimeFormat("fr-FR").format(new Date(claim.period_end))}`
    : undefined;

  const pdf = generateProgressClaimPdf({
    companyName: profile.companyName,
    companyDetails: [
      profile.ownerName,
      `${profile.address} — ${profile.phone}`,
      `NIF ${profile.nif} — STAT ${profile.stat}`,
    ],
    claimNumber: claim.claim_number,
    issueDate: new Intl.DateTimeFormat("fr-FR").format(new Date(claim.issue_date)),
    periodLabel,
    projectName: project?.name || "",
    projectLocation: project?.location || "",
    daoReference,
    clientName,
    legalMentions: [
      `${profile.companyName} — NIF ${profile.nif} — STAT ${profile.stat} — RCS ${profile.rcs}`,
      `Facture soumise à la taxe de ${Number(claim.tax_rate) || 8} % (déjà incluse dans le montant net ci-dessus). Aucune TVA supplémentaire applicable.`,
    ],
    lines,
    grossAmount: Number(claim.gross_amount) || 0,
    retentionRate: Number(claim.retention_rate) || 0,
    retentionAmount: Number(claim.retention_amount) || 0,
    advanceRepayment: Number(claim.advance_repayment) || 0,
    otherDeductions: Number(claim.other_deductions) || 0,
    taxRate: Number(claim.tax_rate) || 0,
    taxAmount: Number(claim.tax_amount) || 0,
    netAmount: Number(claim.net_amount) || 0,
  });

  const fileName = `facture-${safeName(claim.claim_number)}.pdf`;
  const storagePath = `${member.organization_id}/${claim.project_id}/${fileName}`;
  const upload = await supabase.storage.from("billing-pdfs").upload(storagePath, pdf, { contentType: "application/pdf", cacheControl: "300", upsert: true });
  if (upload.error) return NextResponse.json({ error: `Enregistrement du PDF impossible : ${upload.error.message}` }, { status: 400 });

  const signed = await supabase.storage.from("billing-pdfs").createSignedUrl(storagePath, 300, { download: fileName });
  if (signed.error) return NextResponse.json({ error: `Lien privé indisponible : ${signed.error.message}` }, { status: 400 });

  return NextResponse.redirect(signed.data.signedUrl);
}
