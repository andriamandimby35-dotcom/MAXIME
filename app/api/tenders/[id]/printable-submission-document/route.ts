import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createServerClient } from "@/lib/supabase/server";
import { createPrintableSubmissionPdf } from "@/lib/submission/printable-pdf";
import { appendDaoPagesToPdf, appendExternalFileAsPages, createFilledDaoTemplatePdf } from "@/lib/submission/dao-template-pdf";
import { measureTableColumnRatios, locateFieldPositions, locateBracketPlaceholders, locateTableCellPositions } from "@/lib/submission/locate-field-positions";
import { findBestTitleMatch } from "@/lib/submission/title-match";
import { parsePageNumbersFromReference } from "@/lib/submission/parse-page-reference";
import { trimToRelevantStart, extractRelevantPageRange, locateTitleInFullDocument } from "@/lib/submission/trim-to-relevant-pages";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Cette route télécharge parfois le DAO ENTIER (plusieurs Mo, jusqu'à des
// centaines de pages pour les plans) puis le recombine avec pdf-lib : sans
// cette limite explicite, la fonction serverless peut dépasser le temps
// d'exécution par défaut (surtout au premier appel après une période
// d'inactivité, un "cold start") et Vercel renvoie alors sa propre page
// d'erreur générique au lieu d'un vrai message — vu à l'écran sur téléphone
// pour un document nécessitant les pages du DAO. 60s s'est révélé encore
// trop court (le tableau des ressources Vercel confirme que le forfait
// autorise jusqu'à 300s, comme les autres routes de l'appli, ex.
// /api/analyze-dao) : alignée sur cette même limite de 300s.
export const maxDuration = 300;

// L'IA peut se tromper sur les pages d'une pièce sourcée du DAO (une page
// réellement dédiée à un AUTRE document — personnel, matériel, un autre
// modèle...) : on ne fait donc jamais confiance à une page si une pièce
// DIFFÉRENTE revendique aussi ce même numéro. Cette règle s'applique à
// TOUTE pièce sourcée du DAO (garantie bancaire, code de conduite, lettre de
// soumission, plans...), pas à un cas particulier.
function otherItemsClaimedPages(
  items: Array<{ title?: string; template_page_numbers?: number[] }>,
  ownTitle: string,
): Set<number> {
  return new Set(
    items
      .filter((item) => item.title?.toLocaleLowerCase("fr-FR") !== ownTitle.toLocaleLowerCase("fr-FR"))
      .flatMap((item) => item.template_page_numbers ?? []),
  );
}

function pagesNotClaimedByOtherItems(
  items: Array<{ title?: string; template_page_numbers?: number[] }>,
  ownTitle: string,
  candidatePages: number[],
) {
  const claimedByOthers = otherItemsClaimedPages(items, ownTitle);
  return candidatePages.filter((page) => !claimedByOthers.has(page));
}

type TableForCellTargets = { columns: string[]; rows: string[][]; organization_column_indexes?: number[] };

// Un tableau comme "Chiffre d'affaires" est un vrai quadrillage sur la page
// DAO (lignes "Travaux"/"Fournitures"/... × colonnes "Exercice du...") : les
// vraies valeurs doivent aller DANS ce quadrillage, à l'intersection ligne ×
// colonne — pas sur une page à part redessinée par-dessus, qui obligeait
// jusqu'ici à montrer DEUX fois le même tableau (une fois vide, tirée du
// DAO, une fois fabriquée avec les chiffres). On construit ici la liste des
// cases à retrouver sur la vraie page, une par valeur connue.
function buildTableCellTargets(tables: TableForCellTargets[]) {
  const targets: Array<{ field_key: string; row_label: string; column_label: string; value: string }> = [];
  tables.forEach((table, tableIndex) => {
    const orgColumns = table.organization_column_indexes ?? table.columns.map((_, index) => index);
    const labelColumnIndex = table.columns.findIndex((_, index) => !orgColumns.includes(index));
    table.rows.forEach((row, rowIndex) => {
      const rowLabel = (labelColumnIndex >= 0 ? row[labelColumnIndex] : row[0])?.trim();
      if (!rowLabel) return;
      orgColumns.forEach((columnIndex) => {
        const value = row[columnIndex]?.trim();
        const columnLabel = table.columns[columnIndex]?.trim();
        if (!value || !columnLabel) return;
        targets.push({ field_key: `__table_cell_${tableIndex}_${rowIndex}_${columnIndex}`, row_label: rowLabel, column_label: columnLabel, value });
      });
    });
  });
  return targets;
}

// Les planches de plans techniques sont presque toujours regroupées en un
// seul bloc de pages consécutives (parfois une centaine), souvent sans texte
// lisible (dessin vectoriel) — l'IA ne peut donc pas les lister une par une
// de façon fiable. On lui demande maintenant seulement la PREMIÈRE page du
// bloc ; c'est ici qu'on calcule la fin réelle, jusqu'à la page juste avant
// qu'un AUTRE poste déjà identifié ne commence.
async function expandToContiguousPlanRange(
  title: string,
  pageNumbers: number[],
  otherItems: Array<{ title?: string; template_page_numbers?: number[] }>,
  documentPageCount: number,
): Promise<number[]> {
  if (!/\bplans?\b/i.test(title) || !pageNumbers.length) return pageNumbers;
  const claimedByOthers = new Set(
    otherItems
      .filter((item) => item.title?.toLocaleLowerCase("fr-FR") !== title.toLocaleLowerCase("fr-FR"))
      .flatMap((item) => item.template_page_numbers ?? []),
  );
  const start = Math.min(...pageNumbers);
  const range: number[] = [];
  for (let page = start; page <= documentPageCount; page += 1) {
    if (claimedByOthers.has(page)) break;
    range.push(page);
    if (page - start > 400) break; // Garde-fou si rien ne borne la plage.
  }
  return range.length ? range : pageNumbers;
}

type PlanningWorkItem = { designation?: string; row_type?: string; unit?: string; quantity?: number | null; section_title?: string };

function buildExecutionPlanningTable(items: PlanningWorkItem[], executionDays: number | null | undefined) {
  const workItems = items.filter((item) => item.row_type === "item" && item.designation?.trim());
  const totalDays = Math.max(workItems.length || 1, Math.round(executionDays || workItems.length || 1));
  const weights = workItems.map((item) => Math.max(1, Math.sqrt(Math.max(0, Number(item.quantity) || 0))));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const durations = weights.map((weight) => Math.max(1, Math.floor((weight / weightTotal) * totalDays)));
  let difference = totalDays - durations.reduce((sum, duration) => sum + duration, 0);
  let cursor = 0;
  while (difference !== 0 && durations.length) {
    const index = cursor % durations.length;
    if (difference > 0) { durations[index] += 1; difference -= 1; }
    else if (durations[index] > 1) { durations[index] -= 1; difference += 1; }
    cursor += 1;
    if (cursor > durations.length * Math.max(2, totalDays)) break;
  }
  let previousSection = "";
  const rows: string[][] = [];
  workItems.forEach((item, index) => {
    const section = item.section_title?.trim() || "";
    if (section && section !== previousSection) {
      rows.push(["", section, "", "", "", ""]);
      previousSection = section;
    }
    const quantity = Number(item.quantity);
    const duration = durations[index] || 1;
    rows.push([
      String(index + 1),
      item.designation?.trim() || "Poste du DAO",
      item.unit?.trim() || "Forfait",
      Number.isFinite(quantity) && quantity > 0 ? String(quantity) : "Forfait",
      Number.isFinite(quantity) && quantity > 0 ? `${(quantity / duration).toFixed(2)} ${item.unit?.trim() || "u"}/j` : "Forfait/jour",
      `${duration} jour${duration > 1 ? "s" : ""}`,
    ]);
  });
  rows.push(["", "TOTAL PRÉVISIONNEL", "", "", "", `${totalDays} jours`]);
  return {
    title: "Planning d'exécution des travaux",
    columns: ["N°", "Description des travaux", "U", "Quantités", "Rendement / jour", "Délai"],
    rows,
  };
}

function pdfStorageName(title: string, kind: string, workerIndex: number) {
  const normalized = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "document";
  return `${kind === "form_to_complete" ? "formulaire" : "piece"}-${normalized}-${workerIndex + 1}.pdf`;
}

async function savedPdfResponse(supabase: Awaited<ReturnType<typeof createServerClient>>, pdf: Uint8Array, organizationId: string, tenderId: string, estimateId: string | null, title: string, kind: string, workerIndex: number, clientFetch = false) {
  const fileName = pdfStorageName(title, kind, workerIndex);
  const path = `${organizationId}/submission/${tenderId}/generated/${estimateId ?? "master"}/${fileName}`;
  const clientResponse = (storageStatus: "saved" | "unavailable") => {
    if (clientFetch) {
      // IDM intercepte les réponses dont les octets commencent par %PDF.
      // Le navigateur reçoit donc un transport JSON, puis reconstruit le PDF
      // localement dans un Blob avant l'ouverture du lecteur natif.
      return NextResponse.json({ pdfBase64: Buffer.from(pdf).toString("base64"), fileName }, {
        headers: { "Cache-Control": "no-store", "X-PDF-Storage-Status": storageStatus },
      });
    }
    return new NextResponse(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"`, "Cache-Control": "no-store", "X-PDF-Storage-Status": storageStatus } });
  };
  const upload = await supabase.storage.from("btp-documents").upload(path, Buffer.from(pdf), { contentType: "application/pdf", cacheControl: "0", upsert: true });
  if (upload.error) {
    console.error("Generated submission PDF could not be stored", upload.error);
    return clientResponse("unavailable");
  }
  return clientResponse("saved");
}

async function generatePrintableSubmissionPdf(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const title = query.get("title")?.slice(0, 180) || "Document de soumission";
  const kind = query.get("kind") === "form_to_complete" ? "form_to_complete" : "document_to_provide";
  const clientSourceReference = query.get("sourceReference")?.slice(0, 300) || "";
  const estimateId = query.get("estimateId");
  const workerIndex = Math.max(0, Number.parseInt(query.get("workerIndex") || "0", 10) || 0);
  const supabase = await createServerClient();
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-supabase-access-token") || "";
  const clientFetch = request.headers.get("x-pdf-client-fetch") === "1";
  console.info("PRINTABLE_PDF_REQUEST", {
    method: request.method,
    hasAuthorization: Boolean(request.headers.get("authorization")),
    hasDedicatedToken: Boolean(request.headers.get("x-supabase-access-token")),
    hasAccessToken: Boolean(accessToken),
  });
  const { data: { user } } = await supabase.auth.getUser(accessToken);
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const { data: tender } = await supabase.from("tenders").select("id,reference,title,client_name,document_url,ai_analysis,estimated_amount").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!tender) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });
  const [profileResult, itemsResult, estimateResult] = await Promise.all([
    supabase.from("organization_submission_profiles").select("profile_data").eq("organization_id", member.organization_id).maybeSingle(),
    supabase.from("tender_submission_items").select("title,fields,form_data").eq("organization_id", member.organization_id).eq("tender_id", id),
    estimateId ? supabase.from("estimate_submission_dossiers").select("items").eq("estimate_id", estimateId).eq("organization_id", member.organization_id).eq("tender_id", id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const estimateItems = (estimateResult.data?.items ?? []) as Array<{ title?: string; fields?: Array<{ key?: string; label?: string }>; form_data?: Record<string, string> }>;
  const masterItems = (itemsResult.data ?? []) as Array<{ title?: string; fields?: Array<{ key?: string; label?: string }>; form_data?: Record<string, string> }>;
  const allItems = estimateId ? estimateItems : masterItems;
  const savedItem = allItems.find((item) => item.title?.toLocaleLowerCase() === title.toLocaleLowerCase()) ?? null;
  const profileData = (profileResult.data?.profile_data ?? {}) as Record<string, string>;
  const formData = savedItem?.form_data ?? {};
  const fields = savedItem?.fields ?? [];
  const templateValues: Record<string, string> = {
    ...profileData,
    ...formData,
    contract_reference: tender.reference || "",
    tender_reference: tender.reference || "",
    market_reference: tender.reference || "",
    market_title: tender.title || "",
    client_name: tender.client_name || "",
    // Le "bénéficiaire" d'une garantie/caution est l'autorité contractante du
    // DAO (le maître d'ouvrage), jamais l'entreprise candidate elle-même.
    beneficiaire: tender.client_name || "",
    autorite_contractante: tender.client_name || "",
    maitre_ouvrage: tender.client_name || "",
    worksite_location: "",
    chantier_location: "",
    signature_date: new Date().toLocaleDateString("fr-CA"),
    date_signature: new Date().toLocaleDateString("fr-CA"),
  };
  for (const [key, prefix] of [["__personnel", "personnel"], ["__materiel", "materiel"]] as const) {
    try {
      const rows = JSON.parse(formData[key] || "[]") as Array<{ name?: string; role?: string; qualification?: string; experience?: string }>;
      rows.forEach((row, index) => {
        const number = index + 1;
        templateValues[`${prefix}_${number}_name`] = row.name || "";
        templateValues[`${prefix}_${number}_role`] = row.role || "";
        templateValues[`${prefix}_${number}_qualification`] = row.qualification || "";
        templateValues[`${prefix}_${number}_experience`] = row.experience || "";
      });
    } catch { /* The user can still complete a malformed legacy entry manually. */ }
  }
  let workerRole = "";
  // Chemin (dans le stockage Supabase "btp-documents") et type MIME du
  // fichier CIN joint pour ce personnel, s'il en a un — conservés en dehors
  // du bloc try pour rester utilisables plus bas, après la génération du PDF
  // du contrat, afin d'y ajouter la CIN en pages supplémentaires (voir
  // appendExternalFileAsPages plus bas).
  let workerCinPath = "";
  let workerCinMime = "";
  try {
    const personnelItem = allItems.find((item) => /personnel|personnels|ressources humaines|equipe/i.test(item.title || "")
      && !(/petit contrat.*travailleur|contrat.*travailleur|contrat.*employ/i.test(item.title || "") || (/liste du personnel et leurs fonctions/i.test(item.title || "") && !/affecter au chantier/i.test(item.title || ""))));
    const workers = JSON.parse(personnelItem?.form_data?.__personnel || "[]") as Array<{ name?: string; role?: string; identity?: string; address?: string; salary?: string; cinPath?: string; cinMime?: string }>;
    const worker = workers[workerIndex];
    if (worker) {
      templateValues.worker_name = worker.name || "";
      templateValues.worker_identity = worker.identity || "";
      templateValues.worker_cin = worker.identity || "";
      templateValues.worker_address = worker.address || "";
      templateValues.worker_salary = worker.salary || "";
      workerRole = worker.role || "";
      workerCinPath = worker.cinPath || "";
      workerCinMime = worker.cinMime || "";
    }
  } catch { /* A legacy malformed list remains editable in the dossier. */ }
  // Une valeur non résolue ne doit jamais imprimer une explication de ce
  // qu'il fallait écrire (ça se confond avec une vraie information sur un
  // document destiné à être signé tel quel) : on laisse un blanc, exactement
  // comme le ferait un candidat qui complète le modèle DAO à la main.
  const replaceTemplateFields = (value: string) => value.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_match, key: string) => {
    return templateValues[key]?.trim() ?? "";
  });
  const filledFields = fields.map((field) => {
    const key = field.key ?? "";
    const label = field.label ?? key;
    const value = formData[key] || profileData[key] || (/contrat|reference|marche/i.test(`${key} ${label}`) ? tender.reference || "" : "");
    return value ? `${label} : ${value}` : `${label} : À compléter`;
  });
  const analysisForValues = tender.ai_analysis as { execution_period_days?: number } | null;
  if (analysisForValues?.execution_period_days != null) {
    templateValues.delai_execution = `${analysisForValues.execution_period_days} jours`;
    templateValues.delai_execution_travaux = `${analysisForValues.execution_period_days} jours`;
  }
  const estimatedAmount = typeof tender.estimated_amount === "number" ? tender.estimated_amount : Number(tender.estimated_amount) || null;
  if (estimatedAmount != null) {
    templateValues.montant_estime = `${estimatedAmount.toLocaleString("fr-FR")} Ar`;
    templateValues.montant_du_marche = `${estimatedAmount.toLocaleString("fr-FR")} Ar`;
  }
  const analysis = tender.ai_analysis as {
    execution_period_days?: number;
    execution_plan?: Array<{ title?: string; duration_days?: number | null; sequence?: number; source_reference?: string }>;
    transport_weight_table?: { title?: string; columns?: string[]; rows?: string[][]; total_label?: string; total_weight?: string; source_reference?: string };
    plan_register?: { title?: string; columns?: string[]; rows?: string[][]; total_label?: string; total_count?: string; source_reference?: string; page_numbers?: number[] };
    worksite_location?: string;
    work_items?: Array<PlanningWorkItem>;
    submission_items?: Array<{ title?: string; template_origin?: "dao" | "internet" | "generated" | "none"; template_source_url?: string; template_text?: string; template_page_numbers?: number[]; template_fill_positions?: Array<{ page: number; field_key: string; x_percent: number; y_percent: number; width_percent: number }>; template_tables?: Array<{ title: string; columns: string[]; rows: string[][]; organization_column_indexes?: number[]; repeatable?: boolean }>; source_reference?: string; fields?: Array<{ key: string; label: string; description?: string }> }>;
  } | null;
  templateValues.worksite_location = analysis?.worksite_location || "";
  templateValues.chantier_location = analysis?.worksite_location || "";
  const workItems = (analysis?.work_items ?? []).filter((item) => item.row_type === "item");
  const executionPlan = (analysis?.execution_plan ?? []).sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const isExecutionPlanning = /planning.*ex.cution/i.test(title);
  const executionPlanningTable = isExecutionPlanning ? buildExecutionPlanningTable(analysis?.work_items ?? [], analysis?.execution_period_days) : null;
  const transportWeightTable = analysis?.transport_weight_table;
  const hasTransportWeightTable = Boolean(transportWeightTable?.columns?.length && transportWeightTable.rows?.length);
  const planRegister = analysis?.plan_register;
  const hasPlanRegister = Boolean(planRegister?.columns?.length && planRegister.rows?.length);
  const extraLines = /planning/i.test(title) ? [
    `Délai prévisionnel d'exécution : ${analysis?.execution_period_days ?? "à confirmer"} jours`,
    executionPlan.length ? "Planning d'exécution conforme au DAO :" : "Séquence des travaux à confirmer :",
    ...(executionPlan.length ? executionPlan.map((task, index) => `${index + 1}. ${task.title || "Tâche"}${task.duration_days != null ? ` — ${task.duration_days} jour(s)` : ""}${task.source_reference ? ` (${task.source_reference})` : ""}`) : workItems.slice(0, 12).map((item, index) => `${index + 1}. ${item.designation || "Poste à confirmer"}`)),
  ] : /mat.riaux.*transport/i.test(title) ? [
    hasTransportWeightTable
      ? "Tableau des poids repris du DAO."
      : "Le tableau des poids du DAO doit être extrait lors de la prochaine analyse.",
    ...(hasTransportWeightTable && transportWeightTable?.total_weight
      ? [`${transportWeightTable.total_label || "Poids total"} : ${transportWeightTable.total_weight}`]
      : []),
    ...(transportWeightTable?.source_reference ? [`Source : ${transportWeightTable.source_reference}`] : []),
  ] : /\bplans?\b/i.test(title) ? [
    hasPlanRegister
      ? "Registre des plans repris intégralement du DAO."
      : "Le registre des plans du DAO doit être extrait lors de la prochaine analyse.",
    ...(hasPlanRegister && planRegister?.total_count
      ? [`${planRegister.total_label || "Nombre total de plans"} : ${planRegister.total_count}`]
      : []),
    ...(planRegister?.source_reference ? [`Source : ${planRegister.source_reference}`] : []),
  ] : [];
  const isSubmissionLetter = /lettre de soumission|acte d.engagement/i.test(title);
  // Le titre demandé peut être un intitulé générique de la liste type
  // ("Garantie bancaire de soumission B1") alors que l'IA a extrait la pièce
  // réelle du DAO sous un intitulé légèrement différent ("Garantie bancaire
  // de soumission") : on rapproche par mots-clés plutôt que par égalité
  // stricte, sinon les vraies pages/le vrai modèle du DAO ne sont jamais
  // utilisés pour les pièces de la liste générique.
  const detectedTemplate = findBestTitleMatch(title, analysis?.submission_items ?? []);
  const companyName = profileData.legal_name || profileData.trade_name || "[raison sociale à compléter]";
  const signer = profileData.representative_name || "[nom du signataire à compléter]";
  const signerRole = profileData.representative_role || "[fonction à compléter]";
  const generatedLetterLines = [
    `À l’attention de : ${tender.client_name || "[autorité contractante à compléter]"}`,
    `Objet : Soumission au marché ${tender.reference || "[référence à compléter]"} — ${tender.title || "[objet du marché]"}`,
    "",
    "Madame, Monsieur,",
    `Nous, ${companyName}, représentée par ${signer}, en qualité de ${signerRole}, déclarons avoir pris connaissance du dossier d’appel d’offres visé ci-dessus et soumettons notre offre conformément à ses conditions.`,
    "Nous nous engageons, si notre offre est retenue, à exécuter le marché conformément au DAO, au devis joint et aux documents contractuels applicables.",
    "Nous certifions l’exactitude des renseignements fournis et confirmons que cette offre demeure valable pendant la période indiquée dans le DAO.",
    "",
    "Le présent document est établi conformément aux informations disponibles dans le dossier d'appel d'offres. Vérifiez les clauses et annexes applicables avant signature.",
    "",
    "Informations du formulaire :", ...filledFields,
  ];
  const isWorkerContract = /petit contrat.*travailleur|contrat.*travailleur|contrat.*employ/i.test(title)
    || (/liste du personnel et leurs fonctions/i.test(title) && !/affecter au chantier/i.test(title));
  const generatedWorkerContractLines = isWorkerContract ? [
    "CONTRAT INDIVIDUEL DE TRAVAIL",
    `Entre l’entreprise ${companyName}, sise à ${profileData.address || "[adresse à compléter]"}, représentée par ${signer},`,
    `et le travailleur : ${templateValues.worker_name || "[nom à compléter]"}, CIN / identité : ${templateValues.worker_identity || "[numéro à compléter]"}, demeurant à ${templateValues.worker_address || "[adresse à compléter]"}.`,
    `Poste / fonction sur le chantier : ${workerRole || "[à compléter]"}.`,
    `Rémunération convenue : ${templateValues.worker_salary || "[montant à compléter]"}.`,
    "Les parties conviennent que le travailleur intervient pour les activités prévues au chantier, suivant les conditions du DAO et les consignes de sécurité applicables.",
    "Le présent document doit être vérifié, imprimé puis signé par les deux parties.",
    // Pas de pointillés inventés ici non plus : rien ne remplit jamais une
    // signature automatiquement, donc l'espace après le libellé reste vide.
    "", "Signature de l’entreprise :", "", "Signature du travailleur :",
    ...(workerCinPath ? ["", "La copie de la CIN du travailleur est jointe en dernière(s) page(s) de ce document."] : []),
  ] : [];
  const submissionLetterLines = detectedTemplate?.template_text?.trim()
    ? [
      replaceTemplateFields(detectedTemplate.template_text),
      "",
      "Informations du formulaire :", ...filledFields,
    ]
    : generatedLetterLines;
  const formLines = isSubmissionLetter
    ? submissionLetterLines
    : isWorkerContract
      ? generatedWorkerContractLines
      : kind === "form_to_complete"
        ? ["FORMULAIRE À SIGNER OU PARAPHER", "", ...filledFields]
        : [];
  const templateTables = (detectedTemplate?.template_tables ?? []).map((table, tableIndex) => {
    if (table.repeatable) {
      // Le DAO ne montre qu'une ligne d'exemple pour ce genre de rubrique
      // (litiges, conventions non exécutées, marchés similaires...) : le
      // nombre réel de lignes dépend de l'historique du candidat, ajouté via
      // le bouton "+ Ajouter une ligne" du dossier (form_data.__table_<index>,
      // même index de tableau que côté client — voir SubmissionDossierManager).
      let enteredRows: Array<Record<string, string>> = [];
      try {
        const parsed = JSON.parse(formData[`__table_${tableIndex}`] || "[]");
        if (Array.isArray(parsed)) enteredRows = parsed as Array<Record<string, string>>;
      } catch { /* Une entrée mal formée reste éditable dans le dossier. */ }
      const rows = enteredRows.length
        ? enteredRows.map((row) => table.columns.map((_, columnIndex) => row[String(columnIndex)] ?? ""))
        : [table.columns.map(() => "")];
      return { ...table, title: replaceTemplateFields(table.title), columns: table.columns.map(replaceTemplateFields), rows };
    }
    const orgColumns = table.organization_column_indexes ?? table.columns.map((_, index) => index);
    return {
      ...table,
      title: replaceTemplateFields(table.title),
      columns: table.columns.map(replaceTemplateFields),
      rows: table.rows.map((row) => row.map((cell, columnIndex) => orgColumns.includes(columnIndex)
        ? replaceTemplateFields(cell)
        : cell.replace(/\{\{[a-z0-9_]+\}\}/gi, ""))),
    };
  });
  const rosterTable = (() => {
    const isPersonnel = /personnel|personnels|ressources humaines|equipe/i.test(title) && !isWorkerContract;
    const isMaterial = /materiel|matériels|equipement|équipement|engins/i.test(title);
    if (!isPersonnel && !isMaterial) return [];
    const key = isPersonnel ? "__personnel" : "__materiel";
    try {
      const rows = JSON.parse(formData[key] || "[]") as Array<{ name?: string; role?: string; qualification?: string; experience?: string }>;
      return [{
        title,
        columns: isPersonnel ? ["Nom et prénoms", "Fonction", "Diplôme / qualification", "Expérience"] : ["Matériel / engin", "Fonction / usage", "État / capacité", "Quantité / disponibilité"],
        rows: (rows.length ? rows : [{ name: "", role: "", qualification: "", experience: "" }]).map((row) => [row.name || "", row.role || "", row.qualification || "", row.experience || ""]),
      }];
    } catch { return []; }
  })();
  // Une pièce "document_to_provide" (ex. garantie bancaire, caution) n'a
  // souvent aucune case à remplir sur ses pages DAO — juste les pages elles-
  // mêmes à extraire pour signature/insertion. On ne doit donc pas exiger
  // template_fill_positions : createFilledDaoTemplatePdf gère très bien un
  // tableau de positions vide (elle extrait alors les pages telles quelles).
  // template_page_numbers ne contient souvent qu'UNE page de départ (demandée
  // ainsi à l'IA) et peut même rester vide si l'IA n'a donné cette page QUE
  // sous forme de texte dans source_reference ("Pages 31-46, Partie III") —
  // ça a longtemps fait passer à tort une pièce pourtant bien identifiée pour
  // "aucune page connue", et tomber sur le générateur générique tout en bas
  // au lieu d'utiliser la vraie page du DAO. On combine donc toujours les
  // deux sources ici, avant même de décider d'entrer dans cette branche.
  const detectedTemplateKnownPages = [...new Set([
    ...(detectedTemplate?.template_page_numbers ?? []),
    ...parsePageNumbersFromReference(detectedTemplate?.source_reference),
  ])].sort((left, right) => left - right);
  // On a longtemps exigé ICI que l'IA ait elle-même classé la pièce en
  // template_origin "dao" — mais ce classement peut rester "none"/"generated"
  // même quand l'IA a par ailleurs bien donné une vraie page ou référence
  // dans le DAO (constaté sur "Fiches de renseignements A1 à A5" : page 13
  // correcte, mais origin pas "dao", donc cette branche était sautée
  // entièrement malgré une page connue et fiable). Une page/référence connue
  // est un signal plus sûr que ce classement : dès qu'on en a une, on l'utilise.
  if (!isExecutionPlanning && detectedTemplate && tender.document_url && detectedTemplateKnownPages.length) {
    const notClaimedByOthers = pagesNotClaimedByOtherItems(analysis?.submission_items ?? [], detectedTemplate.title ?? title, detectedTemplateKnownPages);
    if (notClaimedByOthers.length) {
      try {
        const source = await fetch(tender.document_url);
        if (source.ok) {
          const bytes = new Uint8Array(await source.arrayBuffer());
          // Si la page précise citée s'avère être la mauvaise (l'IA se trompe
          // parfois de quelques pages), la recherche de titre n'a alors aucune
          // autre page où chercher : detectedTemplateKnownPages (page + plage
          // de source_reference) sert de filet pour laisser la recherche de
          // titre trouver le VRAI début quelque part dedans.
          // Contrairement aux plans (sans texte, donc sans signal fiable), une
          // pièce avec du texte a sa propre détection de frontière par titre :
          // on ne retire donc pas ici les pages qu'une AUTRE pièce revendique
          // sur sa seule estimation (souvent imprécise elle aussi, ex. une
          // page 46 réclamée par une pièce qui commence en réalité page 48) —
          // ça créerait un trou artificiel dans une page qui appartient bien
          // à CETTE pièce-ci. Ce garde-fou anti-collision reste réservé au
          // repli plan (branche ci-dessous), seul cas sans détection de texte.
          const candidatePages = /\bplans?\b/i.test(title) ? notClaimedByOthers : detectedTemplateKnownPages;
          const documentPageCount = (await PDFDocument.load(bytes)).getPageCount();
          const verifiedPages = /\bplans?\b/i.test(title)
            ? await expandToContiguousPlanRange(title, candidatePages, analysis?.submission_items ?? [], documentPageCount)
            : await extractRelevantPageRange(bytes, candidatePages, detectedTemplate.title ?? title, {
              claimedByOtherPages: otherItemsClaimedPages(analysis?.submission_items ?? [], detectedTemplate.title ?? title),
            });
          const templateFields = detectedTemplate.fields ?? [];
          let pdf: Buffer;
          let allTableCellsResolvedOnRealPage = false;
          if (/\bplans?\b/i.test(title)) {
            // Un plan est un dessin vectoriel sans texte à remplacer : la
            // page DAO reste extraite telle quelle, sans réécriture.
            pdf = await createFilledDaoTemplatePdf(bytes, verifiedPages, [], templateValues, []);
          } else {
            // La page DAO reste copiée EXACTEMENT telle quelle (cadres,
            // tableaux, toutes les décorations d'origine intactes) : on ne
            // réécrit jamais son texte à la main. On repère seulement, sur
            // cette vraie page, où se trouve le libellé de chaque champ
            // ("Nom ou raison sociale du candidat :"...) pour écrire la
            // valeur juste à côté — plutôt que de faire deviner une position
            // à l'IA (quasi jamais fiable) ou de reconstruire toute la page
            // nous-même (perd les décorations d'origine, et peut faire
            // déborder le contenu sur une page en trop si le texte recréé est
            // un peu plus long que l'original).
            const fieldTargets = templateFields.map((field) => ({ field_key: field.key, label: field.label, description: field.description }));
            // Un tableau (chiffre d'affaires, matériel, personnel...) est un
            // vrai quadrillage sur la page DAO : ses cases doivent recevoir
            // les valeurs directement, comme n'importe quel autre champ —
            // sinon la page réelle affichée reste un tableau vide alors que
            // les vraies valeurs existent déjà, obligeant (avant ce correctif)
            // à ajouter une DEUXIÈME page fabriquée juste pour les montrer.
            const tableCellTargets = buildTableCellTargets(templateTables);
            const [positions, redactions, tablePositions] = await Promise.all([
              locateFieldPositions(bytes, verifiedPages, fieldTargets),
              locateBracketPlaceholders(bytes, verifiedPages, fieldTargets),
              tableCellTargets.length ? locateTableCellPositions(bytes, verifiedPages, tableCellTargets) : Promise.resolve([]),
            ]);
            const tableCellValues = Object.fromEntries(tableCellTargets.map((target) => [target.field_key, target.value]));
            const foundTableFieldKeys = new Set(tablePositions.map((position) => position.field_key));
            allTableCellsResolvedOnRealPage = tableCellTargets.length > 0 && tableCellTargets.every((target) => foundTableFieldKeys.has(target.field_key));
            pdf = await createFilledDaoTemplatePdf(bytes, verifiedPages, [...positions, ...tablePositions], { ...templateValues, ...tableCellValues }, redactions);
          }
          // La page fabriquée ci-dessous ne sert plus qu'en dernier recours :
          // si toutes les cases du tableau ont été retrouvées et remplies
          // directement sur la vraie page juste au-dessus, l'ajouter EN PLUS
          // ferait apparaître le même tableau deux fois (une fois fidèle et
          // vide en apparence pour qui ne voit pas les valeurs ajoutées, une
          // fois fabriquée) — ce qui est justement le bug signalé. Elle ne
          // reste utile que si une case n'a pas pu être localisée (libellé de
          // ligne ou de colonne introuvable sur la page), pour ne jamais
          // perdre une valeur déjà connue.
          if (templateTables.length && !allTableCellsResolvedOnRealPage) {
            // Les colonnes d'un tableau reconstruit gardaient une largeur
            // égale arbitraire, très différente du vrai tableau du DAO (une
            // colonne de désignation bien plus large que les colonnes de
            // quantité à côté). On mesure ici la vraie largeur de chaque
            // colonne sur la page source et on la reproduit.
            const measuredTables = await Promise.all(templateTables.map(async (table) => ({
              ...table,
              column_ratios: (await measureTableColumnRatios(bytes, verifiedPages, table.columns)) ?? undefined,
            })));
            const tablesPdfBytes = await createPrintableSubmissionPdf(title, profileData, [], measuredTables);
            const tablesDoc = await PDFDocument.load(tablesPdfBytes);
            const mainDoc = await PDFDocument.load(pdf);
            const copiedPages = await mainDoc.copyPages(tablesDoc, tablesDoc.getPageIndices());
            copiedPages.forEach((page) => mainDoc.addPage(page));
            pdf = Buffer.from(await mainDoc.save());
          }
          return savedPdfResponse(supabase, pdf, member.organization_id, id, estimateId, title, kind, workerIndex, clientFetch);
        }
      } catch (error) {
        // Repropagée (au lieu d'être avalée en silence) : sinon toute
        // exception ici fait retomber discrètement sur le générateur
        // générique du bas, sans qu'aucune erreur ne soit jamais visible —
        // ce qui a rendu très difficile de diagnostiquer un vrai échec.
        console.error("DAO template PDF generation failed", error);
        throw error;
      }
    }
  }
  // Repli général : que la pièce détectée par similarité de titre n'ait en
  // fait AUCUNE page connue (analyse mal étiquetée ou incomplète pour CETTE
  // pièce précise), OU qu'aucune pièce ne corresponde du tout dans l'analyse
  // IA, on ne doit JAMAIS abandonner tout de suite sur la feuille générique —
  // deux autres façons de retrouver la vraie page restent à essayer. D'abord
  // la référence affichée par la pièce elle-même (ex. "Pages 31-46, Partie
  // III"), toujours avec la même vérification anti-chevauchement. On tente
  // aussi ici le même remplissage fidèle (page DAO intacte + repérage
  // automatique des positions) qu'utilise la branche ci-dessus — pas
  // seulement l'extraction de page nue — en s'appuyant sur les champs déjà
  // connus pour cette pièce (ceux de l'IA si elle en a, sinon ceux déjà
  // enregistrés côté dossier).
  if (!isExecutionPlanning && !detectedTemplateKnownPages.length && tender.document_url) {
    const fieldTargets = (detectedTemplate?.fields?.length ? detectedTemplate.fields : fields)
      .map((field) => ({ field_key: field.key, label: field.label, description: (field as { description?: string }).description }))
      .filter((field): field is { field_key: string; label: string; description: string | undefined } => Boolean(field.field_key && field.label));
    const referencedPages = parsePageNumbersFromReference(clientSourceReference);
    const notClaimedByOthers = pagesNotClaimedByOtherItems(analysis?.submission_items ?? [], title, referencedPages);
    if (notClaimedByOthers.length) {
      try {
        const source = await fetch(tender.document_url);
        if (source.ok) {
          const bytes = new Uint8Array(await source.arrayBuffer());
          // La plage citée par le DAO couvre parfois plusieurs documents à la
          // suite (ex. "Partie III" commence par l'acte d'engagement et la
          // localisation du site AVANT le CCAP) : on recadre sur la première
          // page qui mentionne vraiment le sujet demandé.
          const verifiedPages = await trimToRelevantStart(bytes, notClaimedByOthers, title, otherItemsClaimedPages(analysis?.submission_items ?? [], title));
          const [positions, redactions] = await Promise.all([
            locateFieldPositions(bytes, verifiedPages, fieldTargets),
            locateBracketPlaceholders(bytes, verifiedPages, fieldTargets),
          ]);
          const pdf = await createFilledDaoTemplatePdf(bytes, verifiedPages, positions, templateValues, redactions);
          return savedPdfResponse(supabase, pdf, member.organization_id, id, estimateId, title, kind, workerIndex, clientFetch);
        }
      } catch (error) {
        console.error("Source-reference PDF generation failed", error);
      }
    } else {
      // Ni l'IA ni le sommaire du DAO n'ont donné la moindre page pour cette
      // pièce (cas des pièces génériques de secours, ex. « Cahier des
      // clauses administratives particulières (CCAP) signé », quand l'IA ne
      // l'a pas retrouvée dans CE DAO précis) : avant d'abandonner, on
      // cherche son titre directement dans tout le document — utile pour
      // n'importe quelle pièce quasi toujours présente dans un DAO, sur
      // n'importe quel DAO, pas seulement celui-ci.
      try {
        const source = await fetch(tender.document_url);
        if (source.ok) {
          const bytes = new Uint8Array(await source.arrayBuffer());
          const locatedPages = pagesNotClaimedByOtherItems(analysis?.submission_items ?? [], title, await locateTitleInFullDocument(bytes, title, otherItemsClaimedPages(analysis?.submission_items ?? [], title)));
          if (locatedPages.length) {
            const [positions, redactions] = await Promise.all([
              locateFieldPositions(bytes, locatedPages, fieldTargets),
              locateBracketPlaceholders(bytes, locatedPages, fieldTargets),
            ]);
            const pdf = await createFilledDaoTemplatePdf(bytes, locatedPages, positions, templateValues, redactions);
            return savedPdfResponse(supabase, pdf, member.organization_id, id, estimateId, title, kind, workerIndex, clientFetch);
          }
        }
      } catch (error) {
        console.error("Full-document title search PDF generation failed", error);
      }
    }
  }
  // Diagnostic TEMPORAIRE : on arrive ici seulement quand aucune des méthodes
  // ci-dessus n'a réussi à utiliser une vraie page du DAO — donc juste avant
  // de retomber sur la feuille générique. Plutôt que de deviner à l'aveugle
  // pourquoi (déjà 3 corrections sans effet visible), on affiche directement
  // dans le PDF généré ce que chaque étape a vu, pour comprendre d'un coup où
  // ça bloque réellement. À retirer une fois le vrai problème confirmé.
  const debugLines: string[] = [];
  if (tender.document_url) {
    try {
      debugLines.push(
        "— DIAGNOSTIC TEMPORAIRE (à retirer après résolution) —",
        `Pièce IA trouvée par titre : ${detectedTemplate ? "oui" : "non"}`,
      );
      if (detectedTemplate) {
        debugLines.push(
          `  Titre IA : ${detectedTemplate.title ?? "(vide)"}`,
          `  Origine (template_origin) : ${detectedTemplate.template_origin ?? "(vide)"}`,
          `  Pages numériques (template_page_numbers) : ${(detectedTemplate.template_page_numbers ?? []).join(", ") || "(aucune)"}`,
          `  Référence texte (source_reference) : ${detectedTemplate.source_reference || "(vide)"}`,
        );
      }
      debugLines.push(`Pages connues combinées (detectedTemplateKnownPages) : ${detectedTemplateKnownPages.join(", ") || "(aucune)"}`);
      if (detectedTemplateKnownPages.length) {
        const claimedByOthers1 = otherItemsClaimedPages(analysis?.submission_items ?? [], detectedTemplate?.title ?? title);
        debugLines.push(`  Réclamées par une AUTRE pièce : ${detectedTemplateKnownPages.filter((page) => claimedByOthers1.has(page)).join(", ") || "(aucune)"}`);
      }
      debugLines.push(`Référence du dossier (sourceReference client) : ${clientSourceReference || "(vide)"}`);
      const referencedPagesDebug = parsePageNumbersFromReference(clientSourceReference);
      debugLines.push(`  Pages extraites de cette référence : ${referencedPagesDebug.join(", ") || "(aucune)"}`);
      const source = await fetch(tender.document_url);
      if (source.ok) {
        const bytes = new Uint8Array(await source.arrayBuffer());
        const blindSearch = await locateTitleInFullDocument(bytes, title, otherItemsClaimedPages(analysis?.submission_items ?? [], title));
        debugLines.push(`Recherche à l'aveugle dans tout le DAO : ${blindSearch.join(", ") || "(rien trouvé)"}`);
      }
    } catch (error) {
      debugLines.push(`Diagnostic interrompu par une erreur : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const transportTables = /mat.riaux.*transport/i.test(title) && hasTransportWeightTable && transportWeightTable
    ? [{ title: transportWeightTable.title || title, columns: transportWeightTable.columns || [], rows: transportWeightTable.rows || [] }]
    : [];
  const planTables = /\bplans?\b/i.test(title) && hasPlanRegister && planRegister
    ? [{ title: planRegister.title || title, columns: planRegister.columns || [], rows: planRegister.rows || [] }]
    : [];
  let pdf = await createPrintableSubmissionPdf(title, profileData, [...formLines, ...extraLines, "", ...debugLines], isExecutionPlanning && executionPlanningTable ? [executionPlanningTable] : templateTables.length ? templateTables : transportTables.length ? transportTables : planTables.length ? planTables : rosterTable);
  // planRegister.page_numbers ne liste que quelques pages éparses au lieu de
  // la vraie plage complète des planches (vérifié : sur un DAO réel, les
  // plans couvraient ~110 pages consécutives alors que l'IA n'en avait cité
  // que 16). Un vrai plan technique n'a souvent AUCUN texte extractible (ce
  // n'est pas un signe de page vide, c'est normal pour un dessin vectoriel) :
  // le texte ne permet donc pas de les distinguer des vraies pages de plan.
  // On prend plutôt TOUTE la plage continue à partir du début indiqué,
  // jusqu'à la page juste avant celle où un AUTRE poste déjà identifié
  // commence (planning, personnel...) — cette limite-là est fiable.
  if (/\bplans?\b/i.test(title) && planRegister?.page_numbers?.length && tender.document_url) {
    try {
      const source = await fetch(tender.document_url);
      if (source.ok) {
        const bytes = new Uint8Array(await source.arrayBuffer());
        const documentPageCount = (await PDFDocument.load(bytes)).getPageCount();
        const verifiedPages = await expandToContiguousPlanRange(title, planRegister.page_numbers, analysis?.submission_items ?? [], documentPageCount);
        if (verifiedPages.length) pdf = await appendDaoPagesToPdf(pdf, bytes, verifiedPages);
      }
    } catch (error) {
      console.error("Plan pages append failed", error);
    }
  }
  // Le tableau des poids retapé ne remplace pas les pages sources : le DAO
  // fournit lui-même le tableau original (souvent p.89-93) à joindre en preuve,
  // exactement comme pour le registre des plans ci-dessus.
  if (/mat.riaux.*transport/i.test(title) && transportWeightTable?.source_reference && tender.document_url) {
    try {
      const referencedPages = parsePageNumbersFromReference(transportWeightTable.source_reference);
      const notClaimedByOthers = pagesNotClaimedByOtherItems(analysis?.submission_items ?? [], title, referencedPages);
      if (notClaimedByOthers.length) {
        const source = await fetch(tender.document_url);
        if (source.ok) {
          const bytes = new Uint8Array(await source.arrayBuffer());
          pdf = await appendDaoPagesToPdf(pdf, bytes, notClaimedByOthers);
        }
      }
    } catch (error) {
      console.error("Transport weight table pages append failed", error);
    }
  }
  // Contrat individuel de travail avec une CIN jointe (photo ou PDF) : la CIN
  // est conservée telle quelle (jamais réécrite) et ajoutée en page(s)
  // supplémentaire(s) à la toute fin du contrat, comme demandé — "le pdf
  // contrat aura la ccin en bas sur un autre feuille".
  if (isWorkerContract && workerCinPath) {
    try {
      const signedCin = await supabase.storage.from("btp-documents").createSignedUrl(workerCinPath, 300);
      if (signedCin.data?.signedUrl) {
        const cinResponse = await fetch(signedCin.data.signedUrl);
        if (cinResponse.ok) {
          const cinBytes = new Uint8Array(await cinResponse.arrayBuffer());
          const cinMime = workerCinMime || cinResponse.headers.get("content-type") || (workerCinPath.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
          pdf = await appendExternalFileAsPages(pdf, cinBytes, cinMime);
        }
      }
    } catch (error) {
      console.error("Worker CIN append failed", error);
    }
  }
  return savedPdfResponse(supabase, pdf, member.organization_id, id, estimateId, title, kind, workerIndex, clientFetch);
}

// Les documents générés sont préparés via POST par le lecteur PDF afin qu'un
// cache de navigateur ou de proxy ne puisse jamais répondre avec un 204 vide.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return GET(request, context);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const response = await generatePrintableSubmissionPdf(request, context);
    if (!response) {
      return NextResponse.json({ error: "Le générateur PDF n’a retourné aucun document." }, { status: 500 });
    }
    return response;
  } catch (error) {
    console.error("Printable submission PDF generation failed", error);
    return NextResponse.json({
      error: "La génération du PDF a échoué côté serveur.",
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
