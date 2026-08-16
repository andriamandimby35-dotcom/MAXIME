import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expirée." }, { status: 401 });

  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (memberError || !member) {
    return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  }

  const { data: deleted, error } = await supabase
    .from("tenders")
    .delete()
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: `Suppression impossible : ${error.message}` }, { status: 400 });
  if (!deleted) return NextResponse.json({ error: "DAO introuvable ou suppression non autorisée." }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
