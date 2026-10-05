// Détecteur PARTAGÉ (une seule définition, utilisée à deux endroits du
// projet) d'un titre de rubrique/sous-total/ligne de bordereau de prix (BDQE)
// — par exemple "TOTAL - CHARPENTE & COUVERTURE", "SOUS-TOTAL MACONNERIE",
// "RÉCAPITULATION GÉNÉRALE" ou "VII - PEINTURE ET VITRERIE". Un tel intitulé
// n'est JAMAIS le titre d'une vraie pièce de soumission ni le début d'un
// vrai nouveau document : c'est un en-tête de ligne de prix (déjà représenté,
// correctement, dans work_items/le bordereau automatique), qui se trouve
// être écrit EN MAJUSCULES ET EN GRAS dans la plupart des DAO — exactement le
// même style typographique qu'un vrai titre de pièce/document.
//
// Utilisé à deux endroits qui doivent reconnaître le même risque :
//  1) sanitize-ai-analysis.ts : retire un submission_item que l'IA a créé à
//     tort à partir d'un tel intitulé.
//  2) trim-to-relevant-pages.ts (pageHeadingLine) : empêche qu'une page de
//     bordereau rencontrée au milieu d'une pièce DAO à plusieurs pages (ex.
//     "Annexe X : Bordereau détail quantitatif") soit prise pour le début
//     d'une toute NOUVELLE pièce par splitPagesByOwnTitle/splitMergedDaoItems
//     — observé en vrai sur le DAO de Maxime : une seule pièce "bordereau"
//     fragmentée en une dizaine de fausses pièces séparées, une par ligne de
//     total/sous-total/lot en chiffres romains repérée dans ses pages.
//
// Une seule définition ici évite que les deux endroits se désynchronisent
// (ce qui est déjà arrivé : le premier connaissait ce risque, pas le second).
export function looksLikeBordereauHeading(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  return (
    /^TOTAL\b/i.test(trimmed) ||
    /^SOUS[ -]?TOTAL\b/i.test(trimmed) ||
    /^R[ÉE]CAPITULAT/i.test(trimmed) ||
    // Chiffre romain suivi d'un tiret/point ("VII - ...", "IV. ...") :
    // numérotation typique d'un lot de bordereau, jamais celle d'une pièce de
    // soumission (qui porte un intitulé comme "Annexe 7", "A2", "B1", jamais
    // un chiffre romain seul).
    startsWithRomanLotNumber(trimmed)
  );
}

// BUG corrigé (vérifié sur un vrai DAO : la pièce « C- CAHIER DES CLAUSES
// ADMINISTRATIVES PARTICULIERES (CCAP) » disparaissait de la liste, prise pour
// un lot de bordereau de prix) : « C- », « D- », « L- » ou « M- » sont avant
// tout les lettres d'une simple liste de rubriques (« A- Acte d'engagement »,
// « B- Localisation », « C- CCAP »...), jamais le numéro d'un lot de bordereau
// (aucun bordereau ne compte 100, 500, 50 ou 1000 lots). Une lettre seule ne
// compte donc comme chiffre romain que si c'est I, V ou X ; avec 2 lettres ou
// plus (« II », « VII », « XII »...) le comportement reste inchangé. Règle
// générale de ponctuation/numérotation, aucun titre codé en dur.
function startsWithRomanLotNumber(title: string): boolean {
  const match = /^([IVXLCDM]{1,6})\s*[-–—.)]/i.exec(title);
  if (!match) return false;
  const token = match[1];
  if (token.length === 1 && !/^[IVX]$/i.test(token)) return false;
  return true;
}
