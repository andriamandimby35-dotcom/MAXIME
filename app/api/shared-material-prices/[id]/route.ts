import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

async function currentUser() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { supabase, user } = await currentUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const [{ data: material, error }, { data: observations, error: observationsError }] = await Promise.all([
    supabase.from("shared_material_prices").select("*").eq("id", id).maybeSingle(),
    supabase.from("shared_material_price_observations").select("*").eq("material_id", id).order("observed_at", { ascending: true }),
  ]);
  if (error || !material) return NextResponse.json({ error: "Matériau introuvable." }, { status: 404 });
  if (observationsError) return NextResponse.json({ error: observationsError.message }, { status: 500 });
  return NextResponse.json({ material, observations: observations ?? [] });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { supabase, user } = await currentUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { error } = await supabase.from("shared_material_prices").delete().eq("id", id);
  if (error) return NextResponse.json({ error: "Suppression refusée : seul le créateur du matériau peut le supprimer." }, { status: 403 });
  return NextResponse.json({ ok: true });
}
