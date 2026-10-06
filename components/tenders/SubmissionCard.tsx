"use client";

import { useRouter } from "next/navigation";
import { DeleteSubmissionDossierButton } from "@/components/tenders/DeleteSubmissionDossierButton";

export type SubmissionCardData = {
  id: string;
  reference: string | null;
  title: string | null;
  deadline: string | null;
  count: number;
  valid: boolean;
  hasStoredItems: boolean;
};

// Carte d'un dossier de soumission (même style que les chantiers et les appels
// d'offres) : toute la carte ouvre le dossier ; « Supprimer » ne vide que ce
// dossier de soumission (jamais le DAO, ses devis ni ses chantiers).
export function SubmissionCard({ dossier }: { dossier: SubmissionCardData }) {
  const router = useRouter();
  const href = `/tenders/${dossier.id}/submission`;
  const stateClass = !dossier.hasStoredItems ? "isPending" : dossier.valid ? "isValid" : "isInvalid";
  const stateLabel = !dossier.hasStoredItems ? "Dossier non généré" : dossier.valid ? "Validé — prêt à déposer" : "Non validé";
  return (
    <div
      className="projectDirectoryCard"
      style={{ cursor: "pointer" }}
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) router.push(href); }}
    >
      <span className="projectCardLabel">DOSSIER DE SOUMISSION{dossier.reference ? ` · ${dossier.reference}` : ""}</span>
      <h2 style={{ fontSize: "1.25rem" }}>{dossier.title || "Sans titre"}</h2>
      <p className="projectCardLocation" style={{ minHeight: 0 }}>
        <span className={`submissionStatus ${stateClass}`}>{stateLabel}</span>
      </p>
      <div className="projectCardMetrics" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
        <span><strong>{dossier.deadline ? new Date(dossier.deadline).toLocaleDateString("fr-FR") : "—"}</strong>échéance</span>
        <span><strong>{dossier.count || "À analyser"}</strong>pièces trouvées</span>
      </div>
      {dossier.hasStoredItems && (
        <div style={{ margin: "14px 0" }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <DeleteSubmissionDossierButton tenderId={dossier.id} />
        </div>
      )}
      <span className="projectOpenButton">Ouvrir le dossier →</span>
    </div>
  );
}
