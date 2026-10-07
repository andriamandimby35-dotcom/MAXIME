import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { freePrices, type FreePriceItem } from "@/lib/prices/free-prices";

// Calcul gratuit des prix manquants d'un devis du DAO (lecture seule : rien n'est enregistré ici).
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { items?: FreePriceItem[] };
  const items = (body.items ?? []).slice(0, 2000).map((item) => ({ id: String(item.id), designation: String(item.designation ?? ""), unit: String(item.unit ?? ""), quantity: Number(item.quantity) || 1 }));
  return NextResponse.json({ results: await freePrices(supabase, member.organization_id as string, items) });
}
