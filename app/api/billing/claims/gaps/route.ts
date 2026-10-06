import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadClaimGaps } from "@/lib/billing/claim-gaps";
import { isDateKey } from "@/lib/billing/claim-periods";

// Périodes encore à facturer entre deux dates (ou du début du chantier jusqu'à
// aujourd'hui) : une facture par « trou » non couvert par une facture existante.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const searchParams = new URL(request.url).searchParams;
  const projectId = searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "Chantier manquant." }, { status: 400 });
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");
  const start = isDateKey(startParam) ? startParam.slice(0, 10) : undefined;
  const end = isDateKey(endParam) ? endParam.slice(0, 10) : undefined;
  if (start && end && start > end) return NextResponse.json({ error: "La date de début doit être avant la date de fin." }, { status: 400 });

  const result = await loadClaimGaps(supabase, { organizationId: member.organization_id, projectId, start, end });
  return NextResponse.json({ gaps: result.gaps, rangeStart: result.rangeStart, rangeEnd: result.rangeEnd });
}
