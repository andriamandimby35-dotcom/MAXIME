"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { parsePageNumbersFromReference } from "@/lib/submission/parse-page-reference";
import { buildDossierRecordsForInsert, type TemplateTable } from "@/lib/submission/build-dossier-items";
import { toFriendlyPdfError } from "@/lib/submission/friendly-pdf-error";
import { isPhoneDevice } from "@/lib/is-phone-device";
import FillablePdfViewer, { type FillablePdfViewerHandle } from "@/components/tenders/FillablePdfViewer";

type Field = { key: string; label: string; required: boolean; description: string };
type Item = {
  kind: "document_to_provide" | "form_to_complete";
  title: string;
  source_reference: string;
  instructions: string;
  required: boolean;
  status: "missing" | "needs_information" | "ready" | "uploaded";
  fields: Field[];
  form_data: Record<string, string>;
  // Présent quand l'IA a retrouvé cette pièce directement dans le DAO (pages
  // réelles à imprimer) plutôt qu'un simple générique à compléter.
  template_origin?: "dao" | "internet" | "generated" | "none";
  template_page_numbers?: number[];
  // Un tableau marqué repeatable (voir le prompt d'analyse) n'a qu'une seule
  // ligne d'exemple côté DAO : l'utilisateur peut en ajouter/retirer autant
  // que nécessaire ci-dessous (ex. litiges, conventions non exécutées).
  template_tables?: TemplateTable[];
  // Titre de la grande division du sommaire du DAO (ex. "Partie II. Les
  // formulaires de soumission...") sous laquelle cette pièce se trouve —
  // calculé côté serveur par buildMasterDetectedItems (voir lib/submission/
  // build-dossier-items.ts) ; sert uniquement à afficher un titre de
  // section au-dessus du groupe de pièces correspondant, dans le MÊME ordre
  // que le sommaire du DAO. null si le DAO n'a pas de grandes divisions ou
  // si cette pièce n'a pas pu y être rattachée.
  dossierSection?: string | null;
  // Pièce générique de secours qui fait presque toujours partie du DAO
  // lui-même (voir lib/submission/build-dossier-items.ts) : autorise le
  // bouton "Ouvrir le document à imprimer" à essayer de la RETROUVER dans le
  // DAO même quand l'IA n'a identifié aucune page pour ce DAO précis (voir
  // needsPrintableVersion) — jamais pour un document externe (CIN, RIB...)
  // que le DAO ne contient de toute façon pas.
  likely_in_dao?: boolean;
};

type DetectedItem = Omit<Item, "status" | "form_data">;
type TemplateDetectedItem = DetectedItem & { prefilled_values?: Array<{ key: string; value: string }> };
type RosterEntry = {
  name: string; role: string; qualification: string; experience: string; identity?: string;
  // Ajoutés pour générer un contrat individuel de travail complet (voir
  // isWorkerContract) : adresse et rémunération saisies à la main, et fichier
  // CIN (photo ou PDF recto/verso) lu automatiquement par l'IA dès l'ajout
  // (voir insertCinFile) puis conservé pour être joint en pages
  // supplémentaires à la fin du contrat PDF de cette personne.
  address?: string; salary?: string; cinPath?: string; cinName?: string; cinMime?: string;
};

const profileFields = [
  ["legal_name", "Raison sociale"], ["trade_name", "Nom commercial"],
  ["legal_form", "Forme juridique"],
  ["representative_name", "Représentant légal"], ["representative_role", "Fonction du représentant"],
  ["address", "Adresse"], ["phone", "Téléphone"], ["email", "E-mail"],
  ["nif", "NIF"], ["stat", "STAT"], ["rcs", "RCS / registre de commerce"],
  ["bank_name", "Banque"], ["bank_agency", "Agence bancaire"], ["bank_phone", "Téléphone de la banque"],
  ["bank_address", "Adresse de la banque"], ["bank_account", "IBAN"],
] as const;

/** Bouton avec petit indicateur de chargement — remplace le libellé par un
 * repère visuel (rotation + texte) pendant l'action, pour qu'on voie
 * immédiatement que quelque chose se passe, là où on vient de cliquer. */
