// Next.js affiche automatiquement ce fichier pendant qu'une page de
// l'espace connecté charge ses données (chantiers, dépenses, etc.), pour
// qu'il n'y ait jamais un écran vide sans explication.
export default function DashboardLoading() {
  return (
    <div className="globalStatusBar globalStatusBar--loading" role="status" aria-live="polite">
      <span className="globalStatusSpinner" />
      <span>Chargement…</span>
    </div>
  );
}
