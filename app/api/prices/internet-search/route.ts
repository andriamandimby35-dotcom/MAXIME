import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { canonicalMaterialKey, canonicalUnit, materialFamily } from "@/lib/material-normalization";

type SearchRequest = {
  action?: "search" | "save_manual_composite" | "resolve_component_prices";
  designation?: string;
  categorie?: string;
  unite?: string;
  worksiteName?: string;
  worksiteLocation?: string;
  daoQuantity?: number;
  pricingContext?: string;
  manualCompositePrice?: number;
  manualComponents?: Array<ManualPriceInput & { local_unit_price: number }>;
};

type Offer = {
  supplier_name: string;
  supplier_address: string;
  supplier_city: string;
  supplier_region: string;
  country: string;
  source_url: string;
  base_price: number | null;
  delivery_cost: number | null;
  landed_price: number | null;
  currency: string;
  unit: string;
  distance_km: number | null;
  estimated_unit_weight_t: number | null;
  weight_basis: string;
  confidence: number;
  evidence: string;
};

type ManualPriceInput = {
  designation: string;
  unit: string;
  quantity_per_work_unit: number;
  note: string;
  found_unit_price: number | null;
  source_url: string;
  supplier_name: string;
};

const resultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    offers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          supplier_name: { type: "string" },
          supplier_address: { type: "string" },
          supplier_city: { type: "string" },
          supplier_region: { type: "string" },
          country: { type: "string" },
          source_url: { type: "string" },
          base_price: { type: ["number", "null"] },
          delivery_cost: { type: ["number", "null"] },
          landed_price: { type: ["number", "null"] },
          currency: { type: "string" },
          unit: { type: "string" },
          distance_km: { type: ["number", "null"] },
          estimated_unit_weight_t: { type: ["number", "null"] },
          weight_basis: { type: "string" },
          confidence: { type: "number" },
          evidence: { type: "string" },
        },
        required: [
          "supplier_name", "supplier_address", "supplier_city", "supplier_region",
          "country", "source_url", "base_price", "delivery_cost", "landed_price",
          "currency", "unit", "distance_km", "estimated_unit_weight_t",
          "weight_basis", "confidence", "evidence",
        ],
      },
    },
    no_result_reason: { type: "string" },
    interpreted_designation: { type: "string" },
    equivalent_options: { type: "array", items: { type: "string" } },
    recommended_equivalent: { type: "string" },
    equivalence_note: { type: "string" },
    requires_technical_validation: { type: "boolean" },
    manual_price_inputs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          designation: { type: "string" },
          unit: { type: "string" },
          quantity_per_work_unit: { type: "number" },
          note: { type: "string" },
          found_unit_price: { type: ["number", "null"] },
          source_url: { type: "string" },
          supplier_name: { type: "string" },
        },
        required: [
          "designation", "unit", "quantity_per_work_unit", "note",
          "found_unit_price", "source_url", "supplier_name",
        ],
      },
    },
  },
  required: [
    "offers", "no_result_reason", "interpreted_designation", "equivalent_options",
    "recommended_equivalent", "equivalence_note", "requires_technical_validation", "manual_price_inputs",
  ],
} as const;

