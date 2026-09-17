import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { CreateProjectFlow } from "@/components/projects/CreateProjectFlow";
import { ProjectCard } from "@/components/projects/ProjectCard";

export default async function ProjectsPage() {
  const { supabase, organizationId, memberRole, user } = await getContext();
  const isAdmin = memberRole === "admin" || memberRole === "owner";
  const { data: projects } = organizationId
    ? await supabase.from("projects").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false })
    : { data: [] };
  // Un conducteur ou chef de chantier ne voit que les chantiers où il a (ou
  // avait) un accès actif — jamais l'ensemble des chantiers de l'entreprise.
  // Un accès seulement mis en pause par une clôture (paused_by_closure)
  // compte aussi : la personne doit continuer à voir la carte, désormais
  // rouge, du chantier clôturé — pas la voir disparaître.
  let projectRows = projects ?? [];
  if (!isAdmin && user) {
    const { data: assignments } = await supabase.from("project_assignments").select("*").eq("user_id", user.id);
    const allowedIds = new Set((assignments ?? []).filter((row: any) => row.active || row.paused_by_closure).map((row: any) => row.project_id));
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
        return <ProjectCard
          key={project.id}
          project={project}
          taskStats={{ completed, total: projectTasks.length }}
          reportsCount={projectReports}
          isAdmin={isAdmin}
        />;
      })}
    </section>}
  </main>;
}
