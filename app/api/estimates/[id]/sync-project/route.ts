import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOrSyncProjectFromEstimate } from "@/lib/projects/create-project-from-estimate";
import { syncProjectTasks } from "@/lib/devis/sync-project-tasks";

// Après un ajout, une modification ou une suppression de ligne d'un devis DAO : si le chantier de ce devis existe
// déjà, ses lignes (bordereau de prix), son planning et — côté écran — sa facture non payée sont remis à jour.
// Si le devis n'a pas encore de chantier, rien n'est créé (le chantier se crée au PDF externe, comme avant).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const { data: member } = await supabase.from("organization_members").select("organization_id,role").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
  if (member.role !== "admin" && member.role !== "owner") return NextResponse.json({ synced: false });
  const organizationId = member.organization_id as string;

  const { data: project } = await supabase.from("projects").select("id").eq("organization_id", organizationId).eq("source_estimate_id", estimateId).maybeSingle();
  if (!project) return NextResponse.json({ synced: false });

  const result = await createOrSyncProjectFromEstimate(supabase, { organizationId, estimateId });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  const tasks = await syncProjectTasks(supabase, organizationId, result.projectId);
  return NextResponse.json({ synced: true, projectId: result.projectId, createdTasks: tasks.ok ? tasks.createdTasks : 0 });
}
