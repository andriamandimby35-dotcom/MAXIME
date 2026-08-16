import { NextResponse } from "next/server";
import { companyProfile } from "@/lib/company";
import { generateOfficialEstimatePdf, type OfficialPdfRow } from "@/lib/estimates/official-pdf";
import { createServerClient } from "@/lib/supabase/server";

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

function safeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "devis";
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await context.params;
  const body = await request.json().catch(() => ({})) as { save?: boolean };
  const shouldSave = body.save === true;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    .select("id,organization_id,dao_template_id,client_name,created_at")
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
    .filter((line) => !isInternal(line))
    .sort((left, right) => Number(left.__sortOrder ?? 0) - Number(right.__sortOrder ?? 0));
  const sourceTenderId = String(lines.find((line) => line.__sourceTenderId)?.__sourceTenderId ?? "");
  let tender: { title?: string; reference?: string; client_name?: string } | null = null;
  if (sourceTenderId) {
    const result = await supabase
      .from("tenders")
      .select("title,reference,client_name")
      .eq("id", sourceTenderId)
      .eq("organization_id", member.organization_id)
      .maybeSingle();
    tender = result.data;
  }

  const pdfRows: OfficialPdfRow[] = [];
  let currentSection = "";
  let currentSubtotal = 0;
  let grandTotal = 0;
  for (const line of lines) {
    const type = rowType(line);
    const designation = textFrom(line, ["Désignation", "DÃ©signation", "DÃƒÂ©signation", "Designation", "designation"]);
    if (type === "section") {
      currentSection = String(line.__daoSectionTitle ?? designation).trim();
      currentSubtotal = 0;
      if (currentSection) pdfRows.push({ kind: "section", title: currentSection });
      continue;
    }
    if (type === "subtotal") {
      const title = String(line.__daoSectionTitle ?? currentSection ?? designation).trim();
      pdfRows.push({ kind: "subtotal", title, total: currentSubtotal });
      currentSubtotal = 0;
      continue;
    }
    const quantity = numberFrom(line, ["Quantité", "QuantitÃ©", "QuantitÃƒÂ©", "Quantite", "quantite"]);
    const unitPrice = numberFrom(line, ["Prix unitaire", "prix_unitaire"]);
    const storedTotal = numberFrom(line, ["Total", "total"]);
    const total = storedTotal || quantity * unitPrice;
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
  if (!pdfRows.some((row) => row.kind === "item")) {
    return NextResponse.json({ error: "Le devis ne contient aucun poste DAO à exporter." }, { status: 400 });
  }

  const organization = Array.isArray(member.organizations) ? member.organizations[0] : member.organizations;
  const pdf = generateOfficialEstimatePdf({
    companyName: organization?.name || "Sébastien BTP",
    companyDetails: [
      companyProfile.ownerName,
      `${companyProfile.address} — ${companyProfile.phone}`,
      `NIF ${companyProfile.nif} — STAT ${companyProfile.stat}`,
    ],
    daoTitle: tender?.title || "DAO",
    daoReference: tender?.reference || "",
    clientName: tender?.client_name || estimate.client_name || "",
    estimateDate: new Intl.DateTimeFormat("fr-FR").format(new Date()),
    rows: pdfRows,
    grandTotal,
  });

  const fixedFileName = `devis-officiel-${safeName(tender?.reference || estimateId)}.pdf`;
  if (!shouldSave) {
    return new Response(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fixedFileName}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const version = 1;
  const fileName = fixedFileName;
  const storagePath = `${member.organization_id}/${estimateId}/dao-official/${fileName}`;
  const upload = await supabase.storage.from("estimate-pdfs").upload(storagePath, pdf, {
    contentType: "application/pdf",
    cacheControl: "3600",
    upsert: true,
  });
  if (upload.error) return NextResponse.json({ error: `Enregistrement du PDF impossible : ${upload.error.message}` }, { status: 400 });

  const documentInsert = await supabase.from("estimate_documents").upsert({
    organization_id: member.organization_id,
    estimate_id: estimateId,
    document_type: "dao_official",
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
  return NextResponse.json({ ok: true, version, fileName, downloadUrl: signed.data.signedUrl });
}
