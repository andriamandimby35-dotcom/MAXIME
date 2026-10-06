"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import DeleteTenderButton from "@/components/tenders/DeleteTenderButton";
import { OpenPdfButton } from "@/components/OpenPdfButton";

export type TenderCardData = {
  id: string;
  reference: string | null;
  title: string | null;
  authority: string | null;
  deadline: string | null;
  amount: number | null;
  hasAnalysis: boolean;
  hasDocument: boolean;
};

// Carte d'un appel d'offres, même style que les cartes de la liste des
// chantiers : toute la carte est cliquable (ouvre l'analyse du DAO). Les
// petits boutons (ouvrir le PDF, ré-analyser, supprimer) gardent leur rôle
// sans ouvrir la carte.
export function TenderCard({ tender }: { tender: TenderCardData }) {
  const router = useRouter();
  const open = () => router.push(`/tenders/${tender.id}/analyze`);
  const amount = Number(tender.amount);
  return (
    <div
      className="projectDirectoryCard"
      style={{ cursor: "pointer" }}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) open(); }}
    >
      <span className="projectCardLabel">APPEL D’OFFRES{tender.reference ? ` · ${tender.reference}` : ""}</span>
      <h2 style={{ fontSize: "1.25rem" }}>{tender.title || "Sans titre"}</h2>
      <p className="projectCardLocation">{tender.authority || "Autorité à confirmer"}</p>
      <div className="projectCardMetrics">
        <span><strong>{tender.deadline ? new Date(tender.deadline).toLocaleDateString("fr-FR") : "—"}</strong>échéance</span>
        <span><strong style={{ fontSize: ".85rem", wordBreak: "break-word" }}>{Number.isFinite(amount) && amount > 0 ? `${amount.toLocaleString("fr-FR")} Ar` : "—"}</strong>montant</span>
        <span><strong style={{ fontSize: ".85rem" }}>{tender.hasAnalysis ? "Analysé" : "À analyser"}</strong>statut</span>
      </div>
      <div
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "14px 0" }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {tender.hasDocument ? (
          <OpenPdfButton title={`DAO — ${tender.title ?? ""}`} url={`/api/tenders/${tender.id}/document`} className="tenderButton">Ouvrir le DAO</OpenPdfButton>
        ) : (
          <button type="button" disabled className="tenderButton submissionPdfDisabled">DAO indisponible</button>
        )}
        <Link href={`/tenders/${tender.id}/analyze`} className="tenderAnalyzeLink">{tender.hasAnalysis ? "Ré-analyser" : "Analyser"}</Link>
        <DeleteTenderButton tenderId={tender.id} tenderName={tender.title || tender.reference || ""} />
      </div>
      <span className="projectOpenButton">Ouvrir l’appel d’offres →</span>
    </div>
  );
}
