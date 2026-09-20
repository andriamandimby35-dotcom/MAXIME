import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push/send-push";

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerClient>>;

// Point d'entrée UNIQUE pour toutes les notifications push liées à un
// chantier : le client (ProjectSiteManager.tsx) appelle cette route juste
// après avoir créé/modifié la donnée réelle (remarque, demande de matériaux,
// achat vérifié...) — voir chaque appel fetch(`/api/projects/${id}/notify`)
// dans ce composant pour la liste des évènements réellement déclenchés
// aujourd'hui. Le texte du message et la liste des destinataires sont
// calculés ICI, jamais envoyés tels quels par le client, pour rester
// cohérents et ne jamais dépendre d'un texte arbitraire.
//
// N'échoue jamais bruyamment : un problème d'envoi ne doit jamais empêcher
// l'action d'origine (déjà enregistrée avant cet appel) de réussir aux yeux
// de l'utilisateur — voir sendPushToUsers, qui journalise sans lever d'erreur.
async function getAdmins(supabase: ServerSupabaseClient, organizationId: string, excludeUserId: string) {
  const { data } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .in("role", ["owner", "admin"]);
  return (data ?? []).map((row) => row.user_id as string).filter((id) => id && id !== excludeUserId);
}

async function getProjectAssignees(supabase: ServerSupabaseClient, projectId: string, excludeUserId: string, roles?: string[]) {
  let query = supabase.from("project_assignments").select("user_id, role").eq("project_id", projectId).eq("active", true);
  if (roles?.length) query = query.in("role", roles);
  const { data } = await query;
  return (data ?? []).map((row) => row.user_id as string).filter((id) => id && id !== excludeUserId);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  const { data: project } = await supabase.from("projects").select("id, organization_id, name").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Chantier introuvable." }, { status: 404 });

  const { data: member } = await supabase
    .from("organization_members")
    .select("active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member?.active) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const data = (await request.json().catch(() => null) ?? {}) as Record<string, unknown>;
  const event = String(data.event || "");
  const projectUrl = `/projects/${projectId}`;
  const projectLabel = project.name || "un chantier";

  switch (event) {
    case "note_created": {
      const severity = String(data.severity || "info");
      const title = String(data.title || "").slice(0, 160);
      const recipients = [
        ...await getAdmins(supabase, project.organization_id, user.id),
        ...await getProjectAssignees(supabase, projectId, user.id),
      ];
      const label = severity === "urgent" ? "⚠️ Remarque urgente" : severity === "review" ? "Remarque à vérifier" : "Nouvelle remarque";
      await sendPushToUsers(recipients, { title: `${label} — ${projectLabel}`, body: title || "Nouvelle remarque sur le chantier.", url: projectUrl });
      break;
    }
    case "note_replied": {
      const targetUserId = String(data.targetUserId || "");
      const title = String(data.title || "").slice(0, 160);
      if (targetUserId && targetUserId !== user.id) {
        await sendPushToUsers([targetUserId], { title: `Réponse à votre remarque — ${projectLabel}`, body: title || "Une réponse a été ajoutée à votre remarque.", url: projectUrl });
      }
      break;
    }
    case "material_order_submitted": {
      const materialName = String(data.materialName || "un matériau");
      const quantity = String(data.quantity || "");
      const unit = String(data.unit || "");
      const recipients = [
        ...await getAdmins(supabase, project.organization_id, user.id),
        ...await getProjectAssignees(supabase, projectId, user.id, ["works_manager"]),
      ];
      await sendPushToUsers(recipients, { title: `Nouvelle demande d’achat — ${projectLabel}`, body: `${materialName}${quantity ? ` : ${quantity} ${unit}`.trimEnd() : ""}`, url: projectUrl });
      break;
    }
    case "material_order_decided": {
      const targetUserId = String(data.targetUserId || "");
      const materialName = String(data.materialName || "votre demande");
      const decision = String(data.decision || "");
      if (targetUserId && targetUserId !== user.id) {
        const label = decision === "rejected" ? "Demande refusée" : decision === "covered_by_stock" ? "Demande couverte par le stock" : "Demande validée — à acheter";
        await sendPushToUsers([targetUserId], { title: `${label} — ${projectLabel}`, body: materialName, url: projectUrl });
      }
      break;
    }
    case "purchase_verified": {
      const materialName = String(data.materialName || "un achat");
      const verdict = String(data.verdict || "");
      const recipients = [
        ...await getAdmins(supabase, project.organization_id, user.id),
        ...await getProjectAssignees(supabase, projectId, user.id),
      ];
      const label = verdict === "mismatch" ? "⚠️ Écart détecté sur un achat" : "Achat validé";
      await sendPushToUsers(recipients, { title: `${label} — ${projectLabel}`, body: materialName, url: projectUrl });
      break;
    }
    default:
      return NextResponse.json({ error: "Évènement de notification inconnu." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
