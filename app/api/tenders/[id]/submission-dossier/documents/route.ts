import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const { data: tender } = await supabase.from("tenders").select("document_url").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!tender) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });

  const { data: lines } = await supabase
    .from("estimate_lines")
    .select("estimate_id,data,estimates!inner(organization_id)")
    .eq("estimates.organization_id", member.organization_id);
  const estimateIds = [...new Set((lines ?? [])
    .filter((line) => (line.data as Record<string, unknown>)?.__sourceTenderId === id)
    .map((line) => line.estimate_id))];
  if (!estimateIds.length) return NextResponse.json({ daoUrl: tender.document_url, estimates: [] });

  const { data: documents } = await supabase
    .from("estimate_documents")
    .select("estimate_id,file_name,storage_path,created_at")
    .eq("organization_id", member.organization_id)
    .eq("document_type", "dao_official")
    .in("estimate_id", estimateIds);
  const documentsByEstimate = new Map((documents ?? []).map((document) => [document.estimate_id, document]));
  const estimates = await Promise.all(estimateIds.map(async (estimateId) => {
    const document = documentsByEstimate.get(estimateId);
    if (!document) return { estimateId, fileName: null, updatedAt: null, url: null };
    const signed = await supabase.storage.from("estimate-pdfs").createSignedUrl(document.storage_path, 300, { download: document.file_name });
    return { estimateId: document.estimate_id, fileName: document.file_name, updatedAt: document.created_at, url: signed.data?.signedUrl ?? null };
  }));
  return NextResponse.json({ daoUrl: tender.document_url, estimates });
}
