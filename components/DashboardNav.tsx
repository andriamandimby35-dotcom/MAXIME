"use client";

import { useState } from "react";
import Link from "next/link";

// Menu de gauche : sur ordinateur/tablette, toujours visible comme avant.
// Sur téléphone en mode portrait, il est caché par défaut derrière un
// bouton "☰ Menu" en haut de l'écran, et s'ouvre en plein écran par-dessus
// la page quand on appuie dessus (comme la plupart des applis mobiles),
// au lieu de s'afficher en entier avant le contenu de chaque page.
export function DashboardNav({
  isAdmin,
  isWorksManager,
}: {
  isAdmin: boolean;
  isWorksManager: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        className="mobileNavToggle"
        onClick={() => setOpen(true)}
        aria-label="Ouvrir le menu"
      >
        ☰ Menu
      </button>

      {open && <div className="mobileNavBackdrop" onClick={close} />}

      <aside className={`sidebar${open ? " sidebarOpen" : ""}`}>

        <button
          type="button"
          className="mobileNavClose"
          onClick={close}
          aria-label="Fermer le menu"
        >
          ✕
        </button>

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




        <nav className={isWorksManager ? "worksManagerNav" : undefined} onClick={close}>

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

          </> : isWorksManager ? <>

          <Link href="/projects">
            Chantier
          </Link>

          </> : <Link href="/projects">
            Mes chantiers
          </Link>}


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
    </>
  );
}
