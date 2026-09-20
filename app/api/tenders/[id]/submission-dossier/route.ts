import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

type SubmissionItem = {
  kind: "document_to_provide" | "form_to_complete";
  title: string;
  source_reference: string;
  instructions: string;
  required: boolean;
  status: "missing" | "needs_information" | "ready" | "uploaded";
  fields: Array<{ key: string; label: string; required: boolean; description: string }>;
  form_data: Record<string, string>;
};

async function getAuthorizedTender(id: string) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Non autorisé." }, { status: 401 }) };

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return { error: NextResponse.json({ error: "Organisation introuvable." }, { status: 403 }) };

  const { data: tender } = await supabase
    .from("tenders")
    .select("id")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (!tender) return { error: NextResponse.json({ error: "DAO introuvable." }, { status: 404 }) };

  return { supabase, user, organizationId: member.organization_id, tenderId: tender.id };
}

async function ensureEstimateBelongsToTender(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  organizationId: string,
  tenderId: string,
  estimateId: string | null,
) {
  if (!estimateId) return true;
  const { data: estimate } = await supabase.from("estimates").select("id").eq("id", estimateId).eq("organization_id", organizationId).maybeSingle();
  if (!estimate) return false;
  const { data: lines } = await supabase.from("estimate_lines").select("data").eq("estimate_id", estimateId);
  return (lines ?? []).some((line) => (line.data as Record<string, unknown>)?.__sourceTenderId === tenderId);
}

