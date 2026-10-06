import type { SupabaseClient } from "@supabase/supabase-js";

// Avancement des tâches du planning À UNE DATE DONNÉE.
// Deux sources enregistrées depuis la mise en place de ce suivi :
//  - l'historique de chaque changement d'avancement (project_task_progress_history) ;
//  - les tâches travaillées dans chaque rapport journalier, avec la date du
//    rapport (project_report_task_progress), plus fiable pour un rapport
//    envoyé en retard après une coupure réseau.
// Aujourd'hui (ou plus tard) = l'avancement actuel de la tâche.

export type ProgressEvent = { date: string; progress: number };
export type ProgressEvents = Map<string, ProgressEvent[]>;

async function fetchPages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) return [];
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

export async function loadProgressEvents(supabase: SupabaseClient, projectId: string): Promise<ProgressEvents> {
  const [history, reports] = await Promise.all([
    fetchPages<{ task_id: string; changed_on: string; progress_after: number | string }>((from, to) =>
      supabase.from("project_task_progress_history").select("task_id,changed_on,progress_after").eq("project_id", projectId).order("created_at", { ascending: true }).range(from, to)),
    fetchPages<{ task_id: string; report_date: string; progress_after: number | string }>((from, to) =>
      supabase.from("project_report_task_progress").select("task_id,report_date,progress_after").eq("project_id", projectId).order("created_at", { ascending: true }).range(from, to)),
  ]);
  const events: ProgressEvents = new Map();
  const push = (taskId: string, date: string, progress: number) => {
    const list = events.get(taskId) ?? [];
    list.push({ date: String(date).slice(0, 10), progress: Math.max(0, Math.min(100, Number(progress) || 0)) });
    events.set(taskId, list);
  };
  // Rapports d'abord, puis changements : à date égale, le dernier état enregistré l'emporte.
  for (const row of reports) push(row.task_id, row.report_date, Number(row.progress_after));
  for (const row of history) push(row.task_id, row.changed_on, Number(row.progress_after));
  for (const list of events.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

/** Avancement (0 à 100) d'une tâche à la fin de la journée `date`. */
export function progressAt(events: ProgressEvents, taskId: string, date: string, currentProgress: number, today: string): number {
  if (date >= today) return Math.max(0, Math.min(100, currentProgress));
  const list = events.get(taskId);
  if (!list || list.length === 0) return 0;
  let value = 0;
  for (const event of list) { if (event.date <= date) value = event.progress; else break; }
  return value;
}
