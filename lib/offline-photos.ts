// Stockage temporaire des photos prises hors connexion.
//
// Le localStorage utilisé pour les autres saisies hors ligne (voir
// "btp-project-pending-sync" dans ProjectSiteManager) ne peut pas contenir de
// vraies photos (trop volumineux, limite de quelques Mo). On utilise donc
// IndexedDB, qui sait garder des fichiers entiers sur l'appareil, le temps
// que la connexion revienne et que la photo soit envoyée à Supabase.
const DB_NAME = "btp-offline-photos";
const STORE_NAME = "photos";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export type OfflinePhoto = { blob: Blob; name: string; type: string };

export async function saveOfflinePhoto(id: string, file: File): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ blob: file, name: file.name, type: file.type } satisfies OfflinePhoto, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadOfflinePhoto(id: string): Promise<OfflinePhoto | null> {
  const db = await openDatabase();
  const result = await new Promise<OfflinePhoto | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as OfflinePhoto | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

export async function deleteOfflinePhoto(id: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
