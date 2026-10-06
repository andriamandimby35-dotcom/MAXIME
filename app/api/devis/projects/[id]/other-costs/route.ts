import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";

// Autres dépenses INTERNES d'un devis importé : les salaires (main-d'œuvre) et le
// transport des matériaux. Les lignes de matériaux du devis ne contiennent ni l'un
// ni l'autre ; ils sont ajoutés ici comme deux lignes « interne seulement »
// (is_internal = true) : visibles dans le devis interne et son PDF, jamais dans le
// devis externe, la facture ni le budget par catégorie.
const OTHER_COSTS_CATEGORY = "AUTRES DÉPENSES INTERNES";
const OTHER_COST_LABELS = { labor: "Main-d'œuvre (salaires)", transport: "Transport des matériaux" } as const;

type CostKey = keyof typeof OTHER_COST_LABELS;

async function loadProject(supabase: Awaited<ReturnType<typeof createClient>>, id: string, organizationId: string) {
  const { data } = await supabase.from("projects").select("id").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  return data;
}

async function readCosts(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data } = await supabase
    .from("project_price_items")
    .select("id,designation,unit_price,quantity")
    .eq("project_id", id)
    .eq("is_internal", true)
    .eq("category", OTHER_COSTS_CATEGORY);
  const found: Record<CostKey, { id: string; amount: number } | null> = { labor: null, transport: null };
  for (const row of (data ?? []) as Array<{ id: string; designation: string | null; unit_price: number | string | null; quantity: number | string | null }>) {
    const key = (Object.keys(OTHER_COST_LABELS) as CostKey[]).find((candidate) => OTHER_COST_LABELS[candidate] === row.designation);
    if (key) found[key] = { id: row.id, amount: (Number(row.unit_price) || 0) * (Number(row.quantity) || 1) };
  }
  return found;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  if (!(await loadProject(supabase, id, auth.organizationId))) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  const found = await readCosts(supabase, id);
  return NextResponse.json({ labor: found.labor?.amount ?? null, transport: found.transport?.amount ?? null });
}

// Corps : { labor?: number | null, transport?: number | null } — un montant > 0 crée ou
// met à jour la ligne, vide / 0 la retire. Seuls les champs envoyés sont touchés.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  if (!(await loadProject(supabase, id, auth.organizationId))) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as Partial<Record<CostKey, number | string | null>>;
  const existing = await readCosts(supabase, id);
  const result: Record<CostKey, number | null> = { labor: existing.labor?.amount ?? null, transport: existing.transport?.amount ?? null };

  for (const key of Object.keys(OTHER_COST_LABELS) as CostKey[]) {
    if (!(key in body)) continue;
    const raw = String(body[key] ?? "").replace(/\s/g, "").replace(",", ".");
    const amount = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: "Montant invalide." }, { status: 400 });
    const current = existing[key];
    if (amount > 0) {
      const values = { unit: "Fft", quantity: 1, unit_price: amount, external_unit_price: null, total: amount };
      if (current) {
        const { error } = await supabase.from("project_price_items").update(values).eq("id", current.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      } else {
        const { error } = await supabase.from("project_price_items").insert({
          organization_id: auth.organizationId,
          project_id: id,
          position: key === "labor" ? "A.1" : "A.2",
          designation: OTHER_COST_LABELS[key],
          category: OTHER_COSTS_CATEGORY,
          subcategory: null,
          is_internal: true,
          created_at: new Date(Date.now() + (key === "labor" ? 0 : 1)).toISOString(),
          ...values,
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      }
      result[key] = amount;
    } else if (current) {
      const { error } = await supabase.from("project_price_items").delete().eq("id", current.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      result[key] = null;
    }
  }
  return NextResponse.json({ ok: true, ...result });
}
