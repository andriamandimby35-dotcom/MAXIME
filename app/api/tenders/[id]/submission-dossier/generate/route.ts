import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { buildMasterDetectedItems, buildDossierRecordsForInsert, type MasterAnalysis, type TemplateDetectedItem } from "@/lib/submission/build-dossier-items";
import { splitMergedDaoItems } from "@/lib/submission/split-merged-dao-items";
import { knownPagesForItem } from "@/lib/submission/parse-page-reference";

function migrationError(error: { code?: string; message?: string } | null) {
  return error?.code === "42P01" || error?.message?.includes("does not exist");
}

// Crée le dossier maître de soumission d'un DAO (tender_submission_items) à
// partir de son analyse IA déjà en cache (tenders.ai_analysis), UNIQUEMENT
// quand ce bouton est cliqué. Avant, cette liste était reconstruite à
// l'affichage de chaque page, sans notion d'existence réelle : une
// suppression n'avait donc aucun effet visible, un dossier vide réapparaissait
// aussitôt. Maintenant, generer un devis IA et générer ce dossier sont deux
// actions indépendantes : l'une peut exister sans l'autre.
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const organizationId = member.organization_id;

  const { data: tender } = await supabase
    .from("tenders")
    .select("id,ai_analysis,document_url")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!tender) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });
  if (!tender.ai_analysis) {
    return NextResponse.json({ error: "Analysez d’abord le DAO avec l’IA avant de générer le dossier de soumission." }, { status: 400 });
  }

  const existing = await supabase
    .from("tender_submission_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("tender_id", id);
  if (migrationError(existing.error)) {
    return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
  }
  if (existing.error) return NextResponse.json({ error: "Vérification du dossier impossible." }, { status: 500 });
  if ((existing.count ?? 0) > 0) {
    return NextResponse.json({ error: "Le dossier de soumission existe déjà pour ce DAO." }, { status: 409 });
  }

  let analysis: MasterAnalysis = null;
  try {
    analysis = typeof tender.ai_analysis === "string" ? JSON.parse(tender.ai_analysis) : tender.ai_analysis as MasterAnalysis;
  } catch {
    analysis = null;
  }

  // Même correctif après coup que app/(dashboard)/tenders/[id]/submission/
  // page.tsx (voir splitMergedDaoItems) : une pièce déjà fusionnée à tort par
  // l'IA doit être séparée dès la toute première génération du dossier, pas
  // seulement à l'affichage. Ne retélécharge le DAO que si vraiment
  // nécessaire (au moins une pièce sur plusieurs vraies pages).
  const rawItems = (analysis?.submission_items ?? []) as TemplateDetectedItem[];
  // knownPagesForItem (fonction partagée, voir parse-page-reference.ts) :
  // même vérification que partout ailleurs (page.tsx,
  // printable-submission-document/route.ts), jamais réécrite à la main ici.
  const mightHaveMergedItems = rawItems.some((item) => item.template_origin === "dao"
    && knownPagesForItem(item).length > 1);
  if (mightHaveMergedItems && tender.document_url) {
    try {
      const response = await fetch(tender.document_url);
      if (response.ok) {
        const pdfBytes = new Uint8Array(await response.arrayBuffer());
        const splitItems = await splitMergedDaoItems(rawItems, pdfBytes);
        if (analysis) analysis = { ...analysis, submission_items: splitItems };
      }
    } catch {
      // DAO original temporairement inaccessible : on continue avec la
      // liste non corrigée plutôt que de bloquer la génération du dossier.
    }
  }

  const detectedItems = buildMasterDetectedItems(analysis);
  const records = buildDossierRecordsForInsert(detectedItems).map((item) => ({
    organization_id: organizationId,
    tender_id: id,
    kind: item.kind,
    title: item.title,
    source_reference: item.source_reference,
    instructions: item.instructions,
    required: item.required,
    status: item.status,
    fields: item.fields,
    form_data: item.form_data,
  }));

  const insertion = await supabase.from("tender_submission_items").insert(records);
  if (migrationError(insertion.error)) {
    return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
  }
  if (insertion.error) return NextResponse.json({ error: "Génération du dossier impossible." }, { status: 500 });

  return NextResponse.json({ ok: true, count: records.length });
}
