// Day review: paste notes from the day (a recorder's summary from Fieldy or
// Plaud, call notes), and ReferralFit lists what belongs in it: new leads,
// case and partner notes, follow-ups, referrals, new partners. Each row is
// matched to a case or partner on this phone; nothing is saved until the
// practitioner taps Approve. Uses the practitioner's own Anthropic key, like
// AI drafts. docs/DAY_REVIEW.md.
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Partner, Referral } from '../data';
import { newUuid, type CaseContact, type CaseRecord } from './cases';
import {
  addDays,
  buildRows,
  caseLabel,
  choosePartner,
  chooseCase,
  comparable,
  countLine,
  destination,
  KIND_LABEL,
  kindChoices,
  leadFor,
  markSavedBefore,
  rowProblem,
  rowReady,
  rowSignatures,
  savedBefore,
  saveOrder,
  signatureHash,
  switchKind,
  withPendingLeads,
  type ReviewRow,
  type RowContext,
  type Workspace,
} from './day-review';
import { requestDayReview, ReviewUnavailableError, saveReviewRow, type SaveResult } from './day-review-api';
import { fetchGlobalDirectory } from './directory';
import { blocksFor, RECORDERS, type FieldyBlock, type Recorder, type RecorderId } from './fieldy';
import {
  connectRecorder,
  disconnectRecorder,
  FieldyError,
  fieldySupported,
  markRecordingsReviewed,
  readNewRecordings,
  recorderStatus,
  rememberSaved,
  savedFrom,
} from './fieldy-api';
import { licenseConcernAlert, licenseOverrideNote, type LicenseConcern } from './integrity';
import { aiKeysSupported, getAnthropicKey } from './outreach-api';
import { directoryIndex, IMPORT_TYPES, type DirectoryIndex, type ImportType } from './partner-import';
import type { FollowUp } from './store';
import { WEB_PAGE } from './web-layout';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#B4513A',
  coralPale: '#F7E7E1',
  coralText: '#8E3B28',
  blue: '#2F5D8A',
  bluePale: '#EAF1F8',
  gray: '#73827D',
  // Small print on white or cream: darker than gray, for contrast.
  muted: '#55645F',
  line: '#DDE4DF',
};

type Props = {
  visible: boolean;
  userId: string;
  cases: CaseRecord[];
  contacts: CaseContact[];
  partners: Partner[];
  followUps: FollowUp[];
  referrals: Referral[];
  /** The workspace reads the Directory (new partners are matched to it). */
  directoryEntitled: boolean;
  /** The practice's lead response target, for a new lead's first call (as the New lead form). */
  leadResponseMinutes: number;
  /** A program's license problem, if any (App.tsx licenseConcernFor), checked before a referral is saved. */
  licenseConcernFor: (partnerId: string) => LicenseConcern | null;
  onClose: () => void;
  /** Something was saved: the app reloads. */
  onSaved: () => void;
  /** Opened from "From your day" (the Today card or the evening reminder): read this recorder at once. */
  startWithRecorder?: RecorderId | null;
  /** A recorder was read, connected or disconnected: the Today card counts again. */
  onRecordersChanged?: () => void;
};

type Phase = 'paste' | 'finding' | 'review' | 'saving' | 'done';

type RecorderState = { state: 'checking' | 'off' | 'on' | 'busy' | 'leaving'; email: string };
const RECORDERS_CHECKING: Record<RecorderId, RecorderState> = { fieldy: { state: 'checking', email: '' }, plaud: { state: 'checking', email: '' } };

