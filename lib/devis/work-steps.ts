// Étapes d'un travail du planning, lues dans le texte de l'article du devis
// (« il comprend : … », suite d'opérations). Elles servent UNIQUEMENT au planning
// (sous-tâches à cocher) : le texte du devis, lui, reste complet et inchangé.

export type WorkSteps = { title: string; steps: string[] };
export type ChecklistItem = { id: string; label: string; done: boolean };

const norm = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Nettoie la réponse de l'IA : titres et étapes en texte, sans vide ni doublon, 20 étapes au plus par travail. */
export function cleanWorkSteps(raw: unknown): WorkSteps[] {
  if (!Array.isArray(raw)) return [];
  const result: WorkSteps[] = [];
  for (const entry of raw) {
    const item = (entry ?? {}) as { title?: unknown; steps?: unknown };
    const title = String(item.title ?? "").trim();
    if (!title || !Array.isArray(item.steps)) continue;
    const seen = new Set<string>();
    const steps: string[] = [];
    for (const step of item.steps) {
      const label = String(step ?? "").replace(/^[\s\-–—•*·\d.)]+/, "").replace(/\s+/g, " ").trim();
      const key = norm(label);
      if (!label || !key || seen.has(key)) continue;
      seen.add(key);
      steps.push(label);
      if (steps.length >= 20) break;
    }
    if (steps.length > 0) result.push({ title, steps });
  }
  return result;
}

/** Sous-tâches (checklist du planning) du travail portant ce titre ; null s'il n'a pas d'étapes. */
export function checklistForTitle(workSteps: WorkSteps[] | undefined, title: string): ChecklistItem[] | null {
  const key = norm(title);
  if (!key || !workSteps?.length) return null;
  const found = workSteps.find((item) => norm(item.title) === key);
  if (!found || found.steps.length === 0) return null;
  return found.steps.map((label) => ({ id: crypto.randomUUID(), label, done: false }));
}
