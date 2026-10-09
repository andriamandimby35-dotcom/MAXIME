import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DeletionKind, DeletionPreview, ProjectImpact } from "@/lib/deletion/types";

// Suppression en chaîne, du haut vers le bas :
//   DAO -> devis (+ dossier) -> chantier -> dépenses -> facturation.
// - Supprimer un DAO supprime ses devis et ses chantiers.
// - Supprimer un devis supprime les chantiers créés à partir de lui.
// - Supprimer un chantier supprime ses dépenses, planning, rapports, etc.
//   (en chaîne dans la base) ET ses factures NON payées.
// - Les factures PAYÉES sont toujours gardées (archivées, sans chantier).
// - Supprimer seulement des dépenses ne touche jamais aux factures (ce
//   fichier n'est utilisé que pour supprimer un DAO, un devis ou un chantier).

export type DeletionContext = {
  supabase: Awaited<ReturnType<typeof createServerClient>>;
  organizationId: string;
  userId: string;
  isAdmin: boolean;
};

type Result = { ok: true; archived?: number } | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): Result => ({ ok: false, error, status });

export async function getDeletionContext(): Promise<{ ctx: DeletionContext } | { response: NextResponse }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "Session expirée." }, { status: 401 }) };
  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return { response: NextResponse.json({ error: "Organisation introuvable." }, { status: 403 }) };
  const role = String((member as { role?: string }).role ?? "");
  return { ctx: { supabase, organizationId: member.organization_id, userId: user.id, isAdmin: role === "admin" || role === "owner" } };
}

type Admin = ReturnType<typeof createAdminClient>;

async function countRows(admin: Admin, table: string, column: string, id: string): Promise<number> {
  const result = await admin.from(table).select("*", { count: "exact", head: true }).eq(column, id);
  return result.error ? 0 : result.count ?? 0;
}

async function findProjects(admin: Admin, organizationId: string, tenderId: string | null, estimateIds: string[]) {
  const found = new Map<string, string>();
  if (tenderId) {
    const { data } = await admin.from("projects").select("id,name").eq("organization_id", organizationId).eq("source_tender_id", tenderId);
    for (const row of data ?? []) found.set(String(row.id), String(row.name ?? "Chantier"));
  }
  if (estimateIds.length > 0) {
    const { data } = await admin.from("projects").select("id,name").eq("organization_id", organizationId).in("source_estimate_id", estimateIds);
    for (const row of data ?? []) found.set(String(row.id), String(row.name ?? "Chantier"));
  }
  return [...found.entries()].map(([id, name]) => ({ id, name }));
}

async function impactOf(admin: Admin, organizationId: string, project: { id: string; name: string }): Promise<ProjectImpact> {
  const { data: claims } = await admin.from("progress_claims").select("id,status").eq("organization_id", organizationId).eq("project_id", project.id);
  const paidIds = new Set((claims ?? []).filter((claim) => claim.status === "paid").map((claim) => String(claim.id)));
  const unpaidClaims = (claims ?? []).length - paidIds.size;
  const { data: payments } = await admin.from("payments").select("id,progress_claim_id").eq("organization_id", organizationId).eq("project_id", project.id);
  const payments_ = (payments ?? []).filter((payment) => !(payment.progress_claim_id && paidIds.has(String(payment.progress_claim_id)))).length;
  const counts = await Promise.all(["project_material_orders", "project_salary_payments", "project_daily_attendance"].map((table) => countRows(admin, table, "project_id", project.id)));
  return { id: project.id, name: project.name, expenses: counts.reduce((sum, value) => sum + value, 0), unpaidClaims, paidClaims: paidIds.size, payments: payments_ };
}

function finishPreview(kind: DeletionKind, name: string, estimates: string[], projects: ProjectImpact[]): DeletionPreview {
  return {
    kind,
    name,
    estimates,
    projects,
    paidKept: projects.reduce((sum, project) => sum + project.paidClaims, 0),
    needsTyping: projects.some((project) => project.expenses > 0 || project.unpaidClaims > 0 || project.payments > 0),
  };
}

