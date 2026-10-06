import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Changer le statut d'une facture (ex : marquer comme "envoyée" au client).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const allowedStatuses = ["draft", "submitted", "approved", "partially_paid", "paid", "rejected"];
  if (!allowedStatuses.includes(body.status)) return NextResponse.json({ error: "Statut invalide." }, { status: 400 });

  const { error } = await supabase.from("progress_claims").update({ status: body.status, updated_at: new Date().toISOString() }).eq("id", id).eq("organization_id", member.organization_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}

// On ne permet de supprimer qu'une facture « brouillon » ou « émise » : une
// facture approuvée ou déjà payée ne doit plus disparaître comme ça, même par erreur.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: claim } = await supabase.from("progress_claims").select("id,status,project_id").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!claim) return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  if (claim.status !== "draft" && claim.status !== "submitted") return NextResponse.json({ error: "Une facture approuvée ou payée ne peut plus être supprimée." }, { status: 400 });

  const { error } = await supabase.from("progress_claims").delete().eq("id", id).eq("organization_id", member.organization_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // Le PDF conservé de cette facture est supprimé avec elle (libère le stockage).
  await supabase.storage.from("billing-pdfs").remove([`${member.organization_id}/${claim.project_id}/${id}.pdf`]);
  return NextResponse.json({ success: true });
}
