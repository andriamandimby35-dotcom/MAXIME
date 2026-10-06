import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCompanyProfileForPdf } from "@/lib/organization-profile";
import { generateOfficialEstimatePdf, type OfficialPdfRow } from "@/lib/estimates/official-pdf";
import { isLaborLine } from "@/lib/compositions/labor";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// PDF d'un devis ajouté par PDF, fabriqué à la demande depuis les lignes du
// chantier (même présentation que le bordereau d'origine : grille, nombres
// alignés à droite, numéros par rubrique, totaux de rubrique, récapitulation).
// Les deux PDF sont STRICTEMENT séparés :
// - mode "external" : uniquement les prix externes (client), colonnes « PRIX UNITAIRE » et « MONTANT » ;
// - mode "internal" : uniquement les prix internes (tes coûts), colonnes « PRIX UNITAIRE INTERNE » et « MONTANT INTERNE ».
// Le PDF est renvoyé directement (pas de stockage Supabase), en A4 portrait.
type Row = { designation: string | null; unit: string | null; quantity: number | string | null; unit_price: number | string | null; external_unit_price: number | string | null; is_internal: boolean | null; category: string | null; subcategory: string | null; position: string | null; ref?: string | null; description?: string | null; concerne?: string | null };

function roman(value: number) {
  const table: Array<[number, string]> = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let rest = Math.max(1, Math.floor(value));
  let out = "";
  for (const [amount, symbol] of table) while (rest >= amount) { out += symbol; rest -= amount; }
  return out;
}

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

  // Taux « TMP » lu sur le devis d'origine (colonne ajoutée par le SQL 20261013 : absente = pas de TMP).
  let tmpPercent = 0;
  {
    const tmpResult = await supabase.from("projects").select("tmp_percent").eq("id", id).maybeSingle();
    if (!tmpResult.error) tmpPercent = Number((tmpResult.data as { tmp_percent?: number | string | null } | null)?.tmp_percent) || 0;
  }

  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let page: Row[] | null = null;
    for (const columns of ["designation,unit,quantity,unit_price,external_unit_price,is_internal,category,subcategory,position,ref,description,concerne", "designation,unit,quantity,unit_price,external_unit_price,is_internal,category,subcategory,position", "designation,unit,quantity,unit_price,external_unit_price,is_internal"]) {
      const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).order("created_at", { ascending: true }).range(from, from + 999);
      if (!result.error) { page = (result.data as unknown as Row[]); break; }
    }
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < 1000) break;
  }

  // Le devis externe ne contient jamais les lignes « internes seulement ».
  const items = rows.filter((row) => mode === "internal" || !row.is_internal);
  // Prix de la ligne dans CE devis uniquement : null = pas encore de prix (case vide).
  // Interne : une ligne de main-d'œuvre / chantier sans prix compte 0 (déjà dans les salaires).
  const priceOf = (row: Row): number | null => {
    const value = Number(mode === "external" ? row.external_unit_price : row.unit_price);
    if (Number.isFinite(value) && value > 0) return value;
    if (mode === "internal" && isLaborLine(row.designation)) return 0;
    return null;
  };
  if (!items.some((row) => (priceOf(row) ?? 0) > 0)) {
    return NextResponse.json({ error: mode === "external" ? "Ce devis n'a pas encore de prix externe : donne la marge dans la page du devis." : "Ce devis n'a pas encore de prix interne : calcule ou remplis les prix dans la page du devis." }, { status: 400 });
  }

  const pdfRows: OfficialPdfRow[] = [];
  const recapEntries: Array<{ reference: string; title: string; total: number }> = [];
  let currentSection: string | null = null;
  let currentSectionNumber = "";
  let currentSubtotal = 0;
  let grandTotal = 0;
  let sectionCount = 0;
  let romanCounter = 0;
  let currentSubsection = "";
  let itemInSection = 0;
  const closeSection = () => {
    if (currentSection === null) return;
    pdfRows.push({ kind: "subtotal", title: currentSection, total: currentSubtotal });
    recapEntries.push({ reference: currentSectionNumber, title: currentSection, total: currentSubtotal });
    currentSubtotal = 0;
  };
  items.forEach((row) => {
    const category = String(row.category ?? "").trim();
    const subcategory = String(row.subcategory ?? "").trim();
    // La rubrique = la catégorie seule ; le sous-titre (texte descriptif) s'affiche à l'intérieur de la rubrique.
    const section = category || "Travaux";
    if (section !== currentSection) {
      currentSubsection = "";
      closeSection();
      currentSection = section;
      // « Installation et repli de chantier » en tête porte le n° 0, les autres rubriques I, II, III…
      // Numéro d'origine (« XI.15 » → rubrique XI) quand il a été lu à l'import ; sinon numérotation calculée.
      const refPrefix = String(row.ref ?? "").trim().split(".")[0];
      if (row.is_internal) currentSectionNumber = "A";
      else if (refPrefix) currentSectionNumber = refPrefix;
      else if (sectionCount === 0 && /installation|repli/i.test(section)) currentSectionNumber = "0";
      else { romanCounter += 1; currentSectionNumber = roman(romanCounter); }
      sectionCount += 1;
      itemInSection = 0;
      pdfRows.push({ kind: "section", title: section, number: currentSectionNumber });
    }
    if (subcategory && subcategory !== currentSubsection) {
      currentSubsection = subcategory;
      pdfRows.push({ kind: "subsection", title: subcategory });
    }
    itemInSection += 1;
    const quantity = Number(row.quantity) || 1;
    const unitPrice = priceOf(row);
    const total = unitPrice === null ? null : Math.round(quantity * unitPrice * 100) / 100;
    currentSubtotal += total ?? 0;
    grandTotal += total ?? 0;
    const fullText = String(row.description ?? "").trim() || String(row.designation ?? "").trim();
    pdfRows.push({ kind: "item", number: String(row.ref ?? "").trim() || `${currentSectionNumber}.${itemInSection}`, designation: fullText, concerne: String(row.concerne ?? "").trim() || undefined, unit: String(row.unit ?? "").trim(), quantity, unitPrice, total });
  });
  closeSection();

  const organization = Array.isArray(member.organizations) ? member.organizations[0] : member.organizations;
  const profile = await getCompanyProfileForPdf(supabase, member.organization_id, organization?.name);
  const pdf = generateOfficialEstimatePdf({
    companyName: profile.companyName,
    companyDetails: [profile.ownerName, `${profile.address} — ${profile.phone}`, `NIF ${profile.nif} — STAT ${profile.stat}`],
    documentLabel: mode === "internal" ? "DEVIS INTERNE" : "DEVIS EXTERNE",
    titleLabel: "Chantier",
    daoTitle: project.name,
    daoReference: "",
    clientName: "",
    estimateDate: new Intl.DateTimeFormat("fr-FR").format(new Date()),
    rows: pdfRows,
    grandTotal,
    bdqeLayout: {
      detail_table: {
        columns: mode === "internal"
          ? ["N°", "DÉSIGNATION DES TRAVAUX", "UNITÉ", "QUANTITÉ", "PRIX UNITAIRE INTERNE", "MONTANT INTERNE (Ar)"]
          : ["N°", "DÉSIGNATION DES TRAVAUX", "UNITÉ", "QUANTITÉ", "PRIX UNITAIRE", "MONTANT (Ar)"],
      },
    },
    recapGroups: [{ reference: "", title: "Bordereau détail quantitatif et estimatif", entries: recapEntries }],
    includeExternalRecap: mode === "external",
    // TMP (taxe écrite sous le total du devis d'origine) : seulement dans le devis externe.
    extraTotals: mode === "external" && tmpPercent > 0
      ? [
          { label: `TMP ${tmpPercent.toLocaleString("fr-FR")} %`, amount: Math.round(grandTotal * tmpPercent) / 100 },
          { label: `TOTAL AVEC TMP ${tmpPercent.toLocaleString("fr-FR")} %`, amount: Math.round(grandTotal * (100 + tmpPercent)) / 100 },
        ]
      : undefined,
  });
  const fileName = `devis-${mode === "internal" ? "interne" : "externe"}-${id.slice(0, 8)}.pdf`;
  return NextResponse.json({ ok: true, fileName, pdfBase64: Buffer.from(pdf).toString("base64") });
}
