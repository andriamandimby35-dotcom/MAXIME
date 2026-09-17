"use client";

// Next.js affiche automatiquement ce fichier si une page de l'espace
// connecté rencontre une erreur (au lieu de laisser un écran blanc), avec
// un bouton pour réessayer sans recharger toute l'application.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="globalStatusBar globalStatusBar--error" role="alert">
      <div>
        <strong>Une erreur est survenue.</strong>
        <p>Cette page n’a pas pu s’afficher correctement. Vous pouvez réessayer, ou revenir en arrière.</p>
      </div>
      <button type="button" onClick={() => reset()}>Réessayer</button>
    </div>
  );
}
