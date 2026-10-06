import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCompanyProfileForPdf } from "@/lib/organization-profile";
import { generateOfficialEstimatePdf, type OfficialPdfRow } from "@/lib/estimates/official-pdf";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// PDF d'un devis ajouté par PDF, fabriqué à la demande depuis les lignes du
// chantier (mêmes pages et même présentation que les devis du DAO) :
// - mode "external" : prix du client (devis importé) ;
// - mode "internal" : tes coûts, avec le résumé marge / bénéfice.
// Le PDF est renvoyé directement (pas de stockage Supabase), en A4 portrait.
type Row = { designation: string | null; unit: string | null; quantity: number | string | null; unit_price: number | string | null; external_unit_price: number | string | null; is_internal: boolean | null; category: string | null; subcategory: string | null; position: string | null };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { mode?: string };
  const mode: "internal" | "external" = body.mode === "internal" ? "internal" : "external";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id,organizations(id,name)").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: project } = await supabase.from("projects").select("id,name").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!project) return NextResponse.json({ error: "Devis introuvable dans votre organisation." }, { status: 404 });

  let rows: Row[] | null = null;
  for (const columns of ["designation,unit,quantity,unit_price,external_unit_price,is_internal,category,subcategory,position", "designation,unit,quantity,unit_price,external_unit_price,is_internal"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).order("created_at", { ascending: true });
    if (!result.error) { rows = (result.data as unknown as Row[]); break; }
  }
  const items = (rows ?? []).filter((row) => mode === "internal" || !row.is_internal);
  const priceOf = (row: Row) => Number(mode === "external" ? row.external_unit_price : row.unit_price) || 0;
  if (!items.some((row) => priceOf(row) > 0)) {
    return NextResponse.json({ error: mode === "external" ? "Ce devis n'a pas encore de prix externe : donne la marge dans la page du devis." : "Ce devis n'a pas encore de prix interne : remplis les prix (IA) dans la page du devis." }, { status: 400 });
  }

  const pdfRows: OfficialPdfRow[] = [];
  const recapEntries: Array<{ title: string; total: number }> = [];
  let currentSection: string | null = null;
  let currentSubtotal = 0;
  let grandTotal = 0;
  const closeSection = () => {
    if (currentSection === null) return;
    pdfRows.push({ kind: "subtotal", title: currentSection, total: currentSubtotal });
    recapEntries.push({ title: currentSection, total: currentSubtotal });
    currentSubtotal = 0;
  };
  items.forEach((row, index) => {
    const category = String(row.category ?? "").trim();
    const subcategory = String(row.subcategory ?? "").trim();
    const section = [category, subcategory].filter(Boolean).join(" — ") || "Travaux";
    if (section !== currentSection) {
      closeSection();
      currentSection = section;
      pdfRows.push({ kind: "section", title: section });
    }
    const quantity = Number(row.quantity) || 1;
    const unitPrice = priceOf(row);
    const total = Math.round(quantity * unitPrice * 100) / 100;
    currentSubtotal += total;
    grandTotal += total;
    pdfRows.push({ kind: "item", number: String(row.position ?? "").trim() || String(index + 1), designation: String(row.designation ?? "").trim(), unit: String(row.unit ?? "").trim(), quantity, unitPrice, total });
  });
  closeSection();

  // Résumé interne : sur les lignes qui ont les deux prix.
  let internalCost = 0;
  let pairedInternal = 0;
  let pairedExternal = 0;
  let externalTotal = 0;
  for (const row of rows ?? []) {
    const quantity = Number(row.quantity) || 1;
    const internal = Number(row.unit_price) || 0;
    const external = Number(row.external_unit_price) || 0;
    internalCost += quantity * internal;
    if (!row.is_internal) externalTotal += quantity * external;
    if (!row.is_internal && internal > 0 && external > 0) { pairedInternal += quantity * internal; pairedExternal += quantity * external; }
  }
  const marginPercent = pairedInternal > 0 ? (pairedExternal / pairedInternal - 1) * 100 : 0;

  const organization = Array.isArray(member.organizations) ? member.organizations[0] : member.organizations;
  const profile = await getCompanyProfileForPdf(supabase, member.organization_id, organization?.name);
  const pdf = generateOfficialEstimatePdf({
    companyName: profile.companyName,
    companyDetails: [profile.ownerName, `${profile.address} — ${profile.phone}`, `NIF ${profile.nif} — STAT ${profile.stat}`],
    daoTitle: `${mode === "internal" ? "DEVIS INTERNE — " : ""}${project.name}`,
    daoReference: "",
    clientName: "",
    estimateDate: new Intl.DateTimeFormat("fr-FR").format(new Date()),
    rows: pdfRows,
    grandTotal,
    recapGroups: [{ reference: "", title: "Bordereau détail quantitatif et estimatif", entries: recapEntries.map((entry) => ({ reference: "", title: entry.title, total: entry.total })) }],
    includeExternalRecap: mode === "external",
    internalFinancialSummary: mode === "internal" ? [
      { title: "Coût réel interne (lignes chiffrées)", total: internalCost },
      { title: `Marge du devis externe (${Math.round(marginPercent * 10) / 10} %)`, total: pairedExternal - pairedInternal },
      { title: "Montant du devis externe", total: externalTotal },
    ] : undefined,
  });
  const fileName = `devis-${mode === "internal" ? "interne" : "externe"}-${id.slice(0, 8)}.pdf`;
  return NextResponse.json({ ok: true, fileName, pdfBase64: Buffer.from(pdf).toString("base64") });
}
