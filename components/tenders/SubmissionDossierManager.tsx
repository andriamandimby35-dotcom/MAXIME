"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { parsePageNumbersFromReference } from "@/lib/submission/parse-page-reference";
import { buildDossierRecordsForInsert } from "@/lib/submission/build-dossier-items";
import { toFriendlyPdfError } from "@/lib/submission/friendly-pdf-error";
import { isPhoneDevice } from "@/lib/is-phone-device";

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
};

type DetectedItem = Omit<Item, "status" | "form_data">;
type TemplateDetectedItem = DetectedItem & { prefilled_values?: Array<{ key: string; value: string }> };
type RosterEntry = { name: string; role: string; qualification: string; experience: string; identity?: string };

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
  // Identifie l'action en cours (ouverture PDF, envoi de fichier...) pour
  // afficher un indicateur directement sur le bouton cliqué — auparavant rien
  // ne montrait qu'une action était en cours pendant l'attente.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pdfIframeRef = useRef<HTMLIFrameElement>(null);
  const hasLocalDraft = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadingItems = useRef(new Set<number>());
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

  async function insertFile(index: number, file: File) {
    const item = items[index];
    if (!item) return;
    if (item.form_data.__attachmentPath || uploadingItems.current.has(index)) {
      setMessage("Cette pièce est déjà jointe. Supprimez-la d’abord si vous souhaitez la remplacer.");
      return;
    }
    uploadingItems.current.add(index);
    const key = `upload:${index}`;
    setPendingAction(key);
    setMessage("Insertion du fichier…");
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${organizationId}/submission/${tenderId}/${crypto.randomUUID()}-${safeName}`;
      const upload = await supabase.storage.from("btp-documents").upload(path, file, { upsert: false });
      if (upload.error) { setMessage(`Insertion impossible : ${upload.error.message}`); return; }
      const nextItems = items.map((current, currentIndex) => currentIndex === index ? { ...current, status: "uploaded" as const, form_data: { ...current.form_data, __attachmentPath: path, __attachmentName: file.name } } : current);
      setItems(nextItems);
      try { await saveImmediately(profile, nextItems); setMessage("Fichier joint et enregistré."); }
      catch (error) { setMessage(`${error instanceof Error ? error.message : "Enregistrement impossible"} Le fichier reste conservé localement.`); }
    } finally {
      uploadingItems.current.delete(index);
      setPendingAction((current) => current === key ? null : current);
    }
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

  async function viewFile(item: Item) {
    const path = item.form_data.__attachmentPath;
    if (!path) return;
    const key = `view:${item.title}`;
    setPendingAction(key);
    setMessage("Ouverture du fichier…");
    const nativeTab = isPhoneDevice() ? window.open("", "_blank") : null;
    try {
      const signed = await supabase.storage.from("btp-documents").createSignedUrl(path, 300);
      if (signed.error || !signed.data?.signedUrl) { nativeTab?.close(); setMessage("Ouverture du fichier impossible."); return; }
      const response = await fetch(signed.data.signedUrl);
      if (!response.ok) throw new Error(`Le serveur a répondu avec le statut ${response.status}.`);
      openPdfPreferringNativeTab(nativeTab, item.form_data.__attachmentName || item.title, await response.blob());
      setMessage("");
    } catch (error) {
      nativeTab?.close();
      setMessage(error instanceof Error ? error.message : "Ouverture du fichier impossible.");
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
  }

  async function removeFile(index: number) {
    const item = items[index];
    const path = item?.form_data.__attachmentPath;
    if (!item || !path) return;
    const key = `remove:${index}`;
    setPendingAction(key);
    setMessage("Suppression du fichier…");
    try {
      const removal = await supabase.storage.from("btp-documents").remove([path]);
      if (removal.error) { setMessage(`Suppression impossible : ${removal.error.message}`); return; }
      const { __attachmentPath: _path, __attachmentName: _name, ...formData } = item.form_data;
      const nextItems = items.map((current, currentIndex) => currentIndex === index ? { ...current, status: current.kind === "form_to_complete" ? "needs_information" as const : "missing" as const, form_data: formData } : current);
      setItems(nextItems);
      try { await saveImmediately(profile, nextItems); setMessage("Fichier supprimé. Vous pouvez en choisir un autre."); }
      catch (error) { setMessage(`${error instanceof Error ? error.message : "Enregistrement impossible"} Brouillon local conservé.`); }
    } finally {
      setPendingAction((current) => current === key ? null : current);
    }
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
    return /\bplans?\b/i.test(item.title);
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
  const generatedDocuments = items.filter(isAiGenerated);
  const bdqeItem = items.find(isBdqe);
  const bdqeIndex = bdqeItem ? items.indexOf(bdqeItem) : -1;
  const documents = items.filter((item) => item.kind === "document_to_provide" && !isAiGenerated(item) && !isBdqe(item));
  const forms = items.filter((item) => item.kind === "form_to_complete" && !isAiGenerated(item));
  const incompleteItems = items.filter((item) => {
    if (isAiGenerated(item)) return false;
    if (isPersonnelList(item) && !rosterFor(item, "__personnel").length) return true;
    if (isMaterialList(item) && !rosterFor(item, "__materiel").length) return true;
    if (isWorkerContract(item) && !items.some((candidate) => isPersonnelList(candidate) && rosterFor(candidate, "__personnel").length)) return true;
    if (item.required && !["ready", "uploaded"].includes(item.status)) return true;
    return item.fields.some((field) => field.required && !resolvedFieldValue(item, field).trim());
  });

  function validateDossier() {
    if (incompleteItems.length) {
      setMessage(`${incompleteItems.length} élément(s) obligatoire(s) restent à compléter ou à joindre.`);
      return;
    }
    setMessage("Dossier complet et validé. Vérifiez une dernière fois les signatures avant dépôt.");
  }

  async function validateAndGenerateFinalPdf() {
    const key = "final";
    setPendingAction(key);
    setMessage("Vérification finale du dossier…");
    const nativeTab = isPhoneDevice() ? window.open("", "_blank") : null;
    try {
      await saveImmediately(profile, items);
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`/api/tenders/${tenderId}/final-submission-pdf${scope}`, {
        method: "POST",
        headers: session?.access_token ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Supabase-Access-Token": session.access_token,
        } : undefined,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Génération finale impossible.");
      const documentUrl = `/api/tenders/${tenderId}/final-submission-pdf${scope}`;
      const getResponse = await fetch(documentUrl, {
        cache: "no-store",
        headers: session?.access_token ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Supabase-Access-Token": session.access_token,
        } : undefined,
      });
      const pdf = await getResponse.blob();
      if (!getResponse.ok || !pdf.type.includes("pdf") || pdf.size < 5) throw new Error("Le PDF final a été enregistré mais ne peut pas être ouvert.");
      openPdfPreferringNativeTab(nativeTab, "Dossier de soumission — PDF final", pdf);
      setMessage("Dossier validé et PDF final enregistré.");
    } catch (error) {
      nativeTab?.close();
      setMessage(error instanceof Error ? error.message : "Génération finale impossible.");
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
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="tenderButton" onClick={validateDossier}>Vérifier le dossier</button><button type="button" className="tenderButton tenderButtonPrimary" disabled={pendingAction === "final"} onClick={() => void validateAndGenerateFinalPdf()}><ButtonLabel loading={pendingAction === "final"} label="Valider et générer le PDF final" loadingLabel="Génération…" /></button><button type="button" className="tenderButton tenderButtonDanger" disabled={pendingAction === "deleteDossier"} onClick={() => void deleteDossier()}><ButtonLabel loading={pendingAction === "deleteDossier"} label="Supprimer le dossier" loadingLabel="Suppression…" /></button></div>
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

    {generatedDocuments.length > 0 && <section className="mb-6 rounded-xl border bg-white p-5"><h2 className="text-xl font-bold">Documents préparés</h2><p className="mt-1 text-sm text-gray-600">Ils restent dans la liste du dossier comme les autres documents et sont disponibles pour vérification avant impression ou signature.</p><div className="mt-3 grid gap-3">{generatedDocuments.map((item, position) => {
  const realIndex = items.indexOf(item);
  return <article key={`${item.kind}-${normalize(item.title)}-${position}`} className="rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><strong>{item.title}</strong><span className={item.form_data.__attachmentPath ? "text-sm font-semibold text-green-700" : "text-sm text-amber-700"}>{item.form_data.__attachmentPath ? "Document signé joint" : "PDF disponible — à imprimer, faire signer/parapher puis joindre"}</span></div>
    <p className="mt-2 text-sm">{item.instructions || "Document établi à partir des postes, quantités et du délai du DAO."}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="tenderButton tenderButtonPrimary" disabled={pendingAction === `pdf:${item.title}`} onClick={() => openPrintableVersion(item)}><ButtonLabel loading={pendingAction === `pdf:${item.title}`} label="Ouvrir le PDF" /></button>
      {item.form_data.__attachmentPath ? <><button type="button" className="tenderButton" disabled={pendingAction === `view:${item.title}`} onClick={() => void viewFile(item)}><ButtonLabel loading={pendingAction === `view:${item.title}`} label="Ouvrir" /></button><button type="button" className="tenderButton" disabled={pendingAction === `remove:${realIndex}`} onClick={() => void removeFile(realIndex)}><ButtonLabel loading={pendingAction === `remove:${realIndex}`} label="Supprimer" loadingLabel="Suppression…" /></button></> : <label className="tenderButton">{pendingAction === `upload:${realIndex}` ? <ButtonLabel loading label="" loadingLabel="Envoi…" /> : "Choisir un fichier"}<input style={{ display: "none" }} type="file" disabled={pendingAction === `upload:${realIndex}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertFile(realIndex, file); }} /></label>}
    </div>
    {item.source_reference && <p className="mt-2 text-xs text-gray-500">Source : {item.source_reference}</p>}
  </article>;
})}</div></section>}

    <section className="mb-6 rounded-xl border bg-white p-5">
      <h2 className="text-xl font-bold">BDQE automatique</h2>
      <p className="mt-1 text-sm text-gray-600">Le BDQE externe provient du devis enregistré pour ce DAO, avec ses récapitulatifs. Imprimez-le, faites signer et parapher les pages demandées, puis joignez la version signée.</p>
      <div className="mt-3 grid gap-2">
        {linkedDocuments.filter((document) => document.url).map((document) => <button key={document.estimateId} type="button" className="tenderButton" disabled={pendingAction === `bdqe:${document.estimateId}`} onClick={() => void openOfficialBdqe(document.estimateId)}><ButtonLabel loading={pendingAction === `bdqe:${document.estimateId}`} label={`Ouvrir le BDQE externe à imprimer — ${document.fileName}`} /></button>)}
        {!linkedDocuments.some((document) => document.url) && <p className="text-sm text-gray-600">Le BDQE apparaîtra ici dès que le devis officiel associé aura été enregistré.</p>}
        {bdqeItem?.form_data.__attachmentPath ? <div className="flex flex-wrap gap-2"><button type="button" className="tenderButton" disabled={pendingAction === `view:${bdqeItem.title}`} onClick={() => void viewFile(bdqeItem)}><ButtonLabel loading={pendingAction === `view:${bdqeItem.title}`} label="Ouvrir le BDQE signé" /></button><button type="button" className="tenderButton" disabled={pendingAction === `remove:${bdqeIndex}`} onClick={() => void removeFile(bdqeIndex)}><ButtonLabel loading={pendingAction === `remove:${bdqeIndex}`} label="Supprimer le BDQE signé" loadingLabel="Suppression…" /></button></div> : bdqeIndex >= 0 ? <label className="tenderButton tenderButtonPrimary" style={{ width: "fit-content" }}>{pendingAction === `upload:${bdqeIndex}` ? <ButtonLabel loading label="" loadingLabel="Envoi…" /> : "Choisir un fichier"}<input style={{ display: "none" }} type="file" accept="application/pdf" disabled={pendingAction === `upload:${bdqeIndex}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertFile(bdqeIndex, file); }} /></label> : null}
      </div>
    </section>

    <section className="mb-6 rounded-xl border bg-white p-5">
      <h2 className="text-xl font-bold">Documents à fournir ({documents.length})</h2>
      {!documents.length && <p className="mt-3 text-gray-600">Aucune pièce distincte n’a été explicitement détectée. Contrôlez tout de même les annexes du DAO.</p>}
      <div className="mt-3 grid gap-3">
        {documents.map((item) => {
          const index = items.indexOf(item);
          const officialBdqe = isBdqe(item) ? linkedDocuments.find((document) => document.url) : null;
          const readingOnly = isReadingOnly(item);
          return <article key={`${item.kind}-${item.title}`} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><strong>{item.title}</strong><span className={readingOnly && item.form_data.__acknowledgedAt ? "text-sm font-semibold text-green-700" : item.form_data.__attachmentPath ? "text-sm font-semibold text-green-700" : "text-sm text-amber-700"}>{readingOnly ? (item.form_data.__acknowledgedAt ? "Lecture confirmée" : "Lecture à confirmer") : (item.form_data.__attachmentPath ? "Document joint" : "Document à insérer")}</span></div>
            <p className="mt-2 text-sm">{isBdqe(item) ? "Le devis complété sert de BDQE. Imprimez-le, faites signer et parapher les pages demandées, puis joignez la version signée." : item.instructions}</p>
            <div className="mt-3 flex flex-wrap gap-2">{readingOnly && <><button type="button" className="tenderButton" disabled={!daoUrl || pendingAction === "read"} onClick={() => void openReadingDocument()}><ButtonLabel loading={pendingAction === "read"} label="Ouvrir le document à lire" /></button><button type="button" className={`tenderButton ${item.form_data.__acknowledgedAt ? "acknowledgedButton" : "acknowledgeButton"}`} onClick={() => updateItem(index, { status: "ready", form_data: { ...item.form_data, __acknowledgedAt: new Date().toISOString() } })}>{item.form_data.__acknowledgedAt ? "Lecture confirmée" : "Prendre connaissance"}</button></>}{officialBdqe?.url && <button type="button" className="tenderButton tenderButtonPrimary" disabled={pendingAction === `bdqe:${officialBdqe.estimateId}`} onClick={() => void openOfficialBdqe(officialBdqe.estimateId)}><ButtonLabel loading={pendingAction === `bdqe:${officialBdqe.estimateId}`} label="Ouvrir le BDQE externe à imprimer" /></button>}{isBdqe(item) && !officialBdqe?.url && <span className="text-sm text-amber-700">Enregistrez d’abord le PDF externe du devis pour l’imprimer.</span>}{needsPrintableVersion(item) && <button type="button" className="tenderButton" disabled={pendingAction === `pdf:${item.title}`} onClick={() => openPrintableVersion(item)}><ButtonLabel loading={pendingAction === `pdf:${item.title}`} label="Ouvrir le document à imprimer" /></button>}{item.form_data.__attachmentPath ? <><button type="button" className="tenderButton" disabled={pendingAction === `view:${item.title}`} onClick={() => void viewFile(item)}><ButtonLabel loading={pendingAction === `view:${item.title}`} label="Ouvrir" /></button><button type="button" className="tenderButton" disabled={pendingAction === `remove:${index}`} onClick={() => void removeFile(index)}><ButtonLabel loading={pendingAction === `remove:${index}`} label="Supprimer" loadingLabel="Suppression…" /></button></> : <label className="tenderButton">{pendingAction === `upload:${index}` ? <ButtonLabel loading label="" loadingLabel="Envoi…" /> : (isBdqe(item) ? "Joindre le BDQE externe signé" : "Choisir un fichier")}<input style={{ display: "none" }} type="file" disabled={pendingAction === `upload:${index}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertFile(index, file); }} /></label>}</div>
            {item.source_reference && <p className="mt-1 text-xs text-gray-500">Source : {item.source_reference}</p>}
          </article>;
        })}
      </div>
    </section>

    <section className="rounded-xl border bg-white p-5">
      <h2 className="text-xl font-bold">Formulaires et déclarations à compléter ({forms.length})</h2>
      {!forms.length && <p className="mt-3 text-gray-600">Aucun formulaire distinct n’a été identifié dans ce DAO.</p>}
      <div className="mt-3 grid gap-4">
        {forms.map((item) => {
          const index = items.indexOf(item);
          const personnel = isPersonnelList(item);
          const material = isMaterialList(item) && !personnel;
          const workerContract = isWorkerContract(item);
          const personnelSource = items.find((candidate) => isPersonnelList(candidate));
          const personnelRoster = personnelSource ? rosterFor(personnelSource, "__personnel") : [];
          const rosterKey = personnel ? "__personnel" : material ? "__materiel" : "__workers";
          const roster = personnel || material ? rosterFor(item, rosterKey) : workerContract ? personnelRoster : [];
          const missingFields = (personnel || material || workerContract) ? [] : item.fields.filter((field) => !resolvedFieldValue(item, field).trim());
          const formState = item.form_data.__attachmentPath ? "Document signé joint" : (personnel || material || workerContract) && !roster.length ? "Ajoutez au moins une ligne" : missingFields.length ? "Informations à compléter" : "Prêt à imprimer et signer";
          return <article key={`${item.kind}-${item.title}`} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><strong>{workerContract ? "Contrat individuel de travail — un PDF par personnel" : item.title}</strong><span className={item.form_data.__attachmentPath || !missingFields.length ? "text-sm font-semibold text-green-700" : "text-sm font-semibold text-amber-700"}>{formState}</span></div>
            <p className="mt-2 text-sm">{item.instructions}</p>
            {!personnel && !material && !workerContract && item.fields.length > 0 && missingFields.length === 0 && <p className="mt-3 rounded-md bg-green-50 p-3 text-sm font-medium text-green-800">Les informations de ce formulaire sont déjà préremplies depuis le profil de l’entreprise.</p>}
            {!personnel && !material && !workerContract && item.fields.map((field) => <label key={field.key} className="mt-3 grid gap-1 text-sm font-semibold">{field.label}{field.required ? " *" : ""}
              <input value={resolvedFieldValue(item, field)} placeholder={field.description || "Information à compléter"} onChange={(event) => updateItem(index, { form_data: { ...item.form_data, [field.key]: event.target.value } })} />
            </label>)}
            {(personnel || material) && <div className="mt-3 grid gap-3">{roster.map((entry, rosterIndex) => <div key={rosterIndex} className="rounded-lg border bg-gray-50 p-3"><div className="grid gap-2 md:grid-cols-2"><label className="grid gap-1 text-sm font-semibold">{personnel ? "Nom et prénoms" : "Matériel / engin"}<input value={entry.name} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, name: event.target.value }; updateRoster(index, rosterKey, next); }} /></label><label className="grid gap-1 text-sm font-semibold">{personnel ? "Poste sur chantier" : "Fonction / usage"}<input value={entry.role} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, role: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>{personnel && <label className="grid gap-1 text-sm font-semibold">N° CIN / identité (pour le contrat)<input value={entry.identity ?? ""} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, identity: event.target.value }; updateRoster(index, rosterKey, next); }} /></label>}{!personnel && <><label className="grid gap-1 text-sm font-semibold">État / capacité<input value={entry.qualification} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, qualification: event.target.value }; updateRoster(index, rosterKey, next); }} /></label><label className="grid gap-1 text-sm font-semibold">Quantité / disponibilité<input value={entry.experience} onChange={(event) => { const next = [...roster]; next[rosterIndex] = { ...entry, experience: event.target.value }; updateRoster(index, rosterKey, next); }} /></label></>}</div><button type="button" className="tenderButton mt-2" onClick={() => updateRoster(index, rosterKey, roster.filter((_, currentIndex) => currentIndex !== rosterIndex))}>Retirer cette ligne</button></div>)}<button type="button" className="tenderButton tenderButtonPrimary" onClick={() => updateRoster(index, rosterKey, [...roster, { name: "", role: "", qualification: "", experience: "", identity: "" }])}>+ Ajouter {personnel ? "un personnel" : "un matériel"}</button></div>}
            {workerContract && <div className="mt-3 grid gap-3">{!personnelRoster.length && <p className="text-sm text-amber-700">Ajoutez d’abord le personnel affecté au chantier dans la liste ci-dessus.</p>}{personnelRoster.map((worker, workerIndex) => <div key={workerIndex} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-gray-50 p-3"><span><strong>{worker.name || "Personnel sans nom"}</strong>{worker.role ? ` — ${worker.role}` : ""}</span><button type="button" className="tenderButton tenderButtonPrimary" disabled={pendingAction === `pdf:${item.title}:${workerIndex}`} onClick={() => openWorkerContract(item, workerIndex)}><ButtonLabel loading={pendingAction === `pdf:${item.title}:${workerIndex}`} label="Ouvrir le contrat PDF" /></button></div>)}</div>}
            <div className="mt-3 flex flex-wrap gap-2">{(needsPrintableVersion(item) || personnel || material) && <button type="button" className="tenderButton" disabled={pendingAction === `pdf:${item.title}`} onClick={() => openPrintableVersion(item)}><ButtonLabel loading={pendingAction === `pdf:${item.title}`} label="Ouvrir le PDF à imprimer" /></button>}{item.form_data.__attachmentPath ? <><button type="button" className="tenderButton" disabled={pendingAction === `view:${item.title}`} onClick={() => void viewFile(item)}><ButtonLabel loading={pendingAction === `view:${item.title}`} label="Ouvrir" /></button><button type="button" className="tenderButton" disabled={pendingAction === `remove:${index}`} onClick={() => void removeFile(index)}><ButtonLabel loading={pendingAction === `remove:${index}`} label="Supprimer" loadingLabel="Suppression…" /></button></> : <label className="tenderButton">{pendingAction === `upload:${index}` ? <ButtonLabel loading label="" loadingLabel="Envoi…" /> : "Choisir un fichier"}<input style={{ display: "none" }} type="file" disabled={pendingAction === `upload:${index}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertFile(index, file); }} /></label>}</div>
            {!item.fields.length && <p className="mt-3 text-sm text-amber-700">Aucune valeur n’a été identifiée à préremplir. Le PDF à imprimer reprend néanmoins le document demandé et doit être vérifié avant signature.</p>}
            {item.source_reference && <p className="mt-2 text-xs text-gray-500">Source : {item.source_reference}</p>}
          </article>;
        })}
      </div>
    </section>
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
  </>;
}
