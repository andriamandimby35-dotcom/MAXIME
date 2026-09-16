import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { canonicalMaterialKey, canonicalUnit } from "@/lib/material-normalization";

function materialKey(value: string) {
  return canonicalMaterialKey(value);
}

export async function POST(req: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
    const { data: member } = await supabase.from("organization_members").select("organization_id,organizations(name)").eq("user_id", user.id).maybeSingle();
    if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });
    const body = await req.json();
    const designation = String(body.designation || "").trim();
    const categorie = String(body.categorie || "Matériaux BTP").trim();
    const unite = canonicalUnit(String(body.unite || "").trim());
    const prix = Number(body.prix);
    const fournisseur = String(body.fournisseur || "").trim();
    const lieu = String(body.lieu || "").trim();
    const isIa = String(body.source || "") === "IA";
    if (!designation || !unite || !Number.isFinite(prix) || prix < 0) return NextResponse.json({ error: "Désignation, unité et prix valides obligatoires." }, { status: 400 });

    // Matériau vendu par pièce/barre entière (ex: bois carré en barres de 4 m)
    // plutôt qu'à la mesure du DAO : ces trois champs sont facultatifs et
    // n'existent que pour ce cas-là.
    const uniteAchat = String(body.unite_achat || "").trim();
    const quantiteParUniteAchat = Number(body.quantite_par_unite_achat);
    const prixUniteAchat = Number(body.prix_unite_achat);
    const hasPurchaseUnit = uniteAchat && Number.isFinite(quantiteParUniteAchat) && quantiteParUniteAchat > 0
      && Number.isFinite(prixUniteAchat) && prixUniteAchat > 0;

    const organizationName = (member.organizations as unknown as { name?: string } | null)?.name || "Entreprise non nommée";
    let current: { id: string; prix_actuel: number | null } | null = null;
    if (body.id) {
      const { data } = await supabase.from("price_library")
        .select("id,prix_actuel").eq("id", body.id).eq("organization_id", member.organization_id).maybeSingle();
      current = data;
    } else {
      const { data } = await supabase.from("price_library")
        .select("id,prix_actuel,designation,unite").eq("organization_id", member.organization_id);
      const matchingPrice = data?.find((price) => materialKey(String(price.designation ?? "")) === materialKey(designation)
        && canonicalUnit(String(price.unite ?? "")) === unite) ?? null;
      current = matchingPrice ? { id: matchingPrice.id, prix_actuel: matchingPrice.prix_actuel } : null;
    }
    const payload = {
      designation, categorie, unite, prix_actuel: prix, prix_entreprise: prix, prix_retenu: prix,
      prix_source: `Saisie manuelle — ${organizationName}`, statut_prix: isIa ? "ia" : "manuel",
      origine_prix: isIa ? "saisie_manuelle_ia" : "saisie_manuelle", fournisseur: fournisseur || null, ville: lieu || null,
      updated_at: new Date().toISOString(),
      unite_achat: hasPurchaseUnit ? uniteAchat : null,
      quantite_par_unite_achat: hasPurchaseUnit ? quantiteParUniteAchat : null,
      prix_unite_achat: hasPurchaseUnit ? prixUniteAchat : null,
    };
    const { data: saved, error } = current?.id
      ? await supabase.from("price_library").update(payload).eq("id", current.id).eq("organization_id", member.organization_id).select("id").single()
      : await supabase.from("price_library").insert({ ...payload, organization_id: member.organization_id }).select("id").single();
    if (error || !saved) return NextResponse.json({ error: error?.message || "Prix non enregistré." }, { status: 500 });

    await supabase.from("price_history").insert({ price_id: saved.id, organization_id: member.organization_id, ancien_prix: current?.prix_actuel ?? null, nouveau_prix: prix, type_variation: current ? "modification_manuelle" : "nouveau", event_type: "manual_price", source_type: "manual_enterprise", created_by: user.id, observed_at: new Date().toISOString() });
    const sourceLabel = `Saisie manuelle — ${organizationName}`;
    const now = new Date().toISOString();
    const key = materialKey(designation);
    const { data: existingSharedRows } = await supabase.from("shared_material_prices")
      .select("id,prix_unitaire,unite").eq("designation_key", key);
    const existingShared = existingSharedRows?.find((price) => canonicalUnit(String(price.unite ?? "")) === unite) ?? null;
    const common = { designation_key: key, designation, categorie, unite, prix_unitaire: prix, currency: "MGA", provenance_label: sourceLabel, contributor_organization_id: member.organization_id, contributor_organization_name: organizationName, last_checked_at: now, updated_at: now };
    const { data: sharedMaterial, error: sharedError } = existingShared?.id
      ? await supabase.from("shared_material_prices").update(Number(existingShared.prix_unitaire) > prix ? common : { last_checked_at: now, updated_at: now }).eq("id", existingShared.id).select("id").single()
      : await supabase.from("shared_material_prices").insert({ ...common, created_by: user.id }).select("id").single();
    if (sharedMaterial?.id) await supabase.from("shared_material_price_observations").insert({ material_id: sharedMaterial.id, prix_unitaire: prix, provenance_type: "saisie_manuelle_entreprise", provenance_label: sourceLabel, contributor_organization_id: member.organization_id, contributor_organization_name: organizationName, observed_at: now, created_by: user.id });
    if (sharedError) console.warn("Shared manual price not published", sharedError.message);
    return NextResponse.json({ success: true, id: saved.id, shared: Boolean(sharedMaterial?.id), provenance: sourceLabel });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur interne." }, { status: 500 });
  }
}
