"use client";

export default function RootError({
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
        <p>La page n’a pas pu s’afficher correctement. Vous pouvez réessayer.</p>
      </div>
      <button type="button" onClick={() => reset()}>Réessayer</button>
    </div>
  );
}
