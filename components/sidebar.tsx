import Link from "next/link";
import { companyProfile } from "@/lib/company";

const items = [
  ["/dashboard", "Tableau de bord"],
  ["/tenders", "Appels d’offres"],
  ["/estimates", "Devis"],
  ["/projects", "Chantiers"],
  ["/billing", "Situations & paiements"],
  ["/clients", "Clients"],
  ["/suppliers", "Fournisseurs"],
  ["/prices", "Bibliothèque de prix"],
  ["/prices/history", "📊 Historique des prix"],
  ["/documents", "Documents"],
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span>SB</span>
        <div><strong>Sébastien BTP</strong><small>{companyProfile.tradeName} · {companyProfile.shortName}</small></div>
      </div>
      <nav>{items.map(([href,label]) => <Link key={href} href={href}>{label}</Link>)}</nav>
      <div className="companyCard">
        <strong>{companyProfile.ownerName}</strong>
        <span>{companyProfile.phone}</span>
        <span>NIF {companyProfile.nif}</span>
        <span>STAT {companyProfile.stat}</span>
      </div>
      <div className="sidebarNote">Données protégées par entreprise avec Supabase RLS.</div>
    </aside>
  );
}
