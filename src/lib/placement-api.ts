import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { newUuid } from './cases';
import { OfflineError, StoreError, asOfflineError, describeError, errorCode, isServerUnreachable, withHttpStatus } from './errors';
import {
  RECIPIENT_COLUMNS,
  REQUEST_COLUMNS,
  isMissingPlacementSchema,
  recipientFromRow,
  requestFromRow,
  seenMarker,
  sortRecipients,
  viewFromJson,
  type AdmitWindow,
  type AnswerFields,
  type PlacementChannel,
  type PlacementRecipient,
  type PlacementRequestView,
  type PlacementSeen,
  type ResponseWindowHours,
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

// Every failure as a readable StoreError; one that never got an answer is an
// OfflineError (nothing was refused; a write may or may not have landed).
function placementFailure(error: unknown, status: number | undefined, fallback: string): StoreError {
  if (error instanceof StoreError) return error;
  const failure = withHttpStatus(error, status);
  const offline = asOfflineError(failure);
  if (offline instanceof OfflineError) return offline;
  const code = errorCode(error);
  const message = (error as { message?: unknown } | null)?.message;
  // The server's own plain words (22023 checks, P0002 not found, 42501).
  if ((code === '22023' || code === 'P0002' || code === '42501') && typeof message === 'string' && message) {
    return new StoreError(message, false);
  }
  return new StoreError(describeError(failure, fallback), false);
}

export type PlacementRequestsRead = { available: boolean; requests: PlacementRequestView[] };

/** The practice's newest requests with their programs (RLS: this workspace only). */
export async function fetchPlacementRequests(): Promise<PlacementRequestsRead> {
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
  });
  if (error) throw placementFailure(error, status, 'Could not send the placement request.');
  return viewOrThrow(data, 'Sent');
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
  /** Reads again; resolves to how it went (the comparison says "online only" on 'offline'). */
  reload: () => Promise<PlacementRequestsState['status'] | 'failed'>;
  /** A request changed by this practitioner (sent, answer logged, cancelled): shown at once. */
  replace: (view: PlacementRequestView) => void;
  /** The practitioner looked at this request's answers. */
  markSeen: (view: PlacementRequestView) => void;
};

// `refreshKey` changes on every full refresh of the app (pull to refresh,
// foreground, workspace change), so answers that arrived meanwhile show.
export function usePlacementRequests(userId: string | undefined, refreshKey: number): PlacementRequestsHook {
  const [state, setState] = useState<PlacementRequestsState>(INITIAL);
  const [seen, setSeen] = useState<PlacementSeen>({});
  const generationRef = useRef(0);
  const userRef = useRef(userId);
  const stateRef = useRef(state);
  stateRef.current = state;
  const seenRef = useRef(seen);
  seenRef.current = seen;

  const load = useCallback(async (): Promise<PlacementRequestsState['status'] | 'failed'> => {
    const generation = ++generationRef.current;
    if (!userId) {
      setState(INITIAL);
      return 'failed';
    }
    try {
      const read = await fetchPlacementRequests();
      if (generation !== generationRef.current) return 'failed';
      const next: PlacementRequestsState = read.available
        ? { status: 'ready', requests: read.requests, error: '' }
        : { status: 'unavailable', requests: [], error: '' };
      setState(next);
      return next.status;
    } catch (error) {
      if (generation !== generationRef.current) return 'failed';
      const offline = isServerUnreachable(error);
      // Keep what is on screen after a failed refresh; with nothing loaded
      // yet, say why.
      setState((current) => (current.status === 'ready'
        ? current
        : { status: offline ? 'offline' : 'error', requests: [], error: describeError(error) }));
      return offline ? 'offline' : 'error';
    }
  }, [userId]);

  // Another account's requests never show for this one.
  useEffect(() => {
    if (userRef.current !== userId) {
      userRef.current = userId;
      setState(INITIAL);
      setSeen({});
    }
    if (!userId) return undefined;
    let active = true;
    void loadPlacementSeen(userId).then((value) => { if (active) setSeen(value); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const replace = useCallback((view: PlacementRequestView) => {
    setState((current) => {
      if (current.status !== 'ready') return { status: 'ready', requests: [view], error: '' };
      const others = current.requests.filter((item) => item.request.id !== view.request.id);
      return { ...current, requests: [view, ...others].sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt)) };
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

  return { state, seen, reload: load, replace, markSeen };
}
