import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Relie des lignes du devis (bordereau du chantier) à des tâches du planning,
// pour que leur avancement soit repris sur la facture. Pour chaque ligne :
// - task_id = identifiant d'une tâche existante du chantier, ou
// - task_id = "new" : la tâche est créée dans le planning (au titre de la ligne,
//   à 0 %), pour compléter un planning auquel il manquait ce travail.
// - task_id = "" : on retire le lien (retour au rapprochement par le texte).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as { links?: Array<{ price_item_id?: string; task_id?: string }> };
  const links = (body.links ?? []).filter((link) => link.price_item_id);
  if (links.length === 0) return NextResponse.json({ error: "Aucun lien à enregistrer." }, { status: 400 });

  const [{ data: items }, { data: tasks }] = await Promise.all([
    supabase.from("project_price_items").select("id,designation").eq("project_id", id).eq("is_internal", false),
    supabase.from("project_tasks").select("id,dao_sequence").eq("project_id", id),
  ]);
  const itemById = new Map((items ?? []).map((item) => [String(item.id), item as { id: string; designation: string }]));
  const taskIds = new Set((tasks ?? []).map((task) => String(task.id)));
  let nextSequence = (tasks ?? []).reduce((max, task) => Math.max(max, Number((task as { dao_sequence?: number | null }).dao_sequence) || 0), 0);

  let created = 0;
  for (const link of links) {
    const item = itemById.get(String(link.price_item_id));
    if (!item) continue;
    let taskId: string | null = null;
    if (link.task_id === "new") {
      nextSequence += 1;
      const { data: task, error: taskError } = await supabase
        .from("project_tasks")
        .insert({ organization_id: member.organization_id, project_id: id, title: item.designation, dao_sequence: nextSequence, is_dao_task: false })
        .select("id")
        .single();
      if (taskError || !task) return NextResponse.json({ error: taskError?.message ?? "Création de la tâche impossible." }, { status: 400 });
      taskId = String(task.id);
      created += 1;
    } else if (link.task_id) {
      if (!taskIds.has(String(link.task_id))) return NextResponse.json({ error: "Une des tâches choisies n'appartient pas à ce chantier." }, { status: 400 });
      taskId = String(link.task_id);
    }
    const { error } = await supabase.from("project_price_items").update({ task_id: taskId }).eq("id", item.id).eq("project_id", id);
    if (error) {
      const missing = /task_id/.test(error.message);
      return NextResponse.json({
        error: missing ? "La base de données n'est pas encore à jour : exécute d'abord le fichier SQL « 20261006c_price_item_task_link.sql » dans Supabase." : error.message,
      }, { status: 400 });
    }
  }
  return NextResponse.json({ success: true, created });
}
