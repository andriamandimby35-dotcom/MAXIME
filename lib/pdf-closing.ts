import { amountInWordsFr } from "@/lib/number-to-words-fr";

// Fin de TOUS les devis PDF (DAO ou PDF importé, interne ou externe), sur la dernière page seulement :
// somme en lettres, « Fait à … le … », signature, puis en petit les observations du DAO (s'il y en a),
// le NB, et la mention légale malgache. Un seul endroit : les deux générateurs de PDF l'utilisent.
export const MALAGASY_LAW_NOTE = "Devis établi en application de la loi n° 2016-055 du 25 janvier 2017 portant Code des Marchés Publics de Madagascar. Tous les montants sont exprimés en Ariary (Ar).";

export type ClosingBlock = {
  /** Lignes en GRAS et MAJUSCULES (même taille que les chiffres du récapitulatif). */
  strong: string[];
  /** Petites lignes en bas : observations du DAO, NB, texte de loi. */
  small: string[];
};

// Retire des notes du DAO ce que le PDF écrit déjà lui-même (arrêté, « fait à », signataire).
export function cleanDaoNotes(annotations: string[] | undefined) {
  return (annotations ?? [])
    .map((note) => String(note ?? "").replace(/\s+/g, " ").trim().replace(/arr[êe]t[ée]e?\s+le\s+pr[ée]sent[\s\S]*$/i, "").trim())
    .filter((note) => note && !/^fait\s+[àa](?![\p{L}])/iu.test(note) && !/^le\s+soumissionnaire(?![\p{L}])/iu.test(note));
}

export function closingBlock(total: number, arreteLabel: string, daoNotes?: string[]): ClosingBlock {
  const amount = Math.round(Number(total) || 0);
  const words = amount > 0 ? `${amountInWordsFr(amount)}.` : "........................................................................";
  return {
    strong: [
      arreteLabel.toLocaleUpperCase("fr-FR"),
      words.toLocaleUpperCase("fr-FR"),
      "FAIT À ........................................, LE ........................................",
      "LE SOUMISSIONNAIRE",
    ],
    small: [...cleanDaoNotes(daoNotes), MALAGASY_LAW_NOTE],
  };
}
