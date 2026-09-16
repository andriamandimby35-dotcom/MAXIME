import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createOrSyncProjectFromEstimate } from "@/lib/projects/create-project-from-estimate";

// Création d'un chantier, depuis la page Chantiers (bouton "+ Ajouter un
// chantier"), de deux façons possibles :
// - "automatique" : on donne un devis déjà fait ({estimateId}). Les prix ne
//   sont pas utilisés pour le planning : seuls les travaux à réaliser sont
//   extraits pour construire la liste de tâches et le pourcentage
//   d'avancement (le bordereau de prix est copié à part, pour la fiche du
//   chantier, sans lien avec ce planning).
// - "manuel" ({mode: "manual", name, location, tasks}) : le chantier est créé
//   directement avec la liste de travaux saisie à la main, sans aucun devis.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    estimateId?: string;
    mode?: string;
    name?: string;
    location?: string;
    tasks?: string[];
  };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.organization_id) return NextResponse.json({ error: "Organisation introuvable." }, { status: 403 });

  // Diagnostic temporaire : vérifie ce que la base de données voit vraiment
  // comme utilisateur connecté au moment de la requête (auth.uid()), ET si
  // elle considère cet utilisateur comme admin de son organisation
  // (is_organization_admin), exactement au moment où l'insertion va être
  // tentée. Nécessite la fonction SQL temporaire public.whoami(p_org_id),
  // mise à jour pour accepter l'identifiant de l'organisation.
  const whoAmI = await supabase.rpc("whoami", { p_org_id: member.organization_id }).then(
    (result) => result,
    (error) => ({ data: null, error }),
  );
  console.log("[diag] whoami", { appUserId: user.id, dbSees: whoAmI.data, rpcError: whoAmI.error });

  if (body.mode === "manual") {
    const name = (body.name || "").trim();
    if (!name) return NextResponse.json({ error: "Le nom du chantier est obligatoire." }, { status: 400 });

    // On choisit nous-mêmes l'identifiant du chantier avant de l'enregistrer,
    // au lieu de demander à la base de nous le redonner juste après (via
    // .select().single()). En effet, juste après la création, la base doit
    // aussi vérifier qu'on peut "relire" cette toute nouvelle ligne — une
    // vérification distincte de celle qui autorise la création elle-même —
    // et c'était cette relecture immédiate qui bloquait, même quand la
    // création en elle-même était bien autorisée. Comme on connaît déjà
    // l'identifiant à l'avance, on n'a plus besoin de cette relecture.
    const projectId = randomUUID();
    const { error: createError } = await supabase
      .from("projects")
      .insert({
        id: projectId,
        organization_id: member.organization_id,
        name,
        location: (body.location || "").trim() || null,
        status: "planned",
      });
    if (createError) {
      // Diagnostic temporaire : affiche le détail complet de l'erreur dans le
      // terminal du serveur (code/details/hint Postgres), en plus du message,
      // pour comprendre précisément pourquoi la sécurité de la base bloque la
      // création alors que le compte est bien "owner".
      console.error("[create project] insert failed", {
        userId: user.id,
        organizationId: member.organization_id,
        error: createError,
      });
      return NextResponse.json({
        error: createError.message,
        code: (createError as { code?: string }).code,
        details: (createError as { details?: string }).details,
        hint: (createError as { hint?: string }).hint,
        diagAppUserId: user.id,
        diagDbSees: whoAmI.data,
        diagRpcError: whoAmI.error ? String((whoAmI.error as { message?: string }).message ?? whoAmI.error) : null,
      }, { status: 400 });
    }

    // dao_sequence sert uniquement à figer l'ordre de la liste (celui saisi à
    // la main, ou celui déjà organisé par l'extraction du PDF) : sans lui,
    // l'ordre affiché pourrait changer après une mise à jour, alors que ce
    // classement sert de base au suivi d'avancement et aux rapports.
    const taskTitles = (body.tasks ?? []).map((title) => title.trim()).filter(Boolean);
    if (taskTitles.length > 0) {
      const { error: tasksError } = await supabase.from("project_tasks").insert(
        taskTitles.map((title, index) => ({
          organization_id: member.organization_id,
          project_id: projectId,
          title,
          dao_sequence: index + 1,
          is_dao_task: false,
        })),
      );
      if (tasksError) return NextResponse.json({ error: tasksError.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, projectId });
  }

  const estimateId = body.estimateId;
  if (!estimateId) return NextResponse.json({ error: "Devis manquant." }, { status: 400 });

  const result = await createOrSyncProjectFromEstimate(supabase, {
    organizationId: member.organization_id,
    estimateId,
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true, projectId: result.projectId });
}
