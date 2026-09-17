import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerClient();
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-supabase-access-token") || "";
  const { data: { user } } = await supabase.auth.getUser(accessToken);
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: tender } = await supabase.from("tenders").select("document_url").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!tender?.document_url) return NextResponse.json({ error: "DAO introuvable ou aucun document associé." }, { status: 404 });

  const marker = "/tender-documents/";
  const markerIndex = tender.document_url.indexOf(marker);
  if (markerIndex === -1) return NextResponse.redirect(tender.document_url);

  const path = decodeURIComponent(tender.document_url.slice(markerIndex + marker.length).split("?")[0]);
  const signed = await supabase.storage.from("tender-documents").createSignedUrl(path, 300);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "Document DAO indisponible." }, { status: 404 });

  return NextResponse.redirect(signed.data.signedUrl);
}
