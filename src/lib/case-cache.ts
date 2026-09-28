import type { CaseContact, CaseDocument, CaseEvent, CaseFile, CaseList, CaseRecord } from './cases';

// Shape and bounds of the saved copies of case data that store.ts keeps in
// AsyncStorage next to the partner/referral snapshot. Pure helpers only: no
// storage, no network, no session fence — those live in store.ts so the case
// cache shares the same account key, workspace binding and wipe rules.
//
// The case list and every case contact are saved in full: the family's
// primary name and phone on each card is what an interventionist needs at a
// hospital or intervention site with no signal. Timelines and document
// metadata are saved only for files the user has opened, most recently saved
// first, and each saved timeline keeps only its newest entries, so storage
// stays small on a long-lived install.
export const MAX_CACHED_CASE_FILES = 25;
export const MAX_CACHED_EVENTS_PER_FILE = 200;

export type CaseFileIndexEntry = { caseId: string; savedAt: string };
export type CachedCaseList = { savedAt: string; list: CaseList };
export type CachedCaseFile = { savedAt: string; truncated: boolean; file: CaseFile };

export type CaseListEnvelope = { version: 1; userId: string; savedAt: string; cases: CaseRecord[]; contacts: CaseContact[] };
export type CaseFileEnvelope = {
  version: 1; userId: string; caseId: string; savedAt: string; truncated: boolean; events: CaseEvent[]; documents: CaseDocument[];
};
export type CaseFileIndexEnvelope = { version: 1; userId: string; entries: CaseFileIndexEntry[] };

function ownedBy(value: { version?: unknown; userId?: unknown } | null, userId: string): boolean {
  return Boolean(value) && value?.version === 1 && typeof value?.userId === 'string' && value.userId.toLowerCase() === userId.toLowerCase();
}

export function makeCaseListEnvelope(userId: string, list: CaseList, savedAt: string): CaseListEnvelope {
  return { version: 1, userId, savedAt, cases: list.cases, contacts: list.contacts };
}

export function parseCachedCaseList(value: unknown, userId: string): CachedCaseList | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<CaseListEnvelope>;
  if (!ownedBy(parsed, userId) || typeof parsed.savedAt !== 'string') return null;
  if (!Array.isArray(parsed.cases) || !Array.isArray(parsed.contacts)) return null;
  return { savedAt: parsed.savedAt, list: { cases: parsed.cases, contacts: parsed.contacts } };
}

// Newest timeline entries only. The full list stays on the server; the saved
// copy tells the reader it is bounded so a gap is never mistaken for history.
export function boundCaseFile(file: CaseFile, maxEvents = MAX_CACHED_EVENTS_PER_FILE): { file: CaseFile; truncated: boolean } {
  const events = file.events.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const truncated = events.length > maxEvents;
  return { file: { events: truncated ? events.slice(0, maxEvents) : events, documents: file.documents }, truncated };
}

export function makeCaseFileEnvelope(userId: string, caseId: string, file: CaseFile, savedAt: string): CaseFileEnvelope {
  const bounded = boundCaseFile(file);
  return {
    version: 1, userId, caseId, savedAt, truncated: bounded.truncated, events: bounded.file.events, documents: bounded.file.documents,
  };
}

export function parseCachedCaseFile(value: unknown, userId: string, caseId: string): CachedCaseFile | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<CaseFileEnvelope>;
  if (!ownedBy(parsed, userId) || typeof parsed.savedAt !== 'string') return null;
  if (typeof parsed.caseId !== 'string' || parsed.caseId.toLowerCase() !== caseId.toLowerCase()) return null;
  if (!Array.isArray(parsed.events) || !Array.isArray(parsed.documents)) return null;
  return { savedAt: parsed.savedAt, truncated: Boolean(parsed.truncated), file: { events: parsed.events, documents: parsed.documents } };
}

export function makeCaseFileIndexEnvelope(userId: string, entries: CaseFileIndexEntry[]): CaseFileIndexEnvelope {
  return { version: 1, userId, entries };
}

// A corrupt or foreign index reads as empty: the worst case is a stray saved
// file that the next workspace wipe removes by key prefix.
export function parseCaseFileIndex(value: unknown, userId: string): CaseFileIndexEntry[] {
  if (!value || typeof value !== 'object') return [];
  const parsed = value as Partial<CaseFileIndexEnvelope>;
  if (!ownedBy(parsed, userId) || !Array.isArray(parsed.entries)) return [];
  return parsed.entries.filter((entry): entry is CaseFileIndexEntry =>
    Boolean(entry) && typeof entry === 'object' && typeof entry.caseId === 'string' && typeof entry.savedAt === 'string');
}

// Least-recently-saved eviction. Entries are kept oldest first; saving a file
// moves it to the end, and anything past the limit falls off the front.
export function touchCaseFileIndex(
  entries: CaseFileIndexEntry[],
  caseId: string,
  savedAt: string,
  limit = MAX_CACHED_CASE_FILES,
): { entries: CaseFileIndexEntry[]; evicted: string[] } {
  const kept = entries.filter((entry) => entry.caseId !== caseId);
  kept.push({ caseId, savedAt });
  const overflow = Math.max(0, kept.length - Math.max(1, limit));
  return { entries: kept.slice(overflow), evicted: kept.slice(0, overflow).map((entry) => entry.caseId) };
}
