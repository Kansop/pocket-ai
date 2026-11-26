// Tiny IndexedDB wrapper for saved conversations.
const DB_NAME = 'pocketai';
const STORE = 'chats';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  async all() {
    const db = await open();
    const t = db.transaction(STORE, 'readonly');
    const list = await reqP(t.objectStore(STORE).getAll());
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async get(id) {
    const db = await open();
    return reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  },
  put(chat) { return tx('readwrite', s => { s.put(chat); }); },
  del(id) { return tx('readwrite', s => { s.delete(id); }); },
  clear() { return tx('readwrite', s => { s.clear(); }); },
};