function migrationError(error: { code?: string; message?: string } | null) {
  return error?.code === "42P01" || error?.message?.includes("does not exist");
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authorized = await getAuthorizedTender(id);
  if (authorized.error) return authorized.error;
  const estimateId = new URL(request.url).searchParams.get("estimateId");
  if (!await ensureEstimateBelongsToTender(authorized.supabase, authorized.organizationId, authorized.tenderId, estimateId)) {
    return NextResponse.json({ error: "Ce devis n’est pas lié à ce DAO." }, { status: 404 });
  }

  const [profileResult, itemsResult, estimateResult, lockResult] = await Promise.all([
    authorized.supabase
      .from("organization_submission_profiles")
      .select("profile_data")
      .eq("organization_id", authorized.organizationId)
      .maybeSingle(),
    authorized.supabase
      .from("tender_submission_items")
      .select("kind,title,source_reference,instructions,required,status,fields,form_data")
      .eq("organization_id", authorized.organizationId)
      .eq("tender_id", authorized.tenderId)
      .order("created_at"),
    estimateId ? authorized.supabase
      .from("estimate_submission_dossiers")
      .select("items,locked_at")
      .eq("estimate_id", estimateId)
      .eq("organization_id", authorized.organizationId)
      .eq("tender_id", authorized.tenderId)
      .maybeSingle() : Promise.resolve({ data: null, error: null }),
    // Table facultative ("Valider la complétion") : si la migration n'a pas
    // encore été appliquée, on ignore simplement l'erreur au lieu de faire
    // échouer tout le chargement du dossier — seul le bouton de verrouillage
    // restera indisponible en attendant.
    !estimateId ? authorized.supabase
      .from("tender_submission_dossier_locks")
      .select("locked_at")
      .eq("tender_id", authorized.tenderId)
      .eq("organization_id", authorized.organizationId)
      .maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (migrationError(profileResult.error) || migrationError(itemsResult.error) || migrationError(estimateResult.error)) {
    return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
  }
  if (profileResult.error || itemsResult.error || estimateResult.error) {
    return NextResponse.json({ error: "Chargement du dossier impossible." }, { status: 500 });
  }

  return NextResponse.json({
    profile: profileResult.data?.profile_data ?? {},
    items: estimateId ? (estimateResult.data?.items ?? []) : (itemsResult.data ?? []),
    lockedAt: estimateId ? (estimateResult.data?.locked_at ?? null) : (lockResult.data?.locked_at ?? null),
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authorized = await getAuthorizedTender(id);
  if (authorized.error) return authorized.error;

  const body = await request.json().catch(() => null) as { profile?: Record<string, unknown>; items?: SubmissionItem[] } | null;
  if (!body || !body.profile || !Array.isArray(body.items)) {
    return NextResponse.json({ error: "Données du dossier invalides." }, { status: 400 });
  }
  const estimateId = typeof (body as { estimateId?: unknown }).estimateId === "string" ? (body as { estimateId: string }).estimateId : null;
  if (!await ensureEstimateBelongsToTender(authorized.supabase, authorized.organizationId, authorized.tenderId, estimateId)) {
    return NextResponse.json({ error: "Ce devis n’est pas lié à ce DAO." }, { status: 404 });
  }

  const profile = Object.fromEntries(
    Object.entries(body.profile).filter(([key, value]) => key.length <= 80 && typeof value === "string"),
  );
  const items = body.items.slice(0, 150).map((item) => ({
    organization_id: authorized.organizationId,
    tender_id: authorized.tenderId,
    kind: item.kind,
    title: String(item.title || "").slice(0, 500),
    source_reference: String(item.source_reference || "").slice(0, 500),
    instructions: String(item.instructions || "").slice(0, 4000),
    required: Boolean(item.required),
    status: item.status,
    fields: Array.isArray(item.fields) ? item.fields.slice(0, 80) : [],
    form_data: Object.fromEntries(Object.entries(item.form_data || {}).filter(([key, value]) => key.length <= 80 && typeof value === "string")),
  })).filter((item) => item.title && (item.kind === "document_to_provide" || item.kind === "form_to_complete"));

  const profileResult = await authorized.supabase
    .from("organization_submission_profiles")
    .upsert({ organization_id: authorized.organizationId, profile_data: profile, updated_by: authorized.user.id, updated_at: new Date().toISOString() });
  if (migrationError(profileResult.error)) return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
  if (profileResult.error) return NextResponse.json({ error: "Enregistrement du profil impossible." }, { status: 500 });

  if (estimateId) {
    const result = await authorized.supabase.from("estimate_submission_dossiers").upsert({
      estimate_id: estimateId, organization_id: authorized.organizationId, tender_id: authorized.tenderId,
      items, updated_by: authorized.user.id, updated_at: new Date().toISOString(),
    });
    if (migrationError(result.error)) return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
    if (result.error) return NextResponse.json({ error: "Enregistrement du dossier du devis impossible." }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const deletion = await authorized.supabase
    .from("tender_submission_items")
    .delete()
    .eq("organization_id", authorized.organizationId)
    .eq("tender_id", authorized.tenderId);
  if (deletion.error) return NextResponse.json({ error: "Enregistrement du dossier impossible." }, { status: 500 });

  if (items.length) {
    const insertion = await authorized.supabase.from("tender_submission_items").insert(items);
    if (insertion.error) return NextResponse.json({ error: "Enregistrement des pièces impossible." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// Supprime le dossier de soumission affiché (celui du devis précis si
// estimateId est fourni, sinon le dossier maître du DAO). Ne touche jamais à
// tenders.ai_analysis (l'analyse IA du DAO, coûteuse) : au prochain
// chargement de la page, l'appli reconstruit simplement une liste de pièces
// vierge à partir de cette analyse déjà en cache, sans nouvel appel IA.
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authorized = await getAuthorizedTender(id);
  if (authorized.error) return authorized.error;
  const estimateId = new URL(request.url).searchParams.get("estimateId");
  if (!await ensureEstimateBelongsToTender(authorized.supabase, authorized.organizationId, authorized.tenderId, estimateId)) {
    return NextResponse.json({ error: "Ce devis n’est pas lié à ce DAO." }, { status: 404 });
  }

  if (estimateId) {
    const result = await authorized.supabase
      .from("estimate_submission_dossiers")
      .delete()
      .eq("organization_id", authorized.organizationId)
      .eq("tender_id", authorized.tenderId)
      .eq("estimate_id", estimateId);
    if (migrationError(result.error)) return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
    if (result.error) return NextResponse.json({ error: "Suppression du dossier impossible." }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const deletionResult = await authorized.supabase
    .from("tender_submission_items")
    .delete()
    .eq("organization_id", authorized.organizationId)
    .eq("tender_id", authorized.tenderId);
  if (migrationError(deletionResult.error)) return NextResponse.json({ error: "La migration du dossier de soumission n’est pas encore appliquée." }, { status: 503 });
  if (deletionResult.error) return NextResponse.json({ error: "Suppression du dossier impossible." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
