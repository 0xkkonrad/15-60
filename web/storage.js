import { normalizeSession } from './core.js';

const DB_NAME = 'clear60';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const MEDIA = 'media';
const FALLBACK_KEY = 'clear60/sessions-fallback/v1';

let opening;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('The local database request failed.'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('The local database write was rolled back.'));
    tx.onerror = () => reject(tx.error || new Error('The local database write failed.'));
  });
}

function openDatabase() {
  if (opening) return opening;
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'));
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        const store = db.createObjectStore(SESSIONS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error || new Error('15:60 could not open its local database.'));
    };
    req.onblocked = () => {
      opening = null;
      reject(new Error('Another 15:60 tab is upgrading the local database.'));
    };
  });
  return opening;
}

function fallbackRead() {
  try {
    const value = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '[]');
    return Array.isArray(value) ? value.map(normalizeSession) : [];
  } catch {
    return [];
  }
}

function fallbackWrite(session) {
  const rows = fallbackRead().filter((row) => row.id !== session.id);
  rows.unshift(session);
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(rows.slice(0, 50)));
    return true;
  } catch {
    return false;
  }
}

function fallbackRemove(id) {
  const rows = fallbackRead().filter((row) => row.id !== id);
  try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(rows)); } catch { /* best effort */ }
}

export async function saveSession(value, mediaBlob) {
  const session = normalizeSession(value);
  try {
    const db = await openDatabase();
    const tx = db.transaction([SESSIONS, MEDIA], 'readwrite');
    tx.objectStore(SESSIONS).put(session);
    if (mediaBlob !== undefined) {
      if (mediaBlob instanceof Blob) tx.objectStore(MEDIA).put({ id: session.id, blob: mediaBlob });
      else tx.objectStore(MEDIA).delete(session.id);
    }
    await transactionDone(tx);
    fallbackRemove(session.id);
    return { session, mediaSaved: mediaBlob instanceof Blob, fallback: false };
  } catch (error) {
    /* Metadata still has value when a private browser refuses IndexedDB. A
     * Blob is deliberately never squeezed into localStorage. */
    if (fallbackWrite(session)) {
      return { session, mediaSaved: false, fallback: true, error };
    }
    throw error;
  }
}

export async function getSession(id, { withMedia = true } = {}) {
  const fallback = fallbackRead().find((row) => row.id === id) || null;
  try {
    const db = await openDatabase();
    const stores = withMedia ? [SESSIONS, MEDIA] : [SESSIONS];
    const tx = db.transaction(stores);
    const sessionPromise = request(tx.objectStore(SESSIONS).get(id));
    const mediaPromise = withMedia ? request(tx.objectStore(MEDIA).get(id)) : Promise.resolve(null);
    const [rawSession, media] = await Promise.all([sessionPromise, mediaPromise]);
    const stored = rawSession ? normalizeSession(rawSession) : null;
    const chosen = !stored || (fallback && fallback.updatedAt > stored.updatedAt) ? fallback : stored;
    if (!chosen) return null;
    const mediaBlob = chosen === stored ? media?.blob || null : null;
    return { session: chosen, mediaBlob };
  } catch {
    return fallback ? { session: fallback, mediaBlob: null } : null;
  }
}

export async function listSessions() {
  try {
    const db = await openDatabase();
    const rows = await request(db.transaction(SESSIONS).objectStore(SESSIONS).getAll());
    const merged = new Map(rows.map((row) => {
      const session = normalizeSession(row);
      return [session.id, session];
    }));
    for (const fallback of fallbackRead()) {
      const stored = merged.get(fallback.id);
      if (!stored || fallback.updatedAt > stored.updatedAt) merged.set(fallback.id, fallback);
    }
    return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return fallbackRead().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export async function listSessionsWithMedia() {
  const sessions = await listSessions();
  return Promise.all(sessions.map(async (session) => {
    const saved = await getSession(session.id);
    return saved || { session, mediaBlob: null };
  }));
}

export async function removeSession(id) {
  try {
    const db = await openDatabase();
    const tx = db.transaction([SESSIONS, MEDIA], 'readwrite');
    tx.objectStore(SESSIONS).delete(id);
    tx.objectStore(MEDIA).delete(id);
    await transactionDone(tx);
  } catch { /* still remove any metadata-only fallback below */ }
  fallbackRemove(id);
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: Number(estimate.usage || 0),
      quota: Number(estimate.quota || 0),
      persisted: navigator.storage.persisted ? await navigator.storage.persisted() : false,
    };
  } catch {
    return null;
  }
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

export const storageIdentity = Object.freeze({ database: DB_NAME, version: DB_VERSION });
