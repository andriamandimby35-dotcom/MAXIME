import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCompanyProfileForPdf } from "@/lib/organization-profile";
import { generateProgressClaimPdf } from "@/lib/billing/situation-pdf";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function safeName(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "facture";
}

// PDF d'une facture enregistrée. Il est fabriqué UNE SEULE FOIS (à la première
// ouverture) puis conservé dans Supabase sous un nom propre à cette facture
// (son identifiant) : une facture plus avancée a son propre fichier et
// n'écrase jamais l'ancien. Les ouvertures suivantes relisent ce fichier figé,
// et le navigateur le garde en mémoire (cache) : pas de nouveau téléchargement
// à chaque ouverture. Le fichier est supprimé avec la facture.
const PDF_CACHE_HEADERS = {
  "Content-Type": "application/pdf",
  "Cache-Control": "private, max-age=31536000, immutable",
};
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id,organizations(id,name)").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  // Une facture payée d'un chantier supprimé est « archivée » : project_id est
  // vide et le nom du chantier est gardé sur la facture (project_name).
  const claimColumns = "id,project_id,claim_number,client_name,issue_date,period_start,period_end,gross_amount,retention_rate,retention_amount,advance_repayment,other_deductions,tax_rate,tax_amount,net_amount";
  type ClaimRow = { id: string; project_id: string | null; project_name?: string | null; claim_number: string; client_name: string | null; issue_date: string; period_start: string | null; period_end: string | null; gross_amount: number | string; retention_rate: number | string; retention_amount: number | string; advance_repayment: number | string; other_deductions: number | string; tax_rate: number | string; tax_amount: number | string; net_amount: number | string };
  let claimResult = await supabase.from("progress_claims").select(`${claimColumns},project_name`).eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  // Colonne project_name pas encore créée (fichier SQL non exécuté) : lecture sans elle.
  if (claimResult.error) claimResult = await supabase.from("progress_claims").select(claimColumns).eq("id", id).eq("organization_id", member.organization_id).maybeSingle() as unknown as typeof claimResult;
  const claim = claimResult.data as unknown as ClaimRow | null;
  if (claimResult.error || !claim) return NextResponse.json({ error: "Facture introuvable dans votre organisation." }, { status: 404 });

  const storagePath = claim.project_id
    ? `${member.organization_id}/${claim.project_id}/${claim.id}.pdf`
    : `${member.organization_id}/archive/${claim.id}.pdf`;
  const storedFileName = `facture-${safeName(claim.claim_number)}.pdf`;
  const stored = await supabase.storage.from("billing-pdfs").download(storagePath);
  if (!stored.error && stored.data) {
    return new NextResponse(Buffer.from(await stored.data.arrayBuffer()), {
      status: 200,
      headers: { ...PDF_CACHE_HEADERS, "Content-Disposition": `inline; filename="${storedFileName}"` },
    });
  }

  type ItemRow = { position: number; designation: string; unit: string; contract_quantity: number | string; unit_price: number | string; previous_quantity: number | string; current_quantity: number | string; category?: string | null; subcategory?: string | null };
  let items: ItemRow[] | null = null;
  const withTitles = await supabase
    .from("progress_claim_items")
    .select("position,designation,unit,contract_quantity,unit_price,previous_quantity,current_quantity,category,subcategory")
    .eq("progress_claim_id", id)
    .order("position", { ascending: true });
  if (!withTitles.error) items = withTitles.data as ItemRow[];
  else {
    // Colonnes de titres pas encore créées (fichier SQL non exécuté) : facture à plat.
    const plain = await supabase
      .from("progress_claim_items")
      .select("position,designation,unit,contract_quantity,unit_price,previous_quantity,current_quantity")
      .eq("progress_claim_id", id)
      .order("position", { ascending: true });
    items = plain.data as ItemRow[] | null;
  }

  // Le nom du client est figé sur la facture au moment de sa création (voir
  // POST /api/billing/claims) : on ne le relit plus depuis le DAO ici, pour
  // qu'une modification ultérieure du DAO ne change jamais une facture déjà
  // émise.
  const { data: project } = claim.project_id
    ? await supabase.from("projects").select("id,name,location,source_tender_id").eq("id", claim.project_id).maybeSingle()
    : { data: null };
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
      category: item.category || undefined,
      subcategory: item.subcategory || undefined,
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
    projectName: project?.name || claim.project_name || "",
    projectLocation: project?.location || "",
    daoReference,
    clientName,
    legalMentions: [
      `${profile.companyName} — NIF ${profile.nif} — STAT ${profile.stat} — RCS ${profile.rcs}`,
      ...(Number(claim.tax_rate) > 0 ? [`La taxe de l'État (${Number(claim.tax_rate)} %) est déduite du montant de cette facture, comme indiqué ci-dessus.`] : []),
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
    // Anciennes factures : la taxe s'ajoutait au total. Les nouvelles la déduisent.
    taxAdded: (() => {
      const gross = Number(claim.gross_amount) || 0;
      const taxable = Math.max(0, gross - (Number(claim.retention_amount) || 0) - (Number(claim.advance_repayment) || 0) - (Number(claim.other_deductions) || 0));
      const tax = Number(claim.tax_amount) || 0;
      return tax > 0 && Math.abs((Number(claim.net_amount) || 0) - (taxable + tax)) < 1 && Math.abs((Number(claim.net_amount) || 0) - Math.max(0, taxable - tax)) >= 1;
    })(),
  });

  // Première ouverture : on enregistre le PDF une fois (sans jamais écraser un
  // fichier existant), puis on le renvoie pour être OUVERT, pas téléchargé.
  const upload = await supabase.storage.from("billing-pdfs").upload(storagePath, pdf, { contentType: "application/pdf", cacheControl: "31536000", upsert: false });
  if (upload.error && !/exists|duplicate/i.test(upload.error.message)) console.error("Enregistrement du PDF de facture impossible :", upload.error.message);
  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: { ...PDF_CACHE_HEADERS, "Content-Disposition": `inline; filename="${storedFileName}"` },
  });
}
