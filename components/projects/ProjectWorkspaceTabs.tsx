"use client";

import { useState, type ReactNode } from "react";

// Onglets "Chantier" / "Dépense" affichés sur la MÊME page, sans navigation.
// Objectif : le conducteur de travaux voit tout le menu Dépense (comme
// l'administrateur, sans les suppressions puisque accessRole reste
// "works_manager") directement depuis l'Espace conducteur de travaux, qui
// s'affiche déjà correctement. Comme il n'y a plus besoin de cliquer sur un
// lien qui change de page, ceci fonctionne même si le lien "Dépense" de la
// barre latérale reste capricieux sur certains appareils.
export function ProjectWorkspaceTabs({
  initialTab = "site",
  siteContent,
  expensesContent,
}: {
  initialTab?: "site" | "expenses";
  siteContent: ReactNode;
  expensesContent: ReactNode;
}) {
  const [tab, setTab] = useState<"site" | "expenses">(initialTab);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, padding: "16px 24px 0", flexWrap: "wrap" }}>
        <button type="button" onClick={() => setTab("site")} className={tab === "site" ? undefined : "secondary"}>
          Chantier
        </button>
        <button type="button" onClick={() => setTab("expenses")} className={tab === "expenses" ? undefined : "secondary"}>
          Dépense
        </button>
      </div>

      <div style={{ display: tab === "site" ? "block" : "none" }}>{siteContent}</div>
      <div style={{ display: tab === "expenses" ? "block" : "none" }}>{expensesContent}</div>
    </div>
  );
}
