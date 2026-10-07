import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireDevisAdmin } from "@/lib/devis/admin";
import { lookupLibraryPrices, loadPriceLibrary } from "@/lib/prices/library-lookup";
import {
  cleanParams, estimateMaterialWeights, DEFAULT_INTERNAL_PARAMS, INTERNAL_COSTS_CATEGORY, LABOR_ROLES, LABOR_UNIT,
  TRANSPORT_DESIGNATION, TRANSPORT_POSITION, TRANSPORT_UNIT, type InternalParams,
} from "@/lib/devis/internal-costs";

// Coûts internes d'un devis importé, comme dans le devis du DAO : « Paramètres
// internes du chantier » (localisation, durée, effectifs) → lignes de main-d'œuvre
// (JOUR-PERSONNE) et ligne de transport (T.KM). Ces lignes sont « interne seulement »
// (is_internal = true) : visibles dans le devis interne et son PDF, jamais dans le
// devis externe, la facture ni le budget par catégorie.
const OLD_CATEGORY = "AUTRES DÉPENSES INTERNES"; // première version de cette fonction

type Supabase = Awaited<ReturnType<typeof createClient>>;
type ItemRow = { id: string; designation: string | null; unit: string | null; quantity: number | string | null; unit_price: number | string | null };

async function ownProject(supabase: Supabase, id: string, organizationId: string) {
  for (const columns of ["id,location,internal_params", "id,location"]) {
    const result = await supabase.from("projects").select(columns).eq("id", id).eq("organization_id", organizationId).maybeSingle();
    if (!result.error) return result.data as unknown as { id: string; location: string | null; internal_params?: unknown } | null;
  }
  return null;
}

async function loadItems(supabase: Supabase, id: string) {
  const items: ItemRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("project_price_items").select("id,designation,unit,quantity,unit_price").eq("project_id", id).eq("is_internal", false).order("created_at", { ascending: true }).range(from, from + 999);
    if (error || !data || data.length === 0) break;
    items.push(...(data as ItemRow[]));
    if (data.length < 1000) break;
  }
  return items;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const project = await ownProject(supabase, id, auth.organizationId);
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  const weights = estimateMaterialWeights(await loadItems(supabase, id));
  const estimated = Math.round(weights.reduce((sum, row) => sum + row.tonnes, 0) * 100) / 100;
  const stated = cleanParams(project.internal_params).weightTonnes;
  return NextResponse.json({ location: project.location ?? "", params: cleanParams(project.internal_params), tonnes: stated > 0 ? stated : estimated, estimatedTonnes: estimated, weights });
}

