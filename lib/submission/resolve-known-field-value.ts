// Règles générales de reconnaissance d'un champ DAO ("Nom, prénom, fonction
// du représentant", "Adresse du candidat", "NIF"...) à partir de son
// identifiant (clé + libellé + description, normalisés) : reconnaît un champ
// même quand la clé donnée par l'IA d'analyse ne correspond pas exactement à
// une clé connue (ex. "representant_nom_prenom_fonction" au lieu de
// "representative_name"), pour ne jamais laisser une case vide alors que
// l'information existe déjà dans le profil de l'entreprise.
//
// Portée ici depuis SubmissionDossierManager.tsx (resolvedFieldValueRaw),
// où elle servait déjà à préremplir les formulaires "un champ à la fois" —
// un seul jeu de règles, réutilisé aussi côté serveur pour préremplir les
// vraies cases cliquables posées directement sur la page scannée du DAO
// (voir printable-submission-document/route.ts). Corrige un même bug à sa
// RACINE plutôt que juste pour la Lettre de soumission qui l'a révélé :
// n'importe quelle pièce utilisant ce mécanisme de cases cliquables en
// profite, pas seulement celle-ci.

export function normalizeIdentifier(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** La banque nommée dans une garantie/caution bancaire est un tiers (celle
 * qui émet la garantie), jamais la propre banque de l'entreprise candidate —
 * ses coordonnées ne doivent donc jamais être devinées depuis le profil. */
export function isGuaranteeBankIdentityTitle(title: string): boolean {
  return /garantiebancaire|cautionbancaire|cautionpersonnelle/.test(normalizeIdentifier(title));
}

export type KnownFieldContext = {
  profile: Record<string, string>;
  tenderReference: string;
  tenderClientName: string;
  tenderLocation: string;
  tenderExecutionPeriodDays: number | null;
  tenderEstimatedAmount: number | null;
  today: string;
  isGuaranteeBankIdentity: boolean;
};

/** identifier = normalizeIdentifier(`${key} ${label} ${description}`) (et,
 * pour les appelants qui en ont besoin, le titre de la pièce peut aussi être
 * inclus dedans en amont — voir isGuaranteeBankIdentityTitle, calculé à
 * part). Retourne "" quand aucune règle connue ne correspond : la case reste
 * alors vide, à remplir/ajuster à la main, jamais un texte inventé. */
export function resolveKnownFieldValue(identifier: string, ctx: KnownFieldContext): string {
  const profile = ctx.profile;
  // Un champ qui demande le NOM ET l'ADRESSE de l'entreprise en même temps
  // (ex. "Nom et adresse de l'Entrepreneur") ne doit jamais s'arrêter à un
  // seul des deux, sinon la raison sociale disparaît derrière la seule
  // adresse (ou l'inverse). "Entrepreneur" et "candidat" désignent ici
  // l'entreprise candidate elle-même (vocabulaire courant des DAO malgaches),
  // jamais un tiers.
  if (/soumissionnaire|entreprise|entrepreneur|raisonsociale|nomentreprise|legalname|candidat/.test(identifier)
      && /nom/.test(identifier) && /adresse|address/.test(identifier)) {
    const companyName = profile.legal_name || profile.trade_name || "";
    return [companyName, profile.address ?? ""].filter((part) => part.trim()).join(", ");
  }
  // Les règles d'IDENTITÉ (nom/fonction du signataire) passent avant les cas
  // génériques ci-dessous (adresse, contrat/référence, date...), sinon un
  // champ qui mentionne aussi "contrat" ou "adresse" dans sa description
  // tombe dans la mauvaise règle générique.
  // "Titre / capacité juridique (du signataire)" : demande la FONCTION,
  // jamais le nom.
  if (/juridique/.test(identifier) && /titre|capacite|qualite/.test(identifier)) return profile.representative_role ?? "";
  // "Nom, prénom, fonction" (ou "Nom et qualité") du signataire veut
  // l'identité ET la fonction ensemble.
  if (/nom|prenom|identite/.test(identifier) && /fonction|qualite|qualification/.test(identifier)) {
    return [profile.representative_name, profile.representative_role].filter((part) => (part ?? "").trim()).join(", ");
  }
  if (/fonction.*signataire|fonction.*representant|qualite.*signataire|qualite.*representant|representativerole/.test(identifier)) return profile.representative_role ?? "";
  if (/signataire|representant/.test(identifier)) return profile.representative_name ?? "";
  // L'adresse et le numéro DE LA BANQUE de l'entreprise (RIB) sont distincts
  // de l'adresse de l'entreprise elle-même : à vérifier avant le cas
  // générique "adresse" ci-dessous.
  if (!ctx.isGuaranteeBankIdentity && /banque/.test(identifier) && /adresse|address/.test(identifier)) return profile.bank_address ?? "";
  if (!ctx.isGuaranteeBankIdentity && /banque/.test(identifier) && /telephone|tel|phone/.test(identifier)) return profile.bank_phone ?? "";
  // "Adresse électronique" est le terme administratif pour "e-mail".
  if (/electronique/.test(identifier) && /adresse|address/.test(identifier)) return profile.email ?? "";
  if (/adresse|address/.test(identifier)) return profile.address ?? "";
  if (/nif/.test(identifier)) return profile.nif ?? "";
  if (/stat/.test(identifier)) return profile.stat ?? "";
  // "Registre du commerce" contient "du" entre les deux mots : après
  // normalisation (espaces supprimés) cela donne "registreducommerce".
  if (/rcs|registre[a-z]*commerce/.test(identifier)) return profile.rcs ?? "";
  if (/formejuridique/.test(identifier)) return profile.legal_form ?? "";
  if (/telephone|phone/.test(identifier)) return profile.phone ?? "";
  if (/email/.test(identifier)) return profile.email ?? "";
  if (!ctx.isGuaranteeBankIdentity) {
    if (/banque/.test(identifier)) return profile.bank_name ?? "";
    if (/agence/.test(identifier)) return profile.bank_agency ?? "";
    if (/compte|iban/.test(identifier)) return profile.bank_account ?? "";
  }
  // Le "bénéficiaire" d'une garantie/caution est l'autorité contractante du
  // DAO (le maître d'ouvrage), jamais l'entreprise candidate elle-même.
  if (/beneficiaire|autoritecontractante|maitreouvrage|maitredouvrage|autoritedelamarche|clientname|nomduclient/.test(identifier)) return ctx.tenderClientName;
  // Le délai d'exécution des travaux est déjà fixé par le DAO — à ne pas
  // confondre avec un délai de validité de l'offre.
  if (/delai.*execution|dureedestravaux|delaicontractuel|delaidexecution/.test(identifier) && ctx.tenderExecutionPeriodDays != null) return `${ctx.tenderExecutionPeriodDays} jours`;
  // Le montant ESTIMÉ du marché ne doit jamais servir de montant DE GARANTIE.
  if (/montantestime|montantdumarche|montantprevisionnel|montantducontrat|montantdeloffre/.test(identifier) && ctx.tenderEstimatedAmount != null) return `${ctx.tenderEstimatedAmount.toLocaleString("fr-FR")} Ar`;
  if (/contrat|reference|marche/.test(identifier)) return ctx.tenderReference;
  // "Lieu DU chantier" / "Site DU chantier".
  if (/localisation|lieu[a-z]*chantier|site[a-z]*chantier|emplacement[a-z]*chantier/.test(identifier)) return ctx.tenderLocation;
  // La date du jour ne convient qu'à une VRAIE date de signature. Un champ
  // "date" qui désigne en réalité un fait précis du DAO (récépissé, date
  // limite...) a sa propre date, différente d'aujourd'hui : on laisse alors
  // le champ vide plutôt que d'induire en erreur.
  const isNonSignatureDate = /recepisse|lancement|limite|echeance|publication|ouverture|cloture|depot|validite|achat|livraison|remise/.test(identifier);
  if (/date|signaturedate/.test(identifier) && !isNonSignatureDate) return ctx.today;
  if (/soumissionnaire|entreprise|entrepreneur|raisonsociale|nomentreprise|legalname|candidat/.test(identifier)) return profile.legal_name || profile.trade_name || "";
  return "";
}
