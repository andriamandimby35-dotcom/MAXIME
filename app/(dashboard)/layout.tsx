import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";


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

  const { data: member } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();
  const isAdmin = Boolean(member?.active && ["owner", "admin"].includes(member.role));

  // Le conducteur de travaux a, en plus de "Mes chantiers", un accès en
  // lecture seule aux dépenses (et à la dépense matériaux) de ses chantiers.
  const { data: worksManagerAssignments } = isAdmin
    ? { data: [] }
    : await supabase
        .from("project_assignments")
        .select("id")
        .eq("user_id", user.id)
        .eq("role", "works_manager")
        .eq("active", true)
        .limit(1);
  const isWorksManager = !isAdmin && Boolean(worksManagerAssignments?.length);



  return (

    <div className="dashboardLayout">


      <aside className="sidebar">


        <div className="brand">

          <div className="logo">
            SB
          </div>


          <div>
            <strong>
              Sébastien BTP
            </strong>

            <small>
              May&Lanh - M&L
            </small>
          </div>

        </div>




        <nav>

          {isAdmin ? <>

          <Link href="/dashboard">
            Tableau de bord
          </Link>

          <span className="sidebarGroupLabel">Chantiers</span>

          <Link href="/projects">
            Chantiers
          </Link>

          <Link href="/expenses">
            Dépenses
          </Link>

          <Link href="/suppliers">
            Fournisseurs
          </Link>

          <Link href="/prices">
            Bibliothèque de prix
          </Link>

          <span className="sidebarGroupLabel">Appels d’offres</span>

          <Link href="/tenders">
            Appels d’offres
          </Link>

          <Link href="/submissions">
            Dossiers de soumission
          </Link>

          <Link href="/estimates">
            Devis
          </Link>

          <Link href="/billing">
            Situations & paiements
          </Link>

          <Link href="/prices">
            Bibliothèque de prix
          </Link>

          </> : <>

          <Link href="/projects">
            Mes chantiers
          </Link>

          {isWorksManager && <Link href="/expenses">
            Dépenses (lecture seule)
          </Link>}

          </>}


        </nav>



        <div className="companyBox">

          <strong>
            ANDRIAMANDIMBY Maxime
          </strong>

          <p>
            038 52 050 00
          </p>

          <p>
            NIF 30119171124
          </p>

          <p>
            STAT 410011 11 2022 0 06440
          </p>

          <form action="/auth/signout" method="post">
            <button type="submit" className="mt-4 w-full rounded border px-3 py-2 text-left">
              Déconnexion
            </button>
          </form>

        </div>


      </aside>



      <main className="mainContent">

        {children}

      </main>


    </div>

  );

}
