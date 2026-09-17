"use client";

// Filet de sécurité ultime : si même le squelette général de l'application
// plante, on affiche quand même un message clair plutôt qu'une page blanche.
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body>
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f4f6f3", padding: 20 }}>
          <div className="globalStatusBar globalStatusBar--error" role="alert" style={{ maxWidth: 480 }}>
            <div>
              <strong>Une erreur est survenue.</strong>
              <p>L’application n’a pas pu s’afficher correctement. Vous pouvez réessayer.</p>
            </div>
            <button type="button" onClick={() => reset()}>Réessayer</button>
          </div>
        </div>
      </body>
    </html>
  );
}
