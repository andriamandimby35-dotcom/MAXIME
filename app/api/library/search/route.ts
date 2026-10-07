import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchLibrary } from "@/lib/prices/library-search";

// Recherche manuelle dans la bibliothèque de prix de l'entreprise, depuis un devis du DAO (lecture seule).
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  return NextResponse.json({ results: await searchLibrary(supabase, member.organization_id as string, new URL(request.url).searchParams.get("q") ?? "") });
}
