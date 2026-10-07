import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { syncProjectTasks } from "@/lib/devis/sync-project-tasks";

// « Enregistrer et mettre à jour le chantier » d'un devis importé (comme le bouton
// « Confirmer et enregistrer » du DAO) : le chantier existe déjà ; on s'assure que
// CHAQUE ligne du devis est reliée à une tâche du planning (sinon la tâche est
// ajoutée à 0 %), pour que la facturation reprenne bien l'avancement de chaque ligne.
// Aucun PDF n'est stocké (pas de stockage Supabase) : les PDF se refont à la demande.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const result = await syncProjectTasks(supabase, auth.organizationId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
