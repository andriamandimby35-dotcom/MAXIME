import { createClient } from "@/lib/supabase/client";

// PDF de devis (DAO) DÉJÀ ENREGISTRÉ : on le rouvre tel quel, sans le refabriquer et sans appuyer sur « Prévisualiser ».
// Le fichier n'est téléchargé qu'UNE fois par visite (gardé en mémoire) — le suivant ne coûte plus rien à Supabase.
// Un nouvel enregistrement remplace la copie en mémoire (pas besoin de retélécharger ce qu'on vient d'envoyer).

export type SavedPdfInfo = { path: string; createdAt: string; fileName: string | null };

const documentType = (mode: "external" | "internal") => mode === "internal" ? "internal_estimate" : "dao_official";
const blobs = new Map<string, { createdAt: string; blob: Blob }>();
const cacheKey = (estimateId: string, mode: "external" | "internal") => `${estimateId}|${mode}`;

// Une toute petite requête (une ligne de la table « estimate_documents »), aucun fichier téléchargé.
export async function findSavedEstimatePdf(estimateId: string, mode: "external" | "internal"): Promise<SavedPdfInfo | null> {
  const { data, error } = await createClient()
    .from("estimate_documents")
    .select("storage_path,file_name,created_at")
    .eq("estimate_id", estimateId)
    .eq("document_type", documentType(mode))
    .maybeSingle();
  if (error || !data?.storage_path) return null;
  return { path: String(data.storage_path), createdAt: String(data.created_at ?? ""), fileName: (data.file_name as string | null) ?? null };
}

// Renvoie une adresse locale (blob) du PDF enregistré. Chaque appel crée une adresse neuve (à libérer par l'appelant).
export async function openSavedEstimatePdf(estimateId: string, mode: "external" | "internal", info?: SavedPdfInfo | null): Promise<{ url: string; createdAt: string } | { error: string }> {
  try {
    const saved = info ?? await findSavedEstimatePdf(estimateId, mode);
    if (!saved) return { error: "Aucun PDF enregistré pour ce devis." };
    const key = cacheKey(estimateId, mode);
    const cached = blobs.get(key);
    if (cached && cached.createdAt === saved.createdAt) return { url: URL.createObjectURL(cached.blob), createdAt: saved.createdAt };
    const result = await createClient().storage.from("estimate-pdfs").download(saved.path);
    if (result.error || !result.data) return { error: `PDF enregistré introuvable : ${result.error?.message ?? "fichier absent"}` };
    const blob = new Blob([result.data], { type: "application/pdf" });
    blobs.set(key, { createdAt: saved.createdAt, blob });
    return { url: URL.createObjectURL(blob), createdAt: saved.createdAt };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Le PDF enregistré n'a pas pu être ouvert." };
  }
}

// Après « Confirmer et enregistrer » : le PDF qu'on vient d'envoyer devient la copie en mémoire (aucun retéléchargement).
export async function rememberSavedEstimatePdf(estimateId: string, mode: "external" | "internal", blob: Blob): Promise<SavedPdfInfo | null> {
  const info = await findSavedEstimatePdf(estimateId, mode);
  if (info) blobs.set(cacheKey(estimateId, mode), { createdAt: info.createdAt, blob: new Blob([blob], { type: "application/pdf" }) });
  return info;
}

// ---------------------------------------------------------------------------------------------
// Devis ajouté par PDF (chantier « devis importé ») : même principe. Son PDF enregistré est un fichier à chemin fixe
// (aucune table en plus) ; on le repère avec une simple liste du dossier (aucun téléchargement).
// ---------------------------------------------------------------------------------------------
const projectBlobs = new Map<string, { createdAt: string; blob: Blob }>();
const projectFolder = (organizationId: string, projectId: string, mode: "external" | "internal") => `${organizationId}/${projectId}/${mode}-pdf`;

async function organizationOfProject(projectId: string) {
  const { data } = await createClient().from("projects").select("organization_id").eq("id", projectId).maybeSingle();
  return (data as { organization_id?: string | null } | null)?.organization_id ?? null;
}

export async function findSavedProjectPdf(projectId: string, mode: "external" | "internal"): Promise<SavedPdfInfo | null> {
  try {
    const organizationId = await organizationOfProject(projectId);
    if (!organizationId) return null;
    const folder = projectFolder(organizationId, projectId, mode);
    const { data, error } = await createClient().storage.from("estimate-pdfs").list(folder, { limit: 10 });
    const file = error ? null : (data ?? []).find((entry) => entry.name === "devis.pdf");
    if (!file) return null;
    return { path: `${folder}/devis.pdf`, createdAt: String(file.updated_at ?? file.created_at ?? ""), fileName: "devis.pdf" };
  } catch { return null; }
}

export async function openSavedProjectPdf(projectId: string, mode: "external" | "internal", info?: SavedPdfInfo | null): Promise<{ url: string; createdAt: string } | { error: string }> {
  try {
    const saved = info ?? await findSavedProjectPdf(projectId, mode);
    if (!saved) return { error: "Aucun PDF enregistré pour ce devis." };
    const key = `${projectId}|${mode}`;
    const cached = projectBlobs.get(key);
    if (cached && cached.createdAt === saved.createdAt) return { url: URL.createObjectURL(cached.blob), createdAt: saved.createdAt };
    const result = await createClient().storage.from("estimate-pdfs").download(saved.path);
    if (result.error || !result.data) return { error: `PDF enregistré introuvable : ${result.error?.message ?? "fichier absent"}` };
    const blob = new Blob([result.data], { type: "application/pdf" });
    projectBlobs.set(key, { createdAt: saved.createdAt, blob });
    return { url: URL.createObjectURL(blob), createdAt: saved.createdAt };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Le PDF enregistré n'a pas pu être ouvert." };
  }
}

// Enregistre le PDF déjà fabriqué (celui de l'aperçu) : envoyé directement par le navigateur, il remplace l'ancien.
export async function saveProjectPdf(projectId: string, mode: "external" | "internal", blob: Blob): Promise<SavedPdfInfo | { error: string }> {
  try {
    const organizationId = await organizationOfProject(projectId);
    if (!organizationId) return { error: "Organisation introuvable." };
    const path = `${projectFolder(organizationId, projectId, mode)}/devis.pdf`;
    const pdf = new Blob([blob], { type: "application/pdf" });
    const upload = await createClient().storage.from("estimate-pdfs").upload(path, pdf, { upsert: true, contentType: "application/pdf", cacheControl: "0" });
    if (upload.error) return { error: `Enregistrement du PDF impossible : ${upload.error.message}` };
    const info = await findSavedProjectPdf(projectId, mode);
    if (info) projectBlobs.set(`${projectId}|${mode}`, { createdAt: info.createdAt, blob: pdf });
    return info ?? { path, createdAt: new Date().toISOString(), fileName: "devis.pdf" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Enregistrement du PDF impossible." };
  }
}
