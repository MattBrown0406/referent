import { useCallback, useEffect, useRef, useState } from 'react';

import { newUuid } from './cases';
import { OfflineError, StoreError, asOfflineError, describeError, errorCode, isServerUnreachable, withHttpStatus } from './errors';
import {
  ASSESSMENT_COLUMNS,
  assessmentFromRow,
  currentAssessment,
  isMissingAssessmentSchema,
  sortAssessments,
  type AssessmentInput,
  type CaseAssessment,
} from './level-of-care';
import { supabase } from './supabase';

// ─── Level-of-care assessment: the server side ──────────────────────────────
// Migration 20261104150000_level_of_care.sql. The rules are in
// level-of-care.ts.
//
// Online only. Reads are not part of the case file's offline copy (neither
// are benefits): offline, the card says the assessment loads when you're
// online. The write is one RPC that throws OfflineError (errors.ts) when the
// server could not be reached; the sheet keeps its answers and its id, so
// "Try again" after a timeout never saves twice.
//
// Against a server without the migration (PGRST202 / PGRST205 / 42P01 /
// 42703 / 42883) the read reports available: false and the app hides the
// whole feature, as it does for the features before it.
//
// Nothing here writes to matching or to placement requests.

// Typed as '*' for supabase-js (no generated schema types): the explicit
// column list assessmentFromRow reads.
const SELECT = ASSESSMENT_COLUMNS.join(', ') as '*';
// The newest assessments of one case: the current one and its history.
const HISTORY_LIMIT = 20;

function isMissing(error: unknown): boolean {
  return isMissingAssessmentSchema(errorCode(error));
}

// Every failure as a readable StoreError; one that never got an answer is an
// OfflineError (nothing was refused; the save may or may not have landed).
function assessmentFailure(error: unknown, status: number | undefined, fallback: string): StoreError {
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
  if (isMissing(error)) return new StoreError('Level-of-care assessments need a server update that has not been applied yet.', false);
  return new StoreError(describeError(failure, fallback), false);
}

export type CaseAssessmentsRead = { available: boolean; assessments: CaseAssessment[] };

/** One case's assessments, newest first (RLS: this workspace only). */
export async function fetchCaseAssessments(caseId: string): Promise<CaseAssessmentsRead> {
  try {
    const { data, error, status } = await supabase
      .from('case_assessments')
      .select(SELECT)
      .eq('case_id', caseId)
      .order('assessed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) {
      if (isMissing(error)) return { available: false, assessments: [] };
      throw assessmentFailure(error, status, 'Could not load the level-of-care assessment.');
    }
    const rows = Array.isArray(data) ? data : [];
    const assessments = rows
      .map((row) => assessmentFromRow(row as Record<string, unknown>))
      .filter((item): item is CaseAssessment => Boolean(item));
    return { available: true, assessments: sortAssessments(assessments) };
  } catch (error) {
    if (isMissing(error)) return { available: false, assessments: [] };
    throw assessmentFailure(error, undefined, 'Could not load the level-of-care assessment.');
  }
}

export function newAssessmentId(): string {
  return newUuid();
}

export type SavedAssessment = { assessment: CaseAssessment; eventBody: string };

/** Save one assessment. The server checks the ratings, the recommendation and the reason, and writes the timeline entry. */
export async function saveCaseAssessment(id: string, caseId: string, input: AssessmentInput): Promise<SavedAssessment> {
  const { data, error, status } = await supabase.rpc('save_case_assessment', {
    p_id: id,
    p_case_id: caseId,
    p_ratings: input.ratings,
    p_notes: input.notes,
    p_imminent_danger: input.imminentDanger,
    p_rules_version: input.rulesVersion,
    p_recommended_level: input.recommendedLevel,
    p_recommended_first_step: input.recommendedFirstStep,
    p_recommended_support: input.recommendedSupport,
    p_chosen_level: input.chosenLevel,
    p_override_reason: input.overrideReason,
  });
  if (error) throw assessmentFailure(error, status, 'Could not save the assessment.');
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const assessment = assessmentFromRow(row);
  if (!assessment || typeof row?.event_body !== 'string') {
    throw new StoreError('Saved, but the assessment could not be read back. Pull to refresh the case.', false);
  }
  return { assessment, eventBody: row.event_body };
}

// ─── The hook: assessments per case, for the case file and the match ────────

export type CaseAssessmentsEntry = {
  // loading: the first read is on its way. ready: loaded (possibly stale
  // after a failed refresh). offline / error: never loaded. unavailable: the
  // server does not have the migration; every assessment UI hides.
  status: 'loading' | 'ready' | 'offline' | 'error' | 'unavailable';
  assessments: CaseAssessment[];
  error: string;
};

