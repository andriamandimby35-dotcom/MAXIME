import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { profit_margin_percent, pricing_mode, target_client_total } = await request.json().catch(() => ({})) as { profit_margin_percent?: unknown; pricing_mode?: unknown; target_client_total?: unknown };
  const margin = Number(profit_margin_percent);
  if (!Number.isFinite(margin) || margin < 0 || margin > 1000) return NextResponse.json({ error: "Marge invalide." }, { status: 400 });
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  // Marge OU montant total fixé : jamais les deux à la fois. En mode « montant
  // total fixé », on garde la somme exacte (la marge en % n'en est qu'un
  // résultat arrondi) ; en mode « marge », le montant fixé est effacé.
  const mode = pricing_mode === "target_total" ? "target_total" : "percentage";
  const target = mode === "target_total" ? Math.max(0, Number(target_client_total) || 0) : null;
  let { error } = await supabase.from("estimates").update({ profit_margin_percent: margin, pricing_mode: mode, target_client_total: target }).eq("id", id).eq("organization_id", member.organization_id);
  if (error && /pricing_mode|target_client_total/.test(error.message)) {
    // Fichier SQL pas encore exécuté : on enregistre au moins la marge.
    ({ error } = await supabase.from("estimates").update({ profit_margin_percent: margin }).eq("id", id).eq("organization_id", member.organization_id));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, profit_margin_percent: margin });
}
