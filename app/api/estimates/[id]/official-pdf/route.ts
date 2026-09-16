import { NextResponse } from "next/server";
import { companyProfile } from "@/lib/company";
import { generateOfficialEstimatePdf, type OfficialPdfRow } from "@/lib/estimates/official-pdf";
import { createOrSyncProjectFromEstimate } from "@/lib/projects/create-project-from-estimate";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type LineData = Record<string, unknown>;

function normalizedKey(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueFrom(line: LineData, candidates: string[]) {
  const wanted = new Set(candidates.map(normalizedKey));
  const entry = Object.entries(line).find(([key]) => wanted.has(normalizedKey(key)));
  return entry?.[1];
}

function textFrom(line: LineData, candidates: string[]) {
  return String(valueFrom(line, candidates) ?? "").trim();
}

function numberFrom(line: LineData, candidates: string[]) {
  const raw = valueFrom(line, candidates);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const parsed = Number(String(raw ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowType(line: LineData) {
  const type = String(line.__daoRowType ?? "item");
  return type === "section" || type === "subtotal" ? type : "item";
}

function isInternal(line: LineData) {
  return line.__internalOnly === true || line.__internalOnly === "true" || line.__disabledInternal === true;
}

function isExcludedByChoice(line: LineData) {
  return line.__excludedByChoice === true || line.__excludedByChoice === "true";
}

function safeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "devis";
}

async function generateOfficialPdfResponse(
  context: { params: Promise<{ id: string }> },
  shouldSave: boolean,
  mode: "external" | "internal" = "external",
  openDirectly = false,
  request?: Request,
) {
  const { id: estimateId } = await context.params;
  // Certaines extensions de sécurité remplacent les réponses PDF brutes par
  // un 204. Pour le lecteur interne, le client demande explicitement le PDF
  // encodé : il le reconstruit ensuite localement en Blob.
  const returnPdfPayload = request?.headers.get("x-pdf-client-fetch") === "1";
  const supabase = await createServerClient();
  const accessToken = request?.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request?.headers.get("x-supabase-access-token") || "";
  const { data: { user } } = await supabase.auth.getUser(accessToken);
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id,organizations(id,name,phone)")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .select("id,organization_id,dao_template_id,client_name,created_at,profit_margin_percent")
    .eq("id", estimateId)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (estimateError || !estimate) return NextResponse.json({ error: "Devis introuvable dans votre organisation." }, { status: 404 });

  const { data: storedLines, error: linesError } = await supabase
    .from("estimate_lines")
    .select("id,data")
    .eq("estimate_id", estimateId);
  if (linesError) return NextResponse.json({ error: `Lecture du devis impossible : ${linesError.message}` }, { status: 400 });

  const lines = (storedLines ?? [])
    .map((stored): LineData => ({ ...(stored.data as LineData), __lineId: stored.id }))
    .filter((line) => !isExcludedByChoice(line))
    .filter((line) => mode === "internal" || !isInternal(line))
    .sort((left, right) => Number(left.__sortOrder ?? 0) - Number(right.__sortOrder ?? 0));
  const allActiveLines = (storedLines ?? [])
    .map((stored): LineData => ({ ...(stored.data as LineData), __lineId: stored.id }))
    .filter((line) => !isExcludedByChoice(line) && line.__disabledInternal !== true && rowType(line) === "item");
  const sourceTenderId = String(lines.find((line) => line.__sourceTenderId)?.__sourceTenderId ?? "");
  let tender: { title?: string; reference?: string; client_name?: string; ai_analysis?: unknown } | null = null;
  if (sourceTenderId) {
    const result = await supabase
      .from("tenders")
      .select("title,reference,client_name,ai_analysis")
      .eq("id", sourceTenderId)
      .eq("organization_id", member.organization_id)
      .maybeSingle();
    tender = result.data;
  }

  const pdfRows: OfficialPdfRow[] = [];
  const recapGroups = new Map<string, { reference: string; title: string; entries: Array<{ reference: string; title: string; total: number }> }>();
  let currentSection = "";
  let currentSectionParentTitle = "";
  let currentSectionParentReference = "";
  let currentSubtotal = 0;
  let grandTotal = 0;
  const addSectionToRecap = () => {
    if (!currentSection) return;
    const groupTitle = currentSectionParentTitle || "Bordereau détail quantitatif et estimatif";
    const groupReference = currentSectionParentReference || "";
    const groupKey = `${groupReference}|${groupTitle}`;
    const group = recapGroups.get(groupKey) ?? { reference: groupReference, title: groupTitle, entries: [] };
    group.entries.push({ reference: "", title: currentSection, total: currentSubtotal });
    recapGroups.set(groupKey, group);
  };
  const marginMultiplier = mode === "external" ? 1 + (Number(estimate.profit_margin_percent) || 0) / 100 : 1;
  for (const line of lines) {
    const type = rowType(line);
    const designation = textFrom(line, ["Désignation", "DÃ©signation", "DÃƒÂ©signation", "Designation", "designation"]);
    if (type === "section") {
      addSectionToRecap();
      currentSection = String(line.__daoSectionTitle ?? designation).trim();
      currentSectionParentTitle = String(line.__daoParentTitle ?? "").trim();
      currentSectionParentReference = String(line.__daoParentReference ?? "").trim();
      currentSubtotal = 0;
      if (currentSection) pdfRows.push({ kind: "section", title: currentSection });
      continue;
    }
    if (type === "subtotal") {
      const title = String(line.__daoSectionTitle ?? currentSection ?? designation).trim();
      pdfRows.push({ kind: "subtotal", title, total: currentSubtotal });
      addSectionToRecap();
      currentSubtotal = 0;
      currentSection = "";
      continue;
    }
    const quantity = numberFrom(line, ["Quantité", "QuantitÃ©", "QuantitÃƒÂ©", "Quantite", "quantite"]);
    const baseUnitPrice = numberFrom(line, ["Prix unitaire", "prix_unitaire"]);
    // Le devis interne garde les coûts réels. La marge choisie s'applique à
    // tous les postes du devis externe, y compris aux prix composés ; le
    // détail de leurs matériaux demeure lui enregistré au coût réel.
    const unitPrice = mode === "external"
      ? Math.round(baseUnitPrice * marginMultiplier * 100) / 100
      : baseUnitPrice;
    const storedTotal = numberFrom(line, ["Total", "total"]);
    const total = mode === "external" ? quantity * unitPrice : (storedTotal || quantity * unitPrice);
    currentSubtotal += total;
    grandTotal += total;
    pdfRows.push({
      kind: "item",
      number: textFrom(line, ["N°", "NÂ°", "NÃ‚Â°", "N", "numero"]),
      designation,
      unit: textFrom(line, ["Unité", "UnitÃ©", "UnitÃƒÂ©", "Unite", "unite"]),
      quantity,
      unitPrice,
      total,
    });
  }
  addSectionToRecap();
  if (!pdfRows.some((row) => row.kind === "item")) {
    return NextResponse.json({ error: "Le devis ne contient aucun poste DAO à exporter." }, { status: 400 });
  }

  const rawLineTotal = (line: LineData) => {
    const quantity = numberFrom(line, ["Quantité", "QuantitÃ©", "QuantitÃƒÂ©", "Quantite", "quantite"]);
    const unitPrice = numberFrom(line, ["Prix unitaire", "prix_unitaire"]);
    return numberFrom(line, ["Total", "total"]) || quantity * unitPrice;
  };
  const internalCost = allActiveLines.reduce((sum, line) => sum + rawLineTotal(line), 0);
  const externalBase = allActiveLines.filter((line) => !isInternal(line)).reduce((sum, line) => sum + rawLineTotal(line), 0);
  const marginBase = allActiveLines.filter((line) => !isInternal(line)).reduce((sum, line) => sum + rawLineTotal(line), 0);
  const expectedMargin = marginBase * (Number(estimate.profit_margin_percent) || 0) / 100;
  const externalBeforeTax = externalBase + expectedMargin;
  const stateTax = externalBeforeTax * 0.08;
  let rawTenderAnalysis: unknown = tender?.ai_analysis ?? {};
  if (typeof rawTenderAnalysis === "string") {
    try { rawTenderAnalysis = JSON.parse(rawTenderAnalysis); } catch { rawTenderAnalysis = {}; }
  }
  const tenderAnalysis = rawTenderAnalysis as {
      bdqe_layout?: {
        annotations?: string[];
        detail_table?: { title?: string; columns?: string[]; total_label?: string; source_reference?: string };
        recap_tables?: Array<{ reference?: string; title?: string; columns?: string[]; row_titles?: string[]; total_label?: string }>;
      };
    };

  const organization = Array.isArray(member.organizations) ? member.organizations[0] : member.organizations;
  const pdf = generateOfficialEstimatePdf({
    companyName: organization?.name || "Sébastien BTP",
    companyDetails: [
      companyProfile.ownerName,
      `${companyProfile.address} — ${companyProfile.phone}`,
      `NIF ${companyProfile.nif} — STAT ${companyProfile.stat}`,
    ],
    daoTitle: `${mode === "internal" ? "DEVIS INTERNE — " : ""}${tender?.title || "DAO"}`,
    daoReference: tender?.reference || "",
    clientName: tender?.client_name || estimate.client_name || "",
    estimateDate: new Intl.DateTimeFormat("fr-FR").format(new Date()),
    rows: pdfRows,
    grandTotal,
    recapGroups: [...recapGroups.values()],
    bdqeLayout: tenderAnalysis.bdqe_layout,
    includeExternalRecap: mode === "external",
    internalFinancialSummary: mode === "internal" ? [
      { title: "Coût réel interne", total: internalCost },
      { title: `Marge prévue du devis externe (${Number(estimate.profit_margin_percent) || 0} %)`, total: expectedMargin },
      { title: "Bénéfice attendu", total: externalBeforeTax - internalCost },
      { title: "Taxe de l'État (8 %)", total: stateTax },
      { title: "Montant total à payer par le client", total: externalBeforeTax + stateTax },
    ] : undefined,
  });

  const fixedFileName = `devis-${mode === "internal" ? "interne" : "soumission"}-${safeName(tender?.reference || estimateId)}.pdf`;
  if (!shouldSave) {
    const previewPath = `${member.organization_id}/${estimateId}/${mode}-preview/${fixedFileName}`;
    const previewUpload = await supabase.storage.from("estimate-pdfs").upload(previewPath, pdf, {
      contentType: "application/pdf",
      cacheControl: "300",
      upsert: true,
    });
    if (previewUpload.error) {
      return NextResponse.json({ error: `Prévisualisation impossible : ${previewUpload.error.message}` }, { status: 400 });
    }
    const previewSigned = await supabase.storage.from("estimate-pdfs").createSignedUrl(previewPath, 300);
    if (previewSigned.error) {
      return NextResponse.json({ error: `Lien de prévisualisation indisponible : ${previewSigned.error.message}` }, { status: 400 });
    }
    // Le même fichier d'aperçu est conservé dans le stockage privé.  Le lien
    // direct permet à la liste des devis de l'ouvrir sans passer par une page JSON.
    if (returnPdfPayload) {
      return NextResponse.json({ ok: true, fileName: fixedFileName, pdfBase64: Buffer.from(pdf).toString("base64") });
    }
    if (openDirectly) return NextResponse.redirect(previewSigned.data.signedUrl);
    return NextResponse.json({ ok: true, previewUrl: previewSigned.data.signedUrl });
  }

  const version = 1;
  const fileName = fixedFileName;
  const storagePath = `${member.organization_id}/${estimateId}/${mode}-pdf/${fileName}`;
  const upload = await supabase.storage.from("estimate-pdfs").upload(storagePath, pdf, {
    contentType: "application/pdf",
    cacheControl: "3600",
    upsert: true,
  });
  if (upload.error) return NextResponse.json({ error: `Enregistrement du PDF impossible : ${upload.error.message}` }, { status: 400 });

  const documentInsert = await supabase.from("estimate_documents").upsert({
    organization_id: member.organization_id,
    estimate_id: estimateId,
    document_type: mode === "internal" ? "internal_estimate" : "dao_official",
    version,
    storage_path: storagePath,
    file_name: fileName,
    file_size: pdf.byteLength,
    created_by: user.id,
    created_at: new Date().toISOString(),
  }, { onConflict: "estimate_id,document_type" });
  if (documentInsert.error) return NextResponse.json({ error: `Historique du PDF non enregistré : ${documentInsert.error.message}` }, { status: 400 });

  const signed = await supabase.storage.from("estimate-pdfs").createSignedUrl(storagePath, 300, { download: fileName });
  if (signed.error) return NextResponse.json({ error: `Lien privé indisponible : ${signed.error.message}` }, { status: 400 });
  // Le chantier est créé (ou rafraîchi) une seule fois, sur la génération du
  // PDF externe : c'est la copie complète (localisation, planning, bordereau
  // de prix) qui rend ensuite le chantier indépendant du DAO.
  if (mode === "external") {
    const projectResult = await createOrSyncProjectFromEstimate(supabase, {
      organizationId: member.organization_id,
      estimateId,
    });
    if ("error" in projectResult) console.error("Automatic project creation failed", projectResult.error);
  }
  if (returnPdfPayload) {
    return NextResponse.json({ ok: true, version, fileName, pdfBase64: Buffer.from(pdf).toString("base64") });
  }
  return NextResponse.json({ ok: true, version, fileName, downloadUrl: signed.data.signedUrl });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => ({})) as { save?: boolean; mode?: "external" | "internal" };
  return generateOfficialPdfResponse(context, body.save === true, body.mode === "internal" ? "internal" : "external", false, request);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const searchParams = new URL(request.url).searchParams;
  const mode = searchParams.get("mode") === "internal" ? "internal" : "external";
  return generateOfficialPdfResponse(context, false, mode, searchParams.get("open") === "1", request);
}
