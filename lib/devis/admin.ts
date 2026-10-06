import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Réservé à l'administrateur : ajouter un devis, remplir ses prix, fixer la marge.
export async function requireDevisAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return { error: NextResponse.json({ error: "Non autorisé." }, { status: 401 }) };
  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member?.organization_id) return { error: NextResponse.json({ error: "Organisation introuvable." }, { status: 403 }) };
  if (member.role !== "admin" && member.role !== "owner") {
    return { error: NextResponse.json({ error: "Seul l'administrateur peut ajouter ou modifier un devis." }, { status: 403 }) };
  }
  return { organizationId: member.organization_id as string };
}
