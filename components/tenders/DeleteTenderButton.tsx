"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmDeletion } from "@/components/deletion/confirmDeletion";

export default function DeleteTenderButton({ tenderId, tenderName }: { tenderId: string; tenderName: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function deleteTender() {
    // Suppression en chaîne : DAO → devis → chantier → dépenses → factures non payées.
    // Les factures payées sont gardées. La confirmation montre ce qui disparaît.
    setDeleting(true);
    if (!(await confirmDeletion("tender", tenderId))) { setDeleting(false); return; }
    const response = await fetch(`/api/tenders/${tenderId}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      window.alert(result.error || "Suppression impossible.");
      setDeleting(false);
      return;
    }
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={deleteTender}
      disabled={deleting}
      className="tenderButton tenderButtonDanger"
      title={`Supprimer le DAO « ${tenderName} » et ce qui en dépend`}
    >
      {deleting ? "Suppression…" : "Supprimer"}
    </button>
  );
}
