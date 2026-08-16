import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

const daoSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    execution_period_days: { type: ["number", "null"] },
    work_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          row_type: { type: "string", enum: ["section", "item", "subtotal"] },
          section_title: { type: "string" },
          designation: { type: "string" },
          category: { type: "string" },
          unit: { type: "string" },
          quantity: { type: ["number", "null"] },
          source_reference: { type: "string" },
          needs_review: { type: "boolean" },
          note: { type: "string" },
          pricing_context: { type: "string" },
        },
        required: [
          "row_type", "section_title",
          "designation", "category", "unit", "quantity",
          "source_reference", "needs_review", "note", "pricing_context",
        ],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    internal_cost_recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["labor", "material", "equipment", "service", "overhead"] },
          title: { type: "string" },
          designation: { type: "string" },
          unit: { type: "string" },
          quantity: { type: ["number", "null"] },
          reason: { type: "string" },
          source_basis: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          default_option: { type: "string" },
          requires_validation: { type: "boolean" },
          safety_note: { type: "string" },
        },
        required: [
          "kind", "title", "designation", "unit", "quantity", "reason",
          "source_basis", "options", "default_option", "requires_validation", "safety_note",
        ],
      },
    },
  },
  required: ["summary", "execution_period_days", "work_items", "warnings", "internal_cost_recommendations"],
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

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

    const body = await request.json().catch(() => null) as { tenderId?: string; pdfUrl?: string } | null;
    const tenderId = body?.tenderId?.trim();
    const pdfUrl = body?.pdfUrl?.trim();
    if (!tenderId || !pdfUrl) {
      return NextResponse.json({ error: "DAO ou document PDF manquant." }, { status: 400 });
    }

    const { data: tender, error: tenderError } = await supabase
      .from("tenders")
      .select("id,title,reference,organization_id,document_url")
      .eq("id", tenderId)
      .single();
    if (tenderError || !tender || tender.document_url !== pdfUrl) {
      return NextResponse.json({ error: "DAO introuvable ou document non autorisé." }, { status: 404 });
    }

    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      return NextResponse.json({ error: "Le document PDF est inaccessible." }, { status: 502 });
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    if (pdfBuffer.length > 45 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Le PDF dépasse 45 Mo. Compressez-le avant l'analyse." },
        { status: 413 },
      );
    }
    const pdfDataUrl = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_DAO_MODEL || "gpt-5.4-mini",
        store: false,
        max_output_tokens: 30_000,
        instructions: [
          "Tu analyses un DAO de travaux publics ou BTP à Madagascar.",
          "Extrais uniquement les postes explicitement présents dans le document.",
          "Reproduis l'ordre et la structure exacte du bordereau DAO.",
          "Retourne une ligne row_type=section pour chaque titre d'ouvrage ou grande rubrique, par exemple TERRASSEMENT ou ÉQUIPEMENT.",
          "Retourne ensuite chaque poste avec row_type=item et section_title égal au titre de son ouvrage.",
          "Retourne une ligne row_type=subtotal à la fin de chaque ouvrage lorsqu'un sous-total existe dans le DAO.",
          "Pour section et subtotal, conserve le libellé exact dans designation, utilise une unité vide et quantity=null.",
          "Ne fusionne jamais deux ouvrages et ne supprime jamais un titre ou un sous-total présent dans le DAO.",
          "Respecte les désignations, unités, quantités et numérotations du document.",
          "N'invente jamais une quantité, un prix, un lot ou une exigence.",
          "Pour une quantité absente, utilise null et needs_review=true.",
          "source_reference indique la page, section, lot ou bordereau justificatif.",
          "Renseigne execution_period_days avec le délai contractuel d'exécution indiqué dans le DAO, converti en jours; utilise null s'il est absent.",
          "Ne calcule et ne propose aucun prix pendant l'analyse du DAO.",
          "Place dans warnings toutes les ambiguïtés qui nécessitent une validation humaine.",
          "Après l'extraction fidèle, identifie séparément les coûts indispensables probablement absents du bordereau: ouvriers, maçons, ingénieurs, encadrement, engins, consommables, transport, installation et repli, sécurité et charges de chantier.",
          "Place ces compléments uniquement dans internal_cost_recommendations; ne les ajoute jamais à work_items.",
          "N'ajoute pas un complément déjà présent dans work_items, même si sa casse, ses accents ou son abréviation diffèrent.",
          "Pour une désignation ambiguë, renseigne les choix dans options et le choix provisoire le plus probable dans default_option.",
          "Toute hypothèse structurelle ou dimension d'acier doit avoir requires_validation=true et une safety_note demandant confirmation par les plans ou le BET.",
          "source_basis explique si la recommandation vient des exigences usuelles de travaux similaires à Madagascar ou d'une déduction du DAO.",
          "Pour chaque poste item, pricing_context résume les informations des plans, coupes, détails et CCTP utiles à son futur chiffrage, sans inventer un prix.",
          "Pour le coffrage, examine les plans de semelles, poteaux, poutres, linteaux, chaînages et dalles; indique les dimensions, surfaces, répétitions et possibilités de réemploi déductibles.",
          "Si le plan est incomplet, fournis dans pricing_context une hypothèse prudente de calepinage clairement signalée à valider, au lieu de laisser une composition inexploitable.",
        ].join(" "),
        input: [{
          role: "user",
          content: [
            {
              type: "input_file",
              filename: `DAO-${tender.reference || tender.id}.pdf`,
              file_data: pdfDataUrl,
            },
            {
              type: "input_text",
              text: [
                `DAO: ${tender.reference || "sans référence"} — ${tender.title}`,
                "Lis directement toutes les pages et leurs tableaux visuels.",
                "Préserve chaque titre d'ouvrage, sous-titre, ligne, numérotation et sous-total dans son ordre d'apparition.",
              ].join("\n"),
            },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "dao_work_items",
            strict: true,
            schema: daoSchema,
          },
        },
      }),
    });

    if (!aiResponse.ok) {
      const details = await aiResponse.text();
      console.error("OpenAI DAO analysis failed", aiResponse.status, details);
      return NextResponse.json(
        {
          error: "Le moteur IA n'a pas pu analyser le DAO.",
          upstream_status: aiResponse.status,
          details,
        },
        { status: 502 },
      );
    }

    const aiPayload = await aiResponse.json() as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const outputText = extractResponseText(aiPayload);
    if (!outputText) return NextResponse.json({ error: "Réponse IA vide." }, { status: 502 });

    let structured: {
      summary: string;
      execution_period_days: number | null;
      work_items: Array<{
        row_type: "section" | "item" | "subtotal";
        section_title: string;
        designation: string;
        category: string;
        unit: string;
        quantity: number | null;
        source_reference: string;
        needs_review: boolean;
        note: string;
        pricing_context: string;
      }>;
      warnings: string[];
      internal_cost_recommendations: Array<{
        kind: "labor" | "material" | "equipment" | "service" | "overhead";
        title: string;
        designation: string;
        unit: string;
        quantity: number | null;
        reason: string;
        source_basis: string;
        options: string[];
        default_option: string;
        requires_validation: boolean;
        safety_note: string;
      }>;
    };
    try {
      structured = JSON.parse(outputText) as typeof structured;
    } catch {
      return NextResponse.json({ error: "Réponse IA invalide." }, { status: 502 });
    }

    const analysis = {
      schema_version: "dao-visual-structured-v3",
      ...structured,
      resume: structured.summary,
      lots: structured.work_items.map((item) => ({
        row_type: item.row_type,
        section_title: item.section_title,
        designation: item.designation,
        categorie: item.category,
        quantite: item.quantity,
        unite: item.unit,
        source_reference: item.source_reference,
        needs_review: item.needs_review,
        note: item.note,
        pricing_context: item.pricing_context,
      })),
    };

    const { error: updateError } = await supabase
      .from("tenders")
      .update({
        ai_analysis: analysis,
      })
      .eq("id", tender.id);
    if (updateError) {
      console.error("DAO analysis save failed", updateError);
      return NextResponse.json({ error: "Analyse produite, mais enregistrement impossible." }, { status: 500 });
    }

    return NextResponse.json({ success: true, analysis });
  } catch (error) {
    console.error("DAO analysis error", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur pendant l'analyse du DAO." },
      { status: 500 },
    );
  }
}
