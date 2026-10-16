import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { pagesForLot, describePageMap, type DetectedLot, type LotDetection, type PageRange } from "@/lib/dao/lot-detection";
import { buildMiniPdf } from "@/lib/dao/lots-server";

// Crée un « mini-DAO » par lot choisi : un PDF qui ne garde que ce qui concerne le lot (les tableaux de prix des
// autres lots et, au choix, le CCAG sont retirés) et un appel d'offres normal rattaché au DAO complet d'origine.
// Le PDF d'origine n'est jamais modifié ni supprimé. Chaque lot suit ensuite exactement le même parcours qu'un DAO
// à lot unique : analyse, BDQE, devis, dossier de soumission, chantier, factures, dépenses.
export const maxDuration = 120;

type LotRequest = { number: number; label?: string; ranges?: Array<[number, number]> };

function cleanRanges(input: unknown, pageCount: number): PageRange[] | null {
  if (!Array.isArray(input)) return null;
  const ranges: PageRange[] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const from = Math.floor(Number(entry[0]));
    const to = Math.floor(Number(entry[1]));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const a = Math.max(1, Math.min(from, to));
    const b = Math.min(pageCount, Math.max(from, to));
    if (a <= b) ranges.push([a, b]);
  }
  return ranges.length > 0 ? ranges : null;
}

function shortPlace(label: string) {
  const first = label.split(/,\s*(?:district|r[ée]gion)/i)[0].replace(/\s+/g, " ").trim();
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

    const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

    const body = await request.json().catch(() => null) as { tenderId?: string; lots?: LotRequest[]; dropCcag?: boolean } | null;
    const tenderId = body?.tenderId?.trim();
    const requested = Array.isArray(body?.lots) ? body!.lots!.filter((lot) => Number.isInteger(lot?.number) && lot.number > 0 && lot.number < 100) : [];
    if (!tenderId || requested.length === 0) return NextResponse.json({ error: "Choisis au moins un lot." }, { status: 400 });

    const { data: parent, error: parentError } = await supabase
      .from("tenders")
      .select("id,title,reference,client_name,description,deadline,estimated_amount,document_url,lot_detection,parent_tender_id")
      .eq("id", tenderId)
      .eq("organization_id", member.organization_id)
      .maybeSingle();
    if (parentError) return NextResponse.json({ error: "Le SQL des lots n'a pas encore été lancé dans Supabase." }, { status: 409 });
    if (!parent) return NextResponse.json({ error: "DAO introuvable." }, { status: 404 });
    if (parent.parent_tender_id) return NextResponse.json({ error: "Ce DAO est déjà un lot : choisis les lots depuis le DAO complet." }, { status: 400 });
    if (!parent.document_url) return NextResponse.json({ error: "Ce DAO n'a pas de document PDF." }, { status: 400 });
    const stored = parent.lot_detection as LotDetection | null;
    if (!stored?.pageCount) return NextResponse.json({ error: "Les lots de ce DAO n'ont pas encore été lus. Rouvre l'écran de choix des lots." }, { status: 400 });

    // Détection de base + corrections faites à la main (pages d'un lot modifiées, lot ajouté).
    const lotsByNumber = new Map<number, DetectedLot>(stored.lots.map((lot) => [lot.number, { ...lot }]));
    let edited = false;
    for (const lot of requested) {
      const ranges = cleanRanges(lot.ranges, stored.pageCount);
      if (!ranges) continue;
      const existing = lotsByNumber.get(lot.number);
      const pageCount = new Set(ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))).size;
      lotsByNumber.set(lot.number, {
        number: lot.number,
        label: String(lot.label ?? existing?.label ?? "").slice(0, 200),
        ranges,
        pageCount,
        bidSecurity: existing?.bidSecurity ?? null,
      });
      edited = true;
    }
    const detection: LotDetection = { ...stored, lots: [...lotsByNumber.values()].sort((a, b) => a.number - b.number) };

    const missing = requested.filter((lot) => !lotsByNumber.has(lot.number));
    if (missing.length > 0) {
      return NextResponse.json({ error: `Lot ${missing.map((lot) => lot.number).join(", ")} : indique ses pages avant de le créer.` }, { status: 400 });
    }

    const { data: existingChildren } = await supabase
      .from("tenders")
      .select("id,lot_number")
      .eq("parent_tender_id", parent.id)
      .eq("organization_id", member.organization_id);
    const alreadyCreated = new Map<number, string>((existingChildren ?? []).map((child: { id: string; lot_number: number }) => [child.lot_number, child.id]));

    const todo = requested.filter((lot) => !alreadyCreated.has(lot.number));
    const created: Array<{ number: number; id: string; pages: number }> = [];
    if (todo.length > 0) {
      const pdfResponse = await fetch(parent.document_url);
      if (!pdfResponse.ok) return NextResponse.json({ error: "Le document PDF est inaccessible." }, { status: 502 });
      const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());

      for (const lot of todo) {
        const detected = lotsByNumber.get(lot.number)!;
        const sourcePages = pagesForLot(detection, lot.number, { dropCcag: body?.dropCcag !== false });
        const mini = await buildMiniPdf(pdfBytes, sourcePages);
        const fileName = `${Date.now()}-lot-${lot.number}-${String(parent.reference || parent.id).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40)}.pdf`;
        const { error: uploadError } = await supabase.storage.from("tender-documents").upload(fileName, mini, { contentType: "application/pdf", cacheControl: "3600", upsert: false });
        if (uploadError) return NextResponse.json({ error: `Envoi du PDF du lot ${lot.number} impossible : ${uploadError.message}` }, { status: 500 });
        const publicUrl = supabase.storage.from("tender-documents").getPublicUrl(fileName).data.publicUrl;

        const place = shortPlace(detected.label);
        const { data: child, error: insertError } = await supabase
          .from("tenders")
          .insert({
            organization_id: member.organization_id,
            title: `${parent.title} – Lot ${lot.number}${place ? ` – ${place}` : ""}`,
            reference: `${parent.reference ?? ""} – Lot ${lot.number}`.trim(),
            client_name: parent.client_name,
            description: detected.label ? `Lot ${lot.number} : ${detected.label}` : `Lot ${lot.number}`,
            deadline: parent.deadline,
            estimated_amount: parent.estimated_amount,
            document_url: publicUrl,
            status: "draft",
            parent_tender_id: parent.id,
            lot_number: lot.number,
            lot_label: detected.label || null,
            source_pages: sourcePages,
            source_document_url: parent.document_url,
          })
          .select("id")
          .single();
        if (insertError || !child) {
          return NextResponse.json({ error: `Création du lot ${lot.number} impossible : ${insertError?.message ?? "erreur inconnue"}` }, { status: 500 });
        }
        created.push({ number: lot.number, id: child.id, pages: sourcePages.length });
        console.log(`Mini-DAO lot ${lot.number} : ${sourcePages.length} pages (${describePageMap(sourcePages)})`);
      }
    }

    await supabase
      .from("tenders")
      .update({ is_multi_lot: true, ...(edited ? { lot_detection: detection } : {}) })
      .eq("id", parent.id)
      .eq("organization_id", member.organization_id);

    return NextResponse.json({
      created,
      alreadyCreated: requested.filter((lot) => alreadyCreated.has(lot.number)).map((lot) => ({ number: lot.number, id: alreadyCreated.get(lot.number)! })),
    });
  } catch (error) {
    console.error("Création des lots impossible", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Création des lots impossible." }, { status: 500 });
  }
}
