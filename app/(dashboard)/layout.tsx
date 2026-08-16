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


          <Link href="/dashboard">
            Tableau de bord
          </Link>


          <Link href="/tenders">
            Appels d’offres
          </Link>


          <Link href="/estimates">
            Devis
          </Link>


          <Link href="/projects">
            Chantiers
          </Link>


          <Link href="/billing">
            Situations & paiements
          </Link>


          <Link href="/clients">
            Clients
          </Link>


          <Link href="/suppliers">
            Fournisseurs
          </Link>


          <Link href="/prices">
            Bibliothèque de prix
          </Link>


          <Link href="/documents">
            Documents
          </Link>


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
