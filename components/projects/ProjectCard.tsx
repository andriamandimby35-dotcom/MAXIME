"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";

type Project = {
  id: string;
  name: string;
  location?: string | null;
  progress_percent?: number | string | null;
  closed_at?: string | null;
};

// Carte d'un chantier dans la liste (/projects). Verte et cliquable tant que
// le chantier est actif ; rouge avec juste « Réouvrir » / « Supprimer » une
// fois clôturé (voir le bouton "Clôture chantier" dans Dépense, réservé à
// l'administrateur). Réouvrir réactive automatiquement tous les accès qui
// étaient actifs au moment de la clôture (marqués paused_by_closure).
// L'administrateur peut aussi supprimer un chantier actif (non clôturé),
// via la petite icône 🗑 en haut à droite de la carte verte — la clôture
// préalable n'est pas obligatoire pour supprimer.
export function ProjectCard({
  project,
  taskStats,
  reportsCount,
  isAdmin,
}: {
  project: Project;
  taskStats: { completed: number; total: number };
  reportsCount: number;
  isAdmin: boolean;
}) {
  const supabase = useState(() => createClient())[0];
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"reopen" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closedAt, setClosedAt] = useState(project.closed_at ?? null);
  const [removed, setRemoved] = useState(false);

  async function reopen() {
    setBusy(true);
    setError(null);
    const { error: reactivateError } = await supabase
      .from("project_assignments")
      .update({ active: true, paused_by_closure: false })
      .eq("project_id", project.id)
      .eq("paused_by_closure", true);
    if (reactivateError) { setBusy(false); setError(`Réouverture impossible : ${reactivateError.message}`); return; }
    const { error: reopenError } = await supabase.from("projects").update({ closed_at: null, closed_by: null }).eq("id", project.id);
    setBusy(false);
    if (reopenError) { setError(`Réouverture impossible : ${reopenError.message}`); return; }
    setClosedAt(null);
    setConfirming(null);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    // Suppression définitive : le chantier et tout ce qui lui est rattaché
    // (rapports, photos, stocks, dépenses, accès…) sont supprimés en chaîne
    // par la base de données. Le devis et l'appel d'offres à l'origine du
    // chantier, eux, ne sont jamais touchés par cette suppression.
    const { error: deleteError } = await supabase.from("projects").delete().eq("id", project.id);
    setBusy(false);
    if (deleteError) { setError(`Suppression impossible : ${deleteError.message}`); return; }
    setRemoved(true);
  }

  if (removed) return null;

  if (closedAt) {
    return <div className="projectDirectoryCard projectDirectoryCardClosed">
      <span className="projectCardLabel">CHANTIER</span>
      <h2>{project.name}</h2>
      <p className="projectCardLocation">{project.location || "Localisation à confirmer"}</p>
      <p className="projectClosedBadge">🔒 Clôturé</p>
      {error && <p className="projectHint" style={{ color: "#a33b3e" }}>{error}</p>}
      {isAdmin ? <div style={{ display: "flex", gap: 10, marginTop: "auto" }}>
        <button type="button" disabled={busy} onClick={() => setConfirming("reopen")}>Réouvrir</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming("delete")}>Supprimer</button>
      </div> : <Link href={`/projects/${project.id}`} className="projectOpenButton" style={{ marginTop: "auto" }}>Consulter →</Link>}

      {confirming === "reopen" && typeof document !== "undefined" && createPortal(
        <div className="modalBackdrop" onClick={() => setConfirming(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Rouvrir « {project.name} » ?</h2>
          <p className="projectHint">Tous les accès conducteur, chef et équipe qui étaient actifs au moment de la clôture seront réactivés. Le chantier redevient actif comme avant.</p>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button type="button" disabled={busy} onClick={() => void reopen()}>{busy ? "Réouverture…" : "Confirmer la réouverture"}</button>
            <button type="button" className="ghostButton" onClick={() => setConfirming(null)}>Annuler</button>
          </div>
        </div></div>,
        document.body,
      )}

      {confirming === "delete" && typeof document !== "undefined" && createPortal(
        <div className="modalBackdrop" onClick={() => setConfirming(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Supprimer « {project.name} » ?</h2>
          <p className="projectHint">Suppression définitive et irréversible : le chantier et tout ce qui lui est rattaché (rapports, photos, stocks, dépenses, accès…) seront supprimés. Le devis et l’appel d’offres à l’origine de ce chantier, eux, ne sont pas touchés.</p>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button type="button" className="dangerButton" disabled={busy} onClick={() => void remove()}>{busy ? "Suppression…" : "Confirmer la suppression"}</button>
            <button type="button" className="ghostButton" onClick={() => setConfirming(null)}>Annuler</button>
          </div>
        </div></div>,
        document.body,
      )}
    </div>;
  }

  return <div className="projectDirectoryCard" style={{ cursor: "pointer", position: "relative" }} onClick={() => router.push(`/projects/${project.id}`)}>
    {isAdmin && <button
      type="button"
      title="Supprimer ce chantier"
      onClick={(event) => { event.stopPropagation(); setConfirming("delete"); }}
      style={{ position: "absolute", top: 14, right: 14, width: 30, height: 30, borderRadius: 999, border: "1px solid #eab7b6", background: "#fff", color: "#a33b3e", fontSize: ".85rem", lineHeight: 1, boxShadow: "none", zIndex: 1 }}
    >🗑</button>}
    <span className="projectCardLabel">CHANTIER</span><h2>{project.name}</h2><p className="projectCardLocation">{project.location || "Localisation à confirmer"}</p>
    <div className="projectCardMetrics"><span><strong>{Number(project.progress_percent ?? 0)} %</strong> avancement</span><span><strong>{taskStats.completed}/{taskStats.total}</strong> tâche(s)</span><span><strong>{reportsCount}</strong> rapport(s)</span></div>
    {error && <p className="projectHint" style={{ color: "#a33b3e" }}>{error}</p>}
    <span className="projectOpenButton">Ouvrir le chantier →</span>

    {confirming === "delete" && typeof document !== "undefined" && createPortal(
      <div className="modalBackdrop" onClick={(event) => { event.stopPropagation(); setConfirming(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
        <h2 className="font-bold text-xl mb-4">Supprimer « {project.name} » ?</h2>
        <p className="projectHint">Suppression définitive et irréversible : le chantier et tout ce qui lui est rattaché (rapports, photos, stocks, dépenses, accès…) seront supprimés, clôturé ou non. Le devis et l’appel d’offres à l’origine de ce chantier, eux, ne sont pas touchés.</p>
        <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
          <button type="button" className="dangerButton" disabled={busy} onClick={() => void remove()}>{busy ? "Suppression…" : "Confirmer la suppression"}</button>
          <button type="button" className="ghostButton" onClick={() => setConfirming(null)}>Annuler</button>
        </div>
      </div></div>,
      document.body,
    )}
  </div>;
}
