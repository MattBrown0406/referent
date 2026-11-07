import { newUuid } from './cases';
import { OfflineError, StoreError, asOfflineError, describeError, errorCode, withHttpStatus } from './errors';
import {
  CREDENTIAL_COLUMNS,
  credentialFromRow,
  type CredentialFields,
  type CredentialRow,
  type ProgramCredential,
} from './integrity';
import { lookupNpi as lookupNpiWith, type NpiFetch, type NpiLookupResult } from './npi';
import { fetchAllPages } from './paging';
import { supabase } from './supabase';

// ─── Program Integrity Watch: the server side ───────────────────────────────
// Migration 20261104130000_program_integrity.sql. A credential belongs to a
// shared directory listing (its claimant or ReferralFit edit it; only
// ReferralFit verifies it) or to one of the practice's own partners (the
// practice edits it and records its own check).
//
// Online only. Reads are not cached: offline, the Credentials card says they
// load when you're online and every chip stays hidden. Writes throw
// OfflineError (errors.ts) when the server could not be reached; the app
// makes the id, so a retry with the same id after a timeout is safe.
//
// Against a server without the migration (PGRST202 unknown function,
// 42P01 / PGRST205 unknown table, 42703 unknown column) the reads report
// available: false and the app hides the whole feature.

export type CredentialIndex = {
  available: boolean;
  // Listing credentials by global_partner_id; the practice's own by partner id.
  listing: Record<string, ProgramCredential[]>;
  local: Record<string, ProgramCredential[]>;
};

export const EMPTY_CREDENTIAL_INDEX: CredentialIndex = { available: true, listing: {}, local: {} };

// Typed as '*' for supabase-js (the client has no generated schema types):
// the columns are the explicit list the mapper reads.
const SELECT = CREDENTIAL_COLUMNS.join(', ') as '*';
// fetch_listing_credentials reads at most this many listings per call, and
// each call is paged: a listing can hold many credentials, and PostgREST cuts
// any response (a set-returning function's included) at 1000 rows.
const LISTING_CHUNK = 200;

export function isMissingCredentialSchema(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}

// Every failure as a readable StoreError; one that never got an answer is an
// OfflineError (nothing was refused, a write may or may not have landed).
function credentialFailure(error: unknown, status: number | undefined, fallback: string): StoreError {
  if (error instanceof StoreError) return error;
  const failure = withHttpStatus(error, status);
  const offline = asOfflineError(failure);
  if (offline instanceof OfflineError) return offline;
  const code = errorCode(error);
  const message = (error as { message?: unknown }).message;
  if (code === '42501') {
    return new StoreError(typeof message === 'string' && message ? message : 'You cannot change these credentials.', false);
  }
  // The server's own plain words for a check (22023) or a missing row
  // (P0002), without a code after them.
  if ((code === '22023' || code === 'P0002') && typeof message === 'string' && message) return new StoreError(message, false);
  return new StoreError(describeError(failure, fallback), false);
}

function mapRows(rows: unknown): ProgramCredential[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => credentialFromRow(row as CredentialRow)).filter((item): item is ProgramCredential => Boolean(item));
}

// A listing's notes (the program's note to ReferralFit, and ReferralFit's
// note when it could not confirm a credential) are only for the listing's
// claimant, in the portal, and for ReferralFit (fetchListingCredentialNotes).
// The server no longer returns them on listing rows; anything an older
// server still sends is dropped here, so no practitioner ever sees one.
export function withoutListingNotes(credential: ProgramCredential): ProgramCredential {
  return credential.scope === 'listing' ? { ...credential, note: '', verificationNote: '' } : credential;
}

function groupBy(credentials: ProgramCredential[], key: 'globalPartnerId' | 'partnerId'): Record<string, ProgramCredential[]> {
  const result: Record<string, ProgramCredential[]> = {};
  for (const credential of credentials) {
    const id = credential[key];
    if (!id) continue;
    (result[id] ||= []).push(credential);
  }
  return result;
}

