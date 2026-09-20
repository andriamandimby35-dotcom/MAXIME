import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

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

function migrationError(error: { code?: string; message?: string } | null) {
  return error?.code === "42P01" || error?.message?.includes("does not exist");
}

// "Valider la complétion" : remplace l'ancienne génération d'un PDF fusionné.
// L'application ne sert qu'à préparer le dossier physique (rien n'est déposé
// depuis l'appli), donc il n'y a plus rien à fusionner ni à générer ici — on
// note juste, avec une date, que l'utilisateur a vérifié que toutes les
// pièces obligatoires sont prêtes et que le dossier peut être déposé.
// Réversible comme le reste du dossier : revalider avec locked=false retire
// cette marque, exactement comme le bouton rouge/vert de chaque pièce.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const authorized = await getAuthorizedTender(id);
  if (authorized.error) return authorized.error;

  const body = await request.json().catch(() => null) as { estimateId?: unknown; locked?: unknown } | null;
  if (!body || typeof body.locked !== "boolean") {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const estimateId = typeof body.estimateId === "string" ? body.estimateId : null;
  const lockedAt = body.locked ? new Date().toISOString() : null;
  const lockedBy = body.locked ? authorized.user.id : null;

  // Le dossier d'un devis précis vit déjà tout entier dans une seule ligne
  // (estimate_submission_dossiers) : on y ajoute juste ces deux colonnes.
  // Cette ligne doit déjà exister (le dossier a été sauvegardé au moins une
  // fois) — le bouton, côté client, sauvegarde toujours avant d'appeler ici.
  if (estimateId) {
    const result = await authorized.supabase
      .from("estimate_submission_dossiers")
      .update({ locked_at: lockedAt, locked_by: lockedBy })
      .eq("estimate_id", estimateId)
      .eq("organization_id", authorized.organizationId)
      .eq("tender_id", authorized.tenderId);
    if (migrationError(result.error)) return NextResponse.json({ error: "La migration du verrouillage du dossier n’est pas encore appliquée." }, { status: 503 });
    if (result.error) return NextResponse.json({ error: "Enregistrement impossible." }, { status: 500 });
    return NextResponse.json({ ok: true, lockedAt });
  }

  // Le dossier maître du DAO, lui, n'a jamais eu de ligne unique (chaque
  // pièce est sa propre ligne dans tender_submission_items) : une petite
  // table dédiée, une ligne par DAO, porte donc ce verrouillage à part.
  const result = await authorized.supabase
    .from("tender_submission_dossier_locks")
    .upsert(
      { tender_id: authorized.tenderId, organization_id: authorized.organizationId, locked_at: lockedAt, locked_by: lockedBy, updated_at: new Date().toISOString() },
      { onConflict: "tender_id" },
    );
  if (migrationError(result.error)) return NextResponse.json({ error: "La migration du verrouillage du dossier n’est pas encore appliquée." }, { status: 503 });
  if (result.error) return NextResponse.json({ error: "Enregistrement impossible." }, { status: 500 });
  return NextResponse.json({ ok: true, lockedAt });
}
