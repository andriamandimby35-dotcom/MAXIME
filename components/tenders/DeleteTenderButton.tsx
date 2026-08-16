"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteTenderButton({ tenderId, tenderName }: { tenderId: string; tenderName: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function deleteTender() {
    if (!window.confirm(`Supprimer définitivement le DAO « ${tenderName} » ?`)) return;
    setDeleting(true);
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
      className="text-red-700 underline disabled:opacity-50"
    >
      {deleting ? "Suppression…" : "Supprimer"}
    </button>
  );
}
