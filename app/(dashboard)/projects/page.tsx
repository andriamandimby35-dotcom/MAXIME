import Link from "next/link";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { CreateProjectFlow } from "@/components/projects/CreateProjectFlow";

export default async function ProjectsPage() {
  const { supabase, organizationId, memberRole, user } = await getContext();
  const isAdmin = memberRole === "admin" || memberRole === "owner";
  const { data: projects } = organizationId
    ? await supabase.from("projects").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false })
    : { data: [] };
  // Un conducteur ou chef de chantier ne voit que les chantiers où il a un
  // accès actif — jamais l'ensemble des chantiers de l'entreprise.
  let projectRows = projects ?? [];
  if (!isAdmin && user) {
    const { data: assignments } = await supabase.from("project_assignments").select("project_id").eq("user_id", user.id).eq("active", true);
    const allowedIds = new Set((assignments ?? []).map((row) => row.project_id));
    projectRows = projectRows.filter((project: any) => allowedIds.has(project.id));
  }
  const [{ data: tasks }, { data: reports }] = await Promise.all([
    organizationId ? supabase.from("project_tasks").select("project_id,status").eq("organization_id", organizationId) : Promise.resolve({ data: [] }),
    organizationId ? supabase.from("project_daily_reports").select("project_id,id").eq("organization_id", organizationId) : Promise.resolve({ data: [] }),
  ]);

  return <main className="projectDirectory">
    <RealtimeRefresh channelName="projects-directory" tables={[
      { table: "projects", filter: `organization_id=eq.${organizationId}` },
      { table: "project_tasks", filter: `organization_id=eq.${organizationId}` },
      { table: "project_daily_reports", filter: `organization_id=eq.${organizationId}` },
    ]} />
    <header className="projectDirectoryHeader"><div>
      <p className="projectEyebrow">PILOTAGE OPÉRATIONNEL</p><h1>Chantiers</h1>
      <p>Ouvrez un chantier pour consulter le planning, les rapports et les accès de son équipe.</p>
    </div><div style={{ display: "flex", alignItems: "center", gap: 14 }}>{isAdmin && <CreateProjectFlow />}<span className="projectRoleBadge">{isAdmin ? "Administrateur" : "Accès chantier"}</span></div></header>
    {!projectRows.length ? <section className="projectEmptyCard"><h2>Aucun chantier</h2><p>{isAdmin ? "Cliquez sur « + Ajouter un chantier » pour en créer un." : "Un chantier apparaîtra ici dès que vous y êtes affecté."}</p></section> : <section className="projectDirectoryGrid" aria-label="Liste des chantiers">
      {projectRows.map((project: any) => {
        const projectTasks = (tasks ?? []).filter((task: any) => task.project_id === project.id);
        const completed = projectTasks.filter((task: any) => task.status === "completed").length;
        const projectReports = (reports ?? []).filter((report: any) => report.project_id === project.id).length;
        const location = project.location || "Localisation à confirmer";
        return <Link key={project.id} href={`/projects/${project.id}`} className="projectDirectoryCard">
          <span className="projectCardLabel">CHANTIER</span><h2>{project.name}</h2><p className="projectCardLocation">{location}</p>
          <div className="projectCardMetrics"><span><strong>{Number(project.progress_percent ?? 0)} %</strong> avancement</span><span><strong>{completed}/{projectTasks.length}</strong> tâche(s)</span><span><strong>{projectReports}</strong> rapport(s)</span></div>
          <span className="projectOpenButton">Ouvrir le chantier →</span>
        </Link>;
      })}
    </section>}
  </main>;
}
