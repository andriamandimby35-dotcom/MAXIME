import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { extractDevisFromPdf } from "@/lib/projects/extract-devis-pdf";
import { externalPricesFromInternal, externalPricingFromTarget } from "@/lib/devis/pricing";
import { resolveItemTasks, type PlanningTask } from "@/lib/billing/task-matching";

// Ré-analyse d'un devis DÉJÀ importé (le PDF n'est pas gardé : on le choisit à nouveau).
// - POST (multipart « file ») : l'IA relit le PDF et renvoie les lignes pour relecture. RIEN n'est enregistré.
// - PUT  (json) : remplace les lignes du devis par les lignes relues. Le chantier, son planning,
//   ses dépenses, ses salaires/transport et la facturation sont conservés. Les prix internes
//   déjà trouvés sont repris pour les lignes qui ont la même désignation et la même unité.
export const maxDuration = 300;

type Supabase = Awaited<ReturnType<typeof createClient>>;
type InLine = { category?: string; subcategory?: string; designation?: string; unit?: string; quantity?: number; unit_price?: number; ref?: string; description?: string; concerne?: string };
type OldItem = { id: string; designation: string | null; unit: string | null; unit_price: number | string | null; task_id?: string | null };

async function ownProject(supabase: Supabase, id: string, organizationId: string) {
  const { data } = await supabase.from("projects").select("id,expected_margin_percent").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  return data as { id: string; expected_margin_percent?: number | string | null } | null;
}

