import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { newUuid } from './cases';
import { OfflineError, StoreError, asOfflineError, describeError, errorCode, isServerUnreachable, withHttpStatus } from './errors';
import {
  ALREADY_SENT_PROBLEM,
  RECIPIENT_COLUMNS,
  REQUEST_COLUMNS,
  isMissingPlacementSchema,
  recipientFromRow,
  requestFromRow,
  seenMarker,
  sortRecipients,
  viewFromJson,
  placementAnswerLink,
  type AdmitWindow,
  type AnswerFields,
  type PlacementChannel,
  type PlacementRecipient,
  type PlacementRequestView,
  type PlacementSeen,
  type ResponseWindowHours,
  type SendFailure,
  placementPracticeName,
} from './placement-requests';
import { supabase } from './supabase';

// ─── Placement Request: the server side ─────────────────────────────────────
// Migration 20261104140000_placement_requests.sql. The rules are in
// placement-requests.ts.
//
// Online only. Reads are never cached: offline, the comparison says answers
// load when you're online. Writes are RPCs that throw OfflineError
// (errors.ts) when the server could not be reached; the app makes the
// request id, so a retry with the same id after a timeout is a no-op.
//
// Against a server without the migration (PGRST202 / PGRST205 / 42P01 /
// 42703 / 42883) the reads report available: false and the app hides the
// whole feature, as it does for the two features before it.
//
// ETHICS: nothing in this file writes to matching, scores, or the ranked
// order; answers are shown, never fed back.

// Typed as '*' for supabase-js (no generated schema types): the explicit
// column lists the mappers read.
const REQUEST_SELECT = REQUEST_COLUMNS.join(', ') as '*';
const RECIPIENT_SELECT = RECIPIENT_COLUMNS.join(', ') as '*';
// The newest requests the comparison and Today look at.
const REQUEST_LIMIT = 100;
// Recipient reads per call (ids go in the URL).
const ID_CHUNK = 40;

function isMissing(error: unknown): boolean {
  return isMissingPlacementSchema(errorCode(error));
}

// The server definitely refused, in its own plain words (22023 checks,
// P0002 not found, 42501): nothing was written. `sqlState` is its code (not
// `code`, so describeError shows the words alone, as before).
export class PlacementRefusal extends StoreError {
  readonly sqlState: string;

  constructor(message: string, sqlState: string) {
    super(message, false);
    this.name = 'PlacementRefusal';
    this.sqlState = sqlState;
  }
}

// Every failure as a readable StoreError; one that never got an answer is an
// OfflineError (nothing was refused; a write may or may not have landed).
function placementFailure(error: unknown, status: number | undefined, fallback: string): StoreError {
  if (error instanceof StoreError) return error;
  const failure = withHttpStatus(error, status);
  const offline = asOfflineError(failure);
  if (offline instanceof OfflineError) return offline;
  const code = errorCode(error);
  const message = (error as { message?: unknown } | null)?.message;
  if ((code === '22023' || code === 'P0002' || code === '42501') && typeof message === 'string' && message) {
    return new PlacementRefusal(message, code);
  }
  return new StoreError(describeError(failure, fallback), false);
}

/**
 * How a failed createPlacementRequest ended (placement-requests.ts
 * SendFailure): a definite refusal is the server's 22023 or P0002 in its own
 * words; the already-sent refusal is told apart; anything else (offline, a
 * timeout, a server failure, an answer that could not be read back) is
 * unknown, so the sheet keeps the request id.
 */
export function sendFailureOf(error: unknown): SendFailure {
  if (!(error instanceof PlacementRefusal) || (error.sqlState !== '22023' && error.sqlState !== 'P0002')) return 'unknown';
  return error.message === ALREADY_SENT_PROBLEM ? 'already_sent' : 'refused';
}

export type PlacementRequestsRead = { available: boolean; requests: PlacementRequestView[] };

/**
 * Whether a request with this id is on the server (RLS: this workspace
 * only). true or false when the server answered; null when it could not be
 * asked. A request the sheet kept an id for after an unknown outcome that
 * exists definitely went out.
 */
export async function placementRequestExists(id: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.from('placement_requests').select('id').eq('id', id).maybeSingle();
    if (error) return null;
    return Boolean(data);
  } catch {
    return null;
  }
}

/**
 * The practice's newest requests with their programs (RLS: this workspace
 * only). `alsoId`: one request to include even when it is older than the
 * newest REQUEST_LIMIT (a push about it was tapped, its answers are open).
 */