// The credentials of these directory listings (any number; read in chunks).
export async function fetchListingCredentials(listingIds: string[]): Promise<{ available: boolean; byListing: Record<string, ProgramCredential[]> }> {
  const ids = Array.from(new Set(listingIds.filter(Boolean).map((id) => id.toLowerCase())));
  const all: ProgramCredential[] = [];
  for (let start = 0; start < ids.length; start += LISTING_CHUNK) {
    const chunk = ids.slice(start, start + LISTING_CHUNK);
    let rows: unknown[];
    try {
      rows = await fetchAllPages<unknown>((from, to) => supabase.rpc('fetch_listing_credentials', { p_ids: chunk }).order('id').range(from, to));
    } catch (error) {
      if (isMissingCredentialSchema(error)) return { available: false, byListing: {} };
      throw credentialFailure(error, (error as { httpStatus?: number } | null)?.httpStatus, 'Could not load credentials.');
    }
    all.push(...mapRows(rows).map(withoutListingNotes));
  }
  return { available: true, byListing: groupBy(all, 'globalPartnerId') };
}

export type ListingCredentialNotes = Record<string, { note: string; verificationNote: string }>;

// A listing's notes by credential id: for the listing's claimant or a
// platform admin only (anyone else gets no rows). null on a server without
// the function (an older server still sends the notes on the rows, and
// only an admin's own screens ask for them).
export async function fetchListingCredentialNotes(globalPartnerId: string): Promise<ListingCredentialNotes | null> {
  const { data, error, status } = await supabase.rpc('fetch_listing_credential_notes', { p_global_partner_id: globalPartnerId.toLowerCase() });
  if (error) {
    if (isMissingCredentialSchema(error)) return null;
    throw credentialFailure(error, status, 'Could not load the notes.');
  }
  const notes: ListingCredentialNotes = {};
  for (const row of (Array.isArray(data) ? data : []) as { id?: unknown; note?: unknown; verification_note?: unknown }[]) {
    if (typeof row.id !== 'string') continue;
    notes[row.id.toLowerCase()] = {
      note: typeof row.note === 'string' ? row.note : '',
      verificationNote: typeof row.verification_note === 'string' ? row.verification_note : '',
    };
  }
  return notes;
}

// The practice's own checks (RLS: this workspace only) plus the listing
// credentials of every partner linked to the directory.
export async function fetchCredentialIndex(listingIds: string[]): Promise<CredentialIndex> {
  let localRows: CredentialRow[];
  try {
    localRows = await fetchAllPages<CredentialRow>((from, to) => supabase
      .from('program_credentials')
      .select(SELECT)
      .not('partner_id', 'is', null)
      .order('id')
      .range(from, to));
  } catch (error) {
    if (isMissingCredentialSchema(error)) return { available: false, listing: {}, local: {} };
    throw credentialFailure(error, undefined, 'Could not load credentials.');
  }
  const listing = await fetchListingCredentials(listingIds);
  if (!listing.available) return { available: false, listing: {}, local: {} };
  return { available: true, listing: listing.byListing, local: groupBy(mapRows(localRows), 'partnerId') };
}

export type CredentialOwner = { globalPartnerId: string; partnerId?: undefined } | { partnerId: string; globalPartnerId?: undefined };

// Add (no id) or edit a credential. Any change sends it back to pending.
export async function saveCredential(owner: CredentialOwner, fields: CredentialFields, id?: string): Promise<ProgramCredential> {
  const { data, error, status } = await supabase.rpc('save_program_credential', {
    p_id: id || newUuid(),
    p_global_partner_id: owner.globalPartnerId ?? null,
    p_partner_id: owner.partnerId ?? null,
    p_kind: fields.kind,
    p_accreditor: fields.accreditor,
    p_accreditor_name: fields.accreditorName,
    p_identifier: fields.identifier,
    p_issuing_state: fields.issuingState,
    p_expires_on: fields.expiresOn,
    p_proof_url: fields.proofUrl,
    p_note: fields.note,
  });
  if (error) {
    // A credential ReferralFit could not confirm keeps its kind, accreditor
    // and state: the server's way forward, said calmly.
    if (errorCode(error) === '22023' && (error as { message?: unknown }).message === CREDENTIAL_CORRECT_ONLY) throw new CredentialKeptError(CREDENTIAL_CORRECT_ONLY);
    throw credentialFailure(error, status, 'Could not save the credential.');
  }
  const saved = credentialFromRow((Array.isArray(data) ? data[0] : data) as CredentialRow);
  if (!saved) throw new StoreError('Saved, but the credential could not be read back. Pull to refresh.', false);
  return saved;
}

