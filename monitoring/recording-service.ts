export type LocalRecording = {
  id: string;

  // Display (user chosen)
  name: string;

  // Identity
  deviceId: string | null;
  vin: string | null;
  vehicleName: string | null;

  // Timestamps
  createdAtIso: string; // when recording started
  savedAtIso: string; // when user clicked save

  // Payload
  metadataJson: string; // pretty JSON string
  csvText: string; // full CSV

  // Sync status
  synced: boolean;
  syncedAtIso: string | null;

  // Optional remote URLs (if synced)
  remoteMetadataUrl: string | null;
  remoteCsvUrl: string | null;
};

export type LocalRecordingSummary = Pick<
  LocalRecording,
  | "id"
  | "name"
  | "deviceId"
  | "vin"
  | "vehicleName"
  | "createdAtIso"
  | "savedAtIso"
  | "synced"
  | "syncedAtIso"
  | "remoteMetadataUrl"
  | "remoteCsvUrl"
>;

export type ImportResult = { id: string; metadataUrl: string; csvUrl: string };
export type LocalDownloadUrls = { jsonUrl: string; csvUrl: string };

type Db = IDBDatabase;

const DB_NAME = "suite_recordings_db";
const DB_VERSION = 1;
const STORE = "recordings";

// Cache the DB open so we don't reconnect for every call.
let dbPromise: Promise<Db> | null = null;

function openDbCached(): Promise<Db> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });

        // Indexes used by list/filter.
        store.createIndex("vin", "vin", { unique: false });
        store.createIndex("savedAtIso", "savedAtIso", { unique: false });
        store.createIndex("createdAtIso", "createdAtIso", { unique: false });
        store.createIndex("synced", "synced", { unique: false });
      }
    };

    req.onsuccess = () => {
      const db = req.result;

      // If the DB is closed/invalidated, reset cache.
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        try {
          db.close();
        } finally {
          dbPromise = null;
        }
      };

      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function toSummary(r: LocalRecording): LocalRecordingSummary {
  const {
    id,
    name,
    deviceId,
    vin,
    vehicleName,
    createdAtIso,
    savedAtIso,
    synced,
    syncedAtIso,
    remoteMetadataUrl,
    remoteCsvUrl,
  } = r;

  return {
    id,
    name,
    deviceId,
    vin,
    vehicleName,
    createdAtIso,
    savedAtIso,
    synced,
    syncedAtIso,
    remoteMetadataUrl,
    remoteCsvUrl,
  };
}

function sortNewestFirst(items: LocalRecording[]) {
  items.sort((a, b) =>
    b.savedAtIso > a.savedAtIso ? 1 : b.savedAtIso < a.savedAtIso ? -1 : 0
  );
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDbCached();
  const tx = db.transaction(STORE, mode);
  const store = tx.objectStore(STORE);

  const result = await fn(store);
  await txDone(tx);
  return result;
}

export const recordingService = {
  /**
   * Save a recording to IndexedDB (overwrites by id).
   * Ensure ids are unique before calling.
   */
  async saveLocal(
    input: Omit<
      LocalRecording,
      "synced" | "syncedAtIso" | "remoteMetadataUrl" | "remoteCsvUrl"
    >
  ): Promise<LocalRecordingSummary> {
    const rec: LocalRecording = {
      ...input,
      synced: false,
      syncedAtIso: null,
      remoteMetadataUrl: null,
      remoteCsvUrl: null,
    };

    await withStore("readwrite", async (store) => {
      store.put(rec);
      return undefined as unknown as void;
    });

    return toSummary(rec);
  },

  async getLocal(id: string): Promise<LocalRecording | null> {
    return await withStore("readonly", async (store) => {
      const result = await reqToPromise<LocalRecording | undefined>(store.get(id));
      return result ?? null;
    });
  },

  async listLocal(): Promise<LocalRecordingSummary[]> {
    return await withStore("readonly", async (store) => {
      const all = await reqToPromise<LocalRecording[]>(store.getAll());
      sortNewestFirst(all);
      return all.map(toSummary);
    });
  },

  async listLocalByVin(vin: string): Promise<LocalRecordingSummary[]> {
    return await withStore("readonly", async (store) => {
      const idx = store.index("vin");
      const all = await reqToPromise<LocalRecording[]>(idx.getAll(vin));
      sortNewestFirst(all);
      return all.map(toSummary);
    });
  },

  async existsLocal(id: string): Promise<boolean> {
    const rec = await this.getLocal(id);
    return !!rec;
  },

  async getAllLocalIds(): Promise<Set<string>> {
    return await withStore("readonly", async (store) => {
      const keys = await reqToPromise<IDBValidKey[]>(store.getAllKeys());
      const s = new Set<string>();
      for (const k of keys) {
        if (typeof k === "string" && k.trim()) s.add(k.trim());
      }
      return s;
    });
  },

  async deleteLocal(id: string): Promise<boolean> {
    return await withStore("readwrite", async (store) => {
      const existing = await reqToPromise<LocalRecording | undefined>(store.get(id));
      if (!existing) return false;

      store.delete(id);
      return true;
    });
  },

  /**
   * Create Blob URLs for JSON + CSV for <a href="...">Download</a>.
   * Revoke URLs when a row is removed/unmounted.
   */
  async getLocalDownloadUrls(id: string): Promise<LocalDownloadUrls> {
    const rec = await this.getLocal(id);
    if (!rec) throw new Error(`Local recording not found: ${id}`);

    const jsonBlob = new Blob([rec.metadataJson], { type: "application/json" });
    const csvBlob = new Blob([rec.csvText], { type: "text/csv" });

    return {
      jsonUrl: URL.createObjectURL(jsonBlob),
      csvUrl: URL.createObjectURL(csvBlob),
    };
  },

  revokeDownloadUrls(urls: LocalDownloadUrls | null | undefined) {
    if (!urls) return;
    try {
      URL.revokeObjectURL(urls.jsonUrl);
    } catch {}
    try {
      URL.revokeObjectURL(urls.csvUrl);
    } catch {}
  },

  /**
   * Optional helper for button-driven downloads.
   * If you want custom filenames, prefer <a download="..."> in the UI.
   */
  async downloadLocal(id: string): Promise<void> {
    const rec = await this.getLocal(id);
    if (!rec) throw new Error(`Local recording not found: ${id}`);

    // JSON
    {
      const blob = new Blob([rec.metadataJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${id}.json`;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    // CSV
    {
      const blob = new Blob([rec.csvText], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${id}.csv`;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  },

  /**
   * Optional sync to RecordingService (kept for later).
   */
  async syncToServer(
    id: string,
    recordingServiceBaseUrl: string
  ): Promise<ImportResult> {
    const rec = await this.getLocal(id);
    if (!rec) throw new Error(`Local recording not found: ${id}`);

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([rec.metadataJson], { type: "application/json" }),
      `${id}.json`
    );
    form.append("data", new Blob([rec.csvText], { type: "text/csv" }), `${id}.csv`);
    form.append("id", id);

    const base = recordingServiceBaseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/recordings/import`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }

    const payload = (await res.json()) as ImportResult;

    const updated: LocalRecording = {
      ...rec,
      synced: true,
      syncedAtIso: new Date().toISOString(),
      remoteMetadataUrl: payload.metadataUrl ?? null,
      remoteCsvUrl: payload.csvUrl ?? null,
    };

    await withStore("readwrite", async (store) => {
      store.put(updated);
      return undefined as unknown as void;
    });

    return payload;
  },
};