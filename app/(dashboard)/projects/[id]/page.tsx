import { notFound } from "next/navigation";
import { ProjectSiteManager } from "@/components/projects/ProjectSiteManager";
import { getContext } from "@/lib/organization";
import { createAdminClient } from "@/lib/supabase/admin";

type Params = { id: string };

export default async function ProjectPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;
  const { supabase, organizationId, user, memberRole } = await getContext();
  if (!organizationId || !user) notFound();

  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!project) notFound();

  const [
    { data: priceItems }, { data: tasks }, { data: reports }, { data: materials },
    { data: stockMovements }, { data: reportMaterialUsages }, { data: photos }, { data: suggestions }, { data: notes },
    { data: assignments }, invitationResult, { data: materialOrders }, { data: staffMembers }, { data: attendance },
  ] = await Promise.all([
    supabase.from("project_price_items").select("*").eq("project_id", id).order("created_at", { ascending: true }),
    supabase.from("project_tasks").select("*").eq("project_id", id).order("dao_sequence", { ascending: true }).order("created_at"),
    supabase.from("project_daily_reports").select("*").eq("project_id", id).order("report_date", { ascending: false }),
    supabase.from("project_materials").select("*").eq("project_id", id).order("created_at"),
    supabase.from("project_stock_movements").select("*").eq("project_id", id).order("movement_date", { ascending: false }),
    supabase.from("project_report_material_usages").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    supabase.from("project_photos").select("*").eq("project_id", id).order("captured_at", { ascending: false }),
    supabase.from("project_ai_suggestions").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    supabase.from("project_record_notes").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    // Les accès retirés (active=false) restent chargés aussi : ils sont
    // affichés dans un petit historique avec leur date de retrait, au lieu
    // de disparaître (comme pour l'équipe déclarée et les photos).
    supabase.from("project_assignments").select("*").eq("project_id", id),
    supabase.from("project_access_invitations").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    supabase.from("project_material_orders").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    supabase.from("project_staff_members").select("*").eq("project_id", id).order("full_name"),
    supabase.from("project_daily_attendance").select("*").eq("project_id", id).order("report_date", { ascending: false }),
  ]);

  const isAdmin = memberRole === "admin" || memberRole === "owner";

  // Les e-mails des comptes conducteur/chef ne sont pas stockés sur
  // project_assignments : ils sont recherchés via le client admin, pour les
  // afficher lisiblement et permettre de choisir un conducteur parent.
  const uniqueAssignmentUserIds = [...new Set((assignments ?? []).map((assignment: any) => assignment.user_id))];
  const admin = createAdminClient();
  const assignmentEmails = new Map<string, string>();
  const assignmentDisplayNames = new Map<string, string>();
  await Promise.all(uniqueAssignmentUserIds.map(async (uid) => {
    const { data } = await admin.auth.admin.getUserById(uid as string);
    if (data.user?.email) assignmentEmails.set(uid as string, data.user.email);
    const identifier = data.user?.user_metadata?.identifier as string | undefined;
    assignmentDisplayNames.set(
      uid as string,
      identifier || data.user?.email?.split("@")[0] || (uid as string).slice(0, 8),
    );
  }));
  // Le mot de passe stocké ne doit jamais atteindre le navigateur d'un
  // compte non administrateur, même si la ligne project_assignments lui est
  // par ailleurs visible (accès à sa propre affectation, à celle de son
  // équipe, etc.).
  const enrichedAssignments = (assignments ?? []).map((assignment: any) => ({
    ...assignment,
    email: assignmentEmails.get(assignment.user_id) ?? null,
    displayName: assignmentDisplayNames.get(assignment.user_id) ?? assignment.user_id.slice(0, 8),
    access_password: isAdmin ? assignment.access_password ?? null : null,
  }));

  const ownAssignment = enrichedAssignments.find((assignment: any) => assignment.user_id === user.id && assignment.active);
  const accessRole = (isAdmin ? "admin" : (ownAssignment?.role ?? "viewer")) as "admin" | "works_manager" | "site_manager" | "viewer";

  return <ProjectSiteManager
    organizationId={organizationId}
    userId={user.id}
    accessRole={accessRole}
    projectPage
    assignments={enrichedAssignments}
    invitations={invitationResult.data ?? []}
    projects={[project]}
    priceItems={priceItems ?? []}
    tasks={tasks ?? []}
    reports={reports ?? []}
    materials={materials ?? []}
    stockMovements={stockMovements ?? []}
    reportMaterialUsages={reportMaterialUsages ?? []}
    photos={photos ?? []}
    suggestions={suggestions ?? []}
    notes={notes ?? []}
    materialOrders={materialOrders ?? []}
    staffMembers={staffMembers ?? []}
    attendance={attendance ?? []}
  />;
}
