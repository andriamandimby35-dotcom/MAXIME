"use client";

import { useEffect, useState } from "react";
import { OpenPdfButton } from "@/components/OpenPdfButton";
import { useInlinePdf } from "@/components/InlinePdf";
import { isPhoneDevice } from "@/lib/is-phone-device";

export type ArchivedClaim = {
  id: string;
  claim_number: string;
  issue_date: string | null;
  net_amount: number | string | null;
  client_name?: string | null;
  project_name?: string | null;
};

const ariary = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

// Factures PAYÉES dont le chantier a été supprimé : on les garde (comptabilité),
// sans chantier. Leur PDF reste consultable.
export function ArchivedClaims({ claims }: { claims: ArchivedClaim[] }) {
  // Téléphone : comportement d'avant (lien ouvert dans son onglet). Ordinateur : lecteur PDF commun avec « Fermer ».
  const inline = useInlinePdf();
  const [phone, setPhone] = useState(false);
  useEffect(() => setPhone(isPhoneDevice()), []);
  if (claims.length === 0) return null;
  return (
    <section className="panel tablePanel" style={{ marginTop: 24 }}>
      <div style={{ padding: "14px 16px 0" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Factures archivées</h2>
        <p style={{ fontSize: ".75rem", color: "#666" }}>Factures payées dont le chantier a été supprimé. Elles sont gardées volontairement.</p>
      </div>
      <table>
        <thead><tr><th>Facture</th><th>Chantier supprimé</th><th>Date</th><th>Net à payer</th><th>PDF</th></tr></thead>
        <tbody>
          {claims.map((claim) => (
            <tr key={claim.id}>
              <td><strong>{claim.claim_number}</strong></td>
              <td>{claim.project_name || "—"}</td>
              <td>{claim.issue_date ? new Date(claim.issue_date).toLocaleDateString("fr-FR") : "—"}</td>
              <td>{ariary.format(Number(claim.net_amount) || 0)} Ar</td>
              <td>{phone
                ? <a className="tenderButton" href={`/api/billing/claims/${claim.id}/pdf`} target="_blank" rel="noopener noreferrer">Ouvrir</a>
                : <OpenPdfButton className="tenderButton" title={`Facture ${claim.claim_number}`} url={`/api/billing/claims/${claim.id}/pdf`} onOpenInline={(title, url) => void inline.open(title, url)}>Ouvrir</OpenPdfButton>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "0 16px 14px" }}>{inline.frame}</div>
    </section>
  );
}
