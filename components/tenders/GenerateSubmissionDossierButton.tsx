"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Bouton "Générer le dossier de soumission" — crée le dossier maître
// (tender_submission_items) à partir de l'analyse IA du DAO déjà en cache
// (aucun nouvel appel IA, donc aucun coût). Symétrique au bouton existant
// "Générer le devis IA" mais totalement indépendant : l'un peut exister sans
// l'autre. Réutilisé sur la page du DAO (à côté de "Générer le devis IA") et
// sur la page du dossier elle-même, quand celui-ci n'a pas encore été généré.
export function GenerateSubmissionDossierButton({ tenderId, className, label }: { tenderId: string; className?: string; label?: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleGenerate() {
    setLoading(true);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/tenders/${tenderId}/submission-dossier/generate`, {
        method: "POST",
        headers: session?.access_token ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Supabase-Access-Token": session.access_token,
        } : undefined,
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) {
        window.alert(payload.error || "Génération du dossier impossible.");
        return;
      }
      router.push(`/tenders/${tenderId}/submission`);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button type="button" className={className ?? "tenderButton tenderButtonPrimary"} disabled={loading} onClick={() => void handleGenerate()}>
      {loading ? "Génération…" : (label ?? "📁 Générer le dossier de soumission")}
    </button>
  );
}
