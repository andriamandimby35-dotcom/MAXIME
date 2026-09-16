import { NextResponse } from "next/server";
import { daoTasksFromAnalysis } from "@/lib/projects/dao-tasks";
import { createServerClient } from "@/lib/supabase/server";

type DatabaseError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

function databaseImportError(step: string, error: DatabaseError) {
  // The browser receives a useful action to take, while the complete error remains
  // in the server terminal for diagnosis without exposing database internals in production.
  console.error(`[import DAO tasks] ${step}`, error);
  const schemaMissing = error.code === "42703" || error.code === "42P01";
  const errorMessage = schemaMissing
    ? "La structure du planning DAO manque dans la base de données. Exécutez la migration de réparation du planning puis réessayez."
    : "Impossible d’importer le planning du DAO. Vérifiez les droits d’accès au chantier puis réessayez.";

  return NextResponse.json({
    error: process.env.NODE_ENV === "development" && error.message
      ? `${errorMessage} Détail : ${error.message}`
      : errorMessage,
  }, { status: 500 });
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, source_tender_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });
  if (!project.source_tender_id) return NextResponse.json({ imported: 0, message: "Ce chantier n'est pas rattaché à un DAO." });

  const { data: tender, error: tenderError } = await supabase.from("tenders")
    .select("ai_analysis")
    .eq("id", project.source_tender_id)
    .maybeSingle();
  if (tenderError || !tender?.ai_analysis) {
    return NextResponse.json({ error: "L'analyse du DAO est introuvable. Réanalysez le DAO puis réessayez l'importation." }, { status: 404 });
  }
  const normalized = daoTasksFromAnalysis(tender?.ai_analysis, project.organization_id, projectId);

  if (!normalized.length) return NextResponse.json({ imported: 0, message: "Aucune étape exploitable n'a été trouvée dans le planning du DAO." });
  const { data: existing, error: existingError } = await supabase
    .from("project_tasks")
    .select("dao_sequence,is_dao_task")
    .eq("project_id", projectId);
  if (existingError) return databaseImportError("lecture des tâches existantes", existingError);

  const importedSequences = new Set(
    (existing ?? [])
      .filter((task) => task.is_dao_task && task.dao_sequence !== null)
      .map((task) => Number(task.dao_sequence)),
  );
  const missingTasks = normalized.filter((task) => !importedSequences.has(task.dao_sequence));
  if (missingTasks.length) {
    const { error } = await supabase.from("project_tasks").insert(missingTasks);
    if (error) return databaseImportError("création des tâches du DAO", error);
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("project_tasks")
    .select("*")
    .eq("project_id", projectId)
    .order("dao_sequence", { ascending: true });
  if (tasksError) return databaseImportError("relecture du planning importé", tasksError);
  return NextResponse.json({
    imported: missingTasks.length,
    tasks: tasks ?? [],
    message: missingTasks.length ? `${missingTasks.length} étape(s) du DAO ajoutée(s).` : "Le planning du DAO est déjà présent.",
  });
}
