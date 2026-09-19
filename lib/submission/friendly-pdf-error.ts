// Quand la préparation d'un PDF échoue vraiment (statut d'erreur, PDF trop
// petit, signature "%PDF-" absente...), les trois lecteurs de l'application
// (SubmissionDossierManager, PdfViewerProvider, app/pdf-viewer) affichent le
// début de la réponse du serveur comme message d'erreur, pour ne jamais
// masquer la vraie cause. Le problème : si le serveur a planté au niveau du
// framework (Next.js) plutôt que dans son propre code, cette réponse est une
// page d'erreur technique en HTML brut (balises <script>, __next_error__...),
// illisible et anxiogène affichée telle quelle à l'écran. On la détecte ici
// pour remplacer ce cas précis par un message clair, tout en gardant les
// vrais messages d'erreur (ex. venant d'un throw explicite côté serveur)
// inchangés.
export function toFriendlyPdfError(raw: string): string {
  if (/^<!doctype html|<html[\s>]|<\/html>|<script[\s>]|__next_error__/i.test(raw)) {
    return "Le serveur a mis trop de temps à répondre ou a rencontré une erreur inattendue en préparant ce document. Réessayez dans quelques instants ; si ça persiste, dites-moi quelle pièce est concernée.";
  }
  return raw;
}