function ButtonLabel({ loading, label, loadingLabel = "Chargement…" }: { loading: boolean; label: string; loadingLabel?: string }) {
  if (!loading) return <>{label}</>;
  return <><span className="spinner" />{loadingLabel}</>;
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isBankAgencyAddress(item: Item, field: Field) {
  const context = normalize(`${item.title} ${field.key} ${field.label} ${field.description}`);
  return /garantiebancaire|banque|agenceemetrice|agence[a-z]*emission/.test(context)
    && /adresse|address|agence/.test(context);
}

// La banque nommée dans une garantie/caution bancaire est un tiers (celle qui
// émet la garantie), jamais la propre banque de l'entreprise soumissionnaire :
// ces champs ne doivent donc jamais être préremplis avec le compte de l'entreprise.
function isGuaranteeBankIdentity(item: Item) {
  return /garantiebancaire|cautionbancaire|cautionpersonnelle/.test(normalize(item.title));
}

function clearCompanyAddressFromBankFields(item: Item, companyAddress: string) {
  let changed = false;
  const formData = { ...item.form_data };
  for (const field of item.fields) {
    if (isBankAgencyAddress(item, field) && formData[field.key]?.trim() === companyAddress.trim()) {
      delete formData[field.key];
      changed = true;
    }
  }
  return changed ? { ...item, form_data: formData } : item;
}

// Un champ "Nom, Prénom et Signature" (ou équivalent) sur une pièce destinée
// À CHAQUE PERSONNEL OU PARTENAIRE (code de conduite, règlement de chantier,
// engagement individuel...) désigne une personne DIFFÉRENTE à chaque
// signature — jamais l'entreprise elle-même. Le préremplir avec un champ du
// PROFIL DE L'ENTREPRISE (téléphone, adresse, banque...) est toujours une
// erreur, exactement comme pour la liste du personnel ou du matériel : ce
// filtre s'applique à N'IMPORTE QUEL DAO, pas seulement à celui-ci. Seul le
// signataire légal de l'entreprise (repéré par "signataire"/"représentant"/
// "gérant") reste concerné par le profil.
function isThirdPartySignatureField(item: Item, field: Field) {
  const identifier = normalize(`${item.title} ${field.key} ${field.label} ${field.description}`);
  const asksForAPerson = /nometprenom|nomprenom/.test(identifier)
    || (/nom/.test(identifier) && /signature|paraphe|cin|identite/.test(identifier));
  const isCompanyRepresentative = /signataire|representant|gerant|legal/.test(identifier);
  return asksForAPerson && !isCompanyRepresentative;
}

// Une valeur déjà enregistrée (avant que ce filtre existe) peut être restée
// collée dans form_data — resolvedFieldValue ne l'écraserait jamais toute
// seule, puisqu'une valeur déjà présente est normalement respectée comme une
// correction manuelle de l'utilisateur. Ici, elle correspond en réalité à une
// case du profil de l'entreprise recopiée par erreur sur un champ qui
// concerne un tiers : on la retire pour laisser la case redevenir blanche.
function clearThirdPartySignatureFields(item: Item, profileValues: Record<string, string>) {
  const knownProfileValues = new Set(Object.values(profileValues).map((value) => String(value ?? "").trim()).filter(Boolean));
  if (!knownProfileValues.size) return item;
  let changed = false;
  const formData = { ...item.form_data };
  for (const field of item.fields) {
    const saved = formData[field.key]?.trim();
    if (saved && isThirdPartySignatureField(item, field) && knownProfileValues.has(saved)) {
      delete formData[field.key];
      changed = true;
    }
  }
  return changed ? { ...item, form_data: formData } : item;
}

// Deux champs composés ("Nom, prénom, fonction" du signataire ; "Nom et
// adresse" de l'entreprise) ne renvoyaient AVANT cette correction qu'UNE
// seule des deux informations demandées (juste "Gérant", ou juste l'adresse
// sans la raison sociale) : resolvedFieldValueRaw sait désormais renvoyer les
// deux ensemble, mais une valeur déjà enregistrée AVANT ce correctif reste
// bloquée telle quelle (une valeur présente dans form_data n'est jamais
// recalculée automatiquement). On efface ici cette ancienne valeur
// incomplète — reconnaissable car elle correspond EXACTEMENT à un seul des
// deux morceaux attendus — pour que le champ se complète correctement au
// prochain calcul.
function clearStaleCompoundFields(item: Item, profileValues: Record<string, string>, tenderReference?: string) {
  const role = (profileValues.representative_role ?? "").trim();
  const address = (profileValues.address ?? "").trim();
  const name = (profileValues.representative_name ?? "").trim();
  const reference = (tenderReference ?? "").trim();
  if (!role && !address && !name && !reference) return item;
  let changed = false;
  const formData = { ...item.form_data };
  for (const field of item.fields) {
    const identifier = normalize(`${field.key} ${field.label} ${field.description}`);
    const saved = formData[field.key]?.trim();
    if (!saved) continue;
    // Champ composé "nom, prénom, fonction" : une ancienne valeur qui ne
    // contient QUE la fonction (ex. "GERANT") vient de l'époque où cette
    // règle ne renvoyait pas encore le nom et la fonction ensemble.
    const wantsNameAndFunction = /nom|prenom|identite/.test(identifier) && /fonction|qualite|qualification/.test(identifier);
    if (wantsNameAndFunction && role && saved === role) { delete formData[field.key]; changed = true; continue; }
    const wantsNameAndAddress = /soumissionnaire|entreprise|entrepreneur|raisonsociale|nomentreprise|legalname|candidat/.test(identifier)
      && /nom/.test(identifier) && /adresse|address/.test(identifier);
    if (wantsNameAndAddress && address && saved === address) { delete formData[field.key]; changed = true; continue; }
    // "Titre / capacité juridique" demande la FONCTION du signataire (ex.
    // "Gérant"), pas son nom : une ancienne valeur qui contient le nom vient
    // du temps où ce champ était mal reconnu.
    const wantsLegalCapacityRole = /juridique/.test(identifier) && /titre|capacite|qualite/.test(identifier);
    if (wantsLegalCapacityRole && name && saved === name) { delete formData[field.key]; changed = true; continue; }
    // Un champ qui demande l'identité d'UNE PERSONNE (nom, prénom, CIN,
    // signature...) ne doit jamais garder un numéro de référence de marché
    // resté collé par erreur (bug vu à l'écran : "Nom, Prénom et Signature"
    // affichait le numéro du contrat).
    const wantsPersonIdentity = /nometprenom|nomprenom/.test(identifier)
      || (/nom/.test(identifier) && /signature|paraphe|cin|identite/.test(identifier));
    if (wantsPersonIdentity && reference && saved === reference) { delete formData[field.key]; changed = true; }
  }
  return changed ? { ...item, form_data: formData } : item;
}

// Certains modèles DAO laissent l'instruction "(à compléter)" ou "à
// compléter" imprimée juste à côté d'une case vide : si l'ancien algorithme
// de remplissage l'a par erreur recopiée comme si c'était une vraie valeur,
// elle reste ensuite bloquée dans form_data et s'affiche telle quelle dans le
// PDF final, alors que ce n'est qu'un texte d'instruction, pas une donnée.
const PLACEHOLDER_VALUES = new Set(["acompleter", "neant", "sansobjet", "xxx"]);
function clearPlaceholderValues(item: Item) {
  let changed = false;
  const formData = { ...item.form_data };
  for (const field of item.fields) {
    const saved = formData[field.key]?.trim();
    if (saved && PLACEHOLDER_VALUES.has(normalize(saved))) { delete formData[field.key]; changed = true; }
  }
  return changed ? { ...item, form_data: formData } : item;
}

// Logique déplacée dans lib/submission/build-dossier-items.ts (partagée avec
// la page qui affiche le dossier et la route qui le génère explicitement),
// pour que les trois endroits produisent toujours exactement la même liste.
function deduplicate(items: TemplateDetectedItem[]): Item[] {
  return buildDossierRecordsForInsert(items);
}

function mergeItems(saved: Item[], detected: TemplateDetectedItem[]) {
  const byKey = new Map(saved.map((item) => [`${item.kind}:${normalize(item.title)}`, item]));
  return deduplicate(detected).map((item) => {
    const stored = byKey.get(`${item.kind}:${normalize(item.title)}`);
    // La table de sauvegarde ne connaît que ce que l'utilisateur a rempli
    // (form_data, status) : elle n'a pas de colonne pour template_origin ou
    // template_page_numbers. Remplacer tout l'item par la version stockée
    // effaçait donc silencieusement ces pages du DAO à chaque sauvegarde
    // suivie d'un rechargement — plus de bouton PDF pour la pièce concernée.
    // Seules les données réellement possédées par l'utilisateur doivent
    // venir du stockage ; tout ce qui vient de l'analyse IA reste la version
    // la plus fraîche (item), jamais l'ancienne copie sauvegardée.
    return stored ? { ...item, status: stored.status, form_data: { ...item.form_data, ...stored.form_data } } : item;
  });
}

export default function SubmissionDossierManager({ tenderId, tenderReference, tenderLocation, tenderClientName, tenderExecutionPeriodDays, tenderEstimatedAmount, estimateId, organizationId, daoUrl, detectedItems }: { tenderId: string; tenderReference: string; tenderLocation: string; tenderClientName: string; tenderExecutionPeriodDays: number | null; tenderEstimatedAmount: number | null; estimateId: string | null; organizationId: string; daoUrl: string | null; detectedItems: TemplateDetectedItem[] }) {
  const scope = estimateId ? `?estimateId=${encodeURIComponent(estimateId)}` : "";
  const storageKey = `submission-dossier:${tenderId}:${estimateId ?? "master"}`;
  // The first browser render must match SSR. Restore local data only after hydration.
  const [profile, setProfile] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Item[]>(() => deduplicate(detectedItems));
  const [message, setMessage] = useState("Chargement du dossier…");
  const [linkedDocuments, setLinkedDocuments] = useState<Array<{ estimateId: string; fileName: string | null; updatedAt: string | null; url: string | null }>>([]);
  const [today, setToday] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [viewingPdf, setViewingPdf] = useState<{ title: string; objectUrl: string } | null>(null);
  // Nouvelle approche (vraie page + cases cliquables, voir printable-
  // submission-document/route.ts) : chaque pièce n'affiche plus qu'un seul
  // bouton rouge "Ouvrir", qui ouvre CETTE petite fenêtre avec Modifier/
  // Enregistrer/Imprimer, au lieu de montrer directement les champs à
  // remplir dans l'appli — l'utilisateur les remplit désormais lui-même
  // dans sa propre application PDF. Un index d'item (pas l'item lui-même)
  // pour toujours lire la version la plus à jour de items[] au moment du clic.
  const [actionsForIndex, setActionsForIndex] = useState<number | null>(null);
  // En-têtes d'authentification (jeton Supabase) à donner au lecteur PDF
  // intégré (FillablePdfViewer) pour qu'il puisse aller chercher le document
  // lui-même : préparés une fois à l'ouverture de la fenêtre plutôt qu'à
  // chaque nouvelle page/pièce.
  const [fillableAuthHeaders, setFillableAuthHeaders] = useState<Record<string, string> | null>(null);
  // Passe à un message + les anciens boutons de secours (onglet séparé +
  // fichier à choisir) si jamais le lecteur intégré n'arrive pas à afficher
  // ce PDF précis (navigateur trop ancien, etc.) — jamais un écran bloqué
  // sans rien à cliquer.
  const [fillableViewerFailed, setFillableViewerFailed] = useState(false);
  // Message technique réel de l'échec (affiché tel quel en solution de
  // secours) : indispensable pour comprendre POURQUOI ça échoue sur un
  // appareil précis au lieu de deviner à l'aveugle.
  const [fillableViewerError, setFillableViewerError] = useState<string | null>(null);
  const fillablePdfViewerRef = useRef<FillablePdfViewerHandle>(null);
  // Date à laquelle l'utilisateur a cliqué sur "Valider la complétion" — null
  // si le dossier n'est pas (ou plus) marqué comme complet. Remplace
  // l'ancienne génération d'un PDF fusionné : voir toggleDossierLock.
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  // Identifie l'action en cours (ouverture PDF, envoi de fichier...) pour
  // afficher un indicateur directement sur le bouton cliqué — auparavant rien
  // ne montrait qu'une action était en cours pendant l'attente.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pdfIframeRef = useRef<HTMLIFrameElement>(null);
  const hasLocalDraft = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const detected = useMemo(() => deduplicate(detectedItems), [detectedItems]);

  useEffect(() => {
    let draft: { profile?: Record<string, string>; items?: Item[] } | null = null;
    try { draft = JSON.parse(window.localStorage.getItem(storageKey) || "null") as { profile?: Record<string, string>; items?: Item[] } | null; } catch { draft = null; }
    hasLocalDraft.current = Boolean(draft);
    const restoreTimer = window.setTimeout(() => {
      if (draft) {
        setProfile(draft.profile ?? {});
        setItems(draft.items ?? detected);
        setMessage("Brouillon local restauré. Synchronisation en cours…");
      }
      setToday(new Date().toLocaleDateString("fr-CA"));
    }, 0);
    fetch(`/api/tenders/${tenderId}/submission-dossier${scope}`)
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || "Chargement impossible");
        setProfile((current) => ({ ...payload.profile, ...current }));
        setLockedAt(payload.lockedAt ?? null);
        const companyAddress = String(payload.profile?.address ?? "");
        const profileValues = (payload.profile ?? {}) as Record<string, string>;
        const correctItem = (item: Item) => clearPlaceholderValues(clearStaleCompoundFields(clearThirdPartySignatureFields(clearCompanyAddressFromBankFields(item, companyAddress), profileValues), profileValues, tenderReference));
        const correctedServerItems = mergeItems(payload.items, detected).map(correctItem);
        setItems((current) => mergeItems(hasLocalDraft.current ? current : correctedServerItems, detected).map(correctItem));
        const hadIncorrectBankAddress = (payload.items as Item[]).some((item) => item.fields.some((field) => isBankAgencyAddress(item, field) && item.form_data[field.key]?.trim() === companyAddress.trim()));
        const knownProfileValues = new Set(Object.values(profileValues).map((value) => String(value ?? "").trim()).filter(Boolean));
        const hadIncorrectThirdPartySignature = (payload.items as Item[]).some((item) => item.fields.some((field) => {
          const saved = item.form_data[field.key]?.trim();
          return Boolean(saved) && isThirdPartySignatureField(item, field) && knownProfileValues.has(saved!);
        }));
        const hadStaleCompoundField = (payload.items as Item[]).some((item) => {
          const cleared = clearStaleCompoundFields(item, profileValues, tenderReference);
          return cleared !== item;
        });
        const hadPlaceholderValue = (payload.items as Item[]).some((item) => clearPlaceholderValues(item) !== item);
        if (hadIncorrectBankAddress || hadIncorrectThirdPartySignature || hadStaleCompoundField || hadPlaceholderValue) {
          window.localStorage.setItem(storageKey, JSON.stringify({ profile: payload.profile, items: correctedServerItems }));
          void fetch(`/api/tenders/${tenderId}/submission-dossier`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile: payload.profile, items: correctedServerItems, estimateId }),
          });
        }
        setMessage("Dossier prêt. Les modifications sont sauvegardées automatiquement.");
      })
      .catch((error: Error) => setMessage(`${error.message} Votre brouillon reste conservé sur cet appareil.`))
      .finally(() => setLoaded(true));

    fetch(`/api/tenders/${tenderId}/submission-dossier/documents`)
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => { if (response.ok) setLinkedDocuments(payload.estimates ?? []); })
      .catch(() => undefined);
    return () => window.clearTimeout(restoreTimer);
  }, [detected, estimateId, scope, storageKey, tenderId, tenderReference]);

  // Prépare les en-têtes d'authentification UNE fois à l'ouverture de la
  // fenêtre Ouvrir (pas à chaque frappe) : c'est FillablePdfViewer qui fait
  // ensuite lui-même la requête vers printable-submission-document, avec ces
  // en-têtes, exactement comme fetchAndValidatePdf le fait ailleurs dans ce
  // fichier.
  useEffect(() => {
    setFillableViewerFailed(false);
    setFillableViewerError(null);
    if (actionsForIndex === null) { setFillableAuthHeaders(null); return; }
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      setFillableAuthHeaders(session?.access_token ? {
        Authorization: `Bearer ${session.access_token}`,
        "X-Supabase-Access-Token": session.access_token,
      } : {});
    });
    return () => { cancelled = true; };
  }, [actionsForIndex, supabase]);

  function scheduleSave(nextProfile: Record<string, string>, nextItems: Item[]) {
    window.localStorage.setItem(storageKey, JSON.stringify({ profile: nextProfile, items: nextItems }));
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setMessage("Enregistrement automatique…");
    saveTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/tenders/${tenderId}/submission-dossier`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: nextProfile, items: nextItems, estimateId }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Enregistrement impossible");
        setMessage("Enregistré pour les prochains DAO de cette entreprise.");
      } catch (error) {
        setMessage(`${error instanceof Error ? error.message : "Erreur d’enregistrement"} Brouillon local conservé.`);
      }
    }, 700);
  }

  async function saveImmediately(nextProfile: Record<string, string>, nextItems: Item[]) {
    window.localStorage.setItem(storageKey, JSON.stringify({ profile: nextProfile, items: nextItems }));
    const response = await fetch(`/api/tenders/${tenderId}/submission-dossier`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: nextProfile, items: nextItems, estimateId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Enregistrement impossible");
  }

  function updateProfile(key: string, value: string) {
    const next = { ...profile, [key]: value };
    setProfile(next);
    scheduleSave(next, items);
  }

  function updateItem(index: number, patch: Partial<Item>) {
    const next = items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    setItems(next);
    scheduleSave(profile, next);
  }

  // Tous les PDF du dossier (fichier joint, document généré, BDQE, contrat…)
  // s'ouvrent dans cette même carte au lieu d'une nouvelle fenêtre : défilement
  // continu, sans la barre d'outils du lecteur natif (donc sans le numéro de
  // page à côté), et un bouton Imprimer qui n'imprime que ce PDF.
  function showPdfInModal(title: string, blob: Blob) {
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    setViewingPdf({ title, objectUrl });
  }

  // Si un onglet natif a été ouvert à l'avance (voir openPdfDirectly plus
  // bas pour l'explication complète du pourquoi), on y affiche le PDF en
  // plein écran ; sinon on garde notre fenêtre habituelle avec ses boutons.
  function openPdfPreferringNativeTab(nativeTab: Window | null, title: string, blob: Blob) {
    if (nativeTab) {
      nativeTab.location.href = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    } else {
      showPdfInModal(title, blob);
    }
  }

  function closePdfModal() {
    if (viewingPdf) URL.revokeObjectURL(viewingPdf.objectUrl);
    setViewingPdf(null);
  }

  function printViewingPdf() {
    try { pdfIframeRef.current?.contentWindow?.print(); }
    catch { setMessage("Impression impossible depuis cet aperçu."); }
  }

  function needsPrintableVersion(item: Item) {
    // Une pièce "à lire et confirmer" (charte, politique de fraude...) peut
    // AUSSI avoir de vraies pages DAO à imprimer et signer (souvent une page
    // de déclaration/engagement en fin de document) : les deux boutons
    // doivent pouvoir coexister, l'un n'exclut pas l'autre.
    // Dès que l'IA a retrouvé de vraies pages du DAO pour cette pièce, il
    // faut pouvoir les ouvrir/imprimer directement — sans ça, la source
    // affichée (ex. "p.19-20") n'est qu'une indication qu'il faut chercher
    // soi-même dans tout le DAO, ce qui est justement le problème à éviter.
    if (item.template_origin === "dao" && (item.template_page_numbers?.length ?? 0) > 0) return true;
    // Idem quand l'IA n'a pas créé d'entrée dédiée pour cette pièce, mais que
    // sa référence affichée cite déjà de vraies pages (ex. "Pages 31-46,
    // Partie III" pour le CCAP) : ce n'est pas juste indicatif, ces pages
    // peuvent être lues et affichées directement.
    if (parsePageNumbersFromReference(item.source_reference).length > 0) return true;
    // Un formulaire à remplir (form_to_complete) produit toujours un PDF utile
    // (préempli avec les infos de l'entreprise). Mais un simple document à
    // fournir (CIN, RIB, attestation, certificat, reçu…) qui n'a pas été
    // trouvé dans le DAO n'a rien de réel à générer : proposer un PDF
    // générique ("Document signé ou certifié conforme...") ne sert à rien —
    // seul "Choisir un fichier" a du sens pour joindre le vrai document.
    if (item.kind === "form_to_complete") return true;
    // Exception : "Plan à parapher" (et toute pièce dont le titre contient
    // "plan") a un vrai contenu même sans template_origin=dao — le registre
    // des plans + les vraies pages du DAO, généré via un mécanisme séparé
    // (plan_register) côté serveur.
    if (/\bplans?\b/i.test(item.title)) return true;
    // Pièce générique de secours dont on sait qu'elle fait presque toujours
    // partie du DAO (CCAP, calendrier cultural, code de conduite...) même
    // quand l'IA n'a retrouvé aucune page pour ce DAO précis : le bouton
    // tente alors de la localiser automatiquement dans le document (voir
    // locateTitleInFullDocument côté serveur) plutôt que de rester une carte
    // sans aucun PDF — jamais pour un document externe (CIN, RIB...).
    return Boolean(item.likely_in_dao);
  }

  function isBdqe(item: Item) {
    return /bdqe|bordereau.*quantitatif|bordereau.*estimatif/i.test(item.title);
  }

  function isReadingOnly(item: Item) { return /charte de déontologie|fraude|corruption/i.test(item.title); }

  async function fetchAndValidatePdf(documentUrl: string) {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(documentUrl, {
      method: "GET",
      cache: "no-store",
      headers: session?.access_token ? {
        Authorization: `Bearer ${session.access_token}`,
        "X-Supabase-Access-Token": session.access_token,
        "X-PDF-Client-Fetch": "1",
      } : undefined,
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => null) as { pdfBase64?: string; error?: string; detail?: string } | null
      : null;
    if (payload && !payload.pdfBase64) {
      // Une réponse JSON sans pdfBase64 est une erreur explicite du serveur
      // (jamais un PDF à moitié lu) : on affiche son vrai détail plutôt
      // qu'un message générique qui masquait la cause réelle jusqu'ici.
      throw new Error(payload.detail || payload.error || `Le serveur a répondu avec le statut ${response.status}.`);
    }
    const pdf = payload?.pdfBase64
      ? new Blob([Uint8Array.from(atob(payload.pdfBase64), (character) => character.charCodeAt(0))], { type: "application/pdf" })
      : await response.blob();
    // Un vrai PDF commence toujours par la signature "%PDF-". Sans cette
    // vérification, une réponse imprévue (page d'erreur, redirection de
    // connexion...) — vue en particulier sur téléphone — était quand même
    // affichée dans le cadre du PDF : au lieu du document, l'écran montrait
    // des caractères illisibles au lieu du vrai message d'erreur.
    const signature = new TextDecoder().decode(new Uint8Array(await pdf.slice(0, 5).arrayBuffer()));
    if (!response.ok || pdf.size < 5 || signature !== "%PDF-") {
      const detail = new TextDecoder().decode(new Uint8Array(await pdf.slice(0, 400).arrayBuffer())).replace(/\s+/g, " ").trim();
      throw new Error(detail || `Le serveur a répondu avec le statut ${response.status}.`);
    }
    return pdf;
  }

  async function openPdfDirectly(key: string, title: string, documentUrl: string) {
    setPendingAction(key);
    setMessage("Préparation du PDF…");
    // Sur téléphone, un PDF affiché dans notre fenêtre (iframe) n'a ni zoom
    // ni défilement correct entre les pages — limitation du mini-lecteur
    // intégré d'iOS/Android, pas de notre code. Le vrai lecteur PDF natif du
    // téléphone ne s'active que si le PDF s'ouvre en plein écran dans son
    // propre onglet. On ouvre donc cet onglet ICI, de façon synchrone, AVANT
    // le premier "await" : Safari bloque comme une pop-up indésirable tout
    // window.open() déclenché après une attente réseau, mais pas celui-ci,
    // toujours accepté puisqu'il vient directement du clic. Sur ordinateur,
    // rien ne change : on garde notre fenêtre avec les boutons personnalisés.
    const nativeTab = isPhoneDevice() ? window.open("", "_blank") : null;
    // Un premier essai raté vient presque toujours d'une fonction serveur
    // trop lente à démarrer (surtout après une période sans activité — un
    // "cold start"), plus visible sur téléphone à cause d'un réseau moins
    // stable. Plusieurs essais automatiques, sans que la personne ait à
    // retaper sur le bouton, suffisent dans la grande majorité des cas.
    const retryDelaysMs = [1500, 3000];
    try {
      let pdf: Blob | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        try {
          pdf = await fetchAndValidatePdf(documentUrl);
          break;
        } catch (error) {
          lastError = error;
          if (attempt === retryDelaysMs.length) break;
          setMessage("Le PDF a mis du temps à répondre, nouvel essai…");
          await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        }
      }
      if (!pdf) throw lastError instanceof Error ? lastError : new Error("Le PDF n’a pas pu être préparé.");
      openPdfPreferringNativeTab(nativeTab, title, pdf);
      setMessage("");
    } catch (error) {
      nativeTab?.close();
      const raw = error instanceof Error ? error.message : "Le PDF n’a pas pu être préparé.";
      if (raw !== "Le PDF n’a pas pu être préparé.") console.error("Échec de préparation du PDF :", raw);
      setMessage(toFriendlyPdfError(raw));
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  async function openOfficialBdqe(officialEstimateId: string) {
    const key = `bdqe:${officialEstimateId}`;
    setPendingAction(key);
    setMessage("Préparation du BDQE…");
    const nativeTab = isPhoneDevice() ? window.open("", "_blank") : null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/estimates/${officialEstimateId}/official-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PDF-Client-Fetch": "1",
          ...(session?.access_token ? {
            Authorization: `Bearer ${session.access_token}`,
            "X-Supabase-Access-Token": session.access_token,
          } : {}),
        },
        body: JSON.stringify({ save: false, mode: "external" }),
      });
      const payload = await response.json().catch(() => ({})) as { pdfBase64?: string; error?: string };
      if (!response.ok || !payload.pdfBase64) throw new Error(payload.error || "Le BDQE n’a pas pu être préparé.");
      const bytes = Uint8Array.from(atob(payload.pdfBase64), (character) => character.charCodeAt(0));
      openPdfPreferringNativeTab(nativeTab, "BDQE", new Blob([bytes], { type: "application/pdf" }));
      setMessage("");
    } catch (error) {
      nativeTab?.close();
      setMessage(error instanceof Error ? error.message : "Ouverture du BDQE impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  function openPrintableVersion(item: Item) {
    // Le PDF s'ouvre toujours, même si une information obligatoire n'est pas
    // encore complétée : la case correspondante reste alors simplement
    // blanche dans le document (le générateur ne remplit jamais une case
    // avec du texte inventé). Bloquer complètement l'ouverture donnait
    // l'impression que le document restait "vide", alors qu'il suffit de
    // compléter le champ puis de rouvrir le PDF pour le voir mis à jour.
    const missing = item.fields.filter((field) => field.required && !resolvedFieldValue(item, field).trim());
    if (missing.length) {
      setMessage(`Le PDF s’ouvre avec des cases encore blanches : ${missing.map((field) => field.label).join(", ")}. Complétez-les puis rouvrez le PDF pour les voir mises à jour.`);
    }
    const query = new URLSearchParams({ title: item.title, kind: item.kind, sourceReference: item.source_reference || "" });
    if (estimateId) query.set("estimateId", estimateId);
    const documentUrl = `/api/tenders/${tenderId}/printable-submission-document?${query}`;
    void openPdfDirectly(`pdf:${item.title}`, item.title, documentUrl);
  }

  function openWorkerContract(item: Item, workerIndex: number) {
    const query = new URLSearchParams({ title: item.title, kind: item.kind, workerIndex: String(workerIndex), sourceReference: item.source_reference || "" });
    if (estimateId) query.set("estimateId", estimateId);
    const documentUrl = `/api/tenders/${tenderId}/printable-submission-document?${query}`;
    void openPdfDirectly(`pdf:${item.title}:${workerIndex}`, item.title, documentUrl);
  }

  // Même construction d'URL utilisée partout où on va chercher LE PDF d'une
  // pièce précise (fenêtre de remplissage intégrée, solution de secours par
  // onglet/téléchargement) : un seul endroit à corriger si jamais un
  // paramètre doit changer.
  function printableDocumentUrl(item: Item) {
    const query = new URLSearchParams({ title: item.title, kind: item.kind, sourceReference: item.source_reference || "" });
    if (estimateId) query.set("estimateId", estimateId);
    return `/api/tenders/${tenderId}/printable-submission-document?${query}`;
  }

  // Déclenche un VRAI téléchargement (fichier posé dans le dossier de
  // téléchargements, comme n'importe quel PDF téléchargé) : gardé comme
  // solution de secours pour downloadPdfForEditingFallback (voir plus bas)
  // quand le navigateur bloque l'ouverture d'un nouvel onglet (pop-up bloquée).
  function triggerBrowserDownload(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Laisse le temps au navigateur de démarrer le téléchargement avant de
    // libérer l'URL mémoire — certains navigateurs annulent sinon le
    // téléchargement à peine commencé.
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Solution de SECOURS uniquement : utilisée seulement si le lecteur PDF
  // intégré (FillablePdfViewer, voir la fenêtre Ouvrir plus bas) échoue à
  // s'afficher pour une raison ou une autre (vieux navigateur, etc.) — dans
  // le fonctionnement normal, remplir se fait directement dans la fenêtre
  // de l'appli, sans onglet séparé ni fichier à re-choisir.
  async function downloadPdfForEditingFallback(item: Item) {
    const key = `edit:${item.title}`;
    setPendingAction(key);
    setMessage("Préparation du PDF à remplir…");
    // Ouvre un nouvel onglet ICI, de façon synchrone, AVANT le premier
    // "await" (même astuce que openPdfDirectly plus haut — Safari et les
    // autres navigateurs bloquent comme pop-up indésirable un window.open()
    // déclenché après une attente réseau, mais jamais celui-ci puisqu'il
    // vient directement du clic). L'intérêt, par rapport à un simple
    // téléchargement : ce nouvel onglet affiche le PDF avec la VRAIE barre
    // d'outils du navigateur (ou de l'application PDF par défaut sur
    // téléphone) — celle que notre propre fenêtre masque exprès ailleurs
    // dans l'appli pour un simple aperçu. C'est cette barre d'outils qui
    // permet de remplir les cases ET d'enregistrer le fichier rempli, sans
    // que le client ait besoin d'installer une quelconque application.
    const editingTab = window.open("", "_blank");
    try {
      const documentUrl = printableDocumentUrl(item);
      const pdf = await fetchAndValidatePdf(documentUrl);
      if (editingTab) {
        editingTab.location.href = URL.createObjectURL(pdf);
        setMessage("PDF ouvert dans un nouvel onglet : remplissez les cases directement dedans, enregistrez le fichier rempli depuis cet onglet (bouton d’enregistrement/téléchargement du navigateur), puis revenez ici cliquer sur « Enregistrer » pour l’envoyer.");
      } else {
        // Fenêtres pop-up bloquées par le navigateur : on retombe sur un
        // téléchargement classique, comme avant — le client ouvre alors le
        // fichier lui-même avec l'application PDF de son choix.
        triggerBrowserDownload(pdf, `${normalize(item.title) || "document"}.pdf`);
        setMessage("Les fenêtres pop-up semblent bloquées par votre navigateur : le PDF a été téléchargé à la place. Ouvrez-le avec votre application PDF, remplissez les cases, puis revenez cliquer sur « Enregistrer ».");
      }
    } catch (error) {
      editingTab?.close();
      setMessage(error instanceof Error ? toFriendlyPdfError(error.message) : "Le PDF n’a pas pu être préparé.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  // Un seul emplacement de stockage PAR PIÈCE (upsert:true, chemin fixe basé
  // sur le titre — pas d'UUID) : renvoyer une nouvelle version après une
  // première correction remplace l'ancienne au lieu de s'accumuler, et
  // rouvrir l'action plus tard retrouve toujours la bonne version.
  function filledPdfStoragePath(item: Item) {
    return `${organizationId}/submission/${tenderId}/filled/${estimateId ?? "master"}/${normalize(item.title) || "document"}.pdf`;
  }

  function hasFilledVersion(item: Item) {
    return Boolean(item.form_data.__filledPdfPath);
  }

  // Accepte n'importe quel Blob (octets renvoyés par le lecteur PDF intégré
  // via saveDocument(), ou un vrai File choisi à la main en solution de
  // secours) — un seul chemin d'envoi pour les deux cas, plutôt que deux
  // fonctions presque identiques.
  async function uploadFilledPdf(index: number, item: Item, data: Blob, fileName: string) {
    const key = `save:${index}`;
    setPendingAction(key);
    setMessage("Envoi du PDF rempli…");
    try {
      const path = filledPdfStoragePath(item);
      const upload = await supabase.storage.from("btp-documents").upload(path, data, { upsert: true, contentType: "application/pdf" });
      if (upload.error) { setMessage(`Envoi impossible : ${upload.error.message}`); return; }
      // On repart de la version la plus à jour de cet item (items[index]),
      // pas de "item" capturé avant l'envoi : une modification faite pendant
      // l'upload ne doit jamais être perdue.
      const current = items[index];
      if (!current) return;
      updateItem(index, {
        status: "ready",
        form_data: { ...current.form_data, __filledPdfPath: path, __filledPdfName: fileName, __readyAt: new Date().toISOString() },
      });
      setMessage("PDF rempli enregistré. Cette pièce est marquée comme prête.");
      // Demandé par Maxime : une fois enregistré, la fenêtre se referme toute
      // seule — plus besoin de cliquer sur Fermer en plus d'Enregistrer.
      setActionsForIndex((current) => current === index ? null : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Envoi du PDF impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  // Appelée par le bouton Enregistrer de la fenêtre Ouvrir (voir plus bas) :
  // récupère les octets DÉJÀ remplis par la personne dans le lecteur PDF
  // intégré (FillablePdfViewer), sans aucune étape de fichier à choisir.
  async function saveFilledPdfFromViewer(index: number, item: Item) {
    const key = `save:${index}`;
    setPendingAction(key);
    setMessage("Lecture des cases remplies…");
    try {
      const bytes = await fillablePdfViewerRef.current?.getFilledPdfBytes();
      if (!bytes) throw new Error("Le PDF n’est pas encore prêt, réessayez dans un instant.");
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      await uploadFilledPdf(index, item, blob, `${normalize(item.title) || "document"}.pdf`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible.");
      setPendingAction((current) => current === key ? null : current);
    }
  }

  async function openReadingDocument() {
    if (!daoUrl) return;
    const key = "read";
    setPendingAction(key);
    setMessage("Ouverture du document…");
    const nativeTab = isPhoneDevice() ? window.open("", "_blank") : null;
    try {
      const response = await fetch(daoUrl);
      if (!response.ok) throw new Error(`Le serveur a répondu avec le statut ${response.status}.`);
      openPdfPreferringNativeTab(nativeTab, "Document à lire", await response.blob());
      setMessage("");
    } catch (error) {
      nativeTab?.close();
      setMessage(error instanceof Error ? error.message : "Ouverture du document impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  // Certains modèles DAO précisent explicitement "(en majuscules)" à côté
  // d'un intitulé (nom, raison sociale...) : une valeur reprise telle quelle
  // depuis le profil (souvent en casse normale) déforme alors visuellement
  // le rendu par rapport au modèle attendu. On met en majuscules uniquement
  // quand le champ le demande lui-même, jamais par défaut sur les autres.
  function resolvedFieldValue(item: Item, field: Field) {
    const value = resolvedFieldValueRaw(item, field);
    const wantsUppercase = /majuscule/.test(normalize(`${field.label} ${field.description}`));
    return wantsUppercase ? value.toLocaleUpperCase("fr-FR") : value;
  }

  function resolvedFieldValueRaw(item: Item, field: Field) {
    const identifier = normalize(`${field.key} ${field.label} ${field.description}`);
    if (isPersonnelList(item) && /nom|prenom|personnel|attribution|fonction|diplome|experience/.test(identifier)) return "";
    if (isMaterialList(item) && /nom|designation|description|materiel|materiel|statut|fonction|capacite|quantite/.test(identifier)) return "";
    if (isThirdPartySignatureField(item, field)) return "";
    // Une garantie bancaire appartient à la banque : son agence ne doit jamais
    // récupérer par défaut l'adresse de l'entreprise soumissionnaire.
    if (isBankAgencyAddress(item, field)) {
      const bankAddress = item.form_data[field.key] ?? "";
      return bankAddress.trim() === (profile.address ?? "").trim() ? "" : bankAddress;
    }
    const direct = item.form_data[field.key] ?? profile[field.key];
    if (direct?.trim()) return direct;
    // Un champ qui demande le NOM ET l'ADRESSE de l'entreprise en même temps
    // (ex. "Nom et adresse de l'Entrepreneur") ne doit jamais s'arrêter à un
    // seul des deux, sinon la raison sociale disparaît derrière la seule
    // adresse (ou l'inverse) : c'était le bug vu à l'écran, où seule
    // l'adresse apparaissait. "Entrepreneur" et "candidat" désignent ici
    // l'entreprise candidate elle-même (vocabulaire courant des DAO
    // malgaches), jamais un tiers.
    if (/soumissionnaire|entreprise|entrepreneur|raisonsociale|nomentreprise|legalname|candidat/.test(identifier)
        && /nom/.test(identifier) && /adresse|address/.test(identifier)) {
      const companyName = profile.legal_name || profile.trade_name || "";
      return [companyName, profile.address ?? ""].filter((part) => part.trim()).join(", ");
    }
    // Les règles d'IDENTITÉ (nom/fonction du signataire) doivent passer AVANT
    // les cas génériques ci-dessous (adresse, contrat/référence, date...),
    // sinon un champ qui mentionne aussi "contrat" ou "adresse" en passant
    // dans sa description tombe dans la mauvaise règle générique (bugs vus à
    // l'écran : "Titre/capacité juridique" affichait un nom, "Nom, Prénom et
    // Signature" affichait un numéro de contrat).
    // "Titre / capacité juridique (du signataire)" : demande la FONCTION,
    // jamais le nom.
    if (/juridique/.test(identifier) && /titre|capacite|qualite/.test(identifier)) return profile.representative_role ?? "";
    // "Nom, prénom, fonction" (ou "Nom et qualité") du signataire veut
    // l'identité ET la fonction ensemble — sinon on n'affiche que "Gérant"
    // sans dire de qui il s'agit, comme vu à l'écran. Cette règle ne dépend
    // plus du mot "signataire"/"représentant" pour s'appliquer : un champ qui
    // demande simplement "nom" + "fonction" ensemble suffit.
    if (/nom|prenom|identite/.test(identifier) && /fonction|qualite|qualification/.test(identifier)) {
      return [profile.representative_name, profile.representative_role].filter((part) => (part ?? "").trim()).join(", ");
    }
    if (/fonction.*signataire|fonction.*representant|qualite.*signataire|qualite.*representant|representativerole/.test(identifier)) return profile.representative_role ?? "";
    if (/signataire|representant/.test(identifier)) return profile.representative_name ?? "";
    // L'adresse et le numéro DE LA BANQUE de l'entreprise (RIB) sont
    // distincts de l'adresse de l'entreprise elle-même : à vérifier avant le
    // cas générique "adresse" ci-dessous, sinon ce dernier gagnerait toujours.
    if (!isGuaranteeBankIdentity(item) && /banque/.test(identifier) && /adresse|address/.test(identifier)) return profile.bank_address ?? "";
    if (!isGuaranteeBankIdentity(item) && /banque/.test(identifier) && /telephone|tel|phone/.test(identifier)) return profile.bank_phone ?? "";
    // "Adresse électronique" est le terme administratif pour "e-mail" — sans
    // ce cas, le mot "adresse" qu'il contient aussi le faisait tomber dans la
    // règle générique juste en dessous, qui renvoie l'adresse POSTALE de
    // l'entreprise à la place d'un e-mail.
    if (/electronique/.test(identifier) && /adresse|address/.test(identifier)) return profile.email ?? "";
    if (/adresse|address/.test(identifier)) return profile.address ?? "";
    if (/nif/.test(identifier)) return profile.nif ?? "";
    if (/stat/.test(identifier)) return profile.stat ?? "";
    // "Registre du commerce" contient "du" entre les deux mots : après
    // normalisation (espaces supprimés) cela donne "registreducommerce",
    // que l'ancien test "registrecommerce" (sans "du") ne reconnaissait pas
    // — la valeur déjà connue du profil restait donc invisible.
    if (/rcs|registre[a-z]*commerce/.test(identifier)) return profile.rcs ?? "";
    if (/formejuridique/.test(identifier)) return profile.legal_form ?? "";
    if (/telephone|phone/.test(identifier)) return profile.phone ?? "";
    if (/email/.test(identifier)) return profile.email ?? "";
    // Les coordonnées bancaires de l'entreprise (RIB, Fiche A1-A5...)
    // reviennent dans plusieurs pièces : elles sont réutilisables comme le
    // reste du profil, sauf sur une pièce de garantie/caution où "banque" et
    // "agence" désignent un tiers différent (voir isGuaranteeBankIdentity).
    if (!isGuaranteeBankIdentity(item)) {
      if (/banque/.test(identifier)) return profile.bank_name ?? "";
      if (/agence/.test(identifier)) return profile.bank_agency ?? "";
      if (/compte|iban/.test(identifier)) return profile.bank_account ?? "";
    }
    // Le "bénéficiaire" d'une garantie/caution est l'autorité contractante du
    // DAO (le maître d'ouvrage), jamais l'entreprise candidate elle-même.
    if (/beneficiaire|autoritecontractante|maitreouvrage|maitredouvrage|autoritedelamarche|clientname|nomduclient/.test(identifier)) return tenderClientName;
    // Le délai d'exécution des travaux est déjà fixé par le DAO (extrait dans
    // execution_period_days) : à ne pas confondre avec un délai de validité
    // de l'offre, qui est une notion différente.
    if (/delai.*execution|dureedestravaux|delaicontractuel|delaidexecution/.test(identifier) && tenderExecutionPeriodDays != null) return `${tenderExecutionPeriodDays} jours`;
    // Le montant ESTIMÉ du marché est saisi une fois à la création de l'appel
    // d'offres ; ne jamais l'utiliser pour le montant d'UNE GARANTIE (qui est
    // un pourcentage calculé, une valeur différente), seulement pour un champ
    // qui demande explicitement le montant estimé/prévisionnel du marché.
    if (/montantestime|montantdumarche|montantprevisionnel|montantducontrat|montantdeloffre/.test(identifier) && tenderEstimatedAmount != null) return `${tenderEstimatedAmount.toLocaleString("fr-FR")} Ar`;
    if (/contrat|reference|marche/.test(identifier)) return tenderReference;
    // "Lieu DU chantier" / "Site DU chantier" : même souci que "registre du
    // commerce" plus haut, le mot de liaison ("du") empêchait la
    // correspondance exacte.
    if (/localisation|lieu[a-z]*chantier|site[a-z]*chantier|emplacement[a-z]*chantier/.test(identifier)) return tenderLocation;
    // La date du jour ne convient qu'à une VRAIE date de signature ("Fait à
    // ..., le ..."). Un champ "date" qui désigne en réalité un fait précis du
    // DAO (date du récépissé d'achat, date de lancement de l'AOL, date
    // limite, date de publication...) a sa propre date, différente
    // d'aujourd'hui : la deviner comme si elle était déjà connue induirait le
    // candidat en erreur. On laisse alors le champ vide, à compléter à la
    // main avec la vraie date lue sur le DAO.
    const isNonSignatureDate = /recepisse|lancement|limite|echeance|publication|ouverture|cloture|depot|validite|achat|livraison|remise/.test(identifier);
    if (/date|signaturedate/.test(identifier) && !isNonSignatureDate) return today;
    // (Les règles d'identité du signataire — nom+fonction, titre/capacité
    // juridique, signataire seul — sont vérifiées PLUS HAUT, avant les cas
    // génériques adresse/contrat/date : voir le commentaire à cet endroit.)
    if (/soumissionnaire|entreprise|entrepreneur|raisonsociale|nomentreprise|legalname|candidat/.test(identifier)) return profile.legal_name || profile.trade_name || "";
    return "";
  }

  // Dans ce DAO l'Annexe 3 p.233 est la seule liste de personnel chantier.
  // L'autre « liste du personnel et leurs fonctions » correspond au contrat
  // individuel à produire pour chaque personne ajoutée dans cette liste.
  function isWorkerContract(item: Item) {
    return /petit contrat.*travailleur|contrat.*travailleur|contrat.*employ/i.test(item.title)
      || (/liste du personnel et leurs fonctions/i.test(item.title) && !/affecter au chantier/i.test(item.title));
  }
  function isPersonnelList(item: Item) { return /personnel|personnels|ressources humaines|equipe/i.test(item.title) && !isWorkerContract(item); }
  function isMaterialList(item: Item) { return /materiel|matériels|equipement|équipement|engins/i.test(item.title); }
  function rosterFor(item: Item, key: "__personnel" | "__materiel" | "__workers") {
    try { const roster = JSON.parse(item.form_data[key] || "[]"); return Array.isArray(roster) ? roster as RosterEntry[] : []; } catch { return []; }
  }
  function updateRoster(index: number, key: "__personnel" | "__materiel" | "__workers", roster: RosterEntry[]) {
    updateItem(index, { form_data: { ...items[index].form_data, [key]: JSON.stringify(roster) } });
  }

  // Photo/PDF de la CIN d'un personnel (recto/verso) : lue AUTOMATIQUEMENT dès
  // l'ajout (pas de bouton "Analyser" séparé), puis CONSERVÉE — jamais
  // effacée après lecture — pour être jointe en pages supplémentaires à la
  // fin du contrat individuel de cette personne (voir generatedWorkerContractLines
  // et appendExternalFileAsPages côté serveur). Une valeur déjà tapée à la
  // main par l'utilisateur (nom, n° CIN, adresse) n'est jamais écrasée par la
  // lecture automatique : on ne complète que les cases encore vides.
  async function insertCinFile(index: number, rosterIndex: number, file: File) {
    const key = `cin:${index}:${rosterIndex}`;
    setPendingAction(key);
    setMessage("Envoi et lecture de la CIN en cours…");
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${organizationId}/submission/${tenderId}/cin/${crypto.randomUUID()}-${safeName}`;
      const upload = await supabase.storage.from("btp-documents").upload(path, file, { upsert: false });
      if (upload.error) { setMessage(`Envoi de la CIN impossible : ${upload.error.message}`); return; }
      // On repart du rôster LE PLUS À JOUR (items[index], pas une copie
      // capturée avant l'envoi) : sinon une saisie faite pendant l'upload
      // serait perdue en enregistrant le fichier joint.
      const rosterWithFile = rosterFor(items[index], "__personnel").map((entry, currentIndex) => currentIndex === rosterIndex
        ? { ...entry, cinPath: path, cinName: file.name, cinMime: file.type || "application/octet-stream" }
        : entry);
      updateRoster(index, "__personnel", rosterWithFile);
      setMessage("CIN jointe. Lecture automatique des informations…");
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/tenders/${tenderId}/extract-cin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}`, "X-Supabase-Access-Token": session.access_token } : {}),
        },
        body: JSON.stringify({ path }),
      });
      const payload = await response.json().catch(() => ({}) as { full_name?: string; cin_number?: string; address?: string; error?: string });
      if (!response.ok) { setMessage(`${payload.error || "Lecture automatique de la CIN impossible."} Le fichier reste joint : complétez les champs à la main.`); return; }
      // À nouveau le rôster le plus récent (la lecture prend quelques
      // secondes, une saisie manuelle a pu avoir lieu entre-temps) ; on ne
      // remplit que les champs encore vides.
      const mergedRoster = rosterFor(items[index], "__personnel").map((entry, currentIndex) => {
        if (currentIndex !== rosterIndex) return entry;
        return {
          ...entry,
          name: entry.name.trim() ? entry.name : (payload.full_name || entry.name),
          identity: entry.identity?.trim() ? entry.identity : (payload.cin_number || entry.identity || ""),
          address: entry.address?.trim() ? entry.address : (payload.address || entry.address || ""),
        };
      });
      updateRoster(index, "__personnel", mergedRoster);
      setMessage("Informations lues sur la CIN et complétées automatiquement. Vérifiez avant impression.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lecture de la CIN impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  async function removeCinFile(index: number, rosterIndex: number) {
    const roster = rosterFor(items[index], "__personnel");
    const entry = roster[rosterIndex];
    if (!entry?.cinPath) return;
    const key = `cin-remove:${index}:${rosterIndex}`;
    setPendingAction(key);
    setMessage("Suppression de la CIN…");
    try {
      const removal = await supabase.storage.from("btp-documents").remove([entry.cinPath]);
      if (removal.error) { setMessage(`Suppression impossible : ${removal.error.message}`); return; }
      const nextRoster = rosterFor(items[index], "__personnel").map((current, currentIndex) => currentIndex === rosterIndex
        ? { ...current, cinPath: undefined, cinName: undefined, cinMime: undefined }
        : current);
      updateRoster(index, "__personnel", nextRoster);
      setMessage("CIN supprimée.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suppression de la CIN impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  // Même principe que rosterFor/updateRoster ci-dessus, mais générique pour
  // n'importe quel tableau marqué repeatable par l'analyse IA (litiges,
  // conventions non exécutées, marchés similaires...) : chaque ligne est un
  // objet { "0": valeur colonne 0, "1": valeur colonne 1, ... }, indexé par
  // position de colonne plutôt que par un nom de champ fixe puisque ces
  // colonnes varient d'un DAO à l'autre.
  type TableRow = Record<string, string>;
  function tableRowsFor(item: Item, tableIndex: number): TableRow[] {
    try {
      const rows = JSON.parse(item.form_data[`__table_${tableIndex}`] || "[]");
      return Array.isArray(rows) ? rows as TableRow[] : [];
    } catch { return []; }
  }
  function updateTableRows(index: number, tableIndex: number, rows: TableRow[]) {
    updateItem(index, { form_data: { ...items[index].form_data, [`__table_${tableIndex}`]: JSON.stringify(rows) } });
  }

  // resolvedFieldValue devine une valeur (profil entreprise, date du jour,
  // référence du marché...) pour l'affichage, mais tant qu'elle n'est écrite
  // nulle part elle reste invisible du PDF généré côté serveur : celui-ci ne
  // lit que form_data, jamais ces suppositions calculées à la volée. On les
  // enregistre donc dès qu'elles apparaissent, pour que « déjà rempli à
  // l'écran » et « déjà rempli dans le PDF » soient toujours la même chose.
  // L'utilisateur garde la main : une valeur déjà présente dans form_data
  // (y compris une correction manuelle) n'est jamais écrasée.
  useEffect(() => {
    if (!loaded) return;
    let changed = false;
    const next = items.map((item) => {
      if (isPersonnelList(item) || isMaterialList(item) || isWorkerContract(item)) return item;
      let nextFormData: Record<string, string> | null = null;
      for (const field of item.fields) {
        if (item.form_data[field.key]?.trim()) continue;
        const resolved = resolvedFieldValue(item, field);
        if (resolved.trim()) {
          nextFormData = nextFormData ?? { ...item.form_data };
          nextFormData[field.key] = resolved;
        }
      }
      if (!nextFormData) return item;
      changed = true;
      return { ...item, form_data: nextFormData };
    });
    if (changed) {
      setItems(next);
      scheduleSave(profile, next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, items, profile, today, tenderReference, tenderLocation, tenderClientName, tenderExecutionPeriodDays, tenderEstimatedAmount]);

  // Une pièce (form_to_complete) sans aucun champ à remplir est entièrement
  // calculée par l'app à partir de ce que l'IA a extrait du DAO (planning,
  // registre des plans, poids à transporter…) : rien à taper, juste à
  // imprimer/joindre. Ce n'est PAS lié à des mots-clés figés (planning,
  // matériaux, plans) — n'importe quelle pièce détectée ainsi par l'IA sur
  // n'importe quel DAO (travaux ou fourniture) doit être traitée pareil,
  // sans dépendre d'une liste préparée à l'avance pour ce DAO précis.
  const isAiGenerated = (item: Item) => item.kind === "form_to_complete" && item.fields.length === 0
    && !isPersonnelList(item) && !isMaterialList(item) && !isWorkerContract(item);
  const bdqeItem = items.find(isBdqe);
  const bdqeIndex = bdqeItem ? items.indexOf(bdqeItem) : -1;
  // Liste unique de toutes les pièces (documents et formulaires confondus),
  // dans le MÊME ordre que le sommaire du DAO — le BDQE externe a sa propre
  // section fixe juste au-dessus (voir "BDQE automatique" plus bas) car il
  // dépend du devis enregistré, pas du sommaire du DAO. Remplace les 3
  // anciens blocs séparés "Documents préparés"/"Documents à fournir"/
  // "Formulaires" qui affichaient les pièces groupées par catégorie plutôt
  // que dans l'ordre réel du DAO, empêchant d'afficher les titres de ses
  // parties (voir renderDossierCard et hasDossierSections plus bas).
  const dossierItems = items.filter((item) => !isBdqe(item));
  const hasDossierSections = dossierItems.some((item) => item.dossierSection);
  // Regroupe les pièces déjà triées dans l'ordre du DAO (dossierItems) en
  // une carte par grande division ("Partie I", "Partie II"...), plutôt
  // qu'un simple titre au-dessus d'une liste continue : chaque groupe de
  // dossierItems partageant le même dossierSection consécutif devient sa
  // propre carte, avec ce titre affiché en haut et uniquement les pièces de
  // cette division à l'intérieur. dossierItems étant déjà dans l'ordre du
  // DAO, deux pièces d'une même Partie ne peuvent être séparées par une
  // pièce d'une autre Partie : le regroupement par simple consécutivité
  // suffit, sans avoir besoin de refaire un tri.
  const dossierGroups: Array<{ title: string | null; items: Item[] }> = [];
  for (const item of dossierItems) {
    const section = item.dossierSection ?? null;
    const currentGroup = dossierGroups[dossierGroups.length - 1];
    if (currentGroup && currentGroup.title === section) currentGroup.items.push(item);
    else dossierGroups.push({ title: section, items: [item] });
  }

  // L'appli ne sert qu'à PRÉPARER le dossier physique (rien n'est déposé
  // depuis l'appli) : plus aucun fichier n'est joint ici. Chaque pièce a un
  // seul bouton rouge/vert, cliquable dans les deux sens — l'utilisateur
  // constate lui-même qu'une pièce est prête (imprimée, remplie, signée,
  // rassemblée) et le note avec ce bouton ; s'il la perd ensuite, il
  // reclique dessus pour la repasser en rouge. Réutilise les classes
  // .acknowledgeButton (rouge) / .acknowledgedButton (vert) déjà présentes
  // dans globals.css pour "Prendre connaissance", exactement le même besoin.
  function isItemReady(item: Item) { return Boolean(item.form_data.__readyAt); }
  function toggleReady(index: number) {
    const current = items[index];
    if (!current) return;
    const ready = isItemReady(current);
    const nextFormData = { ...current.form_data };
    if (ready) delete nextFormData.__readyAt; else nextFormData.__readyAt = new Date().toISOString();
    updateItem(index, { form_data: nextFormData, status: ready ? (current.kind === "form_to_complete" ? "needs_information" : "missing") : "ready" });
  }
  // Même bascule, mais synchronise aussi __acknowledgedAt pour une pièce "à
  // lire" (charte, politique de fraude...) : son bouton "Prendre
  // connaissance" est le même bouton rouge/vert, avec un libellé différent.
  function toggleAcknowledged(index: number) {
    const current = items[index];
    if (!current) return;
    const ready = isItemReady(current);
    const nextFormData = { ...current.form_data };
    if (ready) { delete nextFormData.__readyAt; delete nextFormData.__acknowledgedAt; }
    else { nextFormData.__readyAt = new Date().toISOString(); nextFormData.__acknowledgedAt = new Date().toISOString(); }
    updateItem(index, { form_data: nextFormData, status: ready ? "needs_information" : "ready" });
  }

  // Une seule fonction de rendu de carte, quel que soit le type de pièce
  // (document déjà préparé par l'appli, document à joindre, ou formulaire à
  // compléter) — pour que dossierItems puisse toutes les afficher dans une
  // seule liste, groupée par Partie du DAO (voir plus bas).
  function renderDossierCard(item: Item) {
    const index = items.indexOf(item);
    const ready = isItemReady(item);
    // Bouton unique (rouge) qui ouvre la petite fenêtre Modifier/Enregistrer/
    // Imprimer, demandé par Maxime pour remplacer les différents boutons
    // "Ouvrir le PDF..." dispersés dans chaque carte — voir le modal
    // actionsForIndex plus bas, tout en bas du fichier.
    const openButton = <button type="button" className="tenderButton acknowledgeButton" onClick={() => setActionsForIndex(index)}>Ouvrir{ready ? " ✓" : ""}</button>;
    if (isAiGenerated(item)) {
      return <article key={`${item.kind}-${normalize(item.title)}-${index}`} className="simpleCard">
        <strong>{item.title}</strong>
        <p className="mt-2 text-sm">{item.instructions || "Document établi à partir des postes, quantités et du délai du DAO."}</p>
        <div className="buttonRow" style={{ marginBottom: 0, marginTop: 12 }}>
          {openButton}
        </div>
        {item.source_reference && <p className="mt-2 text-xs text-gray-500">Source : {item.source_reference}</p>}
      </article>;
    }
    if (item.kind === "document_to_provide") {
      const readingOnly = isReadingOnly(item);
      return <article key={`${item.kind}-${item.title}-${index}`} className="simpleCard">
        <strong>{item.title}</strong>
        <p className="mt-2 text-sm">{item.instructions}</p>
        <div className="buttonRow" style={{ marginBottom: 0, marginTop: 12 }}>
          {/* La lecture directe (sans passer par la fenêtre Modifier/
              Enregistrer) ne reste utile que pour une pièce "à lire"
              (charte, politique de fraude...) sans page DAO précise
              repérée : le PDF à imprimer, lui, extrait déjà ce texte. */}
          {readingOnly && !needsPrintableVersion(item) && <button type="button" className="tenderButton" disabled={!daoUrl || pendingAction === "read"} onClick={() => void openReadingDocument()}><ButtonLabel loading={pendingAction === "read"} label="Ouvrir le document à lire" /></button>}
          {openButton}
        </div>
        {item.source_reference && <p className="mt-1 text-xs text-gray-500">Source : {item.source_reference}</p>}
      </article>;
    }
    const personnel = isPersonnelList(item);
    const material = isMaterialList(item) && !personnel;
    const workerContract = isWorkerContract(item);
    const personnelSource = items.find((candidate) => isPersonnelList(candidate));
    const personnelRoster = personnelSource ? rosterFor(personnelSource, "__personnel") : [];
    const rosterKey = personnel ? "__personnel" : material ? "__materiel" : "__workers";
    const roster = personnel || material ? rosterFor(item, rosterKey) : workerContract ? personnelRoster : [];
    const missingFields = (personnel || material || workerContract) ? [] : item.fields.filter((field) => !resolvedFieldValue(item, field).trim());
    const formState = ready ? "Prêt ✓" : (personnel || material || workerContract) && !roster.length ? "Ajoutez au moins une ligne" : missingFields.length ? "Informations à compléter" : "Prêt à imprimer et signer";
    return <article key={`${item.kind}-${item.title}-${index}`} className="simpleCard">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}><strong>{workerContract ? "Contrat individuel de travail — un PDF par personnel" : item.title}</strong><span style={{ fontSize: ".9rem", fontWeight: 700, color: ready ? "#15803d" : "#b45309" }}>{formState}</span></div>
      <p className="mt-2 text-sm">{item.instructions}</p>
      {!ready && <>
        {/* Les champs à remplir un par un ont disparu : depuis « Ouvrir » ->
            « Modifier », Maxime remplit désormais les cases directement dans
            son application PDF, puis les renvoie avec « Enregistrer ». */}
        {!personnel && !material && !workerContract && item.fields.length > 0 && missingFields.length === 0 && <p className="mt-3 rounded-md bg-green-50 p-3 text-sm font-medium text-green-800">Les informations de ce formulaire sont déjà préremplies depuis le profil de l’entreprise.</p>}
        {!personnel && !material && !workerContract && (item.template_tables ?? []).map((table, tableIndex) => {
          if (!table.repeatable) return null;
          const rows = tableRowsFor(item, tableIndex);
          return <div key={tableIndex} className="simpleCardMuted">
            <strong>{table.title}</strong>
            <p className="mt-1 text-xs text-gray-600">Le DAO ne montre qu’une ligne d’exemple : ajoutez-en autant que nécessaire.</p>
            <div className="mt-2 grid gap-3">
              {rows.map((row, rowIndex) => <div key={rowIndex} className="simpleCardNested" style={{ marginTop: 10 }}>
                <div className="grid gap-2 md:grid-cols-2">
                  {table.columns.map((column, columnIndex) => <label key={columnIndex} className="grid gap-1 text-sm font-semibold">{column || `Colonne ${columnIndex + 1}`}
                    <input value={row[String(columnIndex)] ?? ""} onChange={(event) => {
                      const next = rows.map((current, currentIndex) => currentIndex === rowIndex ? { ...current, [String(columnIndex)]: event.target.value } : current);
                      updateTableRows(index, tableIndex, next);
                    }} />
                  </label>)}
                </div>
                <button type="button" className="tenderButton mt-2" onClick={() => updateTableRows(index, tableIndex, rows.filter((_, currentIndex) => currentIndex !== rowIndex))}>Retirer cette ligne</button>
              </div>)}
            </div>
            <button type="button" className="tenderButton tenderButtonPrimary mt-2" onClick={() => updateTableRows(index, tableIndex, [...rows, {}])}>+ Ajouter une ligne</button>
          </div>;
        })}
        {(personnel || material) && <div className="mt-3 grid gap-3">{roster.map((entry, rosterIndex) => <div key={rosterIndex} className="simpleCardMuted" style={{ marginTop: 0 }}>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold">{personnel ? "Nom et prénoms" : "Matériel / engin"}<input value={entry.name} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, name: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>
            <label className="grid gap-1 text-sm font-semibold">{personnel ? "Poste sur chantier" : "Fonction / usage"}<input value={entry.role} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, role: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>
            {personnel && <label className="grid gap-1 text-sm font-semibold">N° CIN / identité (pour le contrat)<input value={entry.identity ?? ""} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, identity: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>}
            {personnel && <label className="grid gap-1 text-sm font-semibold">Adresse<input value={entry.address ?? ""} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, address: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>}
            {personnel && <label className="grid gap-1 text-sm font-semibold">Rémunération / salaire<input value={entry.salary ?? ""} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, salary: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>}
            {!personnel && <><label className="grid gap-1 text-sm font-semibold">État / capacité<input value={entry.qualification} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, qualification: event.target.value }; updateRoster(index, rosterKey, next); }} /></label><label className="grid gap-1 text-sm font-semibold">Quantité / disponibilité<input value={entry.experience} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, experience: event.target.value }; updateRoster(index, rosterKey, next); }} /></label></>}
          </div>
          {personnel && <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-white p-2">
            <span className="text-sm font-semibold">CIN (photo ou PDF, recto/verso) :</span>
            {entry.cinPath ? <><span className="text-sm font-semibold text-green-700">{entry.cinName || "Fichier joint"}</span><button type="button" className="tenderButton" disabled={pendingAction === `cin-remove:${index}:${rosterIndex}`} onClick={() => void removeCinFile(index, rosterIndex)}><ButtonLabel loading={pendingAction === `cin-remove:${index}:${rosterIndex}`} label="Supprimer" loadingLabel="Suppression…" /></button></> : <label className="tenderButton">{pendingAction === `cin:${index}:${rosterIndex}` ? <ButtonLabel loading label="" loadingLabel="Lecture…" /> : "Ajouter une photo ou un PDF"}<input style={{ display: "none" }} type="file" accept="image/*,application/pdf" disabled={pendingAction === `cin:${index}:${rosterIndex}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertCinFile(index, rosterIndex, file); }} /></label>}
            <span className="text-xs text-gray-600">L’IA lit automatiquement le nom, le n° CIN et l’adresse dès l’ajout ; le fichier reste joint et sera imprimé à la fin du contrat de cette personne.</span>
          </div>}
          <button type="button" className="tenderButton mt-2" onClick={() => updateRoster(index, rosterKey, roster.filter((_, currentIndex) => currentIndex !== rosterIndex))}>Retirer cette ligne</button>
        </div>)}<button type="button" className="tenderButton tenderButtonPrimary" onClick={() => updateRoster(index, rosterKey, [...roster, { name: "", role: "", qualification: "", experience: "", identity: "", address: "", salary: "" }])}>+ Ajouter {personnel ? "un personnel" : "un matériel"}</button></div>}
        {workerContract && <div className="mt-3 grid gap-3">{!personnelRoster.length && <p className="text-sm text-amber-700">Ajoutez d’abord le personnel affecté au chantier dans la liste ci-dessus.</p>}{personnelRoster.map((worker, workerIndex) => <div key={workerIndex} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-gray-50 p-3"><span><strong>{worker.name || "Personnel sans nom"}</strong>{worker.role ? ` — ${worker.role}` : ""}</span><button type="button" className="tenderButton tenderButtonPrimary" disabled={pendingAction === `pdf:${item.title}:${workerIndex}`} onClick={() => openWorkerContract(item, workerIndex)}><ButtonLabel loading={pendingAction === `pdf:${item.title}:${workerIndex}`} label="Ouvrir le contrat PDF" /></button></div>)}</div>}
        {!item.fields.length && !personnel && !material && !workerContract && <p className="mt-3 text-sm text-amber-700">Aucune valeur n’a été identifiée à préremplir. Le PDF à imprimer reprend néanmoins le document demandé et doit être vérifié avant signature.</p>}
      </>}
      <div className="buttonRow" style={{ marginBottom: 0, marginTop: 12 }}>
        {openButton}
      </div>
      {item.source_reference && <p className="mt-2 text-xs text-gray-500">Source : {item.source_reference}</p>}
    </article>;
  }

  // Le bouton "Vérifier le dossier" ne regarde plus que le bouton rouge/vert
  // de chaque pièce obligatoire : c'est l'utilisateur qui juge lui-même,
  // physiquement, qu'une pièce est prête, donc c'est cette seule bascule qui
  // compte désormais (plus de vérification automatique des champs remplis
  // ou du nombre de lignes des tableaux, qui ne reflétait plus la réalité
  // depuis que rien n'est saisi ni joint depuis l'application).
  const incompleteItems = items.filter((item) => item.required && !isItemReady(item));

  function validateDossier() {
    if (incompleteItems.length) {
      setMessage(`${incompleteItems.length} élément(s) obligatoire(s) restent à compléter ou à joindre.`);
      return;
    }
    setMessage("Dossier complet et validé. Vérifiez une dernière fois les signatures avant dépôt.");
  }

  // "Valider la complétion" — remplace l'ancienne génération d'un PDF
  // fusionné : l'appli ne sert qu'à préparer le dossier physique, il n'y a
  // donc plus rien à générer. On exige d'abord que toutes les pièces
  // obligatoires soient au vert (comme "Vérifier le dossier"), puis on
  // enregistre juste la date de validation. Réversible : cliquer à nouveau
  // retire la validation, exactement comme le bouton rouge/vert de chaque
  // pièce.
  async function toggleDossierLock() {
    const locking = !lockedAt;
    if (locking && incompleteItems.length) {
      setMessage(`${incompleteItems.length} élément(s) obligatoire(s) restent à compléter ou à marquer comme prêts avant de valider la complétion.`);
      return;
    }
    const key = "lock";
    setPendingAction(key);
    setMessage(locking ? "Validation du dossier…" : "Annulation de la validation…");
    try {
      await saveImmediately(profile, items);
      const response = await fetch(`/api/tenders/${tenderId}/submission-dossier/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimateId, locked: locking }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Enregistrement impossible.");
      setLockedAt(payload.lockedAt ?? null);
      setMessage(locking ? "Dossier validé comme complet et prêt à être déposé." : "Validation retirée. Vous pouvez modifier le dossier.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  // Supprime le dossier actuellement affiché (celui du devis si estimateId
  // est présent, sinon le dossier maître du DAO) — jamais l'analyse IA du
  // DAO (tenders.ai_analysis), qui reste en cache. Avant, on reconstruisait
  // aussitôt une liste de pièces vierge à la place (setItems(detected)) : la
  // page semblait alors n'avoir rien supprimé puisqu'un dossier vide
  // réapparaissait immédiatement. Maintenant la suppression est réelle et
  // visible : on quitte la page vers un endroit qui ne réaffiche pas de
  // dossier reconstruit automatiquement (le dossier maître doit être
  // regénéré explicitement avec le bouton "Générer le dossier de
  // soumission" sur la page du DAO).
  async function deleteDossier() {
    const label = estimateId ? "ce dossier de devis" : "le dossier maître de ce DAO";
    const consequence = estimateId
      ? "Toutes les pièces et informations déjà remplies pour ce devis seront effacées."
      : "Toutes les pièces et informations déjà remplies seront effacées. Il faudra appuyer sur « Générer le dossier de soumission » sur la page du DAO pour en recréer un.";
    if (!window.confirm(`Supprimer définitivement ${label} ? ${consequence} L’analyse du DAO n’est pas concernée.`)) return;
    const key = "deleteDossier";
    setPendingAction(key);
    setMessage("Suppression du dossier…");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/tenders/${tenderId}/submission-dossier${scope}`, {
        method: "DELETE",
        headers: session?.access_token ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Supabase-Access-Token": session.access_token,
        } : undefined,
      });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) throw new Error(payload.error || "Suppression impossible.");
      window.localStorage.removeItem(storageKey);
      hasLocalDraft.current = false;
      router.push(estimateId ? `/tenders/${tenderId}` : "/submissions");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suppression impossible.");
      setPendingAction((current) => current === key ? null : current);
    }
  }

  return <>
  <main className="submissionDossierPage p-8 max-w-6xl">
    <a className="tenderBackLink" href="/submissions">← Retour aux dossiers de soumission</a>
      <div className="mb-7">
        <h1 className="text-3xl font-bold">{estimateId ? "Dossier du devis" : "Dossier maître du DAO"}</h1>
        <p className="mt-2 text-gray-600">Pièces à fournir et formulaires détectés dans le DAO. Vérifiez toujours le document source avant dépôt.</p>
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="tenderButton" onClick={validateDossier}>Vérifier le dossier</button><button type="button" className={`tenderButton ${lockedAt ? "acknowledgedButton" : "tenderButtonPrimary"}`} disabled={pendingAction === "lock"} onClick={() => void toggleDossierLock()}><ButtonLabel loading={pendingAction === "lock"} label={lockedAt ? "Dossier validé ✓ (annuler)" : "Valider la complétion"} loadingLabel="Enregistrement…" /></button><button type="button" className="tenderButton tenderButtonDanger" disabled={pendingAction === "deleteDossier"} onClick={() => void deleteDossier()}><ButtonLabel loading={pendingAction === "deleteDossier"} label="Supprimer le dossier" loadingLabel="Suppression…" /></button></div>
        <p className="mt-3 text-sm font-semibold text-green-800">{message}</p>
    </div>

    <section className="mb-6 rounded-xl border bg-white p-5">
      <h2 className="text-xl font-bold">Informations réutilisables de l’entreprise</h2>
      <p className="mt-1 text-sm text-gray-600">Elles préremplissent les futurs formulaires et sont partagées uniquement avec les DAO de cette entreprise.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {profileFields.map(([key, label]) => <label key={key} className="grid gap-1 text-sm font-semibold">{label}
          <input value={profile[key] ?? ""} onChange={(event) => updateProfile(key, event.target.value)} />
        </label>)}
      </div>
    </section>

    <section className="mb-6 rounded-xl border bg-white p-5">
      <h2 className="text-xl font-bold">BDQE automatique</h2>
      <p className="mt-1 text-sm text-gray-600">Le BDQE externe provient du devis enregistré pour ce DAO, avec ses récapitulatifs. Imprimez-le, faites signer et parapher les pages demandées, puis joignez la version signée.</p>
      <div className="mt-3 grid gap-2">
        {linkedDocuments.filter((document) => document.url).map((document) => <button key={document.estimateId} type="button" className="tenderButton" disabled={pendingAction === `bdqe:${document.estimateId}`} onClick={() => void openOfficialBdqe(document.estimateId)}><ButtonLabel loading={pendingAction === `bdqe:${document.estimateId}`} label={`Ouvrir le BDQE externe à imprimer — ${document.fileName}`} /></button>)}
        {!linkedDocuments.some((document) => document.url) && <p className="text-sm text-gray-600">Le BDQE apparaîtra ici dès que le devis officiel associé aura été enregistré.</p>}
        {bdqeItem && bdqeIndex >= 0 && <button type="button" className={`tenderButton ${isItemReady(bdqeItem) ? "acknowledgedButton" : "acknowledgeButton"}`} onClick={() => toggleReady(bdqeIndex)}>{isItemReady(bdqeItem) ? "Prêt ✓ (annuler)" : "Marquer comme prêt"}</button>}
      </div>
    </section>

    {!dossierItems.length && <section className="rounded-xl border bg-white p-5"><h2 className="text-xl font-bold">Pièces du dossier</h2><p className="mt-3 text-gray-600">Aucune pièce distincte n’a été explicitement détectée. Contrôlez tout de même les annexes du DAO.</p></section>}

    {hasDossierSections
      // Le DAO a un sommaire avec de grandes divisions : une carte par
      // division, dans l'ordre exact où le DAO les présente — jamais une
      // seule carte fourre-tout, précisément pour que la vérification pièce
      // par pièce en suivant le DAO reste simple, quel que soit le DAO.
      ? dossierGroups.map((group, groupIndex) => <section key={`partie-${groupIndex}`} className="mb-6 rounded-xl border bg-white p-5">
          <h2 className="text-xl font-bold">{group.title ?? "Autres pièces (position non repérée dans le sommaire du DAO)"}</h2>
          <div className="mt-3 grid gap-3">{group.items.map((item) => renderDossierCard(item))}</div>
        </section>)
      // Le DAO n'a pas de grandes divisions identifiables dans son sommaire
      // (ou aucun sommaire trouvé) : une seule carte, mais toujours dans
      // l'ordre exact du DAO (voir dossierItems).
      : dossierItems.length > 0 && <section className="rounded-xl border bg-white p-5">
          <h2 className="text-xl font-bold">Pièces du dossier ({dossierItems.length})</h2>
          <p className="mt-1 text-sm text-gray-600">Dans l’ordre exact du DAO. Aucune grande division (Partie, Titre...) n’a été trouvée dans son sommaire.</p>
          <div className="mt-3 grid gap-3">{dossierItems.map((item) => renderDossierCard(item))}</div>
        </section>}
  </main>
  {viewingPdf && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={closePdfModal}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(1000px,95vw)", height: "90vh", display: "flex", flexDirection: "column" }}>
    <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "10px" }}>
      <h2 style={{ margin: 0, fontWeight: 800, fontSize: "1.125rem", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{viewingPdf.title}</h2>
      <div style={{ display: "flex", gap: "8px", flex: "0 0 auto" }}>
        <button type="button" className="tenderButton tenderButtonPrimary" onClick={printViewingPdf}>Imprimer</button>
        <button type="button" className="tenderButton" onClick={closePdfModal}>Fermer</button>
      </div>
    </div>
    <iframe ref={pdfIframeRef} title={viewingPdf.title} src={`${viewingPdf.objectUrl}#toolbar=0&navpanes=0`} style={{ flex: "1 1 auto", minHeight: 0, width: "100%", border: "1px solid #e1ece4", borderRadius: "10px" }} />
  </div></div>, document.body)}
  {/* La fenêtre ouverte par le bouton rouge "Ouvrir" de chaque pièce (voir
      openButton dans renderDossierCard) : le PDF s'affiche ICI, déjà
      remplissable (de vraies cases cliquables par-dessus la vraie page du
      DAO) — la personne tape directement dedans, puis Enregistrer récupère
      ce qui vient d'être tapé et l'envoie tout seul, sans fichier à
      télécharger ni à re-choisir. La fenêtre se referme d'elle-même une
      fois l'envoi terminé (voir uploadFilledPdf). */}
  {actionsForIndex !== null && items[actionsForIndex] && typeof document !== "undefined" && createPortal((() => {
    const index = actionsForIndex;
    const item = items[index];
    const ready = isItemReady(item);
    const personnel = isPersonnelList(item);
    const material = isMaterialList(item) && !personnel;
    const showPrint = needsPrintableVersion(item) || personnel || material;
    const filledName = typeof item.form_data.__filledPdfName === "string" ? item.form_data.__filledPdfName : null;
    // Une pièce "à lire" (charte, politique de fraude...) garde son propre
    // libellé "Prendre connaissance" au lieu de "Marquer comme prêt", et
    // marque en plus __acknowledgedAt (voir toggleAcknowledged) — même bouton
    // rouge/vert, juste un texte différent pour rester clair pour Maxime.
    const readingOnly = item.kind === "document_to_provide" && isReadingOnly(item);
    const saving = pendingAction === `save:${index}`;
    return <div className="modalBackdrop" onClick={() => setActionsForIndex(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(900px,95vw)", height: "88vh", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontWeight: 800, fontSize: "1.125rem", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" }}>{item.title}</h2>
        <div style={{ display: "flex", gap: 8, flex: "0 0 auto", flexWrap: "wrap" }}>
          {!fillableViewerFailed && <button type="button" className="tenderButton tenderButtonPrimary" disabled={saving} onClick={() => void saveFilledPdfFromViewer(index, item)}><ButtonLabel loading={saving} label="Enregistrer" loadingLabel="Envoi…" /></button>}
          {showPrint && <button type="button" className="tenderButton" disabled={pendingAction === `pdf:${item.title}`} onClick={() => openPrintableVersion(item)}><ButtonLabel loading={pendingAction === `pdf:${item.title}`} label="Imprimer" /></button>}
          <button type="button" className="tenderButton" onClick={() => setActionsForIndex(null)}>Fermer</button>
        </div>
      </div>
      <p className="text-sm text-gray-600" style={{ flex: "0 0 auto", marginTop: 0 }}>{hasFilledVersion(item) ? `Version remplie déjà enregistrée : ${filledName || "document.pdf"}` : "Remplissez les cases directement ci-dessous, puis cliquez sur « Enregistrer »."}</p>
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
        {!fillableViewerFailed && fillableAuthHeaders && <FillablePdfViewer
          key={index}
          documentUrl={printableDocumentUrl(item)}
          authHeaders={fillableAuthHeaders}
          onError={(message) => { setFillableViewerFailed(true); setFillableViewerError(message); console.error("FillablePdfViewer a échoué :", message); }}
        />}
        {!fillableViewerFailed && !fillableAuthHeaders && <p>Préparation…</p>}
        {fillableViewerFailed && <div className="simpleCardMuted">
          <p className="text-sm">L’affichage direct n’a pas fonctionné sur cet appareil/navigateur. Solution de secours : téléchargez le PDF, remplissez-le avec votre application PDF, puis renvoyez-le ici.</p>
          {fillableViewerError && <p className="text-xs text-gray-500" style={{ fontFamily: "monospace", wordBreak: "break-word" }}>Détail technique (à envoyer à Maxime si besoin) : {fillableViewerError}</p>}
          <div className="buttonRow" style={{ marginBottom: 0, marginTop: 10 }}>
            <button type="button" className="tenderButton tenderButtonPrimary" disabled={pendingAction === `edit:${item.title}`} onClick={() => void downloadPdfForEditingFallback(item)}><ButtonLabel loading={pendingAction === `edit:${item.title}`} label="Modifier (télécharger)" loadingLabel="Préparation…" /></button>
            <label className="tenderButton" style={{ cursor: saving ? "wait" : "pointer" }}>
              {saving ? <ButtonLabel loading label="" loadingLabel="Envoi…" /> : "Enregistrer un fichier"}
              <input style={{ display: "none" }} type="file" accept="application/pdf" disabled={saving} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFilledPdf(index, item, file, file.name); event.target.value = ""; }} />
            </label>
          </div>
        </div>}
      </div>
      <div className="buttonRow" style={{ flex: "0 0 auto", marginTop: 10, marginBottom: 0 }}>
        <button type="button" className={`tenderButton ${ready ? "acknowledgedButton" : "acknowledgeButton"}`} onClick={() => (readingOnly ? toggleAcknowledged(index) : toggleReady(index))}>{readingOnly ? (ready ? "Pris connaissance ✓ (annuler)" : "Prendre connaissance") : (ready ? "Prêt ✓ (annuler)" : "Marquer comme prêt")}</button>
      </div>
    </div></div>;
  })(), document.body)}
  </>;
}