export async function fetchPlacementRequests(alsoId?: string | null): Promise<PlacementRequestsRead> {
  let requestRows: unknown[] = [];
  try {
    const { data, error, status } = await supabase
      .from('placement_requests')
      .select(REQUEST_SELECT)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(REQUEST_LIMIT);
    if (error) {
      if (isMissing(error)) return { available: false, requests: [] };
      throw placementFailure(error, status, 'Could not load placement requests.');
    }
    requestRows = Array.isArray(data) ? data : [];
    const wanted = alsoId?.toLowerCase();
    if (wanted && !requestRows.some((row) => String((row as { id?: unknown }).id).toLowerCase() === wanted)) {
      const extra = await supabase.from('placement_requests').select(REQUEST_SELECT).eq('id', wanted).maybeSingle();
      if (extra.error) throw placementFailure(extra.error, extra.status, 'Could not load placement requests.');
      if (extra.data) requestRows = [...requestRows, extra.data];
    }
  } catch (error) {
    if (isMissing(error)) return { available: false, requests: [] };
    throw placementFailure(error, undefined, 'Could not load placement requests.');
  }
  const requests = requestRows.map((row) => requestFromRow(row as Record<string, unknown>)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const byRequest = new Map<string, PlacementRecipient[]>();
  const ids = requests.map((item) => item.id);
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const { data, error, status } = await supabase
      .from('placement_request_recipients')
      .select(RECIPIENT_SELECT)
      .in('request_id', ids.slice(start, start + ID_CHUNK))
      .order('request_id', { ascending: true })
      .order('rank', { ascending: true });
    if (error) {
      if (isMissing(error)) return { available: false, requests: [] };
      throw placementFailure(error, status, 'Could not load placement requests.');
    }
    for (const row of Array.isArray(data) ? data : []) {
      const recipient = recipientFromRow(row as Record<string, unknown>);
      if (!recipient) continue;
      const list = byRequest.get(recipient.requestId) || [];
      list.push(recipient);
      byRequest.set(recipient.requestId, list);
    }
  }
  return {
    available: true,
    requests: requests.map((request) => ({ request, recipients: sortRecipients(byRequest.get(request.id) || [], 'ranked') })),
  };
}

/** How each partner would answer: 'portal' (claimed listing) or 'manual'. null when the server lacks the feature. */
export async function fetchPlacementChannels(partnerIds: string[]): Promise<Record<string, PlacementChannel> | null> {
  const ids = Array.from(new Set(partnerIds.filter(Boolean).map((id) => id.toLowerCase()))).slice(0, 100);
  if (!ids.length) return {};
  const { data, error, status } = await supabase.rpc('placement_request_channels', { p_partner_ids: ids });
  if (error) {
    if (isMissing(error)) return null;
    throw placementFailure(error, status, 'Could not check how programs answer.');
  }
  const result: Record<string, PlacementChannel> = {};
  for (const row of (Array.isArray(data) ? data : []) as { partner_id?: unknown; channel?: unknown }[]) {
    if (typeof row.partner_id === 'string') result[row.partner_id.toLowerCase()] = row.channel === 'portal' ? 'portal' : 'manual';
  }
  return result;
}

export type NewPlacementRequest = {
  /** Made once per send attempt and reused on retry, so a retry is a no-op. */
  id: string;
  matchProfileId: string;
  /** The practice's ranked order, rank 1 first. */
  partnerIds: string[];
  /** Each program's place on the match screen, aligned with partnerIds (p_ranks): the answers screen shows the same numbers. */
  ranks: number[];
  respondHours: ResponseWindowHours;
  admitWindow: AdmitWindow;
  /** Already trimmed and checked (preparePlacementRequest). */
  note: string;
};

export function newPlacementRequestId(): string {
  return newUuid();
}

function viewOrThrow(data: unknown, what: string): PlacementRequestView {
  const view = viewFromJson(Array.isArray(data) ? data[0] : data);
  if (!view) throw new StoreError(`${what}, but it could not be read back. Pull to refresh.`, false);
  return view;
}

/** Send the request. The server builds the de-identified payload itself from the saved match. */
export async function createPlacementRequest(input: NewPlacementRequest): Promise<PlacementRequestView> {
  const { data, error, status } = await supabase.rpc('create_placement_request', {
    p_id: input.id,
    p_match_profile_id: input.matchProfileId,
    p_criteria: null,
    p_partner_ids: input.partnerIds,
    p_respond_hours: input.respondHours,
    p_admit_window: input.admitWindow,
    p_note: input.note,
    p_case_id: null,
    p_ranks: input.ranks,
  });
  if (error) throw placementFailure(error, status, 'Could not send the placement request.');
  return viewOrThrow(data, 'Sent');
}

