// Un texte composé UNIQUEMENT de points, tirets ou soulignés répétés
// (".........", "______", "- - - -") est TOUJOURS un simple repère visuel de
// blanc à compléter sur un modèle DAO, jamais du vrai contenu, quel que soit
// le DAO. Utilisé par locate-field-positions.ts (locateFieldPositions) pour
// repérer où se trouve VRAIMENT le blanc à remplir sur une ligne, plutôt que
// de deviner une position à partir de la fin de la ligne entière.
// … (le caractère unique "…", trois points de suspension) est ajouté ici
// à côté du point simple ".", car certains DAO (convertis depuis Word) tapent
// leur blanc avec CE caractère répété ("………………….") au lieu de points séparés —
// repéré sur un vrai DAO ("un montant total estimé à : ……………………….Ariary") :
// invisible pour l'ancienne expression, ce blanc n'était jamais reconnu comme
// tel, et la valeur atterrissait tout à la fin de la ligne (après "Ariary
// (en lettres et en chiffres)") au lieu de prendre la place du blanc.
export function isBlankMarkerRun(text: string) {
  const trimmed = text.trim();
  return trimmed.length >= 2 && /^[.\-_·•∙\u2026]+$/.test(trimmed);
}
