import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readTransportWeightsFromPdf, type TransportWeights } from "@/lib/dao/transport-weights";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// « Lire les poids dans le DAO » : lecture GRATUITE (sans IA) des tableaux « Liste et poids des matériaux estimés à
// transporter » du PDF du DAO. Le PDF n'est téléchargé qu'UNE fois ; le résultat est gardé dans l'analyse du DAO
// (ai_analysis.transport_weights) et réutilisé ensuite par tous les devis de ce DAO. Une relecture n'a lieu que si
// l'on la demande explicitement (force = true).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { force?: boolean };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: tender } = await supabase.from("tenders").select("id,document_url,ai_analysis").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!tender) return NextResponse.json({ error: "DAO introuvable dans votre organisation." }, { status: 404 });
  const analysis = (tender.ai_analysis && typeof tender.ai_analysis === "object" ? tender.ai_analysis : {}) as Record<string, unknown>;

  // Déjà lu : on le renvoie sans rien retélécharger (quota Supabase).
  const stored = analysis.transport_weights as TransportWeights | undefined;
  if (stored && Array.isArray(stored.tables) && !body.force) return NextResponse.json({ ok: true, weights: stored, cached: true });

  if (!tender.document_url) return NextResponse.json({ error: "Ce DAO n'a pas de PDF enregistré." }, { status: 400 });
  const pdfResponse = await fetch(String(tender.document_url));
  if (!pdfResponse.ok) return NextResponse.json({ error: "Le PDF du DAO est inaccessible." }, { status: 502 });
  const weights = await readTransportWeightsFromPdf(new Uint8Array(await pdfResponse.arrayBuffer()));

  // Gardé même s'il est vide : on ne retélécharge pas le PDF à chaque ouverture (la relecture se demande avec « force »).
  const { error } = await supabase.from("tenders").update({ ai_analysis: { ...analysis, transport_weights: weights } }).eq("id", id);
  if (error) return NextResponse.json({ ok: true, weights, warning: "Poids lus mais non enregistrés : " + error.message });
  return NextResponse.json({ ok: true, weights });
}