function localDay(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A new lead's first call is due within the practice's response target,
// today; past midnight it is due today with no time (as the New lead form).
function leadDueTime(minutes: number, now = new Date()): string | null {
  const due = new Date(now.getTime() + Math.max(0, minutes) * 60000);
  if (due.getDate() !== now.getDate()) return null;
  return `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
}

const SWITCH_LABEL: Partial<Record<ReviewRow['kind'], string>> = {
  new_lead: 'New lead',
  case_note: 'Note on a case',
  new_partner: 'New partner',
  partner_note: 'Note on a partner',
};

export default function DayReviewSheet({
  visible, userId, cases, contacts, partners, followUps, referrals, directoryEntitled, leadResponseMinutes, licenseConcernFor, onClose, onSaved,
  startWithRecorder = null, onRecordersChanged,
}: Props) {
  const [phase, setPhase] = useState<Phase>('paste');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [today, setToday] = useState(localDay());
  const [keyState, setKeyState] = useState<'checking' | 'ready' | 'missing'>('checking');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<Record<string, SaveResult>>({});
  const [picker, setPicker] = useState<{ key: string; what: 'case' | 'partner'; query: string } | null>(null);
  const [index, setIndex] = useState<DirectoryIndex | null>(null);
  // Bumped on every open and close: a review or save finishing afterwards changes nothing.
  const openingRef = useRef(0);
  // Set synchronously, so a second tap on Approve cannot start a second save.
  const savingRef = useRef(false);
  // What this opening has saved, so reading the same notes again does not offer it twice.
  const savedSignaturesRef = useRef<Set<string>>(new Set());
  const savedCountRef = useRef(0);
  // Each recorder (Fieldy, Plaud): connected or not; and the recordings this
  // review was read from (committed as read once something from them is
  // saved, or nothing was found).
  const [recorders, setRecorders] = useState<Record<RecorderId, RecorderState>>(RECORDERS_CHECKING);
  // The recordings this review was read from, which recording each row came
  // from, and those skipped for having no text.
  const recorderReadRef = useRef<{ recorder: Recorder; text: string; blocks: FieldyBlock[]; rowIds: Map<string, string[]>; skipped: string[] } | null>(null);
  // Rows the practitioner switched off: set aside (one off from the start, unchecked, is not).
  const switchedOffRef = useRef<Set<string>>(new Set());
  const setRecorder = (id: RecorderId, value: RecorderState | ((current: RecorderState) => RecorderState)) =>
    setRecorders((current) => ({ ...current, [id]: typeof value === 'function' ? value(current[id]) : value }));

  const workspace: Workspace = useMemo(() => ({
    cases, contacts, partners, followUps, referrals, directory: index,
  }), [cases, contacts, partners, followUps, referrals, index]);
  // The review is built after the network call: from the workspace as it is
  // then, not as it was when Find was tapped.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  function clearReview() {
    setPhase('paste');
    setNotes('');
    setRows([]);
    setSaved({});
    setPicker(null);
    setMessage(null);
    savedSignaturesRef.current = new Set();
    savedCountRef.current = 0;
    savingRef.current = false;
    recorderReadRef.current = null;
    switchedOffRef.current = new Set();
  }

  // A fresh sheet each time it opens, and for each account; nothing from a
  // closed review is kept in memory.
  useEffect(() => {
    openingRef.current += 1;
    clearReview();
    if (!visible) return;
    setToday(localDay());
    setKeyState('checking');
    const opening = openingRef.current;
    setRecorders(RECORDERS_CHECKING);
    void Promise.all([getAnthropicKey(userId), ...RECORDERS.map((recorder) => recorderStatus(recorder, userId))]).then(([key, ...statuses]) => {
      if (opening !== openingRef.current) return;
      setKeyState(key ? 'ready' : 'missing');
      const next = { ...RECORDERS_CHECKING };
      RECORDERS.forEach((recorder, index) => {
        const status = statuses[index] as { connected: boolean; email: string };
        next[recorder.id] = { state: status.connected ? 'on' : 'off', email: status.email };
      });
      setRecorders(next);
      // Opened from the Today card or the reminder: the recorder named, else
      // another one connected (the counts may not be in yet at launch), and
      // when the first has nothing new, the other.
      if (!startWithRecorder || !key) return;
      const connected = RECORDERS.filter((recorder) => next[recorder.id].state === 'on');
      const [first, ...rest] = [...connected.filter((recorder) => recorder.id === startWithRecorder), ...connected.filter((recorder) => recorder.id !== startWithRecorder)];
      if (first) void readRecorder(first, opening, rest[0]);
    });
    // readRecorder is this opening's own; startWithRecorder is read once, as the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, userId]);

  // The Directory, once per opening, so a new partner can be matched to it.
  useEffect(() => {
    if (!visible || !directoryEntitled) { setIndex(null); return; }
    let live = true;
    fetchGlobalDirectory()
      .then((listings) => { if (live) setIndex(directoryIndex(listings)); })
      .catch(() => { if (live) setIndex(null); });
    return () => { live = false; };
  }, [visible, directoryEntitled, userId]);

  // The workspace with this review's new leads in it: a follow-up about a
  // caller who is new today can go on the case the lead will create.
  const view = useMemo(() => withPendingLeads(workspace, rows), [workspace, rows]);
  const context: RowContext = { rows, licenseConcern: (partnerId) => Boolean(licenseConcernFor(partnerId)) };
  const isSaved = (row: ReviewRow) => saved[row.key]?.saved === true;
  const pending = rows.filter((row) => !isSaved(row));
  const ready = pending.filter((row) => rowReady(row, context));
  const waiting = pending.filter((row) => row.include && !rowReady(row, context)).length;
  const busy = phase === 'finding' || phase === 'saving';
  const locked = phase === 'saving' || phase === 'done';

  // A recording is done once every item from it is decided: saved; switched
  // off by the practitioner; or off for a reason the app gave (already a
  // follow-up, already in the referral history, saved earlier in this
  // review). An item off only because it could not be checked against the
  // notes, never looked at, is not decided: closing asks about it. An item
  // still on and unsaved whose quote is in no one recording could be from
  // any: until it is decided, none is done (one off and unchecked, tied to
  // no recording, holds none).
  function rowDecided(row: ReviewRow, results: Record<string, SaveResult>): boolean {
    if (results[row.key]?.saved === true) return true;
    if (row.include) return false;
    return switchedOffRef.current.has(row.key) || row.found.verified || savedBefore(row, savedSignaturesRef.current);
  }

  // An item still undecided that matches no one recording: closing asks, and "read again" holds them all.
  function unmatchedUndecided(results: Record<string, SaveResult>, current: ReviewRow[]): boolean {
    const read = recorderReadRef.current;
    return Boolean(read) && current.some((row) => !(read!.rowIds.get(row.key)?.length) && !rowDecided(row, results));
  }

  function recordingsDone(results: Record<string, SaveResult>, current: ReviewRow[]): string[] {
    const read = recorderReadRef.current;
    if (!read) return [];
    const matched = (row: ReviewRow) => Boolean(read.rowIds.get(row.key)?.length);
    if (current.some((row) => !matched(row) && row.include && !rowDecided(row, results))) return [];
    return read.blocks.map((block) => block.id)
      .filter((id) => current.filter((row) => (read.rowIds.get(row.key) ?? []).includes(id)).every((row) => rowDecided(row, results)));
  }

  function settleRecordings(results: Record<string, SaveResult>, current: ReviewRow[]) {
    const read = recorderReadRef.current;
    if (!read || !current.length) return;
    const done = recordingsDone(results, current);
    if (done.length) void markRecordingsReviewed(read.recorder, userId, done).then(() => onRecordersChanged?.());
  }

  function finish(hold = false) {
    if (!hold && phase !== 'finding' && phase !== 'saving') settleRecordings(saved, rows);
    openingRef.current += 1;
    clearReview();
    onClose();
  }

  function close() {
    if (phase === 'saving') return;
    // A read or a review can be stopped (what comes back late is ignored);
    // notes the practitioner typed or pasted are not thrown away without asking.
    const recorderText = Boolean(recorderReadRef.current) && notes.trim() === recorderReadRef.current?.text.trim();
    if (phase === 'finding' && (!notes.trim() || recorderText)) { finish(); return; }
    const unsaved = phase === 'review'
      ? pending.some((row) => row.include)
      : (phase === 'paste' || phase === 'finding') && notes.trim().length > 0;
    const read = recorderReadRef.current;
    // Recordings with items not decided on (off from the start, never
    // looked at): read again next time, or done with, as the practitioner says.
    // An undecided item tied to no one recording could be from any: all of them are in question.
    const holdAll = Boolean(read && rows.length) && unmatchedUndecided(saved, rows);
    const undecided = read && rows.length ? (holdAll ? read.blocks.length : read.blocks.length - recordingsDone(saved, rows).length) : 0;
    if (!unsaved && read && undecided > 0) {
      const noun = undecided === 1 ? read.recorder.noun : `${read.recorder.noun}s`;
      Alert.alert(`Read ${undecided === 1 ? 'this' : 'these'} ${read.recorder.name} ${noun} again?`,
        `${undecided} ${noun} ${undecided === 1 ? 'has items' : 'have items'} you did not save or switch off. ReferralFit can read ${undecided === 1 ? 'it' : 'them'} again next time, or leave ${undecided === 1 ? 'it' : 'them'}.`, [
          // Once everything is saved the rows are locked: nothing to go back to.
          ...(phase === 'done' ? [] : [{ text: 'Keep reviewing', style: 'cancel' as const }]),
          { text: 'Read again next time', onPress: () => finish(holdAll) },
          {
            text: `Done with ${undecided === 1 ? 'it' : 'them'}`,
            onPress: () => {
              void markRecordingsReviewed(read.recorder, userId, read.blocks.map((block) => block.id)).then(() => onRecordersChanged?.());
              finish();
            },
          },
        ]);
      return;
    }
    if (!unsaved) { finish(); return; }
    const kept = savedCountRef.current;
    const again = read ? ` Your ${read.recorder.name} ${read.recorder.noun}s with items not saved or switched off will be read again next time.` : '';
    Alert.alert(
      'Discard this review?',
      (kept
        ? `${kept} ${kept === 1 ? 'item you approved stays' : 'items you approved stay'} saved. Nothing else from these notes is saved.`
        : 'Nothing from these notes has been saved yet.') + again,
      [
        { text: 'Keep reviewing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => finish() },
      ],
    );
  }

  async function pasteFromClipboard() {
    try {
      const text = await Clipboard.getStringAsync();
      if (text.trim()) setNotes((current) => (current.trim() ? `${current.trim()}\n\n${text.trim()}` : text.trim()));
      else setMessage({ ok: false, text: 'Nothing to paste. Copy the summary in Fieldy or Plaud first.' });
    } catch {
      setMessage({ ok: false, text: 'Could not read what you copied. Long-press the box and choose Paste.' });
    }
  }

  async function find(read: { recorder: Recorder; text: string; blocks: FieldyBlock[]; skipped?: string[] } | null = null) {
    if (busy && !read) return;
    // "Back to the notes", then Find again on the same recorder text: still that recorder's recordings.
    const same = recorderReadRef.current && notes.trim() === recorderReadRef.current.text.trim() ? recorderReadRef.current : null;
    const fromRecorder = read ?? (same ? { recorder: same.recorder, text: same.text, blocks: same.blocks, skipped: same.skipped } : null);
    const text = (fromRecorder ? fromRecorder.text : notes).trim();
    // Kept before the review runs, so a retry after a failed one is still these recordings.
    recorderReadRef.current = fromRecorder
      ? { recorder: fromRecorder.recorder, text: fromRecorder.text, blocks: fromRecorder.blocks, rowIds: new Map(), skipped: fromRecorder.skipped ?? [] }
      : null;
    if (text.length < 20) { setMessage({ ok: false, text: 'Paste a little more: there is not enough here to review.' }); return; }
    const opening = openingRef.current;
    const day = localDay();
    setToday(day);
    setMessage(null);
    setPhase('finding');
    try {
      const key = await getAnthropicKey(userId);
      if (!key) {
        if (opening === openingRef.current) { setKeyState('missing'); setPhase('paste'); }
        return;
      }
      const { items } = await requestDayReview(text, day, key);
      if (opening !== openingRef.current) return;
      const blocks = fromRecorder?.blocks ?? null;
      // Items saved from these recordings in an earlier review are known again.
      if (fromRecorder) {
        const before = await savedFrom(fromRecorder.recorder, userId, fromRecorder.blocks.map((block) => block.id)).catch(() => [] as string[]);
        if (opening !== openingRef.current) return;
        for (const fingerprint of before) savedSignaturesRef.current.add(fingerprint);
      }
      const built = markSavedBefore(
        buildRows(items, workspaceRef.current, day, newUuid, blocks ? (found) => {
          const from = blocksFor(found.evidence, blocks);
          return from.length === 1 ? { label: from[0].label, at: from[0].startTime } : null;
        } : undefined),
        savedSignaturesRef.current,
      );
      setRows(built);
      // Rows are keyed by position: what was switched off in an earlier review is not this one's.
      switchedOffRef.current = new Set();
      setSaved({});
      setPicker(null);
      setPhase('review');
      if (fromRecorder) {
        const rowIds = new Map(built.map((row) => [row.key, blocksFor(row.found.evidence, fromRecorder.blocks).map((block) => block.id)]));
        const skipped = fromRecorder.skipped ?? [];
        recorderReadRef.current = { recorder: fromRecorder.recorder, text: fromRecorder.text, blocks: fromRecorder.blocks, rowIds, skipped };
        // A recording nothing was found in is done now (unless an item's
        // quote is in none of them: it could be from any); so is one with no
        // text a day after it ended.
        const withRows = new Set([...rowIds.values()].flat());
        const unmatched = [...rowIds.values()].some((ids) => !ids.length);
        const done = (unmatched ? [] : fromRecorder.blocks.map((block) => block.id).filter((id) => !withRows.has(id))).concat(skipped);
        if (done.length) void markRecordingsReviewed(fromRecorder.recorder, userId, done).then(() => onRecordersChanged?.());
      }
      if (!items.length) {
        setMessage({
          ok: true,
          text: fromRecorder
            ? `Nothing in your new ${fromRecorder.recorder.name} ${fromRecorder.recorder.noun}s needs to go into ReferralFit.`
            : 'Nothing in these notes needs to go into ReferralFit.',
        });
      } else if (read?.skipped?.length) {
        setMessage({ ok: true, text: `${read.skipped.length} ${read.skipped.length === 1 ? read.recorder.noun : `${read.recorder.noun}s`} had no summary or transcript a day after ${read.skipped.length === 1 ? 'it' : 'they'} ended and ${read.skipped.length === 1 ? 'was' : 'were'} skipped.` });
      }
    } catch (error) {
      if (opening !== openingRef.current) return;
      if (error instanceof ReviewUnavailableError && error.reason === 'key') setKeyState('missing');
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Review is unavailable right now.' });
      setPhase('paste');
    }
  }

  // ─── Recorders (Fieldy, Plaud) ───────────────────────────────────────────

  async function connect(recorder: Recorder) {
    if (busy || recorders[recorder.id].state === 'busy') return;
    const opening = openingRef.current;
    setRecorder(recorder.id, (current) => ({ ...current, state: 'busy' }));
    setMessage(null);
    try {
      const status = await connectRecorder(recorder, userId);
      if (opening !== openingRef.current) return;
      setRecorder(recorder.id, { state: 'on', email: status.email });
      onRecordersChanged?.();
      setMessage({ ok: true, text: status.email ? `${recorder.name} is connected (${status.email}).` : `${recorder.name} is connected.` });
    } catch (error) {
      if (opening !== openingRef.current) return;
      setRecorder(recorder.id, { state: 'off', email: '' });
      if (!(error instanceof FieldyError && error.reason === 'cancelled')) {
        setMessage({ ok: false, text: error instanceof Error ? error.message : `${recorder.name} could not connect right now.` });
      }
    }
  }

  function disconnect(recorder: Recorder) {
    if (busy || recorders[recorder.id].state !== 'on') return;
    Alert.alert(`Disconnect ${recorder.name}?`, `ReferralFit stops reading your ${recorder.name} ${recorder.noun}s, and its access is removed at ${recorder.name}. Nothing already saved in ReferralFit changes.`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          setRecorder(recorder.id, (current) => ({ ...current, state: 'leaving' }));
          void disconnectRecorder(recorder, userId).finally(() => {
            setRecorder(recorder.id, { state: 'off', email: '' });
            onRecordersChanged?.();
          });
        },
      },
    ]);
  }

  /** The recordings since the last read, straight into the review. */
  async function readRecorder(recorder: Recorder, opening = openingRef.current, otherwise?: Recorder) {
    if (savingRef.current) return;
    setMessage(null);
    setPhase('finding');
    let read;
    try {
      read = await readNewRecordings(recorder, userId);
    } catch (error) {
      if (opening !== openingRef.current) return;
      setPhase('paste');
      if (error instanceof FieldyError && error.reason === 'disconnected') setRecorder(recorder.id, { state: 'off', email: '' });
      setMessage({ ok: false, text: error instanceof Error ? error.message : `${recorder.name} could not be read right now.` });
      return;
    }
    if (opening !== openingRef.current) return;
    if (!read.blocks.length) {
      setPhase('paste');
      if (read.skipped.length) void markRecordingsReviewed(recorder, userId, read.skipped).then(() => onRecordersChanged?.());
      if (otherwise && !read.later) { await readRecorder(otherwise, opening); return; }
      setMessage({
        ok: true,
        text: read.later
          ? `${recorder.name} is still writing the summary of your latest ${recorder.noun}. Try again in a little while.`
          : read.skipped.length
            ? `${read.skipped.length} ${recorder.noun}${read.skipped.length === 1 ? '' : 's'} had no summary or transcript a day after ending and ${read.skipped.length === 1 ? 'was' : 'were'} skipped. Nothing else is new.`
            : `No new ${recorder.name} ${recorder.noun}s since the last review.`,
      });
      return;
    }
    setNotes(read.text);
    await find({ recorder, text: read.text, blocks: read.blocks, skipped: read.skipped });
    if (opening === openingRef.current && read.later) {
      setMessage((current) => current ?? { ok: true, text: `${read.later} more ${read.later === 1 ? `${recorder.noun} waits` : `${recorder.noun}s wait`} for the next review.` });
    }
  }

  // Reading puts the recordings in the box: notes typed or pasted there are not replaced without asking.
  function readRecorderAsking(recorder: Recorder) {
    const typed = notes.trim() && notes.trim() !== recorderReadRef.current?.text.trim();
    if (!typed) { void readRecorder(recorder); return; }
    Alert.alert(`Read your ${recorder.name} ${recorder.noun}s instead?`, `Your ${recorder.noun}s replace the notes in the box. Review those notes first if you want to keep them.`, [
      { text: 'Keep my notes', style: 'cancel' },
      { text: `Read ${recorder.name}`, onPress: () => { void readRecorder(recorder); } },
    ]);
  }

  // The practitioner is done with these recordings (nothing to save, or the
  // review could not be read): they are not read again.
  function markAllReviewed() {
    const read = recorderReadRef.current;
    if (!read || busy) return;
    const { recorder, blocks } = read;
    Alert.alert(`Done with these ${recorder.noun}s?`, `ReferralFit will not read these ${blocks.length} ${recorder.name} ${blocks.length === 1 ? recorder.noun : `${recorder.noun}s`} again. Anything you have not saved from them is not saved.`, [
      { text: 'Keep reviewing', style: 'cancel' },
      {
        text: 'Done with them',
        onPress: () => {
          void markRecordingsReviewed(recorder, userId, blocks.map((block) => block.id)).then(() => onRecordersChanged?.());
          finish();
        },
      },
    ]);
  }

  // An edit to a row clears the reason its last save failed.
  function updateRow(key: string, change: (row: ReviewRow) => ReviewRow) {
    if (locked) return;
    setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));
    setSaved((current) => {
      if (!current[key] || current[key].saved) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function patch(key: string, change: Partial<ReviewRow>) {
    updateRow(key, (row) => ({ ...row, ...change }));
  }

  function partnerLabel(id: string): string {
    const partner = partners.find((item) => item.id === id);
    return partner ? partner.organization || partner.name : 'A partner';
  }

  function licenseNoteFor(row: ReviewRow): string {
    if (row.kind !== 'referral' || row.direction !== 'sent' || !row.partnerId) return '';
    const concern = licenseConcernFor(row.partnerId);
    return concern ? licenseOverrideNote(partnerLabel(row.partnerId), concern, 'refer') : '';
  }

  async function approve() {
    if (savingRef.current || busy || !ready.length) return;
    savingRef.current = true;
    const opening = openingRef.current;
    setPhase('saving');
    setMessage(null);
    const results: Record<string, SaveResult> = { ...saved };
    const order = saveOrder(ready);
    const dueTime = leadDueTime(leadResponseMinutes);
    let any = false;
    const fromRecordings: Record<string, string[]> = {};
    try {
      // One at a time: new leads first, then what may go on their cases.
      for (const row of order) {
        const lead = leadFor(row, rows);
        if (lead && !results[lead.key]?.saved) {
          results[row.key] = { saved: false, message: 'This saves once the new lead above is saved.' };
          continue;
        }
        const result = await saveReviewRow(row, userId, { today, leadDueTime: dueTime, licenseNote: licenseNoteFor(row) });
        results[row.key] = result;
        if (result.saved) {
          any = true;
          savedCountRef.current += 1;
          const signatures = rowSignatures(row, true);
          for (const signature of signatures) savedSignaturesRef.current.add(signature);
          // Kept with each recording it came from, for when that recording is read again.
          for (const id of recorderReadRef.current?.rowIds.get(row.key) ?? []) {
            fromRecordings[id] = [...(fromRecordings[id] ?? []), ...signatures.map(signatureHash)];
          }
        }
        if (opening !== openingRef.current) break;
      }
    } finally {
      savingRef.current = false;
    }
    if (any) onSaved();
    if (recorderReadRef.current) void rememberSaved(recorderReadRef.current.recorder, userId, fromRecordings).catch(() => undefined);
    settleRecordings(results, rows);
    if (opening !== openingRef.current) return;
    setSaved(results);
    const failed = order.filter((row) => !results[row.key]?.saved);
    const savedKinds = order.filter((row) => results[row.key]?.saved).map((row) => row.kind);
    const notesToAct = order.filter((row) => results[row.key]?.saved && results[row.key].message).length;
    const extra = notesToAct ? ` ${notesToAct} ${notesToAct === 1 ? 'needs' : 'need'} a step by hand; see the row.` : '';
    if (failed.length) {
      setPhase('review');
      setMessage({ ok: false, text: `${failed.length} could not be saved; see the rows. Saved: ${countLine(savedKinds)}${extra}` });
    } else if (rows.some((row) => !results[row.key]?.saved && row.include)) {
      setPhase('review');
      setMessage({ ok: true, text: `Saved: ${countLine(savedKinds)} The rest still need a choice.${extra}` });
    } else {
      setPhase('done');
      setMessage({ ok: true, text: `Saved: ${countLine(savedKinds)}${extra}` });
    }
  }

  // ─── Rows ───────────────────────────────────────────────────────────────

  function renderChoices(row: ReviewRow, what: 'case' | 'partner') {
    const ids = what === 'case' ? row.caseChoices : row.partnerChoices;
    const chosen = what === 'case' ? row.caseId : row.partnerId;
    const unsure = what === 'case' ? row.caseUnsure : row.partnerUnsure;
    const open = picker?.key === row.key && picker.what === what;
    const query = open ? comparable(picker!.query) : '';
    const searched = open && query
      ? (what === 'case'
        ? view.cases.filter((record) => record.id !== row.ids.caseId && comparable(record.title).includes(query)).map((record) => record.id)
        : partners.filter((partner) => comparable(`${partner.organization} ${partner.name}`).includes(query)).map((partner) => partner.id)
      ).slice(0, 8)
      : [];
    const shown = [...new Set([...(chosen ? [chosen] : []), ...ids, ...searched])];
    const label = (id: string) => (what === 'case' ? caseLabel(view, id) : partnerLabel(id));
    const noun = what === 'case' ? 'case' : 'partner';
    return (
      <View style={styles.choices}>
        <Text style={styles.label}>{row.kind === 'new_partner' ? 'ALREADY IN YOUR NETWORK?' : what === 'case' ? 'CASE' : 'PARTNER'}</Text>
        <View style={styles.pillRow}>
          {shown.map((id) => {
            const on = id === chosen;
            return (
              <TouchableOpacity
                key={id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${on ? 'Chosen' : 'Choose'} ${noun}: ${label(id)}`}
                onPress={() => updateRow(row.key, (current) => (what === 'case'
                  ? chooseCase(current, on ? null : id, view)
                  : choosePartner(current, on ? null : id)))}
                style={[styles.pill, on && styles.pillOn]}
              >
                <Text style={[styles.pillText, on && styles.pillTextOn]} numberOfLines={1}>{label(id)}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={open ? `Done finding a ${noun}` : `Find another ${noun}`}
            onPress={() => setPicker(open ? null : { key: row.key, what, query: '' })}
            style={styles.pill}
          >
            <Text style={styles.pillText}>{open ? 'Done' : `Find another ${noun}`}</Text>
          </TouchableOpacity>
        </View>
        {chosen && unsure ? (
          <View style={styles.confirmRow}>
            <Text style={[styles.hint, styles.flex]}>Matched by name only. Is this the right {noun}?</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Yes, ${label(chosen)} is the right ${noun}`}
              onPress={() => patch(row.key, what === 'case' ? { caseUnsure: false } : { partnerUnsure: false })}
              style={styles.confirmButton}
            >
              <Text style={styles.confirmButtonText}>Yes, this {noun}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {open ? (
          <TextInput
            value={picker!.query}
            onChangeText={(value) => setPicker({ key: row.key, what, query: value })}
            placeholder={what === 'case' ? 'Search cases' : 'Search partners'}
            placeholderTextColor={COLORS.gray}
            accessibilityLabel={what === 'case' ? 'Search cases' : 'Search partners'}
            autoFocus
            style={styles.input}
          />
        ) : null}
      </View>
    );
  }

  function renderKindSwitch(row: ReviewRow) {
    const kinds = kindChoices(row);
    if (!kinds.length) return null;
    return (
      <View style={styles.pillRow}>
        {kinds.map((kind) => {
          const on = row.kind === kind;
          return (
            <TouchableOpacity
              key={kind}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Save as: ${SWITCH_LABEL[kind] || KIND_LABEL[kind]}`}
              onPress={() => updateRow(row.key, (current) => switchKind(current, kind))}
              style={[styles.pill, on && styles.pillOn]}
            >
              <Text style={[styles.pillText, on && styles.pillTextOn]}>{SWITCH_LABEL[kind] || KIND_LABEL[kind]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  function renderLicense(row: ReviewRow) {
    if (row.kind !== 'referral' || row.direction !== 'sent' || !row.partnerId) return null;
    const concern = licenseConcernFor(row.partnerId);
    if (!concern) return null;
    const prompt = licenseConcernAlert(partnerLabel(row.partnerId), concern, 'refer');
    const confirmed = row.licenseConfirmed === row.partnerId;
    return (
      <View style={styles.urgent} accessibilityRole="alert">
        <Text style={styles.urgentText}>{prompt.message}</Text>
        {confirmed ? (
          <Text style={styles.urgentText}>You chose to go ahead. That is noted on the referral.</Text>
        ) : (
          <TouchableOpacity accessibilityRole="button" onPress={() => patch(row.key, { licenseConfirmed: row.partnerId })} style={styles.confirmButton}>
            <Text style={styles.confirmButtonText}>{prompt.proceed}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  function renderRow(row: ReviewRow) {
    const result = saved[row.key];
    const done = result?.saved === true;
    const readOnly = done || locked;
    const problem = rowProblem(row, context);
    const found = row.found;
    const edit = !readOnly && row.include;
    const showCase = row.kind === 'case_note' || row.kind === 'follow_up' || row.kind === 'referral';
    const showPartner = row.kind === 'partner_note' || row.kind === 'referral' || row.kind === 'follow_up'
      || (row.kind === 'new_partner' && row.partnerChoices.length > 0);
    return (
      <View key={row.key} style={[styles.row, (!row.include || done) && styles.rowOff]}>
        <View style={styles.rowTop}>
          <View style={styles.flex}>
            <Text style={styles.kind}>{KIND_LABEL[row.kind].toUpperCase()}{found.urgent ? ' · URGENT' : ''}</Text>
            <Text style={styles.destination}>{destination(row, view)}</Text>
          </View>
          {done ? <Text style={styles.savedTag}>Saved</Text> : readOnly ? (
            <Text style={styles.offTag}>{row.include ? '' : 'Skipped'}</Text>
          ) : (
            <Switch
              accessibilityLabel={`Include this ${KIND_LABEL[row.kind].toLowerCase()}`}
              value={row.include}
              onValueChange={(include) => {
                if (include) switchedOffRef.current.delete(row.key);
                else switchedOffRef.current.add(row.key);
                patch(row.key, { include });
              }}
              trackColor={{ true: COLORS.forest }}
            />
          )}
        </View>

        {found.urgent && !done ? (
          <View style={styles.urgent} accessibilityRole="alert">
            <Text style={styles.urgentText}>Someone may be in danger. If so, call 911. For a mental-health crisis, call or text 988.</Text>
          </View>
        ) : null}

        {edit ? renderKindSwitch(row) : null}

        {readOnly ? <Text style={styles.body}>{row.text}</Text> : (
          <TextInput
            value={row.text}
            onChangeText={(value) => patch(row.key, { text: value })}
            multiline
            accessibilityLabel={row.kind === 'follow_up' ? 'Task' : 'Note'}
            style={[styles.input, styles.inputMultiline]}
          />
        )}

        {edit && row.kind === 'new_lead' ? (
          <View style={styles.fields}>
            <Text style={styles.fieldLabel}>CALLER</Text>
            <TextInput value={row.callerName} onChangeText={(value) => patch(row.key, { callerName: value })} placeholder="Caller's name" placeholderTextColor={COLORS.gray} accessibilityLabel="Caller's name" style={styles.input} />
            <Text style={styles.fieldLabel}>PHONE</Text>
            <TextInput value={row.phone} onChangeText={(value) => patch(row.key, { phone: value })} placeholder="Required" placeholderTextColor={COLORS.gray} keyboardType="phone-pad" maxLength={40} accessibilityLabel="Phone" style={styles.input} />
            <Text style={styles.fieldLabel}>EMAIL</Text>
            <TextInput value={row.email} onChangeText={(value) => patch(row.key, { email: value })} placeholder="Optional" placeholderTextColor={COLORS.gray} keyboardType="email-address" autoCapitalize="none" accessibilityLabel="Email" style={styles.input} />
            <View style={styles.fieldRow}>
              <View style={styles.flex}>
                <Text style={styles.fieldLabel}>CALLING ABOUT</Text>
                <TextInput value={row.aboutRelationship} onChangeText={(value) => patch(row.key, { aboutRelationship: value })} placeholder="son, wife, self" placeholderTextColor={COLORS.gray} accessibilityLabel="Calling about" style={styles.input} />
              </View>
              <View style={styles.flex}>
                <Text style={styles.fieldLabel}>THEIR FIRST NAME</Text>
                <TextInput value={row.aboutFirstName} onChangeText={(value) => patch(row.key, { aboutFirstName: value })} placeholder="Optional" placeholderTextColor={COLORS.gray} accessibilityLabel="Their first name" style={styles.input} />
              </View>
            </View>
          </View>
        ) : null}

        {edit && row.kind === 'referral' ? (
          <View style={styles.choices}>
            <Text style={styles.label}>WHICH WAY</Text>
            <View style={styles.pillRow}>
              {([['sent', 'You referred them'], ['received', 'Referred to you']] as const).map(([direction, text]) => {
                const on = row.direction === direction;
                return (
                  <TouchableOpacity key={direction} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => patch(row.key, { direction })} style={[styles.pill, on && styles.pillOn]}>
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{text}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}

        {edit && showCase ? renderChoices(row, 'case') : null}
        {edit && showPartner ? renderChoices(row, 'partner') : null}

        {edit && row.kind === 'follow_up' && (row.caseChoices.length > 0 || row.partnerChoices.length > 0) ? (
          <View style={styles.pillRow}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ selected: row.noLink }}
              accessibilityLabel="Not linked to a case or partner"
              onPress={() => patch(row.key, row.noLink ? { noLink: false } : { noLink: true, caseId: null, partnerId: null, caseUnsure: false, partnerUnsure: false })}
              style={[styles.pill, row.noLink && styles.pillOn]}
            >
              <Text style={[styles.pillText, row.noLink && styles.pillTextOn]}>Not linked</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {edit && row.kind === 'follow_up' ? (
          <View style={styles.choices}>
            <Text style={styles.label}>DUE</Text>
            <View style={styles.pillRow}>
              {[...new Set([today, addDays(today, 1), ...(found.dueDate ? [found.dueDate] : [])])].map((day) => {
                const on = row.dueOn === day;
                const label = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : day;
                return (
                  <TouchableOpacity key={day} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`Due ${label}`} onPress={() => patch(row.key, { dueOn: day })} style={[styles.pill, on && styles.pillOn]}>
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TextInput value={row.dueOn} onChangeText={(value) => patch(row.key, { dueOn: value.trim() })} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.gray} accessibilityLabel="Due date, year month day" maxLength={10} style={styles.input} />
          </View>
        ) : null}

        {edit && row.kind === 'referral' ? (
          <View style={styles.choices}>
            <Text style={styles.label}>CLIENT LABEL</Text>
            <TextInput value={row.clientLabel} onChangeText={(value) => patch(row.key, { clientLabel: value })} placeholder="Initials or a private label" placeholderTextColor={COLORS.gray} accessibilityLabel="Client label, initials or a private label" maxLength={120} style={styles.input} />
            <Text style={styles.hint}>The referral history stays de-identified: use initials or a private label, not a name.</Text>
          </View>
        ) : null}

        {edit ? renderLicense(row) : null}

        {edit && row.kind === 'new_partner' && row.candidate ? (
          <View style={styles.choices}>
            <Text style={styles.body}>{[row.candidate.organization, row.candidate.name !== row.candidate.organization ? row.candidate.name : '', row.candidate.phone, row.candidate.email].filter(Boolean).join(' · ')}</Text>
            {row.candidate.useListing && row.candidate.match ? null : (
              <View style={styles.pillRow}>
                {IMPORT_TYPES.map((type: ImportType) => {
                  const on = row.candidate!.types.includes(type);
                  return (
                    <TouchableOpacity
                      key={type}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => updateRow(row.key, (current) => (current.candidate
                        ? { ...current, candidate: { ...current.candidate, types: on ? current.candidate.types.filter((item) => item !== type) : [...current.candidate.types, type] } }
                        : current))}
                      style={[styles.pill, on && styles.pillOn]}
                    >
                      <Text style={[styles.pillText, on && styles.pillTextOn]}>{type}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        ) : null}

        {found.evidence ? <Text style={styles.quote}>“{found.evidence}”</Text> : null}
        {row.source ? <Text style={styles.hint}>{row.source}</Text> : null}
        {row.hint && !done ? <Text style={styles.hint}>{row.hint}</Text> : null}
        {result?.message ? <Text style={result.saved ? styles.hint : styles.problem}>{result.message}</Text> : null}
        {!readOnly && row.include && problem && !result ? <Text style={styles.problem}>{problem}</Text> : null}
      </View>
    );
  }

  // ─── Screens ────────────────────────────────────────────────────────────

  const keyMissing = keyState === 'missing' || !aiKeysSupported;

  const pasteScreen = (
    <View>
      <Text style={styles.intro}>
        Paste notes from your day: a summary from Fieldy or Plaud, or your own call notes. ReferralFit finds new leads, notes, follow-ups and referrals, and you approve each one before anything is saved.
      </Text>
      {fieldySupported ? RECORDERS.map((recorder) => {
        const status = recorders[recorder.id];
        // Without a key there is nothing to read with, but a connected recorder can always be disconnected.
        if (keyMissing && status.state !== 'on' && status.state !== 'leaving') return null;
        return (
          <View key={recorder.id} style={styles.fieldyCard}>
            <Text style={styles.label}>{recorder.name.toUpperCase()}</Text>
            {status.state === 'on' ? (
              <>
                <Text style={styles.hint}>Connected{status.email ? ` as ${status.email}` : ''}. ReferralFit reads your new {recorder.noun}s here; you approve each item.</Text>
                {keyMissing ? null : (
                  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => readRecorderAsking(recorder)} style={[styles.primaryButton, busy && styles.off]}>
                    <Text style={styles.primaryButtonText}>Read new {recorder.name} {recorder.noun}s</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => disconnect(recorder)} style={styles.textButton}>
                  <Text style={styles.hint}>Disconnect {recorder.name}</Text>
                </TouchableOpacity>
              </>
            ) : status.state === 'checking' || status.state === 'leaving' ? (
              <ActivityIndicator color={COLORS.forest} accessibilityLabel={status.state === 'leaving' ? `Disconnecting ${recorder.name}` : `Checking ${recorder.name}`} />
            ) : (
              <>
                <Text style={styles.hint}>Use {recorder.name}? Connect it once and ReferralFit reads your {recorder.noun}s for you: no copying or pasting. You sign in to {recorder.name}; your sign-in stays on this phone.</Text>
                <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: status.state === 'busy' }} disabled={busy || status.state === 'busy'} onPress={() => { void connect(recorder); }} style={[styles.secondaryButton, (busy || status.state === 'busy') && styles.off]}>
                  {status.state === 'busy' ? <ActivityIndicator color={COLORS.forest} accessibilityLabel="Connecting" /> : <Text style={styles.secondaryButtonText}>Connect {recorder.name}</Text>}
                </TouchableOpacity>
              </>
            )}
          </View>
        );
      }) : null}
      {keyMissing ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>
            {aiKeysSupported
              ? 'Review uses your own Anthropic key, like AI drafts. Add it in Workspace and settings (the gear icon), under AI drafts.'
              : 'Review uses the Anthropic key on your iPhone. Open ReferralFit on your iPhone to review notes.'}
          </Text>
        </View>
      ) : null}
      <View style={styles.sourceRow}>
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void pasteFromClipboard(); }} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Paste</Text>
        </TouchableOpacity>
        {notes ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear the notes" disabled={busy} onPress={() => setNotes('')} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <TextInput
        value={notes}
        onChangeText={setNotes}
        multiline
        editable={!busy}
        placeholder="Paste or type your notes here"
        placeholderTextColor={COLORS.gray}
        accessibilityLabel="Your notes"
        style={[styles.input, styles.notesInput]}
      />
      <Text style={styles.hint}>
        Only this text and today's date are sent, to Anthropic on your own key; ReferralFit does not store them. Paste a recording only if everyone in it agreed to be recorded.
      </Text>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={phase === 'done' ? 'Done' : 'Close review'} disabled={phase === 'saving'} onPress={close} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, phase === 'saving' && styles.off]}>{phase === 'done' ? 'Done' : 'Cancel'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle} accessibilityRole="header">Review notes</Text>
          <View style={styles.headerButton} />
        </View>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            {phase === 'paste' || phase === 'finding' ? pasteScreen : null}
            {phase === 'review' || phase === 'saving' || phase === 'done' ? (
              <View pointerEvents={locked ? 'none' : 'auto'}>
                {rows.length ? <Text style={styles.label}>FROM YOUR NOTES · {countLine(rows.map((row) => row.kind)).replace(/\.$/, '').toUpperCase()}</Text> : null}
                {rows.map(renderRow)}
                {phase === 'review' ? (
                  <TouchableOpacity accessibilityRole="button" onPress={() => { setPhase('paste'); setMessage(null); setPicker(null); }} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Back to the notes</Text>
                  </TouchableOpacity>
                ) : null}
                {phase === 'review' && recorderReadRef.current ? (
                  <TouchableOpacity accessibilityRole="button" onPress={markAllReviewed} style={styles.textButton}>
                    <Text style={styles.hint}>Done with these {recorderReadRef.current.recorder.noun}s: don't read them again</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
          <View style={styles.footer}>
            {message ? (
              <View style={[styles.notice, styles.footerNotice, message.ok && styles.noticeOk]} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <Text style={[styles.noticeText, message.ok && styles.noticeTextOk]}>{message.text}</Text>
              </View>
            ) : null}
            {phase === 'paste' || phase === 'finding' ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || keyMissing, busy }}
                disabled={busy || keyMissing || keyState === 'checking'}
                onPress={() => { void find(); }}
                style={[styles.primaryButton, (busy || keyMissing || keyState === 'checking') && styles.off]}
              >
                {phase === 'finding' ? (
                  <View style={styles.busyRow}>
                    <ActivityIndicator color={COLORS.white} accessibilityLabel="Reading your notes" />
                    <Text style={styles.primaryButtonText}>Reading your notes…</Text>
                  </View>
                ) : <Text style={styles.primaryButtonText}>Find what's in it</Text>}
              </TouchableOpacity>
            ) : phase === 'done' ? (
              <TouchableOpacity accessibilityRole="button" onPress={close} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Done</Text>
              </TouchableOpacity>
            ) : (
              <>
                {waiting ? <Text style={styles.footerHint}>{waiting} {waiting === 1 ? 'needs' : 'need'} a choice before {waiting === 1 ? 'it' : 'they'} can be saved.</Text> : null}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !ready.length, busy }}
                  disabled={busy || !ready.length}
                  onPress={() => { void approve(); }}
                  style={[styles.primaryButton, (busy || !ready.length) && styles.off]}
                >
                  {phase === 'saving' ? <ActivityIndicator color={COLORS.white} accessibilityLabel="Saving" /> : (
                    <Text style={styles.primaryButtonText}>{!ready.length ? 'Nothing ready to save' : ready.length === pending.filter((row) => row.include).length ? `Approve all (${ready.length})` : `Approve ${ready.length}`}</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  content: { padding: 18, paddingBottom: 48 },
  intro: { fontSize: 14, lineHeight: 20, color: COLORS.muted },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.muted, marginTop: 4 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.muted, marginTop: 14, marginBottom: 8 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  notice: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12, marginTop: 12 },
  fieldyCard: { backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 14, marginTop: 12, gap: 8 },
  textButton: { paddingVertical: 8, alignItems: 'center' },
  noticeOk: { backgroundColor: COLORS.mintPale },
  noticeText: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, fontWeight: '600' },
  noticeTextOk: { color: COLORS.forest },
  input: { minHeight: 44, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: COLORS.ink },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  notesInput: { minHeight: 220, marginTop: 12, textAlignVertical: 'top' },
  fields: { gap: 6 },
  fieldLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: COLORS.muted, marginTop: 4 },
  fieldRow: { flexDirection: 'row', gap: 8 },
  row: { backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 14, marginBottom: 10, gap: 8 },
  rowOff: { opacity: 0.6 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  kind: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.forest },
  destination: { fontSize: 13, color: COLORS.inkSoft, marginTop: 3 },
  body: { fontSize: 15, lineHeight: 21, color: COLORS.ink },
  savedTag: { fontSize: 13, fontWeight: '800', color: COLORS.forest },
  offTag: { fontSize: 13, fontWeight: '700', color: COLORS.muted },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  confirmButton: { minHeight: 40, paddingHorizontal: 14, borderRadius: 999, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  confirmButtonText: { color: COLORS.white, fontSize: 13, fontWeight: '800' },
  urgent: { backgroundColor: COLORS.coralPale, borderRadius: 10, padding: 10 },
  urgentText: { fontSize: 13, lineHeight: 18, color: COLORS.coralText, fontWeight: '700' },
  quote: { fontSize: 12, lineHeight: 17, color: COLORS.muted, fontStyle: 'italic' },
  problem: { fontSize: 12, fontWeight: '700', color: COLORS.coralText },
  choices: { gap: 6 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 36, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillOn: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextOn: { color: COLORS.white },
  footer: { padding: 14, gap: 8, borderTopWidth: 1, borderTopColor: COLORS.line, backgroundColor: COLORS.white },
  footerHint: { fontSize: 12, color: COLORS.muted, textAlign: 'center' },
  footerNotice: { marginTop: 0 },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  secondaryButton: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', marginTop: 8 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 15, fontWeight: '800' },
  off: { opacity: 0.5 },
});