// Reconnaissance d'une ligne déjà présente : même unité, mêmes dimensions (410x196…), mêmes mots importants.
// Le verbe d'action (réparation, dépose, remplacement…) doit être le même des deux côtés : un prix de
// portail NEUF ne doit jamais être repris pour une « réparation de portail ».
const STOP = new Set(["de", "des", "du", "la", "le", "les", "et", "en", "d", "l", "a", "au", "aux", "pour", "sur", "avec", "un", "une", "fourniture", "fournitures", "pose", "travaux", "y", "compris"]);
const ACTIONS = ["reparation", "remplacement", "depose", "demolition", "curage", "reprise", "remise", "ajustage", "nettoyage", "traitement", "decapage", "rebouchage", "repose", "renovation", "rehabilitation"];
const normText = (value: string | null | undefined) => String(value ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const normUnit = (value: string | null | undefined) => { const unit = normText(value).replace(/\s/g, ""); return /^(fft|ft|ff|forfait|f)$/.test(unit) ? "ft" : unit; };
function signature(designation: string | null | undefined) {
  const words = normText(designation).split(" ").filter(Boolean);
  const actions = new Set(words.filter((word) => ACTIONS.some((action) => word.startsWith(action.slice(0, 6)))));
  const numbers = new Set(words.filter((word) => /\d/.test(word)));
  const content = new Set(words.filter((word) => !STOP.has(word) && !actions.has(word) && !/\d/.test(word)));
  return { actions, numbers, content };
}
const sameSet = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every((word) => right.has(word));
function similarity(newItem: { designation?: string | null; unit?: string | null }, oldItem: OldItem) {
  if (normUnit(newItem.unit) !== normUnit(oldItem.unit)) return 0;
  const a = signature(newItem.designation); const b = signature(oldItem.designation);
  if (!sameSet(a.actions, b.actions) || !sameSet(a.numbers, b.numbers)) return 0;
  const shared = [...a.content].filter((word) => b.content.has(word)).length;
  const union = new Set([...a.content, ...b.content]).size;
  return union === 0 ? 0 : shared / union;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  if (!(await ownProject(supabase, id, auth.organizationId))) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) return NextResponse.json({ error: "Fichier PDF manquant." }, { status: 400 });
  if (file.type && file.type !== "application/pdf") return NextResponse.json({ error: "Le fichier doit être un PDF." }, { status: 400 });

  const result = await extractDevisFromPdf(file);
  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  const data = result.data;
  return NextResponse.json({ lines: data.all_lines, devis_total: data.devis_total, tmp_percent: data.tmp_percent, warnings: data.warnings });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const project = await ownProject(supabase, id, auth.organizationId);
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as { lines?: InLine[]; kind?: string; keep_internal_prices?: boolean; margin_percent?: number | string | null; target_client_total?: number | string | null; tmp_percent?: number | string | null };
  const lines = (body.lines ?? []).filter((line) => String(line.designation ?? "").trim());
  if (lines.length === 0) return NextResponse.json({ error: "Aucune ligne à enregistrer." }, { status: 400 });
  const kind = body.kind === "internal" ? "internal" : "external";
  const keepInternal = body.keep_internal_prices !== false;

  // Anciennes lignes du devis (hors salaires/transport « interne seulement », qui restent).
  let old: OldItem[] = [];
  for (const columns of ["id,designation,unit,unit_price,task_id", "id,designation,unit,unit_price"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).eq("is_internal", false);
    if (!result.error) { old = (result.data ?? []) as unknown as OldItem[]; break; }
  }
  // Chaque ancienne ligne n'est reprise qu'une seule fois : les meilleures ressemblances d'abord.
  const pairs: Array<{ line: number; item: number; score: number }> = [];
  lines.forEach((line, lineIndex) => old.forEach((item, itemIndex) => {
    const score = similarity(line, item);
    if (score >= 0.7) pairs.push({ line: lineIndex, item: itemIndex, score });
  }));
  pairs.sort((x, y) => y.score - x.score);
  const previous: Array<OldItem | null> = lines.map(() => null);
  const usedOld = new Set<number>();
  for (const pair of pairs) {
    if (previous[pair.line] || usedOld.has(pair.item)) continue;
    previous[pair.line] = old[pair.item];
    usedOld.add(pair.item);
  }

  // Marge (devis interne avec prix : les prix externes en sont tirés).
  const quantities = lines.map((line) => (Number(line.quantity) > 0 ? Number(line.quantity) : 1));
  const prices = lines.map((line) => (Number(line.unit_price) > 0 ? Number(line.unit_price) : 0));
  let externalFromInternal: number[] | null = null;
  let appliedMargin: number | null = null;
  if (kind === "internal" && prices.some((price) => price > 0)) {
    const internalItems = lines.map((_, index) => ({ quantity: quantities[index], unit_price: prices[index] }));
    const targetTtc = Number(String(body.target_client_total ?? "").replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(targetTtc) && targetTtc > 0) {
      // Mode « montant total attendu » (comme le devis du DAO) : la marge est calculée.
      const fromTarget = externalPricingFromTarget(internalItems, targetTtc);
      if (!fromTarget) return NextResponse.json({ error: "Le montant total attendu est invalide." }, { status: 400 });
      externalFromInternal = fromTarget.prices;
      appliedMargin = fromTarget.marginPercent;
    } else {
      const raw = String(body.margin_percent ?? project.expected_margin_percent ?? "").replace(/\s/g, "").replace(",", ".");
      const margin = raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(margin) || margin <= -100) return NextResponse.json({ error: "Indique la marge à appliquer (en %) ou le montant total attendu pour fabriquer le devis externe." }, { status: 400 });
      externalFromInternal = externalPricesFromInternal(internalItems, margin);
      appliedMargin = margin;
    }
  }

  // Planning : on garde le lien déjà connu, sinon la tâche la plus ressemblante, sinon une nouvelle tâche.
  const { data: tasksData } = await supabase.from("project_tasks").select("id,title,progress_percent,dao_sequence").eq("project_id", id);
  const tasks = (tasksData ?? []) as unknown as Array<PlanningTask & { dao_sequence?: number | null }>;
  const taskIds = new Set(tasks.map((task) => String(task.id)));
  const matches = resolveItemTasks(lines.map((line, index) => ({
    designation: String(line.designation), subcategory: line.subcategory, category: line.category,
    task_id: previous[index]?.task_id && taskIds.has(String(previous[index]?.task_id)) ? String(previous[index]?.task_id) : undefined,
  })), tasks);
  const taskIdByLine: Array<string | null> = matches.map((match) => match?.id ?? null);
  const missing = taskIdByLine.map((taskId, index) => (taskId ? -1 : index)).filter((index) => index >= 0);
  let addedTasks = 0;
  if (missing.length > 0) {
    let sequence = tasks.reduce((max, task) => Math.max(max, Number(task.dao_sequence) || 0), 0);
    const { data: extra } = await supabase.from("project_tasks")
      .insert(missing.map((index) => ({ organization_id: auth.organizationId, project_id: id, title: String(lines[index].designation).trim(), dao_sequence: ++sequence, is_dao_task: false })))
      .select("id");
    (extra ?? []).forEach((task, position) => { taskIdByLine[missing[position]] = String(task.id); });
    addedTasks = extra?.length ?? 0;
  }

  const baseTime = Date.now();
  let keptPrices = 0;
  const rows = lines.map((line, index) => {
    const fromPdfInternal = kind === "internal" && prices[index] > 0 ? prices[index] : null;
    const oldInternal = keepInternal ? Number(previous[index]?.unit_price) : 0;
    const internal = fromPdfInternal ?? (oldInternal > 0 ? oldInternal : null);
    if (fromPdfInternal === null && internal !== null) keptPrices += 1;
    const external = kind === "external"
      ? (prices[index] > 0 ? prices[index] : null)
      : (externalFromInternal && externalFromInternal[index] > 0 ? externalFromInternal[index] : null);
    return {
      organization_id: auth.organizationId,
      project_id: id,
      position: String(index + 1),
      designation: String(line.designation).trim(),
      unit: String(line.unit ?? "").trim() || null,
      quantity: quantities[index],
      unit_price: internal,
      external_unit_price: external,
      total: Math.round(quantities[index] * (external ?? internal ?? 0) * 100) / 100 || null,
      is_internal: false,
      created_at: new Date(baseTime + index).toISOString(),
      category: String(line.category ?? "").trim() || null,
      subcategory: String(line.subcategory ?? "").trim() || null,
      task_id: taskIdByLine[index],
      ref: String(line.ref ?? "").trim() || null,
      description: String(line.description ?? "").trim() || null,
      concerne: String(line.concerne ?? "").trim() || null,
    };
  });
  let { error } = await supabase.from("project_price_items").insert(rows);
  if (error && /\b(ref|description|concerne)\b/.test(error.message)) ({ error } = await supabase.from("project_price_items").insert(rows.map(({ ref: _r, description: _d, concerne: _n, ...rest }) => rest)));
  if (error && /task_id/.test(error.message)) ({ error } = await supabase.from("project_price_items").insert(rows.map(({ task_id: _t, ref: _r, description: _d, concerne: _n, ...rest }) => rest)));
  if (error && /category|subcategory/.test(error.message)) ({ error } = await supabase.from("project_price_items").insert(rows.map(({ task_id: _t, category: _c, subcategory: _s, ref: _r, description: _d, concerne: _n, ...rest }) => rest)));
  if (error) return NextResponse.json({ error: `Les anciennes lignes sont gardées (rien n'a été remplacé) : ${error.message}` }, { status: 400 });

  // Les anciennes lignes ne sont retirées qu'une fois les nouvelles bien enregistrées.
  const oldIds = old.map((item) => item.id);
  if (oldIds.length > 0) await supabase.from("project_price_items").delete().in("id", oldIds);

  let warning: string | undefined;
  if (kind === "internal" && externalFromInternal && appliedMargin !== null) {
    await supabase.from("projects").update({ expected_margin_percent: appliedMargin }).eq("id", id);
  }
  const tmpRaw = Number(String(body.tmp_percent ?? "").replace(",", "."));
  if (Number.isFinite(tmpRaw) && tmpRaw > 0 && tmpRaw < 100) {
    const { error: tmpError } = await supabase.from("projects").update({ tmp_percent: tmpRaw }).eq("id", id);
    if (tmpError) warning = "Le taux TMP n'a pas pu être retenu (fichier SQL « 20261013_devis_texte_complet.sql » pas encore exécuté).";
  }

  const oldPriced = old.filter((item) => Number(item.unit_price) > 0).length;
  return NextResponse.json({ ok: true, count: rows.length, addedTasks, keptPrices, oldPriced, removed: oldIds.length, warning });
}
