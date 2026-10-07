import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { searchLibrary } from "@/lib/prices/library-search";

// Recherche manuelle dans la bibliothèque, depuis un devis importé (lecture seule). GET ?q=mots à chercher.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  return NextResponse.json({ results: await searchLibrary(supabase, auth.organizationId, new URL(request.url).searchParams.get("q") ?? "") });
}
