import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeSituationDraft } from "@/lib/billing/generate-situation";
import { isDateKey } from "@/lib/billing/claim-periods";

// Calcule un aperçu de facture pour un chantier, sans rien enregistrer :
// c'est ce que le bouton "Générer une facture" affiche avant validation.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const searchParams = new URL(request.url).searchParams;
  const projectId = searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "Chantier manquant." }, { status: 400 });
  const marginParam = searchParams.get("margin");
  const marginOverride = marginParam !== null && marginParam !== "" ? Number(marginParam) : undefined;
  const clientNameOverride = searchParams.get("client_name") || undefined;

  // Période de cette facture (un « trou » non encore facturé, voir /api/billing/claims/gaps).
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");
  const periodStart = isDateKey(startParam) ? startParam.slice(0, 10) : undefined;
  const periodEnd = isDateKey(endParam) ? endParam.slice(0, 10) : undefined;

  const draft = await computeSituationDraft(supabase, { organizationId: member.organization_id, projectId, marginOverride, clientNameOverride, periodStart, periodEnd });
  if ("error" in draft) return NextResponse.json({ error: draft.error }, { status: 400 });
  return NextResponse.json(draft);
}
