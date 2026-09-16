import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createPrintableSubmissionPdf } from "@/lib/submission/printable-pdf";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SubmissionItem = { kind: string; title: string; required: boolean; status: string; form_data: Record<string, string> };
const generated = (title: string) => /planning|mat.riaux.*transport|liste des plans/i.test(title);
const readingOnly = (title: string) => /charte de déontologie|fraude|corruption/i.test(title);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const estimateId = new URL(request.url).searchParams.get("estimateId");
  const supabase = await createServerClient();
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-supabase-access-token") || "";
  const { data: { user } } = await supabase.auth.getUser(accessToken);
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const path = `${member.organization_id}/submission/${id}/${estimateId ?? "master"}/dossier-soumission-final.pdf`;
  const signed = await supabase.storage.from("btp-documents").createSignedUrl(path, 300);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "PDF final non disponible." }, { status: 404 });
  return NextResponse.redirect(signed.data.signedUrl);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const estimateId = new URL(request.url).searchParams.get("estimateId");
  const supabase = await createServerClient();
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    || request.headers.get("x-supabase-access-token") || "";
  const { data: { user } } = await supabase.auth.getUser(accessToken);
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const { data: tender } = await supabase.from("tenders").select("id,title,reference").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!tender) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });
  const [profileResult, masterItems, estimateDossier] = await Promise.all([
    supabase.from("organization_submission_profiles").select("profile_data").eq("organization_id", member.organization_id).maybeSingle(),
    supabase.from("tender_submission_items").select("kind,title,required,status,form_data").eq("organization_id", member.organization_id).eq("tender_id", id),
    estimateId ? supabase.from("estimate_submission_dossiers").select("items").eq("organization_id", member.organization_id).eq("tender_id", id).eq("estimate_id", estimateId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const items = (estimateId ? estimateDossier.data?.items : masterItems.data ?? []) as SubmissionItem[];
  const missing = items.filter((item) => item.required && !generated(item.title) && (readingOnly(item.title) ? !item.form_data?.__acknowledgedAt : !item.form_data?.__attachmentPath));
  if (missing.length) return NextResponse.json({ error: `${missing.length} pièce(s) obligatoire(s) restent à compléter, signer ou insérer.`, missing: missing.map((item) => item.title) }, { status: 409 });
  const lines = [
    `DAO : ${tender.reference || "sans référence"} — ${tender.title || ""}`,
    "Dossier validé : toutes les pièces obligatoires sont présentes.",
    "", "Pièces incluses :",
    ...items.map((item) => `• ${item.title} — ${generated(item.title) ? "PDF généré" : readingOnly(item.title) ? "lecture confirmée" : item.form_data?.__attachmentName || "document joint"}`),
  ];
  const pdf = createPrintableSubmissionPdf("Dossier de soumission final — vérification", (profileResult.data?.profile_data ?? {}) as Record<string, unknown>, lines);
  const path = `${member.organization_id}/submission/${id}/${estimateId ?? "master"}/dossier-soumission-final.pdf`;
  const upload = await supabase.storage.from("btp-documents").upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (upload.error) return NextResponse.json({ error: `Enregistrement du PDF final impossible : ${upload.error.message}` }, { status: 500 });
  const signed = await supabase.storage.from("btp-documents").createSignedUrl(path, 3600);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "PDF final enregistré, mais ouverture impossible." }, { status: 500 });
  return NextResponse.json({ ok: true, url: signed.data.signedUrl });
}
