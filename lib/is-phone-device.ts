// Sur téléphone, un PDF affiché dans une <iframe> (notre aperçu avec
// boutons "Imprimer"/"Fermer") utilise le mini-lecteur PDF très limité du
// navigateur : une seule page visible à la fois, sans zoom au pincement, il
// faut faire défiler à la main pour tout voir — une limitation connue
// d'iOS/Android, pas un bug de l'application. Le vrai lecteur PDF natif du
// téléphone (zoom, pages qui défilent normalement, partager/imprimer) ne
// s'active que si le PDF est ouvert en PLEIN ÉCRAN dans son propre onglet,
// jamais encapsulé dans une iframe. Sur ordinateur, l'aperçu actuel avec ses
// boutons personnalisés fonctionne bien et reste inchangé : cette détection
// ne sert qu'à choisir, phone par phone, laquelle des deux présentations
// utiliser.
export function isPhoneDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(navigator.userAgent);
}
