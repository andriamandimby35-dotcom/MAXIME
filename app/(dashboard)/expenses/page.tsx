import Link from "next/link";
import { getContext } from "@/lib/organization";
import { RealtimeRefresh } from "@/components/realtime-refresh";

const number = (value: number | string | null) => Number(value ?? 0);
const money = (value: number) => `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Ar`;

// Chaque chantier a ses propres dépenses (salaires, achats, transport,
// imprévus) : ce répertoire ne montre qu'un total par chantier, le détail
// s'ouvre en cliquant, comme pour l'espace chantier.
export default async function ExpensesPage() {
  const { supabase, organizationId, memberRole, user } = await getContext();
  const isAdmin = memberRole === "admin" || memberRole === "owner";
  const { data: projects } = organizationId
    ? await supabase.from("projects").select("id,name,project_code").eq("organization_id", organizationId).order("created_at", { ascending: false })
    : { data: [] };
  let projectRows = projects ?? [];
  if (!isAdmin && user) {
    const { data: assignments } = await supabase.from("project_assignments").select("project_id").eq("user_id", user.id).eq("active", true);
    const allowedIds = new Set((assignments ?? []).map((row) => row.project_id));
    projectRows = projectRows.filter((project: any) => allowedIds.has(project.id));
  }
  const { data: paidOrders } = organizationId
    ? await supabase.from("project_material_orders").select("project_id,quantity,unit_price,status").eq("organization_id", organizationId).eq("status", "paid").is("deleted_at", null)
    : { data: [] };
  const { data: salaryPayments } = organizationId
    ? await supabase.from("project_salary_payments").select("project_id,total_amount").is("deleted_at", null)
    : { data: [] };

  const totalByProject = new Map<string, number>();
  for (const order of paidOrders ?? []) {
    const total = number(order.quantity) * number(order.unit_price);
    totalByProject.set(order.project_id, (totalByProject.get(order.project_id) ?? 0) + total);
  }
  for (const payment of salaryPayments ?? []) {
    totalByProject.set(payment.project_id, (totalByProject.get(payment.project_id) ?? 0) + number(payment.total_amount));
  }

  return <main className="projectDirectory">
    <RealtimeRefresh channelName="expenses-directory" tables={[
      { table: "projects", filter: `organization_id=eq.${organizationId}` },
      { table: "project_material_orders", filter: `organization_id=eq.${organizationId}` },
      { table: "project_salary_payments", filter: `organization_id=eq.${organizationId}` },
    ]} />
    <header className="projectDirectoryHeader"><div>
      <p className="projectEyebrow">DÉPENSES ET APPROVISIONNEMENT</p><h1>Dépenses</h1>
      <p>Ouvrez un chantier pour consulter ses salaires, achats, transport et son compte de dépense générale.</p>
    </div><span className="projectRoleBadge">{isAdmin ? "Administrateur" : "Accès chantier"}</span></header>
    {!projectRows.length ? <section className="projectEmptyCard"><h2>Aucun chantier</h2><p>Un chantier apparaîtra ici dès qu&apos;un devis est validé.</p></section> : <section className="projectDirectoryGrid" aria-label="Liste des chantiers">
      {projectRows.map((project: any) => <Link key={project.id} href={`/expenses/${project.id}`} className="projectDirectoryCard">
        <span className="projectCardLabel">CHANTIER</span><h2>{project.name}</h2>
        <p className="projectCardLocation">{project.project_code || ""}</p>
        <div className="projectCardMetrics"><span><strong>{money(totalByProject.get(project.id) ?? 0)}</strong> dépensé</span></div>
        <span className="projectOpenButton">Voir les dépenses →</span>
      </Link>)}
    </section>}
  </main>;
}
