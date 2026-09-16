"use client";

import Link from "next/link";
import { certifiedAmount } from "@/lib/billing";

type Project = { id: string; project_code: string | null; name: string; budget_amount: number | string | null; received: number };

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

export function BillingProjectList({ projects }: { projects: Project[] }) {
  return (
    <section>
      <div className="pageHead">
        <div><h1>Situations & paiements</h1><p>Facturation des travaux et suivi des encaissements, chantier par chantier.</p></div>
      </div>

      {projects.length ? (
        <div className="billingProjectGrid">
          {projects.map((project) => {
            const certified = certifiedAmount(Number(project.budget_amount) || 0);
            const received = project.received;
            const outstanding = Math.max(0, certified - received);
            const percent = certified > 0 ? Math.min(100, Math.round((received / certified) * 100)) : 0;
            return (
              <Link key={project.id} href={`/billing/${project.id}`} className="billingProjectCard">
                <strong>{project.project_code ? `${project.project_code} — ` : ""}{project.name}</strong>
                <div className="billingProjectStats">
                  <span>Certifié<b>{ariary.format(certified)} Ar</b></span>
                  <span>Reçu<b>{ariary.format(received)} Ar</b></span>
                  <span>Reste<b>{ariary.format(outstanding)} Ar</b></span>
                </div>
                <div className="progress"><span style={{ width: `${percent}%` }} /></div>
                <small>{percent} % encaissé</small>
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="emptyState">Aucun chantier pour le moment.</p>
      )}
    </section>
  );
}
