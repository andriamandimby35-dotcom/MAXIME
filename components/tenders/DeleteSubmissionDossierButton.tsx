"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Petit bouton réutilisable pour supprimer le dossier maître de soumission
// d'un DAO directement depuis la liste (page /submissions), sans avoir à
// ouvrir le dossier d'abord. Même endpoint DELETE que le bouton "Supprimer
// le dossier" à l'intérieur du dossier (SubmissionDossierManager) — cette
// page-liste étant un composant serveur, l'appel réseau doit passer par un
// petit composant client séparé, comme OpenPdfButton pour les PDF.
export function DeleteSubmissionDossierButton({ tenderId }: { tenderId: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleDelete() {
    if (!window.confirm("Supprimer définitivement le dossier maître de ce DAO ? Toutes les pièces et informations déjà remplies seront effacées. L’analyse du DAO n’est pas concernée : la liste des pièces sera reconstruite vierge, sans nouvel appel IA.")) return;
    setLoading(true);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/tenders/${tenderId}/submission-dossier`, {
        method: "DELETE",
        headers: session?.access_token ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Supabase-Access-Token": session.access_token,
        } : undefined,
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) {
        window.alert(payload.error || "Suppression impossible.");
        return;
      }
      // La ligne écoute déjà les changements en temps réel sur
      // tender_submission_items (RealtimeRefresh) : router.refresh() force
      // en plus un rafraîchissement immédiat, sans attendre l'événement.
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button type="button" className="tenderButton tenderButtonDanger" disabled={loading} onClick={() => void handleDelete()}>
      {loading ? "Suppression…" : "Supprimer"}
    </button>
  );
}