export type CaseAssessmentsHook = {
  /** null until a read has answered; false on a server without the migration. */
  available: boolean | null;
  entryFor: (caseId: string | null | undefined) => CaseAssessmentsEntry | undefined;
  /** The current (newest) assessment, once loaded. */
  currentFor: (caseId: string | null | undefined) => CaseAssessment | null;
  /** Reads one case again. */
  load: (caseId: string) => Promise<void>;
  /** An assessment this practitioner just saved: shown at once. */
  saved: (assessment: CaseAssessment) => void;
};

const LOADING: CaseAssessmentsEntry = { status: 'loading', assessments: [], error: '' };

// `refreshKey` changes on every full refresh of the app (pull to refresh,
// foreground); `workspaceKey` when the account moves to another workspace
// (App's workspaceEpoch), which drops every assessment read for the last
// one. `watched` are the cases on screen (the open case file, the match's
// case). Each is read when it appears and on every refresh; any other case
// only when load() asks.
export function useCaseAssessments(userId: string | undefined, refreshKey: number, watched: (string | null | undefined)[], workspaceKey: string | number = 0): CaseAssessmentsHook {
  const scope = `${userId || ''}|${workspaceKey}`;
  const [held, setHeld] = useState<{ scope: string; entries: Record<string, CaseAssessmentsEntry>; available: boolean | null }>({ scope, entries: {}, available: null });
  // Another account's or workspace's assessments never show for this one.
  const entries = held.scope === scope ? held.entries : {};
  const available = held.scope === scope ? held.available : null;
  const generationRef = useRef<Record<string, number>>({});
  const scopeRef = useRef(scope);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    generationRef.current = {};
  }

  // Updates for this account and workspace only; anything else starts empty.
  const setEntries = useCallback((into: string, update: (current: Record<string, CaseAssessmentsEntry>) => Record<string, CaseAssessmentsEntry>, nextAvailable?: boolean) => {
    setHeld((current) => {
      const base = current.scope === into ? current : { scope: into, entries: {}, available: null };
      return { scope: into, entries: update(base.entries), available: nextAvailable ?? base.available };
    });
  }, []);

  const load = useCallback(async (caseId: string): Promise<void> => {
    if (!userId || !caseId) return;
    const key = caseId.toLowerCase();
    const into = scope;
    const generation = (generationRef.current[key] || 0) + 1;
    generationRef.current[key] = generation;
    const stillCurrent = () => scopeRef.current === into && generationRef.current[key] === generation;
    if (!entriesRef.current[key]) setEntries(into, (current) => (current[key] ? current : { ...current, [key]: LOADING }));
    try {
      const read = await fetchCaseAssessments(key);
      if (!stillCurrent()) return;
      setEntries(into, (current) => ({
        ...current,
        [key]: read.available ? { status: 'ready', assessments: read.assessments, error: '' } : { status: 'unavailable', assessments: [], error: '' },
      }), read.available);
    } catch (error) {
      if (!stillCurrent()) return;
      const offline = isServerUnreachable(error);
      // Keep what is on screen after a failed refresh; with nothing loaded
      // yet, say why.
      setEntries(into, (current) => (current[key]?.status === 'ready'
        ? current
        : { ...current, [key]: { status: offline ? 'offline' : 'error', assessments: [], error: describeError(error) } }));
    }
  }, [userId, scope, setEntries]);

  const watchedKey = watched.filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase()).join(',');
  useEffect(() => {
    if (!watchedKey) return;
    for (const caseId of watchedKey.split(',')) void load(caseId);
  }, [load, refreshKey, watchedKey]);

  const saved = useCallback((assessment: CaseAssessment) => {
    const key = assessment.caseId.toLowerCase();
    // A read already on its way began before this save: ignore it.
    generationRef.current[key] = (generationRef.current[key] || 0) + 1;
    setEntries(scopeRef.current, (current) => {
      const previous = current[key]?.status === 'ready' ? current[key].assessments : [];
      return {
        ...current,
        [key]: { status: 'ready', assessments: sortAssessments([assessment, ...previous.filter((item) => item.id !== assessment.id)]), error: '' },
      };
    }, true);
  }, [setEntries]);

  const entryFor = useCallback((caseId: string | null | undefined) => (caseId ? entries[caseId.toLowerCase()] : undefined), [entries]);
  const currentFor = useCallback((caseId: string | null | undefined) => {
    const entry = caseId ? entries[caseId.toLowerCase()] : undefined;
    return entry?.status === 'ready' ? currentAssessment(entry.assessments) : null;
  }, [entries]);

  return { available, entryFor, currentFor, load, saved };
}
