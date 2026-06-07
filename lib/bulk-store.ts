// Client-side store for bulk uploads. Uses IndexedDB (handles many MB — unlike
// localStorage's ~5MB cap, which silently dropped large new files so an OLD upload
// kept loading). Keeps the last few uploads so the user can switch between lists.

export interface BulkUpload {
  id: string;
  fileName: string;
  savedAt: number;        // ms epoch
  rows: Record<string, unknown>[];
  headers: string[];
  cols: unknown;          // ColMap
  aiCat?: Record<string, string>;
  catOverride?: Record<number, string>;
}
export interface BulkUploadMeta { id: string; fileName: string; savedAt: number; count: number }

const DB_NAME = "photoforge";
const STORE = "bulkUploads";
const KEEP = 8; // prune older uploads beyond this

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export async function saveUpload(u: BulkUpload): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(u);
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    await prune(db);
  } finally { db.close(); }
}

export async function listUploads(): Promise<BulkUploadMeta[]> {
  const db = await openDB();
  try {
    const all = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<BulkUpload[]>);
    return all
      .map((u) => ({ id: u.id, fileName: u.fileName, savedAt: u.savedAt, count: u.rows?.length ?? 0 }))
      .sort((a, b) => b.savedAt - a.savedAt);
  } finally { db.close(); }
}

export async function getUpload(id: string): Promise<BulkUpload | null> {
  const db = await openDB();
  try {
    const u = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id) as IDBRequest<BulkUpload | undefined>);
    return u ?? null;
  } finally { db.close(); }
}

export async function deleteUpload(id: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  } finally { db.close(); }
}

async function prune(db: IDBDatabase): Promise<void> {
  const all = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<BulkUpload[]>);
  if (all.length <= KEEP) return;
  const toDelete = all.sort((a, b) => b.savedAt - a.savedAt).slice(KEEP);
  const tx = db.transaction(STORE, "readwrite");
  for (const u of toDelete) tx.objectStore(STORE).delete(u.id);
  await new Promise<void>((res) => { tx.oncomplete = () => res(); tx.onerror = () => res(); });
}
