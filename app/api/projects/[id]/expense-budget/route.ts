import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Budget par catégorie du devis = somme (quantité × prix INTERNE) des lignes du
// devis du chantier. Sert à la carte « Budget » de la page Dépenses.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  let rows: Array<Record<string, unknown>> | null = null;
  for (const columns of ["designation,quantity,unit_price,is_internal,category,subcategory", "designation,quantity,unit_price,is_internal"]) {
    const result = await supabase.from("project_price_items").select(columns).eq("project_id", id).order("created_at", { ascending: true });
    if (!result.error) { rows = result.data as unknown as Array<Record<string, unknown>>; break; }
  }

  type Sub = { name: string; budget: number };
  const categories = new Map<string, { name: string; budget: number; subs: Map<string, Sub> }>();
  let internalOnly = 0;
  let missing = 0;
  let lines = 0;
  for (const row of rows ?? []) {
    const quantity = Number(row.quantity) || 1;
    const price = Number(row.unit_price) || 0;
    if (row.is_internal === true) { internalOnly += quantity * price; continue; }
    lines += 1;
    if (!(price > 0)) { missing += 1; continue; }
    // Même nom de catégorie que le classement des dépenses.
    const category = String(row.category ?? "").trim() || String(row.designation ?? "").trim() || "Travaux";
    const subcategory = String(row.subcategory ?? "").trim();
    const entry = categories.get(category) ?? { name: category, budget: 0, subs: new Map<string, Sub>() };
    entry.budget += quantity * price;
    const sub = entry.subs.get(subcategory) ?? { name: subcategory, budget: 0 };
    sub.budget += quantity * price;
    entry.subs.set(subcategory, sub);
    categories.set(category, entry);
  }
  return NextResponse.json({
    categories: [...categories.values()].map((entry) => ({ name: entry.name, budget: entry.budget, subs: [...entry.subs.values()] })),
    internalOnly,
    missingLines: missing,
    lines,
  }, { headers: { "Cache-Control": "no-store" } });
}
