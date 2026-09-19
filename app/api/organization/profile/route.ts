import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Profil entreprise unique par organisation (table déjà utilisée par les
// dossiers de soumission DAO) : cet écran permet de le remplir une fois pour
// toutes, sans passer par un DAO précis. Les mêmes données servent ensuite à
// pré-remplir les devis, les factures et les dossiers de soumission.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data } = await supabase
    .from("organization_submission_profiles")
    .select("profile_data")
    .eq("organization_id", member.organization_id)
    .maybeSingle();

  return NextResponse.json({ profile: data?.profile_data ?? {} });
}

export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const body = await request.json().catch(() => null) as { profile?: Record<string, unknown> } | null;
  if (!body || typeof body.profile !== "object" || !body.profile) {
    return NextResponse.json({ error: "Profil invalide." }, { status: 400 });
  }
  const profile = Object.fromEntries(
    Object.entries(body.profile)
      .filter(([key, value]) => key.length <= 80 && typeof value === "string")
      .map(([key, value]) => [key, String(value).slice(0, 300)]),
  );

  const { error } = await supabase
    .from("organization_submission_profiles")
    .upsert({ organization_id: member.organization_id, profile_data: profile, updated_by: user.id, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
