"use client";

import Link from "next/link";

type Project = { id: string; project_code: string | null; name: string; budget_amount: number | string | null; received: number; certified: number; overpaid: number };

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

export function BillingProjectList({ projects }: { projects: Project[] }) {
  return (
    <section>
      <div className="pageHead">
        <div><h1>Factures & paiements</h1><p>Facturation des travaux et suivi des encaissements, chantier par chantier.</p></div>
      </div>

      {projects.length ? (
        <div className="billingProjectGrid">
          {projects.map((project) => {
            const certified = project.certified;
            const received = project.received;
            const outstanding = Math.max(0, certified - received);
            const percent = certified > 0 ? Math.min(100, Math.round((received / certified) * 100)) : 0;
            return (
              <Link
                key={project.id}
                href={`/billing/${project.id}`}
                className="billingProjectCard"
                // Seule la carte en erreur (reçu > certifié) devient rouge.
                style={project.overpaid > 0 ? { background: "#fdecec", borderColor: "#c0392b", boxShadow: "0 0 0 2px rgba(192,57,43,.35)" } : undefined}
              >
                <strong>{project.project_code ? `${project.project_code} — ` : ""}{project.name}</strong>
                <div className="billingProjectStats">
                  <span>Certifié<b>{ariary.format(certified)} Ar</b></span>
                  <span style={project.overpaid > 0 ? { color: "#b3261e" } : undefined}>Reçu<b style={project.overpaid > 0 ? { color: "#b3261e" } : undefined}>{ariary.format(received)} Ar</b></span>
                  <span>Reste<b>{ariary.format(outstanding)} Ar</b></span>
                </div>
                <div className="progress"><span style={{ width: `${percent}%` }} /></div>
                <small>{percent} % encaissé</small>
                {project.overpaid > 0 && (
                  <small style={{ color: "#b3261e", fontWeight: 700, display: "block", marginTop: 4 }}>
                    Erreur : le reçu dépasse le certifié de {ariary.format(project.overpaid)} Ar
                  </small>
                )}
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
