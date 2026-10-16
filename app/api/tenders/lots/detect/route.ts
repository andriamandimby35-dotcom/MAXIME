import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { detectLots, type LotDetection } from "@/lib/dao/lot-detection";
import { readPageTexts } from "@/lib/dao/lots-server";

// Lecture du PDF d'un DAO pour y repérer les lots (texte du PDF uniquement : aucun appel IA, aucun crédit).
// Le résultat est gardé dans tenders.lot_detection : le PDF n'est relu que si on le demande (force = true).
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

    const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

    const body = await request.json().catch(() => null) as { tenderId?: string; force?: boolean } | null;
    const tenderId = body?.tenderId?.trim();
    if (!tenderId) return NextResponse.json({ error: "DAO manquant." }, { status: 400 });

    const { data: tender } = await supabase
      .from("tenders")
      .select("id,document_url,organization_id")
      .eq("id", tenderId)
      .eq("organization_id", member.organization_id)
      .maybeSingle();
    if (!tender) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });
    if (!tender.document_url) return NextResponse.json({ error: "Ce DAO n'a pas de document PDF." }, { status: 400 });

    // Colonnes ajoutées par le SQL des lots : si elles n'existent pas encore, cette lecture échoue sans casser le reste.
    const stored = await supabase.from("tenders").select("lot_detection").eq("id", tender.id).maybeSingle();
    if (stored.error) {
      return NextResponse.json({ error: "Le SQL des lots n'a pas encore été lancé dans Supabase." }, { status: 409 });
    }
    const storedDetection = (stored.data as { lot_detection?: LotDetection | null } | null)?.lot_detection;
    if (storedDetection && !body?.force) return NextResponse.json({ detection: storedDetection, cached: true });

    const pdfResponse = await fetch(tender.document_url);
    if (!pdfResponse.ok) return NextResponse.json({ error: "Le document PDF est inaccessible." }, { status: 502 });
    const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());

    const pages = await readPageTexts(pdfBytes);
    const detection = detectLots(pages);
    // Un PDF sans aucun texte (scan) : on le dit clairement, l'utilisateur pourra indiquer les pages lui-même.
    const readable = pages.some((page) => page.lines.length > 0);

    const { error: saveError } = await supabase
      .from("tenders")
      .update({ lot_detection: detection })
      .eq("id", tender.id)
      .eq("organization_id", member.organization_id);
    if (saveError) console.error("Sauvegarde détection des lots impossible", saveError);

    return NextResponse.json({ detection, readable, cached: false });
  } catch (error) {
    console.error("Détection des lots impossible", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Détection des lots impossible." }, { status: 500 });
  }
}
