export default function AuthLoading() {
  return (
    <div className="globalStatusBar globalStatusBar--loading" role="status" aria-live="polite">
      <span className="globalStatusSpinner" />
      <span>Chargement…</span>
    </div>
  );
}
