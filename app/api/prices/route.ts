import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { buildDesignationWithOrigin, canonicalMaterialKey, canonicalUnit, originFromCaracteristiques } from "@/lib/material-normalization";

function materialKey(value: string) {
  return canonicalMaterialKey(value);
}

// Même normalisation que la protection anti-doublon de la base (colonne
// générée "designation_norm" de price_library, voir migration SQL) : on ne
// compare que le nom, sans l'unité, pour ne jamais tenter de créer un
// doublon que la base refuserait de toute façon (erreur 23505). Le
// formulaire (PriceForm) a déjà demandé confirmation à l'utilisateur avant
// d'arriver ici si un matériau du même nom existait.
function designationNormKey(value: string) {
  return canonicalMaterialKey(value).replace(/\s+/g, "");
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
    const region = String(body.region || "").trim();
    const disponibilite = String(body.disponibilite || "").trim();
    const livraison = String(body.livraison || "").trim();
    const caracteristiques = Array.isArray(body.caracteristiques)
      ? body.caracteristiques
          .map((item: unknown) => ({
            label: String((item as { label?: unknown })?.label ?? "").trim(),
            valeur: String((item as { valeur?: unknown })?.valeur ?? "").trim(),
          }))
          .filter((item: { label: string; valeur: string }) => item.label && item.valeur)
      : [];
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
    let current: { id: string; prix_actuel: number | null; fournisseurs: unknown; caracteristiques: unknown } | null = null;
    if (body.id) {
      const { data } = await supabase.from("price_library")
        .select("id,prix_actuel,fournisseurs,caracteristiques").eq("id", body.id).eq("organization_id", member.organization_id).maybeSingle();
      current = data;
    } else {
      const { data } = await supabase.from("price_library")
        .select("id,prix_actuel,designation,fournisseurs,caracteristiques").eq("organization_id", member.organization_id);
      const targetKey = designationNormKey(designation);
      const matchingPrice = data?.find((price) => designationNormKey(String(price.designation ?? "")) === targetKey) ?? null;
      current = matchingPrice;
    }
    const now = new Date().toISOString();

    // Un même matériau peut avoir plusieurs fournisseurs/régions : au lieu
    // d'écraser la ligne existante avec cette seule saisie, on ajoute (ou on
    // met à jour) une offre dans sa liste "fournisseurs", puis on recalcule
    // le prix retenu comme le moins cher de toutes les offres.
    const offerKey = (offer: { fournisseur?: string; ville?: string; region?: string }) =>
      `${materialKey(String(offer.fournisseur ?? ""))}|${materialKey(String(offer.ville || offer.region || ""))}`;
    const newOffer = {
      fournisseur: fournisseur || "",
      ville: lieu || "",
      region: region || "",
      prix,
      disponibilite: disponibilite || "",
      livraison: livraison || "",
      date_prix: now,
    };
    const existingOffers = Array.isArray(current?.fournisseurs) ? (current!.fournisseurs as typeof newOffer[]) : [];
    const matchIndex = existingOffers.findIndex((offer) => offerKey(offer) === offerKey(newOffer));
    const mergedOffers = matchIndex >= 0
      ? existingOffers.map((offer, index) => (index === matchIndex ? newOffer : offer))
      : [...existingOffers, newOffer];
    const cheapestOffer = mergedOffers.reduce((best, offer) => (Number(offer.prix) < Number(best.prix) ? offer : best), mergedOffers[0]);

    // Si le formulaire n'a pas de caractéristiques (cas d'une confirmation de
    // doublon sans ressaisir les détails techniques), on garde celles déjà
    // enregistrées plutôt que de les effacer.
    const mergedCaracteristiques = caracteristiques.length > 0
      ? caracteristiques
      : (Array.isArray(current?.caracteristiques) ? current!.caracteristiques : caracteristiques);

    // Le nom enregistré doit toujours être nom + dimension (déjà dans le nom
    // tapé) + origine SEULEMENT si elle est connue (caractéristique
    // "origine") — jamais le fournisseur, qui vit dans "fournisseurs"
    // ci-dessus. Deux origines différentes (ex: Turquie / Inde) donnent donc
    // deux noms différents, et restent deux fiches séparées.
    const finalDesignation = buildDesignationWithOrigin(designation, originFromCaracteristiques(mergedCaracteristiques));

    const payload = {
      designation: finalDesignation, categorie, unite,
      prix_actuel: cheapestOffer.prix, prix_entreprise: cheapestOffer.prix, prix_retenu: cheapestOffer.prix,
      prix_source: `Saisie manuelle — ${organizationName}`, statut_prix: isIa ? "ia" : "manuel",
      origine_prix: isIa ? "saisie_manuelle_ia" : "saisie_manuelle",
      fournisseur: cheapestOffer.fournisseur || null, ville: cheapestOffer.ville || null,
      region: cheapestOffer.region || null, disponibilite: cheapestOffer.disponibilite || null, livraison: cheapestOffer.livraison || null,
      fournisseurs: mergedOffers,
      caracteristiques: mergedCaracteristiques, date_prix: cheapestOffer.date_prix || now,
      updated_at: now,
      unite_achat: hasPurchaseUnit ? uniteAchat : null,
      quantite_par_unite_achat: hasPurchaseUnit ? quantiteParUniteAchat : null,
      prix_unite_achat: hasPurchaseUnit ? prixUniteAchat : null,
    };
    const { data: saved, error } = current?.id
      ? await supabase.from("price_library").update(payload).eq("id", current.id).eq("organization_id", member.organization_id).select("id").single()
      : await supabase.from("price_library").insert({ ...payload, organization_id: member.organization_id }).select("id").single();
    if (error || !saved) return NextResponse.json({ error: error?.message || "Prix non enregistré." }, { status: 500 });

    await supabase.from("price_history").insert({ price_id: saved.id, organization_id: member.organization_id, ancien_prix: current?.prix_actuel ?? null, nouveau_prix: cheapestOffer.prix, type_variation: current ? "modification_manuelle" : "nouveau", event_type: "manual_price", source_type: "manual_enterprise", created_by: user.id, observed_at: now });
    const sourceLabel = `Saisie manuelle — ${organizationName}`;
    const key = materialKey(finalDesignation);
    const { data: existingSharedRows } = await supabase.from("shared_material_prices")
      .select("id,prix_unitaire,unite").eq("designation_key", key);
    const existingShared = existingSharedRows?.find((price) => canonicalUnit(String(price.unite ?? "")) === unite) ?? null;
    const common = { designation_key: key, designation: finalDesignation, categorie, unite, prix_unitaire: cheapestOffer.prix, currency: "MGA", provenance_label: sourceLabel, contributor_organization_id: member.organization_id, contributor_organization_name: organizationName, last_checked_at: now, updated_at: now };
    const { data: sharedMaterial, error: sharedError } = existingShared?.id
      ? await supabase.from("shared_material_prices").update(Number(existingShared.prix_unitaire) > cheapestOffer.prix ? common : { last_checked_at: now, updated_at: now }).eq("id", existingShared.id).select("id").single()
      : await supabase.from("shared_material_prices").insert({ ...common, created_by: user.id }).select("id").single();
    if (sharedMaterial?.id) await supabase.from("shared_material_price_observations").insert({ material_id: sharedMaterial.id, prix_unitaire: cheapestOffer.prix, provenance_type: "saisie_manuelle_entreprise", provenance_label: sourceLabel, contributor_organization_id: member.organization_id, contributor_organization_name: organizationName, observed_at: now, created_by: user.id });
    if (sharedError) console.warn("Shared manual price not published", sharedError.message);
    return NextResponse.json({ success: true, id: saved.id, shared: Boolean(sharedMaterial?.id), provenance: sourceLabel });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur interne." }, { status: 500 });
  }
}
