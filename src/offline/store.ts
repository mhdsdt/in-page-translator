import { catalog, packKey } from '../shared/catalog';
import type { Pack } from '../shared/catalog';
import type { ModelBuffers } from '../shared/offline';

const STORE = 'packs';
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('translation-models', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    database = undefined;
    throw error;
  });
  return database;
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function installedPacks(): Promise<Set<string>> {
  const current = new Map([...catalog.values()].map(pack => [packKey(pack), pack.id]));
  const keys = await transact('readwrite', store => {
    const request = store.getAllKeys();
    request.onsuccess = () => {
      // Older catalog revisions are no longer usable by this build.
      for (const key of request.result) {
        if (typeof key !== 'string' || !current.has(key)) store.delete(key);
      }
    };
    return request;
  });
  return new Set(keys.flatMap(key => {
    const id = typeof key === 'string' ? current.get(key) : undefined;
    return id ? [id] : [];
  }));
}

export function readPack(pack: Pack): Promise<ModelBuffers | undefined> {
  return transact('readonly', store => store.get(packKey(pack)));
}

export async function writePack(pack: Pack, buffers: ModelBuffers): Promise<void> {
  // One transaction publishes the entire verified pack. Partial downloads never appear installed.
  await transact('readwrite', store => store.put(buffers, packKey(pack)));
}

export async function removePack(pack: Pack): Promise<void> {
  await transact('readwrite', store => store.delete(packKey(pack)));
}
