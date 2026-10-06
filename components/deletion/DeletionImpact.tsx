"use client";

import { useEffect, useState } from "react";
import { CONFIRM_WORD, describePreview, type DeletionKind, type DeletionPreview } from "@/lib/deletion/types";

// Bloc affiché dans une fenêtre de confirmation : liste ce qui va disparaître,
// et demande de taper SUPPRIMER si des dépenses / paiements / factures non
// payées sont concernés. Prévient le parent (onReady) quand la suppression
// peut être confirmée.
export function DeletionImpact({ kind, id, onReady }: { kind: DeletionKind; id: string; onReady: (ready: boolean) => void }) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let cancelled = false;
    onReady(false);
    fetch(`/api/deletion/preview?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => ({ ok: response.ok, payload: await response.json().catch(() => ({})) as { preview?: DeletionPreview; error?: string } }))
      .then(({ ok, payload }) => {
        if (cancelled) return;
        if (!ok || !payload.preview) { setError(payload.error || "Impossible de vérifier ce qui sera supprimé."); return; }
        setPreview(payload.preview);
        onReady(!payload.preview.needsTyping);
      })
      .catch(() => { if (!cancelled) setError("Connexion interrompue."); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  if (error) return <p className="projectHint" style={{ color: "#a33b3e" }}>{error}</p>;
  if (!preview) return <p className="projectHint">Vérification de ce qui sera supprimé…</p>;
  return (
    <div style={{ marginTop: 8 }}>
      <ul style={{ margin: "0 0 10px 18px", padding: 0, fontSize: ".85rem", lineHeight: 1.5 }}>
        {describePreview(preview).map((line) => <li key={line}>{line}</li>)}
      </ul>
      {preview.needsTyping && (
        <label style={{ display: "block", fontSize: ".85rem" }}>
          Pour confirmer, tape <strong>{CONFIRM_WORD}</strong> :
          <input
            value={typed}
            onChange={(event) => { setTyped(event.target.value); onReady(event.target.value.trim().toUpperCase() === CONFIRM_WORD); }}
            style={{ display: "block", marginTop: 4, width: "100%" }}
            autoComplete="off"
          />
        </label>
      )}
    </div>
  );
}
