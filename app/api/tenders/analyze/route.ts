import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

type SearchRequest = {
  designation?: string;
  categorie?: string;
  unite?: string;
  worksiteName?: string;
  worksiteLocation?: string;
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
  confidence: number;
  evidence: string;
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
          confidence: { type: "number" },
          evidence: { type: "string" },
        },
        required: [
          "supplier_name", "supplier_address", "supplier_city", "supplier_region",
          "country", "source_url", "base_price", "delivery_cost", "landed_price",
          "currency", "unit", "distance_km", "confidence", "evidence",
        ],
      },
    },
    no_result_reason: { type: "string" },
  },
  required: ["offers", "no_result_reason"],
} as const;

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
  const { data: possiblePrices } = await supabase
    .from("price_library")
    .select("*")
    .eq("organization_id", organizationId)
    .ilike("unite", unite);
  const existingPrice = possiblePrices?.find(
    (price) => normalizeMaterialName(String(price.designation)) === designationKey,
  ) ?? null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });
  }

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      store: false,
      tools: [{ type: "web_search" }],
      instructions: [
        "Tu recherches des prix réels de matériaux et prestations BTP à Madagascar.",
        "Cherche d'abord près du chantier, puis élargis à tout Madagascar.",
        "N'utilise jamais un fournisseur situé hors de Madagascar.",
        "N'invente ni fournisseur, ni adresse, ni prix, ni URL.",
        "Retourne uniquement des offres dont la page source permet de justifier le prix.",
        "Normalise les prix en ariary malgache (MGA).",
        "Le landed_price est le prix rendu chantier: base_price + delivery_cost.",
        "Si le transport est inconnu, utilise null et réduis la confiance.",
        "Si rien de vérifiable n'existe, retourne offers vide et explique pourquoi.",
      ].join(" "),
      input: [
        `ARTICLE: ${canonicalDesignation}`,
        `CATÉGORIE: ${categorie}`,
        `UNITÉ DAO: ${unite}`,
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
    console.error("OpenAI price search failed", aiResponse.status, await aiResponse.text());
    return NextResponse.json({ error: "La recherche Internet a échoué." }, { status: 502 });
  }

  const responsePayload = await aiResponse.json() as { output_text?: string };
  if (!responsePayload.output_text) {
    return NextResponse.json({ error: "La recherche Internet n'a retourné aucun résultat exploitable." }, { status: 502 });
  }

  let parsed: { offers: Offer[]; no_result_reason: string };
  try {
    parsed = JSON.parse(responsePayload.output_text) as typeof parsed;
  } catch {
    return NextResponse.json({ error: "Réponse de recherche invalide." }, { status: 502 });
  }

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

  if (offers.length === 0) {
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
      metadata: { reason: parsed.no_result_reason },
    });
    return NextResponse.json({
      found: false,
      requires_manual: true,
      message: "Aucun prix vérifiable trouvé à Madagascar. Ajout manuel requis.",
    });
  }

  const bestOffer = offers[0];
  const manualPrice = positiveNumber(existingPrice?.prix_entreprise);
  const currentPrice = manualPrice ?? positiveNumber(existingPrice?.prix_retenu) ?? positiveNumber(existingPrice?.prix_actuel);
  const isCheaper = Boolean(currentPrice && Number(bestOffer.landed_price) < currentPrice);
  const requiresValidation = Boolean(manualPrice && isCheaper);

  let priceId = existingPrice?.id as string | undefined;
  if (!priceId) {
    const { data: created, error } = await supabase
      .from("price_library")
      .insert({
        organization_id: organizationId,
        designation: canonicalDesignation,
        categorie,
        unite,
        prix_ia: bestOffer.landed_price,
        prix_retenu: bestOffer.landed_price,
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
        landed_price: bestOffer.landed_price,
        last_checked_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !created) return NextResponse.json({ error: "Prix trouvé mais non enregistrable." }, { status: 500 });
    priceId = created.id;
  }

  const historyRows = offers.map((offer, index) => ({
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
    metadata: { evidence: offer.evidence },
  }));

  const { data: savedHistory, error: historyError } = await supabase
    .from("price_history")
    .insert(historyRows)
    .select("id,decision")
    .order("observed_at", { ascending: true });
  if (historyError) return NextResponse.json({ error: "Prix trouvé mais historique non enregistré." }, { status: 500 });

  const selectedHistoryId = savedHistory?.find((row) => row.decision !== "alternative")?.id ?? null;
  const updatePayload = requiresValidation
    ? {
        pending_lower_price: bestOffer.landed_price,
        pending_history_id: selectedHistoryId,
        requires_validation: true,
        last_checked_at: new Date().toISOString(),
      }
    : {
        prix_ia: bestOffer.landed_price,
        prix_retenu: manualPrice ?? bestOffer.landed_price,
        prix_source: bestOffer.source_url,
        fournisseur: bestOffer.supplier_name,
        ville: bestOffer.supplier_city,
        region: bestOffer.supplier_region,
        reference_source: bestOffer.source_url,
        distance_chantier_km: bestOffer.distance_km,
        confiance_ia: bestOffer.confidence,
        delivery_cost: bestOffer.delivery_cost,
        landed_price: bestOffer.landed_price,
        requires_validation: false,
        pending_lower_price: null,
        pending_history_id: null,
        last_checked_at: new Date().toISOString(),
      };

  await supabase.from("price_library").update(updatePayload).eq("id", priceId);

  return NextResponse.json({
    found: true,
    price_id: priceId,
    selected_price: requiresValidation ? manualPrice : (manualPrice ?? bestOffer.landed_price),
    proposed_lower_price: requiresValidation ? bestOffer.landed_price : null,
    requires_validation: requiresValidation,
    supplier: bestOffer.supplier_name,
    offers_found: offers.length,
  });
}