// 'verified': checked against the issuer and it matches. 'rejected': it
// could not be confirmed. A listing's: ReferralFit only. `seenUpdatedAt`
// refuses the check when the credential changed after it was opened.
export async function verifyCredential(id: string, verdict: 'verified' | 'rejected', note: string, seenUpdatedAt?: string): Promise<ProgramCredential> {
  const { data, error, status } = await supabase.rpc('verify_program_credential', {
    p_id: id,
    p_verdict: verdict,
    p_note: note.trim(),
    p_seen_updated_at: seenUpdatedAt || null,
  });
  if (error) throw credentialFailure(error, status, 'Could not record the check.');
  const saved = credentialFromRow((Array.isArray(data) ? data[0] : data) as CredentialRow);
  if (!saved) throw new StoreError('Recorded, but the credential could not be read back. Pull to refresh.', false);
  return saved;
}

// The server kept the credential on purpose (42501): for example a listing
// credential ReferralFit could not confirm stays on record. Not a failure to
// apologise for: the screens show its message calmly, as information.
export class CredentialKeptError extends StoreError {
  constructor(message: string) {
    super(message, false);
    this.name = 'CredentialKeptError';
  }
}

export const CREDENTIAL_KEPT_TITLE = 'Kept on record';

// save_program_credential's 22023 when a claimant edits a listing credential
// ReferralFit could not confirm into another kind, accreditor or issuing
// state (program_credential_write_edit): it can only be corrected. The
// editor shows it as information, not as a failure.
export const CREDENTIAL_CORRECT_ONLY = 'ReferralFit could not confirm this credential. Correct its number, date or link, or add a new credential.';

export async function deleteCredential(id: string): Promise<void> {
  const { error, status } = await supabase.rpc('delete_program_credential', { p_id: id });
  if (!error) return;
  const message = (error as { message?: unknown }).message;
  if (errorCode(error) === '42501' && typeof message === 'string' && message) throw new CredentialKeptError(message);
  throw credentialFailure(error, status, 'Could not remove the credential.');
}

// The NPI Registry's name for an NPI credential, kept as a hint. On a
// listing's credential only ReferralFit may keep it (the server refuses
// anyone else with 42501): see mayKeepNpiHint.
export function mayKeepNpiHint(scope: ProgramCredential['scope'], isPlatformAdmin: boolean): boolean {
  return scope === 'local' || isPlatformAdmin;
}

export async function recordNpiLookup(id: string, name: string): Promise<ProgramCredential | null> {
  const { data, error, status } = await supabase.rpc('record_npi_lookup', { p_id: id, p_name: name });
  if (error) throw credentialFailure(error, status, 'Could not keep the NPI Registry result.');
  return credentialFromRow((Array.isArray(data) ? data[0] : data) as CredentialRow);
}

// The device's fetch, resolved at call time (React Native installs it at startup).
const deviceFetch: NpiFetch = (url, init) => fetch(url, init);

export function lookupNpi(npi: string): Promise<NpiLookupResult> {
  return lookupNpiWith(npi, deviceFetch);
}

// ─── ReferralFit's review queue (platform admins) ───────────────────────────

export type PendingListingCredential = ProgramCredential & {
  listing: string;
  listingState: string;
  listingWebsite: string;
  listingStatus: string;
  statusToday: string;
  createdAt: string;
};

type PendingRow = CredentialRow & {
  listing?: string | null;
  listing_state?: string | null;
  listing_website?: string | null;
  listing_status?: string | null;
  status_today?: string | null;
  created_at?: string | null;
};

// Raises for anyone but a platform admin. Oldest first.
export async function fetchPendingListingCredentials(): Promise<{ available: boolean; items: PendingListingCredential[] }> {
  const { data, error, status } = await supabase.rpc('list_pending_listing_credentials');
  if (error) {
    if (isMissingCredentialSchema(error)) return { available: false, items: [] };
    throw credentialFailure(error, status, 'Could not load credentials waiting for review.');
  }
  const items: PendingListingCredential[] = [];
  for (const row of (Array.isArray(data) ? data : []) as PendingRow[]) {
    const credential = credentialFromRow({ ...row, status: 'pending' });
    if (!credential) continue;
    items.push({
      ...credential,
      listing: row.listing || '',
      listingState: row.listing_state || '',
      listingWebsite: row.listing_website || '',
      listingStatus: row.listing_status || '',
      statusToday: row.status_today || 'pending',
      createdAt: row.created_at || '',
    });
  }
  return { available: true, items };
}
