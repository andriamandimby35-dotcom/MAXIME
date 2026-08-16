import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

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
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function displayMaterialName(value: string) {
  return normalizeMaterialName(value).toLocaleUpperCase("fr-FR");
}

function materialFamily(value: string) {
  const normalized = normalizeMaterialName(value);
  if (normalized.includes("ciment")) return "ciment";
  if (normalized.includes("sable")) return "sable";
  if (normalized.includes("gravillon") || normalized.includes("gravier")) return "granulat_gravier";
  if (normalized.includes("parpaing") || normalized.includes("bloc creux") || normalized.includes("agglo")) return "parpaing";
  if (normalized.includes("planche")) return "planche";
  if (normalized.includes("tasseau") || normalized.includes("chevron") || normalized.includes("raidisseur")) return "bois_raidissement";
  if (normalized.includes("pointe") || normalized.includes("clou")) return "pointes";
  if (normalized.includes("huile") && normalized.includes("coffrage")) return "huile_decoffrage";
  return normalized;
}

function savedPriceForRequestedUnit(price: Record<string, unknown>, requestedUnit: string) {
  const retained = positiveNumber(price.prix_entreprise)
    ?? positiveNumber(price.prix_retenu)
    ?? positiveNumber(price.prix_actuel)
    ?? positiveNumber(price.prix_ia);
  if (!retained) return null;
  const savedUnit = normalizeMaterialName(String(price.unite ?? ""));
  const targetUnit = normalizeMaterialName(requestedUnit);
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
  const unite = body?.unite?.trim();
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
  const designationKey = normalizeMaterialName(designation);
  const canonicalDesignation = displayMaterialName(designation);
  const { data: organizationPrices } = await supabase
    .from("price_library")
    .select("*")
    .eq("organization_id", organizationId);
  const existingPrice = organizationPrices?.find(
    (price) => normalizeMaterialName(String(price.designation)) === designationKey
      && normalizeMaterialName(String(price.unite ?? "")) === normalizeMaterialName(unite),
  ) ?? null;

  if (body?.action === "resolve_component_prices") {
    const components = body.manualComponents ?? [];
    const resolved = components.map((component) => {
      const family = materialFamily(component.designation);
      const savedPrice = organizationPrices?.find((price) =>
        materialFamily(String(price.designation)) === family
        && savedPriceForRequestedUnit(price, component.unit) !== null,
      );
      const savedUnitPrice = savedPrice ? savedPriceForRequestedUnit(savedPrice, component.unit) : null;
      return {
        ...component,
        saved_unit_price: savedUnitPrice,
        saved_designation: savedPrice ? String(savedPrice.designation ?? "") : "",
        saved_supplier: savedPrice ? String(savedPrice.fournisseur ?? "Prix enregistré") : "",
        saved_source: savedPrice ? String(savedPrice.prix_source ?? savedPrice.reference_source ?? "historique interne") : "",
      };
    });
    return NextResponse.json({ components: resolved });
  }

  if (body?.action === "save_manual_composite") {
    const compositePrice = positiveNumber(body.manualCompositePrice);
    const components = (body.manualComponents ?? []).filter(
      (item) => item.designation?.trim() && item.unit?.trim() && Number(item.local_unit_price) >= 0,
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
  const automaticallyCalculatedComposite = manualPriceInputs.length > 1
    && manualPriceInputs.every((item) => item.quantity_per_work_unit > 0 && positiveNumber(item.found_unit_price))
    ? manualPriceInputs.reduce(
        (sum, item) => sum + item.quantity_per_work_unit * Number(item.found_unit_price),
        0,
      )
    : null;
  const calculatedInternetPrice = automaticallyCalculatedComposite ?? Number(bestOffer.landed_price);
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
        designation: canonicalDesignation,
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
        pending_lower_price: calculatedInternetPrice,
        pending_history_id: selectedHistoryId,
        requires_validation: true,
        last_checked_at: new Date().toISOString(),
      }
    : keptExistingPrice
      ? {
          prix_retenu: selectedPrice,
          requires_validation: false,
          pending_lower_price: null,
          pending_history_id: null,
          last_checked_at: new Date().toISOString(),
        }
      : {
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