/**
 * The practice name programs read on this workspace's requests, worked out
 * as public.placement_practice_name does (placementPracticeName): the
 * workspace's name, else its directory profile's, else "A ReferralFit
 * practice". '' only when it could not be read (the screens then say so
 * without guessing).
 */
export async function fetchPlacementPracticeName(): Promise<string> {
  try {
    const org = await supabase.rpc('current_org_id');
    if (org.error || typeof org.data !== 'string' || !org.data) return '';
    const orgId = org.data;
    const [workspace, listing] = await Promise.all([
      supabase.from('orgs').select('name').eq('id', orgId).maybeSingle(),
      supabase.from('global_partners').select('organization, name').eq('owner_org_id', orgId).is('merged_into', null).order('id', { ascending: true }).limit(1),
    ]);
    if (workspace.error) return '';
    const profile = !listing.error && Array.isArray(listing.data) ? (listing.data[0] as { organization?: string | null; name?: string | null } | undefined) : undefined;
    return placementPracticeName((workspace.data as { name?: string | null } | null)?.name, profile);
  } catch {
    return '';
  }
}

export async function cancelPlacementRequest(id: string): Promise<PlacementRequestView> {
  const { data, error, status } = await supabase.rpc('cancel_placement_request', { p_id: id });
  if (error) throw placementFailure(error, status, 'Could not cancel the request.');
  return viewOrThrow(data, 'Cancelled');
}

export async function closePlacementRequest(id: string): Promise<PlacementRequestView> {
  const { data, error, status } = await supabase.rpc('close_placement_request', { p_id: id });
  if (error) throw placementFailure(error, status, 'Could not close the request.');
  return viewOrThrow(data, 'Closed');
}

// Answer links made while the app runs, by recipient: a program texted and
// then emailed gets the same link (the server keeps a recipient's 50
// newest links working; placement_answer_link).
const answerLinks = new Map<string, string>();
// Requests in flight, so a prefetch and a tap never ask twice.
const answerLinkRequests: Record<string, Promise<string | null> | undefined> = Object.create(null);
// Bumped on sign-out: a request still in flight then never fills the cache.
let answerLinkEpoch = 0;
// On the web the links also survive a reload of the tab (sessionStorage), so
// reloading the page does not make a new link for every program each time.
const ANSWER_LINKS_STORAGE_KEY = 'referralfit.answerLinks.v1';
let answerLinksLoaded = false;

function linkStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function loadStoredAnswerLinks(): void {
  if (answerLinksLoaded) return;
  answerLinksLoaded = true;
  try {
    const stored = JSON.parse(linkStorage()?.getItem(ANSWER_LINKS_STORAGE_KEY) || '{}') as Record<string, unknown>;
    for (const [id, link] of Object.entries(stored)) {
      if (/^[0-9a-f-]{36}$/.test(id) && typeof link === 'string' && placementAnswerLink(link.split('#')[1] || null) === link) {
        answerLinks.set(id, link);
      }
    }
  } catch {
    // Unreadable storage: links are made again as needed.
  }
}

function rememberAnswerLink(id: string, link: string): void {
  answerLinks.set(id, link);
  try {
    linkStorage()?.setItem(ANSWER_LINKS_STORAGE_KEY, JSON.stringify(Object.fromEntries(answerLinks)));
  } catch {
    // Full or blocked storage: the in-memory copy still serves this page.
  }
}
// Making a link must never hold up a text: past this, the message goes
// without one.
export const ANSWER_LINK_TIMEOUT_MS = 4000;

/**
 * The answer link for one program asked by hand (migration
 * 20261108130000), or null: offline, slow, an older server without the
 * migration, a closed request, or anything else. Never throws; the summary
 * is sent without a link instead.
 */
