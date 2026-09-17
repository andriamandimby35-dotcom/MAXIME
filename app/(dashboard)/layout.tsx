import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { DashboardNav } from "@/components/DashboardNav";


export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {


  const supabase = await createServerClient();


  const {
    data: { user },
  } = await supabase.auth.getUser();



  if (!user) {
    redirect("/login");
  }

  // Un compte tout juste invité doit d'abord voir son invitation acceptée
  // (création de l'accès entreprise + chantier) avant qu'on vérifie ses
  // droits ci-dessous — sinon un tout premier accès pourrait être bloqué à
  // tort par la vérification qui suit.
  await supabase.rpc("accept_my_project_access_invitations");

  const { data: member } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();
  const isAdmin = Boolean(member?.active && ["owner", "admin"].includes(member.role));

  // Un conducteur ou un chef de chantier ne doit plus pouvoir entrer dans
  // l'application dès qu'il n'est plus attaché à AUCUN chantier — typiquement
  // parce que le seul chantier auquel il était rattaché a été supprimé
  // (la suppression retire aussi sa ligne project_assignments). S'il reste
  // attaché à au moins un autre chantier (même clôturé/verrouillé), il garde
  // l'accès normalement.
  if (!isAdmin) {
    const { count: assignmentCount } = await supabase
      .from("project_assignments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    if (!assignmentCount) {
      await supabase.auth.signOut();
      redirect("/login?acces=chantier_supprime");
    }
  }

  // Le conducteur de travaux a, en plus de "Chantier", accès au menu Dépense
  // complet (comme l'administrateur, sans les suppressions) : il est affiché
  // en onglet directement sur la page "Chantier" (voir
  // app/(dashboard)/projects/[id]/page.tsx), donc plus besoin d'un second
  // lien "Dépense" dans le menu de gauche — il menait de toute façon à la
  // même page.
  const { data: worksManagerAssignments } = isAdmin
    ? { data: [] }
    : await supabase
        .from("project_assignments")
        .select("project_id")
        .eq("user_id", user.id)
        .eq("role", "works_manager")
        .eq("active", true);
  const isWorksManager = !isAdmin && Boolean(worksManagerAssignments?.length);



  return (

    <div className="dashboardLayout">


      <DashboardNav isAdmin={isAdmin} isWorksManager={isWorksManager} />



      <main className="mainContent">

        {children}

      </main>


    </div>

  );

}
