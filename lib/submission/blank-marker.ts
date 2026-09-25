// Un texte composé UNIQUEMENT de points, tirets ou soulignés répétés
// (".........", "______", "- - - -") est TOUJOURS un simple repère visuel de
// blanc à compléter sur un modèle DAO, jamais du vrai contenu, quel que soit
// le DAO. Utilisé par locate-field-positions.ts (locateFieldPositions) pour
// repérer où se trouve VRAIMENT le blanc à remplir sur une ligne, plutôt que
// de deviner une position à partir de la fin de la ligne entière.
export function isBlankMarkerRun(text: string) {
  const trimmed = text.trim();
  return trimmed.length >= 2 && /^[.\-_·•∙]+$/.test(trimmed);
}
