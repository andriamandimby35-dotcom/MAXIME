import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

type ChecklistItem = { id: string; label: string; done: boolean };

function extractResponseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text;
  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

// Découpe chaque étape du planning DAO en sous-tâches concrètes, une fois pour
// toutes, afin que le chef de chantier n'ait plus qu'à cocher ce qui a été
// fait aujourd'hui au lieu de taper du texte libre.
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: project } = await supabase.from("projects").select("id, organization_id, name").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.active || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Seul l'administrateur peut générer les sous-tâches." }, { status: 403 });
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("project_tasks")
    .select("id, title, checklist")
    .eq("project_id", projectId)
    .eq("is_dao_task", true);
  if (tasksError) return NextResponse.json({ error: `Lecture du planning impossible : ${tasksError.message}` }, { status: 500 });

  const pending = (tasks ?? []).filter((task) => !Array.isArray(task.checklist) || task.checklist.length === 0);
  if (!pending.length) return NextResponse.json({ generated: 0, message: "Toutes les étapes ont déjà leurs sous-tâches." });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY n'est pas configurée." }, { status: 503 });

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      store: false,
      instructions: [
        "Tu prépares le suivi de chantier BTP à Madagascar pour un chef de chantier peu à l'aise avec la saisie de texte.",
        "Pour chaque étape du planning fournie, découpe-la en 4 à 8 sous-tâches concrètes, dans l'ordre d'exécution réel.",
        "Chaque sous-tâche doit être une action courte et précise (4 à 7 mots), au format 'verbe + complément', par exemple 'Implantation des axes' ou 'Évacuation des déblais'.",
        "N'invente pas de sous-tâche hors sujet ; reste strictement dans le périmètre du titre de l'étape.",
        "Réponds uniquement pour les étapes listées, dans le même ordre, sans en omettre ni en ajouter.",
      ].join(" "),
      input: pending.map((task, index) => `${index + 1}. ${task.title}`).join("\n"),
      text: {
        format: {
          type: "json_schema",
          name: "dao_task_checklist",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    steps: { type: "array", items: { type: "string" } },
                  },
                  required: ["title", "steps"],
                },
              },
            },
            required: ["tasks"],
          },
        },
      },
    }),
  });

  if (!aiResponse.ok) {
    const details = await aiResponse.text();
    console.error("OpenAI checklist generation failed", aiResponse.status, details);
    return NextResponse.json({ error: "La génération des sous-tâches a échoué." }, { status: 502 });
  }

  const responsePayload = await aiResponse.json();
  const outputText = extractResponseText(responsePayload);
  if (!outputText) return NextResponse.json({ error: "Aucune sous-tâche exploitable n'a été générée." }, { status: 502 });

  let parsed: { tasks: Array<{ title: string; steps: string[] }> };
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return NextResponse.json({ error: "Réponse de génération invalide." }, { status: 502 });
  }

  let generated = 0;
  let firstError: string | null = null;
  for (let index = 0; index < pending.length; index += 1) {
    const task = pending[index];
    const steps = parsed.tasks[index]?.steps ?? [];
    if (!steps.length) continue;
    const checklist: ChecklistItem[] = steps.map((label) => ({ id: crypto.randomUUID(), label, done: false }));
    const { error } = await supabase.from("project_tasks").update({ checklist }).eq("id", task.id);
    if (error) { console.error("[generate-task-checklist] update failed", task.id, error); firstError ??= error.message; }
    else generated += 1;
  }

  const { data: updatedTasks } = await supabase.from("project_tasks").select("*").eq("project_id", projectId).order("dao_sequence", { ascending: true });
  const message = generated
    ? `${generated} étape(s) découpée(s) en sous-tâches.`
    : `Aucune étape mise à jour${firstError ? ` : ${firstError}` : ""}.`;
  return NextResponse.json({ generated, tasks: updatedTasks ?? [], message });
}
