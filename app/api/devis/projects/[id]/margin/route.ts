import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { externalPricesFromInternal, externalPricingFromTarget, summarizeDevis } from "@/lib/devis/pricing";

// Marge d'un devis importé.
// - Les prix externes existent déjà (devis externe) : la marge est CALCULÉE
//   (externe ÷ interne − 1) et retenue sur le chantier. Rien d'autre ne change.
// - Les prix externes n'existent pas (devis interne) : on donne la marge
//   ({ margin_percent }) et les prix externes sont fabriqués (arrondis comme
//   les devis du DAO), puis la marge est retenue sur le chantier.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const { data: project } = await supabase.from("projects").select("id,expected_margin_percent").eq("id", id).eq("organization_id", auth.organizationId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const body = await request.json().catch(() => ({})) as { margin_percent?: number | string | null; target_client_total?: number | string | null };
  const { data: itemsData, error: itemsError } = await supabase
    .from("project_price_items")
    .select("id,designation,quantity,unit_price,external_unit_price,is_internal")
    .eq("project_id", id)
    .eq("is_internal", false)
    .order("created_at", { ascending: true });
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 400 });
  const items = (itemsData ?? []) as Array<{ id: string; designation?: string | null; quantity: number | null; unit_price: number | null; external_unit_price: number | null; is_internal: boolean | null }>;
  const before = summarizeDevis(items);

  let marginPercent: number | null = null;
  if (before.externalTotal > 0) {
    // Des prix externes existent déjà : la marge est calculée à partir d'eux.
    marginPercent = before.marginPercent;
    // Devis interne dont une partie des lignes vient d'être chiffrée : ces
    // lignes reçoivent leur prix externe avec la marge déjà retenue.
    const known = Number((project as { expected_margin_percent?: number | string | null }).expected_margin_percent);
    const toPrice = items.filter((item) => Number(item.unit_price) > 0 && !(Number(item.external_unit_price) > 0));
    if (toPrice.length > 0 && Number.isFinite(known) && (project as { expected_margin_percent?: unknown }).expected_margin_percent !== null) {
      const externals = externalPricesFromInternal(toPrice, known);
      for (let index = 0; index < toPrice.length; index += 1) {
        const quantity = Number(toPrice[index].quantity) || 1;
        await supabase.from("project_price_items").update({ external_unit_price: externals[index], total: Math.round(quantity * externals[index] * 100) / 100 }).eq("id", toPrice[index].id);
      }
      marginPercent = known;
    }
  } else if (Number(String(body.target_client_total ?? "").replace(/\s/g, "").replace(",", ".")) > 0) {
    // Mode « montant total attendu » (comme le devis du DAO) : total TTC donné, marge calculée, prix externes ajustés.
    const candidates = items.filter((item) => Number(item.unit_price) > 0);
    if (candidates.length === 0) return NextResponse.json({ error: "Remplis d'abord les prix internes du devis." }, { status: 400 });
    const result = externalPricingFromTarget(candidates, Number(String(body.target_client_total).replace(/\s/g, "").replace(",", ".")));
    if (!result) return NextResponse.json({ error: "Le montant total attendu est invalide." }, { status: 400 });
    for (let index = 0; index < candidates.length; index += 1) {
      const quantity = Number(candidates[index].quantity) || 1;
      const { error } = await supabase
        .from("project_price_items")
        .update({ external_unit_price: result.prices[index], total: Math.round(quantity * result.prices[index] * 100) / 100 })
        .eq("id", candidates[index].id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
    marginPercent = result.marginPercent;
  } else {
    const raw = String(body.margin_percent ?? "").replace(/\s/g, "").replace(",", ".");
    const parsed = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= -100) return NextResponse.json({ error: "Indique la marge à appliquer (en %)." }, { status: 400 });
    const candidates = items.filter((item) => Number(item.unit_price) > 0);
    if (candidates.length === 0) return NextResponse.json({ error: "Remplis d'abord les prix internes du devis." }, { status: 400 });
    const externals = externalPricesFromInternal(candidates, parsed);
    for (let index = 0; index < candidates.length; index += 1) {
      const quantity = Number(candidates[index].quantity) || 1;
      const { error } = await supabase
        .from("project_price_items")
        .update({ external_unit_price: externals[index], total: Math.round(quantity * externals[index] * 100) / 100 })
        .eq("id", candidates[index].id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
    marginPercent = parsed;
  }

  let warning: string | undefined;
  if (marginPercent !== null) {
    const { error } = await supabase.from("projects").update({ expected_margin_percent: marginPercent }).eq("id", id);
    if (error) warning = "La marge n'a pas pu être retenue (fichier SQL « 20261006_project_pricing.sql » pas encore exécuté).";
  }
  return NextResponse.json({ ok: true, marginPercent, missingInternal: before.missingInternal, warning });
}
