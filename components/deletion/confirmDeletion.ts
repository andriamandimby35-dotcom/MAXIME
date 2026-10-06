import { CONFIRM_WORD, describePreview, type DeletionKind, type DeletionPreview } from "@/lib/deletion/types";

// Confirmation avant suppression d'un DAO, d'un devis ou d'un chantier :
// montre ce qui va disparaître (et ce qui est gardé : factures payées), et
// demande de taper SUPPRIMER quand des dépenses, paiements ou factures non
// payées sont concernés. Renvoie true si l'utilisateur confirme.
export async function confirmDeletion(kind: DeletionKind, id: string): Promise<boolean> {
  let preview: DeletionPreview | null = null;
  try {
    const response = await fetch(`/api/deletion/preview?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { preview?: DeletionPreview; error?: string };
    if (!response.ok || !payload.preview) { window.alert(payload.error || "Impossible de vérifier ce qui sera supprimé."); return false; }
    preview = payload.preview;
  } catch {
    window.alert("Connexion interrompue : suppression annulée.");
    return false;
  }
  const text = describePreview(preview).join("\n");
  if (!preview.needsTyping) return window.confirm(`${text}\n\nCette suppression est définitive. Continuer ?`);
  const typed = window.prompt(`${text}\n\nCette suppression est définitive.\nPour confirmer, tape ${CONFIRM_WORD} :`);
  return (typed ?? "").trim().toUpperCase() === CONFIRM_WORD;
}
