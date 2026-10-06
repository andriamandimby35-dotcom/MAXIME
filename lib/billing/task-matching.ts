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
