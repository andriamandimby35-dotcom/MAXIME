import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

type ReviewSuggestion = {
  suggestion_type: "progress" | "material_need" | "stock_alert" | "photo_issue" | "planning_risk" | "safety";
  severity: "info" | "review" | "urgent";
  title: string;
  content: string;
  confidence: number;
};

const reviewSchema = {
  type: "object", additionalProperties: false,
  properties: {
    suggestions: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, properties: {
      suggestion_type: { type: "string", enum: ["progress", "material_need", "stock_alert", "photo_issue", "planning_risk", "safety"] },
      severity: { type: "string", enum: ["info", "review", "urgent"] }, title: { type: "string" }, content: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 100 },
    }, required: ["suggestion_type", "severity", "title", "content", "confidence"] } },
  }, required: ["suggestions"],
} as const;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: project, error: projectError } = await supabase.from("projects")
    .select("id, organization_id, name, location, progress_percent, planned_end_date, status")
    .eq("id", projectId).maybeSingle();
  if (projectError || !project) return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });

  const [tasks, reports, materials, usages, photos] = await Promise.all([
    supabase.from("project_tasks").select("title,status,planned_start_date,planned_end_date,progress_percent,notes").eq("project_id", projectId),
    supabase.from("project_daily_reports").select("id,report_date,weather,workers_present,completed_work,next_day_plan,issues").eq("project_id", projectId).order("report_date", { ascending: false }).limit(14),
    supabase.from("project_materials").select("designation,unit,on_site_quantity,required_tomorrow,required_week,minimum_stock,notes").eq("project_id", projectId),
    supabase.from("project_report_material_usages").select("report_id,material_id,quantity,unit,created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(250),
    supabase.from("project_photos").select("id,report_id,storage_path,photo_type,caption,captured_at").eq("project_id", projectId).order("captured_at", { ascending: false }).limit(20),
  ]);
  if (tasks.error || reports.error || materials.error || usages.error || photos.error) return NextResponse.json({ error: "Les données du chantier ne peuvent pas être lues." }, { status: 500 });

  const photoRows = photos.data ?? [];
  const signedPhotos = await Promise.all(photoRows.slice(0, 6).map(async (photo) => {
    const { data } = await supabase.storage.from("btp-documents").createSignedUrl(photo.storage_path, 60 * 10);
    return { ...photo, signedUrl: data?.signedUrl ?? null };
  }));
  const visualPhotos = signedPhotos.filter((photo): photo is typeof photo & { signedUrl: string } => Boolean(photo.signedUrl));
  const snapshot = {
    generated_at: new Date().toISOString(), project, tasks: tasks.data ?? [], recent_reports: reports.data ?? [], materials: materials.data ?? [], report_material_usages: usages.data ?? [],
    photo_metadata: photoRows.map(({ storage_path: _storagePath, ...photo }) => photo),
    visual_photos_sent: visualPhotos.map(({ signedUrl: _signedUrl, ...photo }) => photo),
  };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: JSON.stringify(snapshot) }];
  visualPhotos.forEach((photo) => content.push({ type: "input_image", image_url: photo.signedUrl, detail: "low" }));
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_SITE_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini", store: false,
      instructions: "Tu es un assistant de pilotage de chantier BTP à Madagascar. Analyse uniquement les données fournies. Les photos jointes doivent être examinées visuellement lorsqu'elles sont disponibles ; sinon, utilise seulement leur légende et ne prétends pas constater ce qui n'est pas visible. Compare les consommations déclarées avec les rapports, les stocks et les photos. Si un écart important ou physiquement improbable apparaît, produis une alerte factuelle de type stock_alert ou photo_issue demandant une vérification terrain. Ne conclus jamais à une fraude et n'accuse jamais une personne. Propose au plus six recommandations concises et actionnables concernant le stock, les besoins, le planning, la sécurité, l'avancement ou les anomalies. Chaque recommandation indique sa base factuelle et demande une vérification terrain si les données sont insuffisantes. Une anomalie grave ou de sécurité est urgent, un risque à contrôler est review, les autres informations sont info. Réponds uniquement au format demandé.",
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "site_review", strict: true, schema: reviewSchema } },
    }),
  });
  if (!aiResponse.ok) { console.error("OpenAI site review failed", aiResponse.status, await aiResponse.text()); return NextResponse.json({ error: "L'analyse en ligne a échoué." }, { status: 502 }); }
  const payload = await aiResponse.json() as { output_text?: string };
  if (!payload.output_text) return NextResponse.json({ error: "L'analyse n'a produit aucun résultat exploitable." }, { status: 502 });
  let result: { suggestions: ReviewSuggestion[] };
  try { result = JSON.parse(payload.output_text) as { suggestions: ReviewSuggestion[] }; }
  catch { return NextResponse.json({ error: "Réponse d'analyse invalide." }, { status: 502 }); }

  const rows = (result.suggestions ?? []).map((suggestion) => ({
    organization_id: project.organization_id, project_id: projectId, suggestion_type: suggestion.suggestion_type,
    title: suggestion.title.trim().slice(0, 180), content: suggestion.content.trim(),
    confidence: Math.max(0, Math.min(100, Number(suggestion.confidence) || 0)), source_snapshot: snapshot, status: "pending",
  })).filter((suggestion) => suggestion.title && suggestion.content);
  if (!rows.length) return NextResponse.json({ suggestions: [], messages: [], message: "Aucune recommandation nouvelle n'est nécessaire." });
  const { data: saved, error: saveError } = await supabase.from("project_ai_suggestions").insert(rows).select();
  if (saveError) return NextResponse.json({ error: "Analyse terminée, mais recommandations non enregistrées." }, { status: 500 });

  const notificationRows = (saved ?? []).filter((suggestion) => ["photo_issue", "safety", "planning_risk", "stock_alert"].includes(suggestion.suggestion_type)).map((suggestion) => ({
    organization_id: project.organization_id, project_id: projectId, entity_type: "suggestion", entity_id: suggestion.id,
    severity: suggestion.suggestion_type === "safety" ? "urgent" : "review", title: `Alerte chantier — ${suggestion.title}`, content: suggestion.content,
  }));
  let messages: unknown[] = [];
  if (notificationRows.length) {
    const { data, error } = await supabase.from("project_record_notes").insert(notificationRows).select();
    if (!error) messages = data ?? [];
    else console.error("Project review messages could not be saved", error);
  }
  return NextResponse.json({ suggestions: saved ?? [], messages, message: `${saved?.length ?? 0} recommandation(s) enregistrée(s).${messages.length ? ` ${messages.length} alerte(s) envoyée(s) dans la messagerie.` : ""}` });
}