function extractResponseText(payload: {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}) {
  if (payload.output_text) return payload.output_text;
  return payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("") || "";
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeMaterialName(value: string) {
  return canonicalMaterialKey(value);
}

function displayMaterialName(value: string) {
  return normalizeMaterialName(value).toLocaleUpperCase("fr-FR");
}

function savedPriceForRequestedUnit(price: Record<string, unknown>, requestedUnit: string) {
  const retained = positiveNumber(price.prix_entreprise)
    ?? positiveNumber(price.prix_retenu)
    ?? positiveNumber(price.prix_actuel)
    ?? positiveNumber(price.prix_ia);
  if (!retained) return null;
  const savedUnit = canonicalUnit(String(price.unite ?? ""));
  const targetUnit = canonicalUnit(requestedUnit);
  if (savedUnit === targetUnit) return retained;
  if (materialFamily(String(price.designation ?? "")) === "ciment") {
    if ((savedUnit.includes("sac") || savedUnit.includes("bag")) && targetUnit === "kg") return retained / 50;
    if (savedUnit === "kg" && (targetUnit.includes("sac") || targetUnit.includes("bag"))) return retained * 50;
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const body = await request.json().catch(() => null) as SearchRequest | null;
  const designation = body?.designation?.trim();
  const categorie = body?.categorie?.trim() || "Matériaux BTP";
  const unite = canonicalUnit(body?.unite?.trim() ?? "");
  const worksiteName = body?.worksiteName?.trim() || "Chantier non nommé";
  const worksiteLocation = body?.worksiteLocation?.trim();
  const daoQuantity = Number(body?.daoQuantity) || 0;
  const pricingContext = body?.pricingContext?.trim() || "Aucun contexte détaillé transmis.";

  if (!designation || !unite || !worksiteLocation) {
    return NextResponse.json(
      { error: "Désignation, unité et localisation du chantier obligatoires." },
      { status: 400 },
    );
  }

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  const organizationId = member.organization_id;
  const designationKey = canonicalMaterialKey(designation);
  const canonicalDesignation = displayMaterialName(designation);
  const { data: organizationPrices } = await supabase
    .from("price_library")
    .select("*")
    .eq("organization_id", organizationId);
  // Le catalogue partagé est un cache commun : les devis et les ajustements
  // propres à l'entreprise restent prioritaires et privés.
  const { data: sharedPriceRows } = await supabase
    .from("shared_material_prices")
    .select("*")
    .eq("designation_key", designationKey)
    .order("prix_unitaire", { ascending: true })
    .order("updated_at", { ascending: false });
  const sharedPrice = sharedPriceRows?.find((price) => canonicalUnit(String(price.unite ?? "")) === unite) ?? null;
  // Le nom du DAO ne correspond pas toujours au nom réel/commercial déjà
  // enregistré (ex: "CIMENT CEM I 42.5..." côté DAO vs "Ciment Orimbato" en
  // bibliothèque) : si aucune désignation identique n'est trouvée, on retombe
  // sur la même famille de matériau pour réutiliser le prix déjà connu au
  // lieu de relancer inutilement une recherche.
  const requestedFamily = materialFamily(designation);
  const existingPrice = organizationPrices?.find(
    (price) => normalizeMaterialName(String(price.designation)) === designationKey
      && canonicalUnit(String(price.unite ?? "")) === unite,
  ) ?? organizationPrices?.find(
    (price) => materialFamily(String(price.designation)) === requestedFamily
      && canonicalUnit(String(price.unite ?? "")) === unite,
  ) ?? null;

  async function cacheSharedPrice(price: number, source: { label: string; url?: string; supplier?: string; city?: string; region?: string; confidence?: number }) {
    const { data: organization } = await supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    const now = new Date().toISOString();
    const common = {
      designation_key: designationKey,
      designation: canonicalDesignation,
      categorie,
      unite,
      prix_unitaire: price,
      provenance_label: source.label,
      provenance_url: source.url || null,
      supplier_name: source.supplier || null,
      supplier_city: source.city || null,
      supplier_region: source.region || null,
      confidence: source.confidence ?? null,
      contributor_organization_id: organizationId,
      contributor_organization_name: organization?.name ?? null,
      last_checked_at: now,
      updated_at: now,
    };
    const { data: existingRows } = await supabase.from("shared_material_prices")
      .select("id,prix_unitaire,unite")
      .eq("designation_key", designationKey)
      .order("prix_unitaire", { ascending: true });
    const existing = existingRows?.find((item) => canonicalUnit(String(item.unite ?? "")) === unite) ?? null;
    const { data: material, error } = existing?.id
      ? await supabase.from("shared_material_prices").update(Number(existing.prix_unitaire) > price ? common : { last_checked_at: now, updated_at: now }).eq("id", existing.id).select("id").single()
      : await supabase.from("shared_material_prices").insert({ ...common, created_by: user!.id }).select("id").single();
    if (error || !material) { console.warn("Shared material price cache unavailable", error?.message); return; }
    const { error: observationError } = await supabase.from("shared_material_price_observations").insert({
      material_id: material.id, prix_unitaire: price, provenance_type: "internet_ia", provenance_label: source.label,
      provenance_url: source.url || null, contributor_organization_id: organizationId, contributor_organization_name: organization?.name ?? null,
      supplier_name: source.supplier || null, supplier_city: source.city || null, supplier_region: source.region || null,
      confidence: source.confidence ?? null, observed_at: now, created_by: user!.id,
    });
    if (observationError) console.warn("Shared material observation unavailable", observationError.message);
  }

  if (body?.action === "resolve_component_prices") {
    const components = body.manualComponents ?? [];
    const resolved = await Promise.all(components.map(async (component) => {
      const family = materialFamily(component.designation);
      const enterprisePrice = organizationPrices?.find((price) =>
        materialFamily(String(price.designation)) === family
        && savedPriceForRequestedUnit(price, component.unit) !== null,
      );
      const { data: sharedComponents } = await supabase.from("shared_material_prices")
        .select("designation,unite,prix_unitaire,provenance_label,contributor_organization_name,supplier_name")
        .eq("designation_key", normalizeMaterialName(component.designation))
        .eq("unite", component.unit)
        .order("prix_unitaire", { ascending: true }).limit(1);
      let sharedComponent = sharedComponents?.[0] ?? null;
      // Une même matière peut être saisie sous une désignation plus précise
      // (ex. « ciment 350 kg » au lieu de « ciment »). On réutilise alors
      // le prix familial plutôt que de redemander inutilement une saisie.
      if (!sharedComponent) {
        const { data: familyComponents } = await supabase.from("shared_material_prices")
          .select("designation,unite,prix_unitaire,provenance_label,contributor_organization_name,supplier_name")
          .order("prix_unitaire", { ascending: true }).limit(200);
        sharedComponent = familyComponents?.find((price) =>
          materialFamily(String(price.designation)) === family
          && canonicalUnit(String(price.unite ?? "")) === canonicalUnit(component.unit),
        ) ?? null;
      }
      const enterpriseUnitPrice = enterprisePrice ? savedPriceForRequestedUnit(enterprisePrice, component.unit) : null;
      const sharedUnitPrice = positiveNumber(sharedComponent?.prix_unitaire);
      const useEnterprise = enterpriseUnitPrice !== null;
      return {
        ...component,
        saved_unit_price: useEnterprise ? enterpriseUnitPrice : sharedUnitPrice,
        saved_designation: useEnterprise ? String(enterprisePrice?.designation ?? "") : String(sharedComponent?.designation ?? ""),
        saved_supplier: useEnterprise ? String(enterprisePrice?.fournisseur ?? "Prix enregistré") : String(sharedComponent?.supplier_name ?? "Prix partagé"),
        saved_source: useEnterprise ? String(enterprisePrice?.prix_source ?? enterprisePrice?.reference_source ?? "historique interne") : `${sharedComponent?.provenance_label ?? "Prix partagé"}${sharedComponent?.contributor_organization_name ? ` — ${sharedComponent.contributor_organization_name}` : ""}`,
        shared_lower_price: enterpriseUnitPrice && sharedUnitPrice && sharedUnitPrice < enterpriseUnitPrice ? sharedUnitPrice : null,
        shared_provenance: sharedComponent?.provenance_label ?? "",
        shared_contributor_organization: sharedComponent?.contributor_organization_name ?? "",
      };
    }));
    return NextResponse.json({ components: resolved });
  }

  // Matériau vendu par pièce/barre/plaque entière (ex: bois carré en barres
  // de 4 m, tôle en feuilles de 6 m²) : le DAO compte en unité de mesure (ml,
  // m2, kg...) mais le fournisseur ne vend jamais une fraction de pièce.
  // quantite_par_unite_achat est toujours exprimée dans CETTE unité DAO (une
  // longueur si unite=ml, une surface si unite=m2, etc.) — le calcul est donc
  // le même quel que soit le type d'unité. On calcule le nombre de pièces
  // entières réellement à acheter (arrondi au supérieur) pour cette quantité
  // DAO, puis on ramène ça à un prix par unité DAO — multiplié par la
  // quantité dans EstimateBuilder, ça reconstitue exactement le coût d'achat
  // réel, pas une simple moyenne linéaire.
  const purchaseUnitQty = positiveNumber(existingPrice?.quantite_par_unite_achat);
  const purchaseUnitPrice = positiveNumber(existingPrice?.prix_unite_achat);
  if (existingPrice && purchaseUnitQty && purchaseUnitPrice && daoQuantity > 0) {
    const piecesNeeded = Math.ceil(daoQuantity / purchaseUnitQty);
    const totalCost = piecesNeeded * purchaseUnitPrice;
    const effectiveUnitPrice = totalCost / daoQuantity;
    return NextResponse.json({
      found: true,
      price_id: existingPrice.id,
      selected_price: effectiveUnitPrice,
      proposed_lower_price: null,
      requires_validation: false,
      supplier: existingPrice.fournisseur || "Prix enregistré",
      supplier_distance_km: null,
      estimated_unit_weight_t: null,
      weight_basis: `Vendu par ${existingPrice.unite_achat || "pièce"} de ${purchaseUnitQty} ${unite} à ${purchaseUnitPrice.toLocaleString("fr-FR")} Ar : ${piecesNeeded} pièce(s) nécessaire(s) pour ${daoQuantity} ${unite}.`,
      interpreted_designation: existingPrice.designation,
      equivalent_options: [], recommended_equivalent: "",
      equivalence_note: `${piecesNeeded} × ${existingPrice.unite_achat || "pièce"} (${purchaseUnitQty} ${unite}) à ${purchaseUnitPrice.toLocaleString("fr-FR")} Ar = ${totalCost.toLocaleString("fr-FR")} Ar au total, soit ${effectiveUnitPrice.toLocaleString("fr-FR")} Ar/${unite} pour cette quantité.`,
      requires_technical_validation: false, manual_price_inputs: [], composite_calculated_automatically: false, offers_found: 0,
      purchase_unit: true,
    });
  }

  const sharedLowestPrice = positiveNumber(sharedPrice?.prix_unitaire);
  const organizationManualPrice = positiveNumber(existingPrice?.prix_entreprise);
  if (organizationManualPrice && sharedLowestPrice && sharedLowestPrice < organizationManualPrice) {
    return NextResponse.json({
      found: true,
      price_id: existingPrice?.id ?? null,
      selected_price: organizationManualPrice,
      proposed_lower_price: sharedLowestPrice,
      requires_validation: true,
      supplier: sharedPrice?.supplier_name || "Prix partagé",
      supplier_distance_km: null,
      estimated_unit_weight_t: null,
      weight_basis: "Prix partagé le moins cher.",
      interpreted_designation: sharedPrice?.designation || canonicalDesignation,
      equivalent_options: [], recommended_equivalent: "",
      equivalence_note: `Prix partagé moins cher : ${sharedPrice?.provenance_label}${sharedPrice?.contributor_organization_name ? ` — ${sharedPrice.contributor_organization_name}` : ""}. Votre prix reste appliqué jusqu’à validation.`,
      requires_technical_validation: false, manual_price_inputs: [], composite_calculated_automatically: false, offers_found: sharedPriceRows?.length ?? 0,
      shared_price: true, price_provenance: sharedPrice?.provenance_label, contributor_organization: sharedPrice?.contributor_organization_name,
    });
  }

  // Un prix déjà vérifié par une autre entreprise évite une nouvelle recherche
  // Internet. La provenance est retournée au devis pour rester transparente.
  if (!existingPrice && sharedPrice && body?.action !== "save_manual_composite") {
    const price = positiveNumber(sharedPrice.prix_unitaire);
    if (price) return NextResponse.json({
      found: true,
      price_id: null,
      selected_price: price,
      proposed_lower_price: null,
      requires_validation: false,
      supplier: sharedPrice.supplier_name || "Prix partagé",
      supplier_distance_km: null,
      estimated_unit_weight_t: null,
      weight_basis: "Prix récupéré du catalogue partagé.",
      interpreted_designation: sharedPrice.designation,
      equivalent_options: [],
      recommended_equivalent: "",
      equivalence_note: `Meilleur prix partagé parmi ${sharedPriceRows?.length ?? 1} provenance(s) : ${sharedPrice.provenance_label}${sharedPrice.contributor_organization_name ? ` — saisi/confirmé par ${sharedPrice.contributor_organization_name}` : ""}.`,
      requires_technical_validation: false,
      manual_price_inputs: [],
      composite_calculated_automatically: false,
      offers_found: 0,
      shared_price: true,
      price_provenance: sharedPrice.provenance_label,
      contributor_organization: sharedPrice.contributor_organization_name,
    });
  }

  if (body?.action === "save_manual_composite") {
    const compositePrice = positiveNumber(body.manualCompositePrice);
    const components = (body.manualComponents ?? []).filter(
      (item) => item.designation?.trim() && item.unit?.trim() && Number(item.local_unit_price) > 0,
    );
    if (!compositePrice || components.length === 0) {
      return NextResponse.json({ error: "Prix composé ou composants invalides." }, { status: 400 });
    }

    let compositePriceId = existingPrice?.id as string | undefined;
    if (compositePriceId) {
      const { error } = await supabase.from("price_library").update({
        prix_entreprise: compositePrice,
        prix_retenu: compositePrice,
        prix_source: "saisie_locale_composite",
        statut_validation: "valide_manuellement",
        statut_prix: "manuel",
        origine_prix: "saisie_locale_composite",
        nom_chantier: worksiteName,
        updated_at: new Date().toISOString(),
      }).eq("id", compositePriceId);
      if (error) return NextResponse.json({ error: `Prix composé non enregistré : ${error.message}` }, { status: 500 });
    } else {
      const { data: created, error } = await supabase.from("price_library").insert({
        organization_id: organizationId,
        designation: canonicalDesignation,
        categorie,
        unite,
        prix_entreprise: compositePrice,
        prix_retenu: compositePrice,
        prix_source: "saisie_locale_composite",
        statut_validation: "valide_manuellement",
        statut_prix: "manuel",
        origine_prix: "saisie_locale_composite",
        nom_chantier: worksiteName,
      }).select("id").single();
      if (error || !created) return NextResponse.json({ error: `Prix composé non enregistré : ${error?.message ?? "erreur inconnue"}` }, { status: 500 });
      compositePriceId = created.id;
    }

    for (const component of components) {
      const componentKey = normalizeMaterialName(component.designation);
      const { data: componentCandidates } = await supabase.from("price_library")
        .select("*")
        .eq("organization_id", organizationId)
        .ilike("unite", component.unit);
      const componentExisting = componentCandidates?.find(
        (price) => normalizeMaterialName(String(price.designation)) === componentKey
          || materialFamily(String(price.designation)) === materialFamily(component.designation),
      );
      let componentPriceId = componentExisting?.id as string | undefined;
      if (componentPriceId) {
        await supabase.from("price_library").update({
          prix_entreprise: component.local_unit_price,
          prix_retenu: component.local_unit_price,
          prix_source: "saisie_locale",
          statut_validation: "valide_manuellement",
          statut_prix: "manuel",
          origine_prix: "saisie_locale",
          updated_at: new Date().toISOString(),
        }).eq("id", componentPriceId);
      } else {
        const { data: createdComponent } = await supabase.from("price_library").insert({
          organization_id: organizationId,
          designation: displayMaterialName(component.designation),
          categorie: "Composants de prix",
          unite: component.unit,
          prix_entreprise: component.local_unit_price,
          prix_retenu: component.local_unit_price,
          prix_source: "saisie_locale",
          statut_validation: "valide_manuellement",
          statut_prix: "manuel",
          origine_prix: "saisie_locale",
          nom_chantier: worksiteName,
        }).select("id").single();
        componentPriceId = createdComponent?.id;
      }
      await supabase.from("price_history").insert({
        price_id: componentPriceId ?? null,
        organization_id: organizationId,
        ancien_prix: componentExisting?.prix_retenu ?? null,
        nouveau_prix: component.local_unit_price,
        type_variation: componentExisting ? "modification_manuelle" : "nouveau",
        event_type: "manual_component_price",
        source_type: "manual_local",
        search_query: displayMaterialName(component.designation),
        worksite_name: worksiteName,
        worksite_location: worksiteLocation,
        unit: component.unit,
        decision: "manually_selected",
        requires_validation: false,
        observed_at: new Date().toISOString(),
        created_by: user.id,
        metadata: {
          parent_designation: canonicalDesignation,
          quantity_per_work_unit: component.quantity_per_work_unit,
          note: component.note,
        },
      });
    }

    await supabase.from("price_history").insert({
      price_id: compositePriceId,
      organization_id: organizationId,
      ancien_prix: existingPrice?.prix_retenu ?? null,
      nouveau_prix: compositePrice,
      type_variation: existingPrice ? "modification_manuelle" : "nouveau",
      event_type: "manual_composite_price",
      source_type: "manual_local_composite",
      search_query: canonicalDesignation,
      worksite_name: worksiteName,
      worksite_location: worksiteLocation,
      unit: unite,
      decision: "manually_selected",
      requires_validation: false,
      observed_at: new Date().toISOString(),
      created_by: user.id,
      metadata: { components },
    });
    return NextResponse.json({ saved: true, price_id: compositePriceId, selected_price: compositePrice });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });
  }

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // Keep DAO analysis and Internet price search independent: an OPENAI_MODEL
      // chosen for document analysis may not expose the web_search tool.
      model: process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-5.4-mini",
      store: false,
      tools: [{ type: "web_search" }],
      instructions: [
        "Tu recherches des prix réels de matériaux et prestations BTP à Madagascar.",
        "Cherche d'abord près du chantier, puis élargis à tout Madagascar.",
        "N'utilise jamais un fournisseur situé hors de Madagascar.",
        "N'invente ni fournisseur, ni adresse, ni prix, ni URL.",
        "Interprète la désignation technique et propose jusqu'à 5 équivalents réellement compatibles disponibles à Madagascar.",
        "Ne modifie jamais la désignation officielle du DAO; les équivalents servent uniquement au calcul et à l'approvisionnement internes.",
        "interpreted_designation doit toujours être le nom réel, simple et commercial du matériau tel qu'on le trouve à Madagascar — jamais le nom technique, le code ou le jargon du DAO. C'est ce nom qui sera enregistré dans la bibliothèque de prix interne ; le nom officiel du DAO reste inchangé partout ailleurs (devis compris), cette interprétation ne sert qu'à retrouver et nommer le bon prix.",
        "Toute mention d'eau, y compris «eau de gâchage», doit être interprétée comme «Eau». Si le DAO propose un choix entre eau et adjuvant, retiens «Eau» (option la moins chère) sauf si un adjuvant est explicitement exigé sans alternative, auquel cas retiens «Adjuvant».",
        "À Madagascar, le sable utilisé pour le béton, le mortier, la chape, la maçonnerie de parpaings ou tout autre usage courant est le même sable normal (lavé) : toute variante («sable pour mortier», «sable de mortier», «sable de chape», «sable de maçonnerie», «sable lavé», etc.) doit être interprétée simplement comme «Sable», jamais avec sa variante technique, pour éviter les doublons dans la bibliothèque.",
        "Pour un ciment désigné seulement par sa classe de résistance, utilise ce tableau de référence vérifié des marques vendues à Madagascar (prix indicatif au sac de 50 kg) : Lova CEM II 22.5 ≈36 000 Ar ; Lafatra CEM II 32.5 ≈36 450 Ar ; Kinga CEM II 42.5 ≈39 000 Ar ; Orimbato 42.5 ≈42 950 Ar ; Lucky CEM I 42.5 ≈37 000 Ar. Choisis la marque dont la classe correspond à celle demandée par le DAO. Si plusieurs marques correspondent à la même classe (ex: Kinga, Orimbato et Lucky pour du 42.5) et que le DAO ne précise pas de marque, choisis la moins chère. N'utilise une recherche web que si aucune marque de ce tableau ne correspond à la classe demandée, et n'invente jamais une marque non vendue à Madagascar.",
        "Pour un fer à béton torsadé désigné seulement par son diamètre, interpreted_designation doit être la marque réellement vendue à Madagascar (par exemple Fer Turcky, Fer Indien) suivie du diamètre. Si le DAO ne précise pas de marque, choisis la moins chère.",
        "Pour un béton désigné par un code de résistance ou d'ouvrage (par exemple Q350, «béton armé Q350»), interprète-le comme un dosage réel : interpreted_designation doit être «Béton à <dosage> kg/m3», jamais le code technique.",
        "De façon générale, interpreted_designation doit rester un nom simple, sans doublon ni jargon technique, facilement recherchable sur Internet à Madagascar ; ne recopie jamais littéralement une désignation ou un code technique du DAO.",
        "Pour acier, béton, électricité, structure ou sécurité, requires_technical_validation doit être true si le choix exige les plans ou le BET.",
        "Si l'article est un ouvrage composé sans prix direct, recherche ses composants dans le même passage et calcule un prix composé justifié.",
        "Pour un béton Q350 ou dosé à 350 kg/m³, recherche notamment ciment, sable, gravillon, eau/adjuvant et préparation; détaille la composition dans equivalence_note.",
        "Un béton Q350 est une interprétation à confirmer: ne garantis jamais sa formulation sans le CCTP ou le BET.",
        "Pour une maçonnerie de parpaings au m², identifie les dimensions probables du bloc, calcule le nombre de blocs par m² avec pertes, puis le mortier, le ciment, le sable et l'eau au dosage minimal adapté.",
        "Si l'épaisseur du parpaing est absente, propose les dimensions compatibles dans equivalent_options et exige une validation avant remplacement.",
        "Pour un ouvrage composé, le prix proposé correspond aux matériaux de la composition; n'ajoute pas la main-d'œuvre déjà calculée séparément dans le devis interne.",
        "Explique dans equivalence_note les quantités de chaque composant ramenées à l'unité DAO et la formule du prix composé.",
        "Si aucun prix complet fiable n'est trouvé, remplis manual_price_inputs avec uniquement les composants dont l'utilisateur doit saisir le prix local.",
        "Dans la même recherche Internet, cherche aussi séparément le prix malgache vérifiable de chacun de ces composants.",
        "Quand un prix de composant est vérifiable, remplis found_unit_price, source_url et supplier_name. Sinon found_unit_price doit être null et les deux textes vides.",
        "Pour chaque composant, indique sa désignation claire, son unité d'achat locale et la quantité nécessaire pour fabriquer UNE unité du poste DAO.",
        "Exemple béton au m3 : ciment en kg ou sacs, sable en m3, gravillon en m3 et, seulement si facturée, eau/adjuvant. Exemple maçonnerie au m2 : parpaings en unités, ciment et sable de mortier.",
        "Pour tout ouvrage composé (béton, coffrage, maçonnerie, dallage, enduit, mortier, peinture composée, assainissement ou autre ouvrage), remplis toujours manual_price_inputs, même si une offre directe complète est trouvée.",
        "Le détail des composants doit rester disponible afin que l'utilisateur puisse contrôler et modifier chaque quantité et chaque prix.",
        "manual_price_inputs ne doit jamais être vide.",
        "Pour un article simple réellement indivisible, ajoute l'article lui-même comme unique composant avec quantity_per_work_unit=1, son unité DAO et son prix trouvé s'il existe.",
        "Pour un coffrage, exploite d'abord le contexte des plans transmis. Estime les bois, panneaux, pointes, accessoires et le nombre prudent de réemplois ramenés à une unité DAO.",
        "Si le DAO dit coffrage en bois ordinaire, recommande en priorité des planches de coffrage en bois de sciage local avec tasseaux/bois de raidissement et pointes. Ne remplace jamais automatiquement ce bois ordinaire par du contreplaqué bakélisé.",
        "Le contreplaqué peut seulement apparaître dans equivalent_options comme variante distincte soumise à validation de l'utilisateur.",
        "Un prix trouvé pour une planche n'est jamais le prix complet d'un m² de coffrage.",
        "Pour tout coffrage, manual_price_inputs doit détailler séparément au minimum: planches ou peau coffrante, tasseaux/chevrons/raidisseurs, pointes ou attaches, et huile de décoffrage si nécessaire.",
        "Intègre les pertes et le nombre de réemplois dans les quantités ramenées à 1 m² de coffrage et explique ces hypothèses dans les notes.",
        "Une offre portant seulement sur l'un des composants ne doit pas être placée dans offers comme prix unitaire complet du poste coffrage; utilise-la uniquement comme found_unit_price du composant concerné.",
        "Si les plans restent incomplets, fournis des quantités prudentes non nulles fondées sur la surface DAO et une hypothèse de calepinage explicitée; requires_technical_validation reste true.",
        "Cherche d'abord la désignation exacte puis ses équivalents ou composants si le prix exact est absent.",
        "Retourne uniquement des offres dont la page source permet de justifier le prix.",
        "Normalise les prix en ariary malgache (MGA).",
        "Le landed_price est le prix rendu chantier: base_price + delivery_cost.",
        "Estime aussi le poids en tonnes correspondant à UNE unité DAO dans estimated_unit_weight_t.",
        "Pour KG utilise 0,001 tonne; pour T utilise 1; pour les autres unités, utilise une masse technique prudente seulement si elle est raisonnablement déductible.",
        "Explique brièvement l'hypothèse de poids dans weight_basis; si elle est impossible, retourne null.",
        "Si le transport est inconnu, utilise null et réduis la confiance.",
        "Si rien de vérifiable n'existe, retourne offers vide et explique pourquoi.",
      ].join(" "),
      input: [
        `ARTICLE: ${canonicalDesignation}`,
        `CATÉGORIE: ${categorie}`,
        `UNITÉ DAO: ${unite}`,
        `QUANTITÉ TOTALE DAO: ${daoQuantity || "non précisée"}`,
        `CONTEXTE DES PLANS ET DU CCTP: ${pricingContext}`,
        `CHANTIER: ${worksiteName}`,
        `LOCALISATION DU CHANTIER: ${worksiteLocation}, Madagascar`,
      ].join("\n"),
      text: {
        format: {
          type: "json_schema",
          name: "madagascar_price_search",
          strict: true,
          schema: resultSchema,
        },
      },
    }),
  });

  if (!aiResponse.ok) {
    const details = await aiResponse.text();
    console.error("OpenAI price search failed", aiResponse.status, details);
    return NextResponse.json(
      {
        error: "La recherche Internet a échoué.",
        upstream_status: aiResponse.status,
        details,
      },
      { status: 502 },
    );
  }

  const responsePayload = await aiResponse.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  const outputText = extractResponseText(responsePayload);
  if (!outputText) {
    return NextResponse.json({ error: "La recherche Internet n'a retourné aucun résultat exploitable." }, { status: 502 });
  }

  let parsed: {
    offers: Offer[];
    no_result_reason: string;
    interpreted_designation: string;
    equivalent_options: string[];
    recommended_equivalent: string;
    equivalence_note: string;
    requires_technical_validation: boolean;
    manual_price_inputs: ManualPriceInput[];
  };
  try {
    parsed = JSON.parse(outputText) as typeof parsed;
  } catch {
    return NextResponse.json({ error: "Réponse de recherche invalide." }, { status: 502 });
  }

  let manualPriceInputs = (parsed.manual_price_inputs ?? []).map((item) => {
    const requestedFamily = materialFamily(item.designation);
    const savedPrice = organizationPrices?.find((price) =>
      materialFamily(String(price.designation)) === requestedFamily
      && savedPriceForRequestedUnit(price, item.unit) !== null,
    );
    const savedUnitPrice = savedPrice ? savedPriceForRequestedUnit(savedPrice, item.unit) : null;
    return {
      ...item,
      found_unit_price: savedUnitPrice ?? positiveNumber(item.found_unit_price),
      source_url: savedUnitPrice ? String(savedPrice?.prix_source ?? savedPrice?.reference_source ?? "historique interne") : item.source_url,
      supplier_name: savedUnitPrice ? String(savedPrice?.fournisseur ?? "Prix enregistré") : item.supplier_name,
    };
  });

  const offers = parsed.offers
    .filter((offer) => offer.country.toLowerCase().includes("madagascar"))
    .map((offer) => {
      const basePrice = positiveNumber(offer.base_price);
      const deliveryCost = positiveNumber(offer.delivery_cost) ?? 0;
      const statedLandedPrice = positiveNumber(offer.landed_price);
      return {
        ...offer,
        base_price: basePrice,
        delivery_cost: deliveryCost,
        landed_price: statedLandedPrice ?? (basePrice ? basePrice + deliveryCost : null),
      };
    })
    .filter((offer) => offer.landed_price && offer.source_url.startsWith("http"))
    .sort((left, right) => Number(left.landed_price) - Number(right.landed_price));

  const searchedFamilies = new Set([
    materialFamily(canonicalDesignation),
    materialFamily(parsed.interpreted_designation),
    materialFamily(parsed.recommended_equivalent),
  ]);
  if (offers.length > 0) {
    const directOffer = offers[0];
    manualPriceInputs = manualPriceInputs.map((item) => {
      if (positiveNumber(item.found_unit_price)) return item;
      const componentFamily = materialFamily(item.designation);
      if (!searchedFamilies.has(componentFamily)) return item;
      const offerUnit = normalizeMaterialName(directOffer.unit || unite);
      const requestedUnit = normalizeMaterialName(item.unit);
      let componentPrice = positiveNumber(directOffer.landed_price);
      if (componentFamily === "ciment" && componentPrice) {
        if ((offerUnit.includes("sac") || offerUnit.includes("bag")) && requestedUnit === "kg") componentPrice /= 50;
        else if (offerUnit === "kg" && (requestedUnit.includes("sac") || requestedUnit.includes("bag"))) componentPrice *= 50;
        else if (offerUnit !== requestedUnit) componentPrice = null;
      } else if (offerUnit !== requestedUnit) {
        componentPrice = null;
      }
      return componentPrice ? {
        ...item,
        found_unit_price: componentPrice,
        source_url: directOffer.source_url,
        supplier_name: directOffer.supplier_name,
      } : item;
    });
  }

  if (offers.length === 0) {
    for (const component of manualPriceInputs) {
      const componentPrice = positiveNumber(component.found_unit_price);
      if (!componentPrice) continue;
      const componentExisting = organizationPrices?.find((price) =>
        normalizeMaterialName(String(price.designation)) === normalizeMaterialName(component.designation)
        && normalizeMaterialName(String(price.unite ?? "")) === normalizeMaterialName(component.unit),
      );
      let componentPriceId = componentExisting?.id as string | undefined;
      if (componentPriceId) {
        await supabase.from("price_library").update({
          prix_ia: componentPrice,
          prix_retenu: componentExisting.prix_entreprise ?? componentPrice,
          prix_source: component.source_url || componentExisting.prix_source,
          fournisseur: component.supplier_name || componentExisting.fournisseur,
          statut_prix: componentExisting.prix_entreprise ? "manuel" : "ia",
          origine_prix: componentExisting.prix_entreprise ? "saisie_locale" : "internet_ia_composant",
          last_checked_at: new Date().toISOString(),
        }).eq("id", componentPriceId);
      } else {
        const { data: createdComponent } = await supabase.from("price_library").insert({
          organization_id: organizationId,
          designation: displayMaterialName(component.designation),
          categorie: "Composants de prix",
          unite: component.unit,
          prix_ia: componentPrice,
          prix_retenu: componentPrice,
          prix_source: component.source_url,
          fournisseur: component.supplier_name,
          statut_prix: "ia",
          origine_prix: "internet_ia_composant",
          nom_chantier: worksiteName,
          last_checked_at: new Date().toISOString(),
        }).select("id").single();
        componentPriceId = createdComponent?.id;
      }
      await supabase.from("price_history").insert({
        price_id: componentPriceId ?? null,
        organization_id: organizationId,
        ancien_prix: componentExisting?.prix_retenu ?? null,
        nouveau_prix: componentPrice,
        type_variation: componentExisting ? "observation_internet" : "nouveau",
        event_type: "internet_component_price_found",
        source_type: "internet_ai",
        supplier_name: component.supplier_name,
        source_url: component.source_url,
        search_query: displayMaterialName(component.designation),
        worksite_name: worksiteName,
        worksite_location: worksiteLocation,
        unit: component.unit,
        decision: componentExisting?.prix_entreprise ? "manual_price_kept" : "automatically_selected",
        requires_validation: false,
        observed_at: new Date().toISOString(),
        created_by: user.id,
        metadata: { parent_designation: canonicalDesignation, quantity_per_work_unit: component.quantity_per_work_unit },
      });
    }
    await supabase.from("price_history").insert({
      price_id: existingPrice?.id ?? null,
      organization_id: organizationId,
      event_type: "internet_search_no_result",
      source_type: "internet_ai",
      search_query: canonicalDesignation,
      worksite_name: worksiteName,
      worksite_location: worksiteLocation,
      unit: unite,
      decision: "manual_required",
      requires_validation: true,
      observed_at: new Date().toISOString(),
      created_by: user.id,
      metadata: {
        reason: parsed.no_result_reason,
        interpreted_designation: parsed.interpreted_designation,
        equivalent_options: parsed.equivalent_options,
        recommended_equivalent: parsed.recommended_equivalent,
        equivalence_note: parsed.equivalence_note,
        manual_price_inputs: manualPriceInputs,
      },
    });
    return NextResponse.json({
      found: false,
      requires_manual: true,
      message: "Aucun prix vérifiable trouvé à Madagascar. Ajout manuel requis.",
      interpreted_designation: parsed.interpreted_designation,
      equivalent_options: parsed.equivalent_options,
      recommended_equivalent: parsed.recommended_equivalent,
      equivalence_note: parsed.equivalence_note,
      requires_technical_validation: parsed.requires_technical_validation,
      manual_price_inputs: manualPriceInputs,
    });
  }

  const bestOffer = offers[0];
  // Le nom stocké dans la bibliothèque doit être le nom réel/commercial trouvé
  // à Madagascar (ex: "Ciment Orimbato", "Eau", "Béton à 350"), jamais le
  // jargon ou le code technique du DAO ; le devis garde toujours son propre
  // libellé DAO, indépendant de cette bibliothèque.
  const libraryDesignation = parsed.interpreted_designation?.trim() || canonicalDesignation;
  const automaticallyCalculatedComposite = manualPriceInputs.length > 1
    && manualPriceInputs.every((item) => item.quantity_per_work_unit > 0 && positiveNumber(item.found_unit_price))
    ? manualPriceInputs.reduce(
        (sum, item) => sum + item.quantity_per_work_unit * Number(item.found_unit_price),
        0,
      )
    : null;
  const calculatedInternetPrice = automaticallyCalculatedComposite ?? Number(bestOffer.landed_price);
  await cacheSharedPrice(calculatedInternetPrice, {
    label: bestOffer.source_url,
    url: bestOffer.source_url,
    supplier: bestOffer.supplier_name,
    city: bestOffer.supplier_city,
    region: bestOffer.supplier_region,
    confidence: bestOffer.confidence,
  });
  const manualPrice = positiveNumber(existingPrice?.prix_entreprise);
  const currentPrice = manualPrice ?? positiveNumber(existingPrice?.prix_retenu) ?? positiveNumber(existingPrice?.prix_actuel);
  const isCheaper = Boolean(currentPrice && calculatedInternetPrice < currentPrice);
  const requiresValidation = Boolean(manualPrice && isCheaper);
  const selectedPrice = manualPrice
    ?? (currentPrice && calculatedInternetPrice >= currentPrice
      ? currentPrice
      : calculatedInternetPrice);
  const keptExistingPrice = Boolean(currentPrice && calculatedInternetPrice >= currentPrice);

  let priceId = existingPrice?.id as string | undefined;
  if (!priceId) {
    const { data: created, error } = await supabase
      .from("price_library")
      .insert({
        organization_id: organizationId,
        designation: libraryDesignation,
        categorie,
        unite,
        prix_ia: calculatedInternetPrice,
        prix_retenu: calculatedInternetPrice,
        prix_source: bestOffer.source_url,
        fournisseur: bestOffer.supplier_name,
        ville: bestOffer.supplier_city,
        region: bestOffer.supplier_region,
        reference_source: bestOffer.source_url,
        statut_prix: "ia",
        origine_prix: "internet_ia",
        distance_chantier_km: bestOffer.distance_km,
        confiance_ia: bestOffer.confidence,
        nom_chantier: worksiteName,
        delivery_cost: bestOffer.delivery_cost,
        landed_price: calculatedInternetPrice,
        last_checked_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !created) return NextResponse.json({ error: "Prix trouvé mais non enregistrable." }, { status: 500 });
    priceId = created.id;
  }

  const historyRows = offers.map((offer, index) => ({
    id: crypto.randomUUID(),
    price_id: priceId,
    organization_id: organizationId,
    ancien_prix: currentPrice,
    nouveau_prix: offer.landed_price,
    difference: currentPrice ? Number(offer.landed_price) - currentPrice : null,
    pourcentage_variation: currentPrice
      ? ((Number(offer.landed_price) - currentPrice) / currentPrice) * 100
      : null,
    type_variation: !currentPrice ? "nouveau" : Number(offer.landed_price) < currentPrice ? "diminution" : "augmentation",
    event_type: "internet_price_found",
    source_type: "internet_ai",
    supplier_name: offer.supplier_name,
    supplier_address: offer.supplier_address,
    supplier_city: offer.supplier_city,
    supplier_region: offer.supplier_region,
    source_url: offer.source_url,
    search_query: canonicalDesignation,
    worksite_name: worksiteName,
    worksite_location: worksiteLocation,
    distance_km: offer.distance_km,
    base_price: offer.base_price,
    delivery_cost: offer.delivery_cost,
    landed_price: offer.landed_price,
    currency: "MGA",
    unit: offer.unit || unite,
    decision: index === 0 ? (requiresValidation ? "pending_validation" : "automatically_selected") : "alternative",
    requires_validation: index === 0 && requiresValidation,
    is_cheaper: Boolean(currentPrice && Number(offer.landed_price) < currentPrice),
    confidence: offer.confidence,
    observed_at: new Date().toISOString(),
    created_by: user.id,
    metadata: {
      evidence: offer.evidence,
      estimated_unit_weight_t: offer.estimated_unit_weight_t,
      weight_basis: offer.weight_basis,
    },
  }));

  const { error: historyError } = await supabase.from("price_history").insert(historyRows);
  if (historyError) {
    return NextResponse.json(
      { error: `Prix trouvé mais historique non enregistré : ${historyError.message}` },
      { status: 500 },
    );
  }

  const selectedHistoryId = historyRows.find((row) => row.decision !== "alternative")?.id ?? null;
  const updatePayload = requiresValidation
    ? {
        designation: libraryDesignation,
        pending_lower_price: calculatedInternetPrice,
        pending_history_id: selectedHistoryId,
        requires_validation: true,
        last_checked_at: new Date().toISOString(),
      }
    : keptExistingPrice
      ? {
          designation: libraryDesignation,
          prix_retenu: selectedPrice,
          requires_validation: false,
          pending_lower_price: null,
          pending_history_id: null,
          last_checked_at: new Date().toISOString(),
        }
      : {
        designation: libraryDesignation,
        prix_ia: calculatedInternetPrice,
        prix_retenu: selectedPrice,
        prix_source: bestOffer.source_url,
        fournisseur: bestOffer.supplier_name,
        ville: bestOffer.supplier_city,
        region: bestOffer.supplier_region,
        reference_source: bestOffer.source_url,
        distance_chantier_km: bestOffer.distance_km,
        confiance_ia: bestOffer.confidence,
        delivery_cost: bestOffer.delivery_cost,
        landed_price: calculatedInternetPrice,
        requires_validation: false,
        pending_lower_price: null,
        pending_history_id: null,
        last_checked_at: new Date().toISOString(),
      };

  await supabase.from("price_library").update(updatePayload).eq("id", priceId);

  return NextResponse.json({
    found: true,
    price_id: priceId,
    selected_price: selectedPrice,
    proposed_lower_price: requiresValidation ? calculatedInternetPrice : null,
    requires_validation: requiresValidation,
    supplier: bestOffer.supplier_name,
    supplier_distance_km: bestOffer.distance_km,
    estimated_unit_weight_t: bestOffer.estimated_unit_weight_t,
    weight_basis: bestOffer.weight_basis,
    interpreted_designation: parsed.interpreted_designation,
    equivalent_options: parsed.equivalent_options,
    recommended_equivalent: parsed.recommended_equivalent,
    equivalence_note: parsed.equivalence_note,
    requires_technical_validation: parsed.requires_technical_validation,
    manual_price_inputs: manualPriceInputs,
    composite_calculated_automatically: automaticallyCalculatedComposite !== null,
    offers_found: offers.length,
  });
}
