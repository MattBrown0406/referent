import {
  createEmptyEnvelope,
  migrateStoredData,
  type SchemaV3Envelope,
} from './types';

export const LEGACY_STORAGE_KEY = 'referralfit-v2';
export const STORAGE_KEY = 'referralfit-v3';
export const LEGACY_BACKUP_PREFIX = 'referralfit-v2-backup-';
export const RESTORE_BACKUP_PREFIX = 'referralfit-restore-backup-';

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const storageQueues = new WeakMap<object, Promise<void>>();

function inStorageQueue<T>(storage: KeyValueStorage, operation: () => Promise<T>): Promise<T> {
  const previous = storageQueues.get(storage as object) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  storageQueues.set(storage as object, result.then(() => undefined, () => undefined));
  return result;
}

export type StorageLoadResult =
  | { status: 'empty'; data: SchemaV3Envelope }
  | { status: 'loaded'; data: SchemaV3Envelope }
  | { status: 'migrated'; data: SchemaV3Envelope; backupKey: string }
  | { status: 'recovery'; sourceKey: string; raw: string; error: string };

export interface LoadStoredDataOptions {
  now?: () => Date;
}

function parseAndMigrate(raw: string, expectedVersion: 2 | 3): SchemaV3Envelope {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const hasV3Version = typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).schemaVersion === 3;
    if ((expectedVersion === 3) !== hasV3Version) {
      throw new Error(`Expected schema v${expectedVersion} data under this storage key.`);
    }
    return migrateStoredData(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse stored data: ${message}`);
  }
}

function backupKeyFor(date: Date): string {
  return `${LEGACY_BACKUP_PREFIX}${date.toISOString().replace(/[:.]/g, '-')}`;
}

async function availableBackupKey(storage: KeyValueStorage, date: Date): Promise<string> {
  const base = backupKeyFor(date);
  let candidate = base;
  let suffix = 0;
  while (await storage.getItem(candidate) !== null) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/**
 * Loads v3 when present. On first v2 migration it writes an exact byte-for-byte
 * backup before writing v3. Unreadable source data is only returned for recovery.
 */
export async function loadStoredData(
  storage: KeyValueStorage,
  options: LoadStoredDataOptions = {},
): Promise<StorageLoadResult> {
  const v3Raw = await storage.getItem(STORAGE_KEY);
  if (v3Raw !== null) {
    try {
      return { status: 'loaded', data: parseAndMigrate(v3Raw, 3) };
    } catch (error) {
      return {
        status: 'recovery',
        sourceKey: STORAGE_KEY,
        raw: v3Raw,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const legacyRaw = await storage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw === null) return { status: 'empty', data: createEmptyEnvelope() };

  let data: SchemaV3Envelope;
  try {
    data = parseAndMigrate(legacyRaw, 2);
  } catch (error) {
    return {
      status: 'recovery',
      sourceKey: LEGACY_STORAGE_KEY,
      raw: legacyRaw,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const backupKey = await availableBackupKey(storage, (options.now ?? (() => new Date()))());
  await storage.setItem(backupKey, legacyRaw);
  await storage.setItem(STORAGE_KEY, JSON.stringify(data));
  return { status: 'migrated', data, backupKey };
}

export function saveStoredData(
  storage: KeyValueStorage,
  data: SchemaV3Envelope,
): Promise<void> {
  return inStorageQueue(storage, async () => {
    const validated = migrateStoredData(data);
    const existingV3 = await storage.getItem(STORAGE_KEY);
    if (existingV3 !== null) {
      try {
        parseAndMigrate(existingV3, 3);
      } catch {
        throw new Error('Existing v3 data is invalid; recover it before saving.');
      }
      throw new Error('Existing v3 data must be changed with updateStoredData().');
    }
    if (await storage.getItem(LEGACY_STORAGE_KEY) !== null) {
      throw new Error('Legacy data must be loaded, backed up, and migrated before saving.');
    }
    await storage.setItem(STORAGE_KEY, JSON.stringify(validated));
  });
}

/** Serializes read-modify-write operations so unrelated updates cannot overwrite one another. */
export function updateStoredData(
  storage: KeyValueStorage,
  updater: (current: SchemaV3Envelope) => SchemaV3Envelope,
): Promise<SchemaV3Envelope> {
  return inStorageQueue(storage, async () => {
    const existingV3 = await storage.getItem(STORAGE_KEY);
    let current: SchemaV3Envelope;
    if (existingV3 !== null) {
      current = parseAndMigrate(existingV3, 3);
    } else {
      if (await storage.getItem(LEGACY_STORAGE_KEY) !== null) {
        throw new Error('Legacy data must be loaded, backed up, and migrated before updating.');
      }
      current = createEmptyEnvelope();
    }
    const next = migrateStoredData(updater(current));
    await storage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  });
}

/**
 * Explicit user-driven recovery path. The replacement is fully validated before
 * any write, and the exact current serialized value is backed up before replacement.
 */
export function restoreStoredData(
  storage: KeyValueStorage,
  replacementRaw: string,
  options: LoadStoredDataOptions = {},
): Promise<{ data: SchemaV3Envelope; backupKey?: string }> {
  return inStorageQueue(storage, async () => {
    let replacement: SchemaV3Envelope;
    try {
      replacement = migrateStoredData(JSON.parse(replacementRaw) as unknown);
    } catch (error) {
      throw new Error(`Backup is not valid ReferralFit data: ${error instanceof Error ? error.message : String(error)}`);
    }

    const currentV3 = await storage.getItem(STORAGE_KEY);
    const currentLegacy = currentV3 === null ? await storage.getItem(LEGACY_STORAGE_KEY) : null;
    const currentRaw = currentV3 ?? currentLegacy;
    let backupKey: string | undefined;
    if (currentRaw !== null) {
      const date = (options.now ?? (() => new Date()))();
      const base = `${RESTORE_BACKUP_PREFIX}${date.toISOString().replace(/[:.]/g, '-')}`;
      backupKey = base;
      let suffix = 0;
      while (await storage.getItem(backupKey) !== null) {
        suffix += 1;
        backupKey = `${base}-${suffix}`;
      }
      await storage.setItem(backupKey, currentRaw);
    }
    await storage.setItem(STORAGE_KEY, JSON.stringify(replacement));
    return { data: replacement, backupKey };
  });
}
