// Rapprochement entre une ligne du devis chiffré et une tâche du planning.
// Les deux listes viennent du même devis mais n'ont pas d'identifiant commun :
// on les relie par ressemblance de texte (sans accents, sans majuscules, sans
// petits mots, pluriels et fins de mots ignorés). Le lien trouvé peut ensuite
// être enregistré sur la ligne (project_price_items.task_id) et corrigé à la
// main depuis l'écran de facture.

export type PlanningTask = { id: string; title: string; progress_percent: number | string | null };
export type TaskMatch = { id: string; title: string; progress: number; score: number };

const STOP_WORDS = new Set(["de", "du", "des", "la", "le", "les", "et", "en", "d", "l", "a", "au", "aux", "pour", "sur", "avec", "un", "une", "par", "dans", "ou"]);

function stem(word: string) {
  let w = word;
  if (w.length > 4 && /[sx]$/.test(w)) w = w.slice(0, -1);
  return w.length > 6 ? w.slice(0, 6) : w;
}

export function titleTokens(value: string): string[] {
  const text = String(value ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe")
    .replace(/[^a-z0-9]+/g, " ");
  return text.split(" ").filter((word) => word && !STOP_WORDS.has(word)).map(stem);
}

function score(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = new Set(a.filter((token) => setB.has(token))).size;
  if (shared === 0) return 0;
  const setA = new Set(a);
  const smaller = Math.min(setA.size, setB.size);
  const union = new Set([...setA, ...setB]).size;
  // Contenance (un titre court inclus dans un long) + part commune globale.
  return 0.75 * (shared / smaller) + 0.25 * (shared / union);
}

const THRESHOLD = 0.55;

export function bestTaskFor(text: string, tasks: PlanningTask[]): TaskMatch | null {
  const tokens = titleTokens(text);
  if (tokens.length === 0) return null;
  let best: TaskMatch | null = null;
  for (const task of tasks) {
    const s = score(tokens, titleTokens(task.title));
    if (s >= THRESHOLD && (!best || s > best.score)) {
      best = { id: task.id, title: task.title, progress: Math.max(0, Math.min(100, Number(task.progress_percent) || 0)), score: s };
    }
  }
  return best;
}

/** Ligne du devis → tâche : par son titre, puis par sa sous-catégorie, puis sa catégorie. */
export function matchTaskForItem(item: { designation: string; subcategory?: string | null; category?: string | null }, tasks: PlanningTask[]): TaskMatch | null {
  return bestTaskFor(item.designation, tasks)
    ?? (item.subcategory ? bestTaskFor(String(item.subcategory), tasks) : null)
    ?? (item.category ? bestTaskFor(String(item.category), tasks) : null);
}

type ItemForLink = { designation: string; subcategory?: string | null; category?: string | null; task_id?: string | null };

/**
 * Relie TOUTES les lignes d'un devis à une tâche du planning, dans cet ordre :
 * 1. le lien déjà enregistré sur la ligne ;
 * 2. la ressemblance du texte (titre, sous-catégorie, catégorie) ;
 * 3. sinon la tâche des autres lignes de la MÊME sous-catégorie (puis de la
 *    même catégorie) : une ligne sans tâche à elle suit celle de ses voisines.
 * Retourne, pour chaque ligne (même ordre), la tâche trouvée ou null.
 */
export function resolveItemTasks(items: ItemForLink[], tasks: PlanningTask[]): Array<TaskMatch | null> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const asMatch = (task: PlanningTask, score: number): TaskMatch => ({ id: task.id, title: task.title, progress: Math.max(0, Math.min(100, Number(task.progress_percent) || 0)), score });
  const result: Array<TaskMatch | null> = items.map((item) => {
    const stored = item.task_id ? byId.get(item.task_id) : undefined;
    if (stored) return asMatch(stored, 1);
    return matchTaskForItem(item, tasks);
  });
  const key = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
  const dominant = (indexes: number[]): TaskMatch | null => {
    const counts = new Map<string, { count: number; match: TaskMatch }>();
    for (const i of indexes) {
      const match = result[i];
      if (!match) continue;
      const entry = counts.get(match.id) ?? { count: 0, match };
      entry.count += 1;
      counts.set(match.id, entry);
    }
    const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
    if (ranked.length === 0) return null;
    // Une seule tâche chez les voisines, ou une tâche nettement plus partagée
    // que les autres ; sinon on ne devine pas.
    if (ranked.length === 1 || ranked[0].count > ranked[1].count) return { ...ranked[0].match, score: 0.5 };
    return null;
  };
  const resolved = [...result];
  items.forEach((item, index) => {
    if (resolved[index]) return;
    const sub = key(item.subcategory);
    const cat = key(item.category);
    if (sub) {
      const same = items.map((other, i) => (i !== index && key(other.subcategory) === sub && key(other.category) === cat ? i : -1)).filter((i) => i >= 0);
      const found = dominant(same);
      if (found) { resolved[index] = found; return; }
    }
    if (cat) {
      const same = items.map((other, i) => (i !== index && key(other.category) === cat ? i : -1)).filter((i) => i >= 0);
      const found = dominant(same);
      if (found) resolved[index] = found;
    }
  });
  return resolved;
}
