/// <reference lib="dom" />

import { SyncError } from "./errors.js";
import type { Storage, StoredOp } from "./types.js";

/**
 * In-memory implementation of `Storage` for tests and ephemeral queues.
 */
export class MemoryStorage implements Storage {
  private readonly ops = new Map<string, StoredOp>();

  public async load(): Promise<StoredOp[]> {
    const list = Array.from(this.ops.values()).map((op) => ({ ...op }));
    list.sort((a, b) => a.seq - b.seq);
    return list;
  }

  public async put(op: StoredOp): Promise<void> {
    this.ops.set(op.id, { ...op });
  }

  public async delete(id: string): Promise<void> {
    this.ops.delete(id);
  }
}

const STORE_NAME = "ops";
const DB_VERSION = 1;

/**
 * IndexedDB implementation of `Storage` for persistent browser queues.
 */
export class IndexedDbStorage implements Storage {
  private readonly dbName: string;
  private readonly factory: IDBFactory | undefined;
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Creates an IndexedDB storage adapter.
   *
   * @param dbName - The IndexedDB database name.
   * @param factory - Optional `IDBFactory` override (defaults to `globalThis.indexedDB`).
   */
  public constructor(dbName: string, factory?: IDBFactory) {
    if (typeof dbName !== "string" || dbName.trim().length === 0 || dbName.length > 128) {
      throw new SyncError("invalid_op", "Invalid database name");
    }
    this.dbName = dbName;
    this.factory = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise !== null) {
      return this.dbPromise;
    }
    const idb = this.factory;
    if (!idb) {
      return Promise.reject(
        new SyncError("storage_failed", "IndexedDB factory is not available in this environment"),
      );
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = idb.open(this.dbName, DB_VERSION);
      } catch (err) {
        this.dbPromise = null;
        reject(new SyncError("storage_failed", "Failed to open IndexedDB", { cause: err }));
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.dbPromise = null;
        reject(
          new SyncError("storage_failed", "IndexedDB open request failed", {
            cause: req.error,
          }),
        );
      };
    });
    return this.dbPromise;
  }

  public async load(): Promise<StoredOp[]> {
    const db = await this.openDb();
    return new Promise<StoredOp[]>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const rows = (req.result as StoredOp[]).slice();
          rows.sort((a, b) => a.seq - b.seq);
          resolve(rows);
        };
        req.onerror = () => {
          reject(
            new SyncError("storage_failed", "Failed to load operations from IndexedDB", {
              cause: req.error,
            }),
          );
        };
      } catch (err) {
        reject(
          new SyncError("storage_failed", "IndexedDB load transaction failed", { cause: err }),
        );
      }
    });
  }

  public async put(op: StoredOp): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put({ ...op });
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          reject(
            new SyncError("storage_failed", "Failed to store operation in IndexedDB", {
              cause: tx.error,
            }),
          );
        };
        tx.onabort = () => {
          reject(
            new SyncError("storage_failed", "IndexedDB put transaction aborted", {
              cause: tx.error,
            }),
          );
        };
      } catch (err) {
        reject(new SyncError("storage_failed", "IndexedDB put transaction failed", { cause: err }));
      }
    });
  }

  public async delete(id: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          reject(
            new SyncError("storage_failed", "Failed to delete operation from IndexedDB", {
              cause: tx.error,
            }),
          );
        };
        tx.onabort = () => {
          reject(
            new SyncError("storage_failed", "IndexedDB delete transaction aborted", {
              cause: tx.error,
            }),
          );
        };
      } catch (err) {
        reject(
          new SyncError("storage_failed", "IndexedDB delete transaction failed", { cause: err }),
        );
      }
    });
  }

  /**
   * Closes the underlying IndexedDB connection if open.
   */
  public async close(): Promise<void> {
    if (this.dbPromise !== null) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