type Body = { location?: string; params?: Partial<InternalParams>; prices?: Record<string, number | string | null> };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireDevisAdmin(supabase);
  if ("error" in auth) return auth.error;
  const project = await ownProject(supabase, id, auth.organizationId);
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });
  const body = await request.json().catch(() => ({})) as Body;
  const warnings: string[] = [];

  // 1. Paramètres du chantier : localisation (partagée avec la recherche de prix) + durée et effectifs.
  const location = body.location !== undefined ? String(body.location).trim() : String(project.location ?? "").trim();
  const nextParams = cleanParams({ ...cleanParams(project.internal_params ?? DEFAULT_INTERNAL_PARAMS), ...(body.params ?? {}) });
  if (body.location !== undefined) {
    const { error } = await supabase.from("projects").update({ location: location || null }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (body.params) {
    const { error } = await supabase.from("projects").update({ internal_params: nextParams }).eq("id", id);
    if (error) warnings.push("Durée et effectifs non retenus pour la prochaine visite (fichier SQL « 20261014_parametres_internes_chantier.sql » pas encore exécuté).");
  }

  // 2. Lignes internes déjà créées (et nettoyage de la première version de cette fonction).
  const { data: existingData } = await supabase.from("project_price_items").select("id,designation,unit,quantity,unit_price,category").eq("project_id", id).eq("is_internal", true);
  const existing = (existingData ?? []) as Array<ItemRow & { category: string | null }>;
  const oldIds = existing.filter((row) => row.category === OLD_CATEGORY).map((row) => row.id);
  if (oldIds.length > 0) await supabase.from("project_price_items").delete().in("id", oldIds);
  const current = new Map(existing.filter((row) => row.category === INTERNAL_COSTS_CATEGORY).map((row) => [String(row.designation ?? ""), row]));

  // 3. Prix : saisi > déjà enregistré sur la ligne > bibliothèque (même libellé, gratuit).
  const typedPrice = (designation: string) => {
    const raw = body.prices?.[designation];
    if (raw === undefined || raw === null || raw === "") return null;
    const value = Number(String(raw).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  // Poids : celui donné par le DAO / le dossier de soumission s'il est indiqué, sinon l'estimation d'après les matériaux du devis.
  const weights = estimateMaterialWeights(await loadItems(supabase, id));
  const estimatedTonnes = Math.round(weights.reduce((sum, row) => sum + row.tonnes, 0) * 100) / 100;
  const tonnes = nextParams.weightTonnes > 0 ? nextParams.weightTonnes : estimatedTonnes;
  const wanted: Array<{ designation: string; unit: string; quantity: number; position: string }> = [];
  for (const role of LABOR_ROLES) {
    const quantity = Math.round(nextParams.days * nextParams[role.key] * 100) / 100;
    if (quantity > 0) wanted.push({ designation: role.designation, unit: LABOR_UNIT, quantity, position: role.position });
  }
  const needs: string[] = [];
  const transportQuantity = Math.round(tonnes * nextParams.distanceKm * 100) / 100;
  if (!location) needs.push("location");
  else if (!(nextParams.distanceKm > 0)) needs.push("distance");
  else if (transportQuantity > 0) wanted.push({ designation: TRANSPORT_DESIGNATION, unit: TRANSPORT_UNIT, quantity: transportQuantity, position: TRANSPORT_POSITION });
  if (!(nextParams.days > 0)) needs.push("days");

  const library = await loadPriceLibrary(supabase, auth.organizationId);
  const hits = await lookupLibraryPrices(supabase, auth.organizationId, wanted.map((line) => ({ id: line.designation, designation: line.designation, unit: line.unit, quantity: line.quantity })), library);
  const libraryPrice = new Map(hits.map((hit) => [hit.id, hit.price]));

  const keep = new Set<string>();
  const baseTime = Date.now();
  for (const [index, line] of wanted.entries()) {
    const price = typedPrice(line.designation) ?? (Number(current.get(line.designation)?.unit_price) > 0 ? Number(current.get(line.designation)?.unit_price) : null) ?? libraryPrice.get(line.designation) ?? null;
    const values = { unit: line.unit, quantity: line.quantity, unit_price: price, external_unit_price: null, total: price ? Math.round(price * line.quantity * 100) / 100 : null };
    const row = current.get(line.designation);
    keep.add(line.designation);
    if (row) {
      const { error } = await supabase.from("project_price_items").update(values).eq("id", row.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    } else {
      const { error } = await supabase.from("project_price_items").insert({
        organization_id: auth.organizationId, project_id: id, position: line.position, designation: line.designation,
        category: INTERNAL_COSTS_CATEGORY, subcategory: null, is_internal: true,
        created_at: new Date(baseTime + index).toISOString(), ...values,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Un prix saisi à la main est gardé dans la bibliothèque : les prochains devis le retrouvent.
    const typed = typedPrice(line.designation);
    if (typed) {
      const found = library.find((entry) => String(entry.designation ?? "").toLowerCase() === line.designation.toLowerCase() && String(entry.unite ?? "").toLowerCase() === line.unit.toLowerCase());
      if (found?.id) await supabase.from("price_library").update({ prix_entreprise: typed, prix_retenu: typed, updated_at: new Date().toISOString() }).eq("id", String(found.id));
      else {
        const { error } = await supabase.from("price_library").insert({
          organization_id: auth.organizationId, designation: line.designation, categorie: "Coûts internes du chantier", unite: line.unit,
          prix_entreprise: typed, prix_retenu: typed, prix_source: "saisie_locale", statut_validation: "valide_manuellement", statut_prix: "manuel", origine_prix: "saisie_locale",
        });
        if (error) warnings.push("Le prix n'a pas pu être gardé dans la bibliothèque.");
      }
    }
  }
  // Lignes qui ne sont plus d'actualité (effectif à 0, localisation retirée…).
  const staleIds = [...current.entries()].filter(([designation]) => !keep.has(designation)).map(([, row]) => row.id);
  if (staleIds.length > 0) await supabase.from("project_price_items").delete().in("id", staleIds);

  return NextResponse.json({ ok: true, tonnes, estimatedTonnes, weights, needs, params: nextParams, location, warning: warnings.join(" ") || undefined });
}
