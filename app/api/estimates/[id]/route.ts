import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// La suppression passe par le client admin (clé service_role) car les
// politiques RLS de estimates/estimate_lines/estimate_documents n'autorisent
// pas le DELETE direct depuis le navigateur. L'appartenance à l'organisation
// est vérifiée avant toute suppression, avec le client authentifié normal.
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: estimate, error: estimateReadError } = await supabase
    .from("estimates")
    .select("id")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (estimateReadError) return NextResponse.json({ error: estimateReadError.message }, { status: 400 });
  if (!estimate) return NextResponse.json({ error: "Devis introuvable pour votre organisation." }, { status: 404 });

  const admin = createAdminClient();

  const { data: documents, error: documentsReadError } = await admin
    .from("estimate_documents")
    .select("storage_path")
    .eq("estimate_id", id);
  if (documentsReadError) return NextResponse.json({ error: documentsReadError.message }, { status: 400 });

  const paths = (documents ?? []).map((document) => document.storage_path).filter(Boolean);
  if (paths.length > 0) {
    const removal = await admin.storage.from("estimate-pdfs").remove(paths);
    if (removal.error) return NextResponse.json({ error: removal.error.message }, { status: 400 });
  }

  const { error: documentsDeleteError } = await admin.from("estimate_documents").delete().eq("estimate_id", id);
  if (documentsDeleteError) return NextResponse.json({ error: documentsDeleteError.message }, { status: 400 });

  const { error: linesError } = await admin.from("estimate_lines").delete().eq("estimate_id", id);
  if (linesError) return NextResponse.json({ error: linesError.message }, { status: 400 });

  const { error: estimateError } = await admin
    .from("estimates")
    .delete()
    .eq("id", id)
    .eq("organization_id", member.organization_id);
  if (estimateError) return NextResponse.json({ error: estimateError.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