export async function fetchPlacementAnswerLink(recipientId: string, timeoutMs: number = ANSWER_LINK_TIMEOUT_MS): Promise<string | null> {
  const id = (recipientId || '').toLowerCase();
  if (!id) return null;
  loadStoredAnswerLinks();
  const cached = answerLinks.get(id);
  if (cached) return cached;
  const epoch = answerLinkEpoch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let call = answerLinkRequests[id];
    if (!call) {
      const pending: Promise<string | null> = (async () => {
        const { data, error } = await supabase.rpc('placement_answer_link', { p_recipient_id: id });
        const made = error ? null : placementAnswerLink(typeof data === 'string' ? data : null);
        if (made && epoch === answerLinkEpoch) rememberAnswerLink(id, made);
        return made;
      })().catch(() => null).finally(() => {
        if (answerLinkRequests[id] === pending) answerLinkRequests[id] = undefined;
      });
      answerLinkRequests[id] = pending;
      call = pending;
    }
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const link = await Promise.race([call, late]);
    // Signed out meanwhile: that account's link is not used.
    if (epoch !== answerLinkEpoch) return null;
    if (link) rememberAnswerLink(id, link);
    return link;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A link already made for this recipient, or null; never waits. */
export function cachedPlacementAnswerLink(recipientId: string): string | null {
  loadStoredAnswerLinks();
  return answerLinks.get((recipientId || '').toLowerCase()) || null;
}

/**
 * Make the links for programs asked by hand as soon as their row shows, so a
 * web tap never waits. It must not: Safari allows the clipboard and mail only
 * during the tap itself, so a send there uses only a link made ahead of time
 * (cachedPlacementAnswerLink). Call it only for rows that can be sent: each
 * link made is one more the server keeps for that program.
 */
export function prefetchPlacementAnswerLinks(recipientIds: string[]): void {
  loadStoredAnswerLinks();
  for (const recipientId of recipientIds) {
    const id = (recipientId || '').toLowerCase();
    if (id && !answerLinks.has(id) && !answerLinkRequests[id]) void fetchPlacementAnswerLink(id);
  }
}

/** Sign-out: links made for the previous account are dropped. */
export function clearPlacementAnswerLinks(): void {
  answerLinkEpoch += 1;
  answerLinks.clear();
  answerLinksLoaded = true;
  try {
    linkStorage()?.removeItem(ANSWER_LINKS_STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  for (const key of Object.keys(answerLinkRequests)) answerLinkRequests[key] = undefined;
}

/** A program's answer from a call or a text, logged by the practitioner. */
export async function logManualAnswer(recipientId: string, fields: AnswerFields): Promise<PlacementRecipient> {
  const { data, error, status } = await supabase.rpc('log_manual_response', {
    p_recipient_id: recipientId,
    p_bed_available: fields.bedAvailable,
    p_likely_accept: fields.likelyAccept,
    p_earliest_admit_on: fields.earliestAdmitOn,
    p_daily_rate: fields.dailyRate,
    p_cost_note: fields.costNote,
    p_note: fields.note,
  });
  if (error) throw placementFailure(error, status, 'Could not log the answer.');
  const recipient = recipientFromRow((Array.isArray(data) ? data[0] : data) as Record<string, unknown>);
  if (!recipient) throw new StoreError('Logged, but the answer could not be read back. Pull to refresh.', false);
  return recipient;
}

// ─── What this practitioner has already looked at (this phone only) ─────────

function seenKey(userId: string): string {
  return `referralfit.placementSeen.v1.${userId.toLowerCase().replace(/[^a-z0-9._-]/g, '')}`;
}

export async function loadPlacementSeen(userId: string): Promise<PlacementSeen> {
  if (!userId) return {};
  try {
    const raw = await AsyncStorage.getItem(seenKey(userId));
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const result: PlacementSeen = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

async function savePlacementSeen(userId: string, seen: PlacementSeen, keep: Set<string>): Promise<void> {
  if (!userId) return;
  // Only requests still on the list: the map never grows without bound.
  const pruned: PlacementSeen = {};
  for (const [key, value] of Object.entries(seen)) if (keep.has(key)) pruned[key] = value;
  try {
    await AsyncStorage.setItem(seenKey(userId), JSON.stringify(pruned));
  } catch {
    // Best effort: at worst an answer reads as new once more.
  }
}

// ─── The hook ───────────────────────────────────────────────────────────────

export type PlacementRequestsState = {
  // loading: the first read is on its way. ready: loaded (possibly stale
  // after a failed refresh). offline / error: never loaded. unavailable:
  // the server does not have the migration; every placement UI hides.
  status: 'loading' | 'ready' | 'offline' | 'error' | 'unavailable';
  requests: PlacementRequestView[];
  error: string;
};

const INITIAL: PlacementRequestsState = { status: 'loading', requests: [], error: '' };

export type PlacementRequestsHook = {
  state: PlacementRequestsState;
  seen: PlacementSeen;
  /**
   * Reads again; resolves to how it went (the comparison says "online only"
   * on 'offline'). `alsoId`: a request to keep in the list from now on, even
   * when it is older than the newest ones read.
   */
  reload: (alsoId?: string) => Promise<PlacementRequestsState['status'] | 'failed'>;
  /** A request changed by this practitioner (sent, answer logged, cancelled): shown at once. */
  replace: (view: PlacementRequestView) => void;
  /** The practitioner looked at this request's answers. */
  markSeen: (view: PlacementRequestView) => void;
  /** Its answers closed: later reads no longer fetch it by id. */
  releaseKept: () => void;
};

// The account and workspace a read belongs to: one workspace's requests
// never show for another, even when the next read fails.
export function placementScopeKey(userId: string | undefined, workspaceKey: string | number): string {
  return `${userId || ''}|${workspaceKey}`;
}

// `refreshKey` changes on every full refresh of the app (pull to refresh,
// foreground), so answers that arrived meanwhile show. `workspaceKey`
// changes when the account moves to another workspace (App's
// workspaceEpoch): the last workspace's requests are dropped at once.
export function usePlacementRequests(userId: string | undefined, refreshKey: number, workspaceKey: string | number = 0): PlacementRequestsHook {
  const scope = placementScopeKey(userId, workspaceKey);
  // The state remembers whose it is: another account's or workspace's reads
  // as "loading" until this one's arrive.
  const [held, setHeld] = useState<{ scope: string; state: PlacementRequestsState }>({ scope, state: INITIAL });
  const state = held.scope === scope ? held.state : INITIAL;
  const [seen, setSeen] = useState<PlacementSeen>({});
  const generationRef = useRef(0);
  const userRef = useRef(userId);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const stateRef = useRef(state);
  stateRef.current = state;
  const seenRef = useRef(seen);
  seenRef.current = seen;
  // The request whose answers were last opened: every later read keeps it,
  // so a refresh never drops it from under the open screen.
  const alsoIdRef = useRef<string | null>(null);

  const load = useCallback(async (alsoId?: string): Promise<PlacementRequestsState['status'] | 'failed'> => {
    const generation = ++generationRef.current;
    const readScope = scope;
    if (typeof alsoId === 'string' && alsoId) alsoIdRef.current = alsoId;
    if (!userId) {
      setHeld({ scope: readScope, state: INITIAL });
      return 'failed';
    }
    try {
      const read = await fetchPlacementRequests(alsoIdRef.current);
      if (generation !== generationRef.current || scopeRef.current !== readScope) return 'failed';
      const next: PlacementRequestsState = read.available
        ? { status: 'ready', requests: read.requests, error: '' }
        : { status: 'unavailable', requests: [], error: '' };
      setHeld({ scope: readScope, state: next });
      return next.status;
    } catch (error) {
      if (generation !== generationRef.current || scopeRef.current !== readScope) return 'failed';
      const offline = isServerUnreachable(error);
      // Keep what is on screen after a failed refresh of THIS workspace;
      // with nothing of its own loaded yet, say why (never the last
      // workspace's requests).
      setHeld((current) => (current.scope === readScope && current.state.status === 'ready'
        ? current
        : { scope: readScope, state: { status: offline ? 'offline' : 'error', requests: [], error: describeError(error) } }));
      return offline ? 'offline' : 'error';
    }
  }, [userId, scope]);

  // Another account's requests never show for this one.
  useEffect(() => {
    if (userRef.current !== userId) {
      userRef.current = userId;
      setSeen({});
    }
    if (!userId) return undefined;
    let active = true;
    void loadPlacementSeen(userId).then((value) => { if (active) setSeen(value); });
    return () => { active = false; };
  }, [userId]);

  // Another workspace keeps nothing of this one's (before its first read).
  useEffect(() => { alsoIdRef.current = null; }, [scope]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const replace = useCallback((view: PlacementRequestView) => {
    const into = scopeRef.current;
    setHeld((current) => {
      if (current.scope !== into || current.state.status !== 'ready') return { scope: into, state: { status: 'ready', requests: [view], error: '' } };
      const others = current.state.requests.filter((item) => item.request.id !== view.request.id);
      return { scope: into, state: { ...current.state, requests: [view, ...others].sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt)) } };
    });
  }, []);

  const markSeen = useCallback((view: PlacementRequestView) => {
    if (!userId) return;
    const next = { ...seenRef.current, [view.request.id]: seenMarker(view, new Date()) };
    seenRef.current = next;
    setSeen(next);
    const keep = new Set(stateRef.current.requests.map((item) => item.request.id));
    keep.add(view.request.id);
    void savePlacementSeen(userId, next, keep);
  }, [userId]);

  const releaseKept = useCallback(() => { alsoIdRef.current = null; }, []);

  return { state, seen, reload: load, replace, markSeen, releaseKept };
}
