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
export function checklistForTitle(workSteps: WorkSteps[] | undefined, title: string, occurrence = 0): ChecklistItem[] | null {
  const key = norm(title);
  if (!key || !workSteps?.length) return null;
  // Plusieurs travaux de même titre (ex. 4 « Peinture à l'eau extérieure ») : le n-ième travail prend la n-ième liste d'étapes.
  const matches = workSteps.filter((item) => norm(item.title) === key);
  const found = matches[occurrence] ?? matches[0];
  if (!found || found.steps.length === 0) return null;
  return found.steps.map((label) => ({ id: crypto.randomUUID(), label, done: false }));
}


const COLORS = ["blanche", "blanc", "orange", "marron", "fushia", "fuchsia", "rose", "rouge", "bleue", "bleu", "verte", "vert", "jaune", "noire", "noir", "grise", "gris", "beige", "violette", "violet", "crème", "creme", "ocre", "saumon", "turquoise", "ivoire", "sable", "bordeaux", "marine"];

/** Couleur écrite dans la ligne « Concerne : … » (ex. « "couleur blanche existant" mur… » → « blanche »), sinon début du texte. */
export function colourFromConcerne(concerne: string | null | undefined): string {
  const text = String(concerne ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lowered = norm(text).split(" ");
  const colour = COLORS.find((name) => lowered.includes(norm(name)));
  if (colour) return `couleur ${colour}`;
  return text.length > 40 ? `${text.slice(0, 40).trim()}…` : text;
}

export type PlanningTitle = { title: string; base: string; occurrence: number; lineIndex: number | null };

/**
 * Titres du planning. Quand plusieurs travaux ont EXACTEMENT le même titre (ex. quatre
 * « Peinture à l'eau extérieure »), on ajoute après le titre la couleur / le « Concerne » de la ligne
 * correspondante du devis pour les distinguer. Les titres uniques ne changent pas. Le texte du devis
 * n'est jamais touché. lineIndex = ligne du devis liée à ce travail (n-ième ligne de même titre).
 */
export function disambiguateTitles(titles: string[], lines: Array<{ designation?: string | null; concerne?: string | null }>): PlanningTitle[] {
  const counts = new Map<string, number>();
  titles.forEach((title) => counts.set(norm(title), (counts.get(norm(title)) ?? 0) + 1));
  const lineIndexesByKey = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = norm(String(line.designation ?? ""));
    if (!key) return;
    lineIndexesByKey.set(key, [...(lineIndexesByKey.get(key) ?? []), index]);
  });
  const seen = new Map<string, number>();
  const result: PlanningTitle[] = titles.map((title) => {
    const key = norm(title);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const lineIndex = (lineIndexesByKey.get(key) ?? [])[occurrence] ?? null;
    return { title, base: title, occurrence, lineIndex };
  });
  // Seuls les doublons reçoivent un suffixe (couleur / Concerne), puis un numéro si ça ne suffit pas.
  const used = new Map<string, number>();
  result.forEach((entry) => {
    if ((counts.get(norm(entry.base)) ?? 0) < 2) return;
    const colour = entry.lineIndex !== null ? colourFromConcerne(lines[entry.lineIndex]?.concerne) : "";
    entry.title = colour ? `${entry.base} – ${colour}` : `${entry.base} (${entry.occurrence + 1})`;
  });
  result.forEach((entry) => {
    const key = norm(entry.title);
    const times = (used.get(key) ?? 0) + 1;
    used.set(key, times);
    if (times > 1) entry.title = `${entry.title} (${times})`;
  });
  return result;
}
