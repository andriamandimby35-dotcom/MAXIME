import type { SupabaseClient } from "@supabase/supabase-js";
import { daoTasksFromAnalysis } from "@/lib/projects/dao-tasks";

// Le chantier devient indépendant du DAO dès sa création : la localisation,
// le planning et le bordereau de prix sont copiés une seule fois depuis le
// devis (et le DAO qui l'a éventuellement généré). Après cette copie, le
// chantier ne va plus jamais relire le DAO en direct — les deux logiciels
// sont séparés. Relancer cette fonction sur un chantier déjà créé rafraîchit
// simplement sa copie (par exemple si le devis a été modifié).

type LineData = Record<string, unknown>;

function normalizedKey(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
function isSectionOrSubtotal(line: LineData) {
  const type = String(line.__daoRowType ?? "item");
  return type === "section" || type === "subtotal";
}
function isInternal(line: LineData) {
  return line.__internalOnly === true || line.__internalOnly === "true";
}

export async function createOrSyncProjectFromEstimate(
  supabase: SupabaseClient,
  params: { organizationId: string; estimateId: string },
): Promise<{ projectId: string } | { error: string }> {
  const { organizationId, estimateId } = params;

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .select("id,organization_id,source_tender_id,client_name,profit_margin_percent")
    .eq("id", estimateId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (estimateError) return { error: estimateError.message };
  if (!estimate) return { error: "Devis introuvable pour votre organisation." };

  // La marge du devis externe (voir EstimateBuilder) n'est jamais recopiée
  // dans le bordereau du chantier : on la retrouve ici pour figer, une bonne
  // fois pour toutes, le prix externe déjà montré au client sur son PDF
  // (external_unit_price), séparément du prix interne (unit_price) qui,
  // lui, reste le coût réel. Sert notamment à la facturation à l'avancement.
  const marginPercent = Number(estimate.profit_margin_percent) || 0;

  let tender: { title?: string; reference?: string; ai_analysis?: unknown } | null = null;
  if (estimate.source_tender_id) {
    const { data } = await supabase
      .from("tenders")
      .select("title,reference,ai_analysis")
      .eq("id", estimate.source_tender_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    tender = data ?? null;
  }

  type StoredAnalysis = { worksite_location?: string };
  let rawAnalysis: unknown = tender?.ai_analysis ?? {};
  if (typeof rawAnalysis === "string") {
    try { rawAnalysis = JSON.parse(rawAnalysis); } catch { rawAnalysis = {}; }
  }
  const analysis = rawAnalysis as StoredAnalysis;
  const location = String(analysis.worksite_location ?? "").trim() || null;

  // Un devis = un seul chantier. S'il en existe déjà un pour ce devis, on le
  // réutilise et on rafraîchit sa copie au lieu d'en recréer un second.
  const { data: existingProject, error: existingProjectError } = await supabase
    .from("projects")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("source_estimate_id", estimateId)
    .maybeSingle();
  if (existingProjectError) return { error: existingProjectError.message };

  let projectId = existingProject?.id as string | undefined;

  if (!projectId) {
    const { data: created, error: createError } = await supabase
      .from("projects")
      .insert({
        organization_id: organizationId,
        source_tender_id: estimate.source_tender_id,
        source_estimate_id: estimateId,
        name: tender?.title || estimate.client_name || `Chantier ${estimateId.slice(0, 8)}`,
        location,
        status: "planned",
      })
      .select("id")
      .single();
    if (createError) return { error: createError.message };
    projectId = created.id as string;
  } else if (location) {
    const { error: updateError } = await supabase.from("projects").update({ location }).eq("id", projectId);
    if (updateError) return { error: updateError.message };
  }

  // Bordereau de prix : copie indépendante des lignes du devis. On remplace
  // l'ancienne copie pour refléter fidèlement le devis au moment de l'appel.
  const { data: lines, error: linesError } = await supabase
    .from("estimate_lines")
    .select("data")
    .eq("estimate_id", estimateId);
  if (linesError) return { error: linesError.message };

  const priceItems = (lines ?? [])
    .map((row) => (row.data ?? {}) as LineData)
    .filter((line) => !isSectionOrSubtotal(line))
    .map((line) => {
      const quantity = numberFrom(line, ["Quantité", "Quantite"]);
      const unitPrice = numberFrom(line, ["Prix unitaire"]);
      const total = numberFrom(line, ["Total"]) || quantity * unitPrice;
      const lineIsInternal = isInternal(line);
      return {
        organization_id: organizationId,
        project_id: projectId as string,
        position: textFrom(line, ["N°", "N"]) || null,
        designation: textFrom(line, ["Désignation", "Designation"]) || "Poste sans désignation",
        unit: textFrom(line, ["Unité", "Unite"]) || null,
        quantity: quantity || null,
        unit_price: unitPrice || null,
        // Prix déjà donné au client sur le devis externe (coût + marge),
        // figé ici plutôt que recalculé plus tard : sert de référence stable
        // pour la facturation, même si la marge du devis change ensuite.
        // Sans objet pour une ligne interne (jamais montrée au client).
        external_unit_price: lineIsInternal ? null : Math.round(unitPrice * (1 + marginPercent / 100) * 100) / 100,
        total: total || null,
        is_internal: lineIsInternal,
      };
    });

  const { error: deleteOldItemsError } = await supabase.from("project_price_items").delete().eq("project_id", projectId);
  if (deleteOldItemsError) return { error: deleteOldItemsError.message };
  if (priceItems.length > 0) {
    const { error: insertItemsError } = await supabase.from("project_price_items").insert(priceItems);
    if (insertItemsError) return { error: insertItemsError.message };
  }

  // Planning : mêmes étapes qu'avant, importées une bonne fois pour toutes
  // (jamais relues en direct sur le DAO après coup).
  const { data: existingTasks } = await supabase
    .from("project_tasks")
    .select("dao_sequence,is_dao_task")
    .eq("project_id", projectId);
  const alreadyImportedSequences = new Set(
    (existingTasks ?? [])
      .filter((task) => task.is_dao_task && task.dao_sequence !== null)
      .map((task) => Number(task.dao_sequence)),
  );

  const rawDaoTasks = daoTasksFromAnalysis(tender?.ai_analysis, organizationId, projectId);
  let tasksToInsert = rawDaoTasks.filter((task) => !alreadyImportedSequences.has(task.dao_sequence));

  // Devis sans DAO (ou DAO sans planning détaillé) : on construit quand même
  // une liste de travaux à faire, directement à partir du bordereau de prix
  // du devis, pour que le suivi de progression du chantier fonctionne aussi
  // dans ce cas.
  if (rawDaoTasks.length === 0) {
    const usedSequences = new Set<number>();
    tasksToInsert = priceItems
      .map((item, index) => {
        const title = item.designation.trim();
        if (!title || title === "Poste sans désignation") return null;
        const fromPosition = Number(item.position);
        let daoSequence = Number.isFinite(fromPosition) && fromPosition > 0 ? Math.trunc(fromPosition) : index + 1;
        while (usedSequences.has(daoSequence)) daoSequence += 1;
        usedSequences.add(daoSequence);
        return {
          organization_id: organizationId,
          project_id: projectId as string,
          dao_sequence: daoSequence,
          title,
          source_reference: "Bordereau de prix",
          is_dao_task: true as const,
          notes: item.quantity ? `Quantité prévue : ${item.quantity}${item.unit ? ` ${item.unit}` : ""}.` : null,
        };
      })
      .filter((task): task is NonNullable<typeof task> => task !== null)
      .filter((task) => !alreadyImportedSequences.has(task.dao_sequence));
  }

  if (tasksToInsert.length > 0) {
    const { error: tasksError } = await supabase.from("project_tasks").insert(tasksToInsert);
    if (tasksError) return { error: tasksError.message };
  }

  return { projectId };
}