export async function previewDeletion(ctx: DeletionContext, kind: DeletionKind, id: string): Promise<DeletionPreview | null> {
  const admin = createAdminClient();
  const org = ctx.organizationId;
  if (kind === "project") {
    const { data: project } = await admin.from("projects").select("id,name").eq("id", id).eq("organization_id", org).maybeSingle();
    if (!project) return null;
    return finishPreview("project", String(project.name), [], [await impactOf(admin, org, { id: String(project.id), name: String(project.name) })]);
  }
  if (kind === "estimate") {
    const { data: estimate } = await admin.from("estimates").select("id,source_tender_id").eq("id", id).eq("organization_id", org).maybeSingle();
    if (!estimate) return null;
    let label = `Devis ${id.slice(0, 8)}`;
    if (estimate.source_tender_id) {
      const { data: tender } = await admin.from("tenders").select("reference,title").eq("id", estimate.source_tender_id).maybeSingle();
      if (tender) label = `${tender.reference || "DAO"} — ${tender.title || "Sans titre"}`;
    }
    const projects = await findProjects(admin, org, null, [id]);
    return finishPreview("estimate", label, [], await Promise.all(projects.map((project) => impactOf(admin, org, project))));
  }
  const { data: tender } = await admin.from("tenders").select("id,reference,title").eq("id", id).eq("organization_id", org).maybeSingle();
  if (!tender) return null;
  const { data: estimates } = await admin.from("estimates").select("id").eq("organization_id", org).eq("source_tender_id", id);
  const estimateIds = (estimates ?? []).map((row) => String(row.id));
  const projects = await findProjects(admin, org, id, estimateIds);
  return finishPreview("tender", `${tender.reference || "DAO"} — ${tender.title || "Sans titre"}`, estimateIds.map((estimateId) => estimateId), await Promise.all(projects.map((project) => impactOf(admin, org, project))));
}

// ---------------------------------------------------------------- chantier
export async function deleteProjectChain(ctx: DeletionContext, projectId: string): Promise<Result> {
  if (!ctx.isAdmin) return fail("Seul l'administrateur peut supprimer un chantier.", 403);
  const admin = createAdminClient();
  const org = ctx.organizationId;
  const { data: project } = await admin.from("projects").select("id,name").eq("id", projectId).eq("organization_id", org).maybeSingle();
  if (!project) return fail("Chantier introuvable.", 404);

  const { data: claims, error: claimsError } = await admin.from("progress_claims").select("id,status").eq("organization_id", org).eq("project_id", projectId);
  if (claimsError) return fail(claimsError.message);
  const paidIds = (claims ?? []).filter((claim) => claim.status === "paid").map((claim) => String(claim.id));
  const otherIds = (claims ?? []).filter((claim) => claim.status !== "paid").map((claim) => String(claim.id));

  // 1) Factures payées : on fige le nom du chantier dessus et on range leur PDF
  //    dans un dossier "archive" (le dossier du chantier va disparaître).
  if (paidIds.length > 0) {
    const archive = await admin.from("progress_claims").update({ project_name: String(project.name) }).in("id", paidIds);
    if (archive.error) {
      return fail(`Ce chantier a des factures payées à garder, mais la base n'est pas prête. Exécute d'abord le fichier SQL « 20261010_suppression_hierarchie.sql » dans Supabase. (${archive.error.message})`, 409);
    }
    for (const claimId of paidIds) {
      await admin.storage.from("billing-pdfs").move(`${org}/${projectId}/${claimId}.pdf`, `${org}/archive/${claimId}.pdf`);
    }
  }

  // 2) Paiements du chantier qui ne se rapportent pas à une facture payée.
  const { data: payments } = await admin.from("payments").select("id,progress_claim_id").eq("organization_id", org).eq("project_id", projectId);
  const paymentIds = (payments ?? []).filter((payment) => !(payment.progress_claim_id && paidIds.includes(String(payment.progress_claim_id)))).map((payment) => String(payment.id));
  if (paymentIds.length > 0) {
    const removed = await admin.from("payments").delete().in("id", paymentIds);
    if (removed.error) return fail(`Suppression des paiements impossible : ${removed.error.message}`);
  }

  // 3) Factures non payées + leur PDF conservé.
  if (otherIds.length > 0) {
    await admin.storage.from("billing-pdfs").remove(otherIds.map((claimId) => `${org}/${projectId}/${claimId}.pdf`));
    const removed = await admin.from("progress_claims").delete().in("id", otherIds);
    if (removed.error) return fail(`Suppression des factures impossible : ${removed.error.message}`);
  }

  // 4) Le chantier lui-même (dépenses, planning, rapports... en chaîne), via la
  //    fonction dédiée qui neutralise le verrou "modification le jour même".
  const { error } = await ctx.supabase.rpc("admin_delete_project", { p_project_id: projectId });
  if (error) return fail(`Suppression du chantier impossible : ${error.message}`);
  // PDF enregistrés de ce devis importé (interne et externe) : supprimés avec lui (au mieux, sans bloquer).
  await admin.storage.from("estimate-pdfs").remove([`${org}/${projectId}/internal-pdf/devis.pdf`, `${org}/${projectId}/external-pdf/devis.pdf`]).catch(() => undefined);
  return { ok: true, archived: paidIds.length };
}

