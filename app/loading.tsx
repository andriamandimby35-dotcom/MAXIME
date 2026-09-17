export default function RootLoading() {
  return (
    <div className="globalStatusBar globalStatusBar--loading" role="status" aria-live="polite">
      <span className="globalStatusSpinner" />
      <span>Chargement…</span>
    </div>
  );
}
