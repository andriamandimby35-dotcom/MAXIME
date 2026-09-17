import { notFound } from "next/navigation";
import { getContext } from "@/lib/organization";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProjectExpensesManager } from "@/components/expenses/ProjectExpensesManager";
import { RealtimeRefresh } from "@/components/realtime-refresh";

type Params = { id: string };

// Même raison que sur /projects/[id] : cette page doit toujours refléter
// l'état réel (clôturé ou non), même après un rechargement complet (F5).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export default async function ProjectExpensesPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;
  const { supabase, organizationId, user, memberRole } = await getContext();
  if (!organizationId || !user) notFound();

  const { data: project } = await supabase.from("projects").select("id, name, project_code, location, source_tender_id, organization_id, closed_at").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (!project) notFound();

  const isAdmin = memberRole === "admin" || memberRole === "owner";
  let accessRole: "admin" | "works_manager" | "site_manager" | "viewer" = "viewer";
  if (isAdmin) {
    accessRole = "admin";
  } else {
    // Un accès seulement mis en pause par une clôture (paused_by_closure)
    // compte aussi : la page reste accessible (en lecture verrouillée),
    // au lieu de renvoyer une page introuvable.
    const { data: ownAssignments } = await supabase.from("project_assignments").select("role,active,paused_by_closure").eq("project_id", id).eq("user_id", user.id);
    const assignment = (ownAssignments ?? []).find((row: any) => row.active || row.paused_by_closure);
    if (!assignment) notFound();
    accessRole = assignment.role as typeof accessRole;
  }

  const [
    { data: staffMembers },
    { data: attendance },
    { data: materialOrders },
    { data: salaryPayments },
    { data: laborRateOverrides },
    { data: teamAssignments },
    estimateLinesResult,
  ] = await Promise.all([
    supabase.from("project_staff_members").select("*").eq("project_id", id).eq("active", true).order("full_name"),
    supabase.from("project_daily_attendance").select("*").eq("project_id", id).order("report_date", { ascending: false }),
    supabase.from("project_material_orders").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    supabase.from("project_salary_payments").select("*, project_salary_payment_lines(*)").eq("project_id", id).is("deleted_at", null).order("paid_at", { ascending: false }),
    supabase.from("project_labor_rates").select("*").eq("project_id", id),
    // Conducteur(s) et chef(s) actifs : la paie du chantier doit les inclure,
    // au même titre que les ouvriers déclarés (comme la Présence du jour).
    supabase.from("project_assignments").select("id,user_id,role,phone_number,mvola_enabled,call_enabled,created_at").eq("project_id", id).eq("active", true).in("role", ["works_manager", "site_manager"]),
    project.source_tender_id
      ? (async () => {
          const { data: estimate } = await supabase.from("estimates").select("id").eq("source_tender_id", project.source_tender_id).maybeSingle();
          if (!estimate) return { data: [] };
          return supabase.from("estimate_lines").select("id, data").eq("estimate_id", estimate.id);
        })()
      : Promise.resolve({ data: [] }),
  ]);

  const laborRates = ((estimateLinesResult as { data: Array<{ id: string; data: Record<string, unknown> }> | null }).data ?? [])
    .filter((line) => line.data?.__internalOnly === true && line.data?.__recommendationKind === "labor")
    .map((line) => ({ designation: String(line.data["Désignation"] ?? ""), unitPrice: line.data["Prix unitaire"] }));

  // Le nom affiché d'un conducteur/chef n'est pas stocké sur
  // project_assignments : on le récupère via le client admin, comme pour
  // l'Espace chantier.
  const admin = createAdminClient();
  const displayNames = new Map<string, string>();
  await Promise.all((teamAssignments ?? []).map(async (assignment) => {
    const { data } = await admin.auth.admin.getUserById(assignment.user_id);
    const identifier = data.user?.user_metadata?.identifier as string | undefined;
    displayNames.set(assignment.id, identifier || data.user?.email?.split("@")[0] || assignment.user_id.slice(0, 8));
  }));
  const assignments = (teamAssignments ?? []).map((assignment) => ({
    ...assignment,
    displayName: displayNames.get(assignment.id) ?? assignment.user_id.slice(0, 8),
  }));

  // Cette page est normalement réservée à l'administrateur (le conducteur
  // passe désormais par l'onglet Dépense de /projects/[id]) ; en filet de
  // sécurité, un accès direct par un rôle terrain voit quand même son écran
  // se verrouiller ici pendant une clôture, comme sur l'Espace chantier.
  const fieldLocked = Boolean(project.closed_at) && accessRole !== "admin";
  const content = <ProjectExpensesManager
    project={project}
    accessRole={accessRole}
    userId={user.id}
    staffMembers={staffMembers ?? []}
    attendance={attendance ?? []}
    materialOrders={materialOrders ?? []}
    salaryPayments={(salaryPayments as any) ?? []}
    laborRates={laborRates}
    laborRateOverrides={laborRateOverrides ?? []}
    assignments={assignments}
  />;

  return <div style={{ position: "relative" }}>
    <RealtimeRefresh channelName={`project-closure-${id}`} tables={[{ table: "projects", filter: `id=eq.${id}` }]} />
    {fieldLocked && <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(255,255,255,.78)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
      <div>
        <p style={{ margin: "0 0 10px", fontSize: "clamp(1.5rem,5vw,2.3rem)", fontWeight: 900, color: "#7a2b2d", letterSpacing: "-.02em" }}>Chantier clôturé</p>
        <p style={{ margin: 0, fontSize: ".85rem", color: "#8a4a49" }}>Demandez à l’administrateur si vous souhaitez y accéder de nouveau.</p>
      </div>
    </div>}
    <div style={{ pointerEvents: fieldLocked ? "none" : undefined }}>{content}</div>
  </div>;
}
