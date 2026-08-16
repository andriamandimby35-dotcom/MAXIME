import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const memoireSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cover_title: { type: "string" },
    executive_summary: { type: "string" },
    understanding_of_need: { type: "string" },
    methodology: { type: "array", items: { type: "string" } },
    organization_and_staffing: { type: "array", items: { type: "string" } },
    equipment_and_materials: { type: "array", items: { type: "string" } },
    quality_plan: { type: "array", items: { type: "string" } },
    health_safety_environment: { type: "array", items: { type: "string" } },
    schedule_and_milestones: { type: "array", items: { type: "string" } },
    risk_management: { type: "array", items: { type: "string" } },
    local_context: { type: "array", items: { type: "string" } },
    assumptions_and_reservations: { type: "array", items: { type: "string" } },
    submission_checklist: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          item: { type: "string" },
          status: { type: "string", enum: ["à préparer", "à vérifier", "prêt"] },
          note: { type: "string" },
        },
        required: ["item", "status", "note"],
      },
    },
  },
  required: [
    "cover_title", "executive_summary", "understanding_of_need", "methodology",
    "organization_and_staffing", "equipment_and_materials", "quality_plan",
    "health_safety_environment", "schedule_and_milestones", "risk_management",
    "local_context", "assumptions_and_reservations", "submission_checklist"
  ],
} as const;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });

  const body = await request.json().catch(() => null) as {
    tenderId?: string;
    companyName?: string;
    proposedDuration?: string;
  } | null;

  const tenderId = body?.tenderId?.trim();
  const companyName = body?.companyName?.trim();
  const proposedDuration = body?.proposedDuration?.trim() || "non précisée";
  if (!tenderId || !companyName) {
    return NextResponse.json({ error: "L’appel d’offres et le nom de l’entreprise sont requis." }, { status: 400 });
  }

  const { data: tender, error } = await supabase
    .from("tenders")
    .select("id,reference,title,contracting_authority,location,submission_deadline,summary,requirements,missing_documents")
    .eq("id", tenderId)
    .single();

  if (error || !tender) return NextResponse.json({ error: "Appel d’offres introuvable." }, { status: 404 });
  if (!tender.summary || !tender.requirements) {
    return NextResponse.json({ error: "Analysez d’abord ce DAO avant de générer le mémoire." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n’est pas configurée sur le serveur." }, { status: 503 });

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      store: false,
      instructions: [
        "Tu es un ingénieur BTP senior spécialisé dans les mémoires techniques pour marchés de travaux à Madagascar.",
        "Rédige une trame professionnelle en français, directement exploitable mais nécessitant une validation humaine.",
        "Utilise uniquement les exigences et informations fournies.",
        "N’invente jamais de personnel, références, certifications, équipements, délais contractuels ou capacités de l’entreprise.",
        "Lorsqu’une information manque, formule une hypothèse explicite ou une action à vérifier.",
        "Distingue les obligations du DAO des propositions méthodologiques raisonnables.",
        "La checklist doit reprendre les pièces détectées et marquer comme à vérifier toute pièce dont la disponibilité n’est pas connue."
      ].join(" "),
      input: JSON.stringify({
        company: companyName,
        proposed_duration: proposedDuration,
        tender: {
          reference: tender.reference,
          title: tender.title,
          contracting_authority: tender.contracting_authority,
          location: tender.location,
          submission_deadline: tender.submission_deadline,
          summary: tender.summary,
          analysis: tender.requirements,
          documents_to_verify: tender.missing_documents,
        },
      }),
      text: {
        format: {
          type: "json_schema",
          name: "technical_memoire",
          strict: true,
          schema: memoireSchema,
        },
      },
    }),
  });

  if (!aiResponse.ok) {
    const details = await aiResponse.text();
    console.error("OpenAI memoire generation failed", aiResponse.status, details);
    return NextResponse.json({ error: "Le moteur IA n’a pas pu générer le mémoire." }, { status: 502 });
  }

  const payload = await aiResponse.json() as { output_text?: string };
  if (!payload.output_text) return NextResponse.json({ error: "Réponse IA vide." }, { status: 502 });

  try {
    const memoire = JSON.parse(payload.output_text);
    return NextResponse.json({ memoire });
  } catch {
    return NextResponse.json({ error: "Le mémoire généré n’est pas dans un format valide." }, { status: 502 });
  }
}
