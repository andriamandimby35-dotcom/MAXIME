import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { resolveItemTasks, type PlanningTask } from "@/lib/billing/task-matching";

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

  // Colonne « task_id » (lien ligne → tâche) ajoutée par un fichier SQL : si elle manque encore,
  // on continue sans elle (la facturation rapproche alors les lignes par leur texte).
  let hasTaskLink = true;
  const items: Array<{ id: string; designation: string | null; category: string | null; subcategory: string | null; task_id: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    let page = await supabase.from("project_price_items").select("id,designation,category,subcategory,task_id")
      .eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true }).range(from, from + 999);
    if (page.error && /task_id/.test(page.error.message)) {
      hasTaskLink = false;
      page = await supabase.from("project_price_items").select("id,designation,category,subcategory")
        .eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true }).range(from, from + 999) as unknown as typeof page;
    }
    if (page.error) return NextResponse.json({ error: page.error.message }, { status: 400 });
    items.push(...((page.data ?? []) as unknown as typeof items).map((item) => ({ ...item, task_id: item.task_id ?? null })));
    if (!page.data || page.data.length < 1000) break;
  }
  const { data: tasksData } = await supabase.from("project_tasks").select("id,title,progress_percent,dao_sequence").eq("project_id", id);
  const tasks = (tasksData ?? []) as unknown as Array<PlanningTask & { dao_sequence?: number | null }>;
  const taskIds = new Set(tasks.map((task) => String(task.id)));

  const unlinked = hasTaskLink ? items.filter((item) => !item.task_id || !taskIds.has(String(item.task_id))) : items;
  const matches = resolveItemTasks(unlinked.map((item) => ({ designation: String(item.designation ?? ""), subcategory: item.subcategory, category: item.category })), tasks);
  const taskFor: Array<string | null> = matches.map((match) => match?.id ?? null);

  let createdTasks = 0;
  const missing = taskFor.map((taskId, index) => (taskId ? -1 : index)).filter((index) => index >= 0);
  if (missing.length > 0) {
    let sequence = tasks.reduce((max, task) => Math.max(max, Number(task.dao_sequence) || 0), 0);
    const { data: created, error } = await supabase.from("project_tasks")
      .insert(missing.map((index) => ({ organization_id: auth.organizationId, project_id: id, title: String(unlinked[index].designation ?? "").trim() || "Travaux", dao_sequence: ++sequence, is_dao_task: false })))
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    (created ?? []).forEach((task, position) => { taskFor[missing[position]] = String(task.id); });
    createdTasks = created?.length ?? 0;
  }

  // Une mise à jour par tâche (et non par ligne) : peu de requêtes.
  const byTask = new Map<string, string[]>();
  unlinked.forEach((item, index) => {
    const taskId = taskFor[index];
    if (!taskId) return;
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), item.id]);
  });
  let linked = 0;
  for (const [taskId, ids] of hasTaskLink ? byTask : new Map<string, string[]>()) {
    const { error } = await supabase.from("project_price_items").update({ task_id: taskId }).in("id", ids).eq("project_id", id);
    if (error) {
      if (/task_id/.test(error.message)) break; // colonne absente : rien à relier
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    linked += ids.length;
  }

  return NextResponse.json({ ok: true, total: items.length, linked, createdTasks, alreadyLinked: hasTaskLink ? items.length - unlinked.length : 0, taskLinkMissing: !hasTaskLink });
}