// -------------------------------------------------------------------- devis
async function deleteEstimateRows(admin: Admin, organizationId: string, estimateId: string): Promise<Result> {
  const { data: documents, error: documentsReadError } = await admin.from("estimate_documents").select("storage_path").eq("estimate_id", estimateId);
  if (documentsReadError) return fail(documentsReadError.message);
  const paths = (documents ?? []).map((document) => document.storage_path).filter(Boolean);
  if (paths.length > 0) {
    const removal = await admin.storage.from("estimate-pdfs").remove(paths);
    if (removal.error) return fail(removal.error.message);
  }
  const documentsDelete = await admin.from("estimate_documents").delete().eq("estimate_id", estimateId);
  if (documentsDelete.error) return fail(documentsDelete.error.message);
  const lines = await admin.from("estimate_lines").delete().eq("estimate_id", estimateId);
  if (lines.error) return fail(lines.error.message);
  // Le dossier de soumission du devis part avec lui (suppression en chaîne de la base).
  const estimate = await admin.from("estimates").delete().eq("id", estimateId).eq("organization_id", organizationId);
  if (estimate.error) return fail(estimate.error.message);
  return { ok: true };
}

export async function deleteEstimateChain(ctx: DeletionContext, estimateId: string): Promise<Result> {
  const admin = createAdminClient();
  const org = ctx.organizationId;
  const { data: estimate } = await ctx.supabase.from("estimates").select("id").eq("id", estimateId).eq("organization_id", org).maybeSingle();
  if (!estimate) return fail("Devis introuvable pour votre organisation.", 404);

  const projects = await findProjects(admin, org, null, [estimateId]);
  if (projects.length > 0 && !ctx.isAdmin) return fail("Ce devis a un chantier : seul l'administrateur peut le supprimer.", 403);
  for (const project of projects) {
    const result = await deleteProjectChain(ctx, project.id);
    if (!result.ok) return result;
  }
  return deleteEstimateRows(admin, org, estimateId);
}

// ---------------------------------------------------------------------- DAO
export async function deleteTenderChain(ctx: DeletionContext, tenderId: string): Promise<Result> {
  const admin = createAdminClient();
  const org = ctx.organizationId;
  const { data: tender } = await admin.from("tenders").select("id").eq("id", tenderId).eq("organization_id", org).maybeSingle();
  if (!tender) return fail("DAO introuvable ou suppression non autorisée.", 404);

  const { data: estimates } = await admin.from("estimates").select("id").eq("organization_id", org).eq("source_tender_id", tenderId);
  const estimateIds = (estimates ?? []).map((row) => String(row.id));
  const projects = await findProjects(admin, org, tenderId, estimateIds);
  if (projects.length > 0 && !ctx.isAdmin) return fail("Ce DAO a un chantier : seul l'administrateur peut le supprimer.", 403);

  for (const project of projects) {
    const result = await deleteProjectChain(ctx, project.id);
    if (!result.ok) return result;
  }
  for (const estimateId of estimateIds) {
    const result = await deleteEstimateRows(admin, org, estimateId);
    if (!result.ok) return result;
  }
  const removed = await admin.from("tenders").delete().eq("id", tenderId).eq("organization_id", org);
  if (removed.error) return fail(`Suppression impossible : ${removed.error.message}`);
  return { ok: true };
}

export function resultResponse(result: Result) {
  if (result.ok) return NextResponse.json({ deleted: true, ok: true, archived: result.archived ?? 0 });
  return NextResponse.json({ error: result.error }, { status: result.status });
}
