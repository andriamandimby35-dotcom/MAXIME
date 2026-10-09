"use client";

import { createPortal } from "react-dom";

// Petite fenêtre « Enregistrer les modifications ? » quand on ferme un PDF modifié sans l'avoir enregistré.
// Trois choix : Enregistrer, Ne pas enregistrer (ferme quand même), Continuer à modifier (revient au PDF).
export default function ConfirmSaveDialog({ message, busy = false, onSave, onDiscard, onCancel }: {
  message: string;
  busy?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="modalBackdrop" style={{ zIndex: 2147483000 }} onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()} style={{ width: "min(460px, 100%)", cursor: busy ? "progress" : undefined }}>
        <h2 style={{ margin: "0 0 8px", fontSize: "1.1rem", fontWeight: 800 }}>Enregistrer les modifications ?</h2>
        <p style={{ margin: "0 0 16px", fontSize: ".92rem", overflowWrap: "anywhere" }}>{message}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="tenderButton" disabled={busy} onClick={onCancel}>Continuer à modifier</button>
          <button type="button" className="tenderButton" disabled={busy} onClick={onDiscard}>Ne pas enregistrer</button>
          <button type="button" className="tenderButton tenderButtonPrimary" disabled={busy} onClick={onSave}>{busy ? "Enregistrement…" : "Enregistrer"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
