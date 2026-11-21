// Day review: paste notes from the day (a recorder's summary from Fieldy or
// Plaud, call notes, text shared from another app, a voice note), and
// ReferralFit lists what belongs in it: new leads,
// case and partner notes, follow-ups, referrals, new partners. Each row is
// matched to a case or partner on this phone; nothing is saved until the
// practitioner taps Approve. Uses the practitioner's own Anthropic key, like
// AI drafts. docs/DAY_REVIEW.md.
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
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
import { createCaseBundle, leadCallerRelationship, newUuid, type CaseContact, type CaseRecord } from './cases';
import { initialCaseFollowUp } from './outreach';
import {
  addDays,
  blocksInNotes,
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
  NARROWED_READS,
  narrowedMessage,
  notesBesides,
  olderHalf,
  readAgainLine,
  recordingsDoneOnRead,
  recordingsHeld,
  rowProblem,
  rowReady,
  laterSignatures,
  rowSignatures,
  saveOrder,
  savedLine,
  signatureHash,
  stoppedAtCapMessage,
  switchKind,
  waitingLine,
  NEW_CASE_STATUS,
  withPendingCases,
  withPendingLeads,
  suggestedCaseTitle,
  type PendingCase,
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
import { loadDayReviewReminder, saveDayReviewReminder } from './day-review-reminder';
import { DAY_REVIEW_DEFAULT_TIME, DAY_REVIEW_REMINDER_OFF, dayReviewReminderLabel, getNotificationPermissionState, stepDayReviewReminderTime } from './notifications';
import { licenseConcernAlert, licenseOverrideNote, type LicenseConcern } from './integrity';
import { aiKeysSupported, getAnthropicKey } from './outreach-api';
import { directoryIndex, IMPORT_TYPES, type DirectoryIndex, type ImportType } from './partner-import';
import { appendToNotes, REVIEW_TEXT_MAX, sharedNoteMessage, type SharedNote } from './share-intake';
import { shareToAppSupported } from './share-receiver';
import type { FollowUp } from './store';
import { useVoiceNote } from './voice-note';
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
  /**
   * A recorder was read, connected or disconnected: the Today card counts
   * again. With `reviewed`, that many of the recorder's recordings were just
   * marked done: the count drops by them at once, before the recount answers.
   */
  onRecordersChanged?: (reviewed?: { recorder: RecorderId; count: number }) => void;
  /**
   * Text shared to ReferralFit from another app (App.tsx keeps it until it is
   * taken). It goes into the notes box, below anything already there, and
   * waits for Find; a review in progress keeps it until it is done.
   */
  incomingShare?: (SharedNote & { id: string }) | null;
  /** The share is in the notes box now: App.tsx lets it go. */
  onIncomingShareTaken?: (id: string) => void;
};

type Phase = 'paste' | 'finding' | 'review' | 'saving' | 'done';

type RecorderState = { state: 'checking' | 'off' | 'on' | 'busy' | 'leaving'; email: string };
const CLOSED_STATUSES = new Set(['closed', 'lost']);
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
  startWithRecorder = null, onRecordersChanged, incomingShare = null, onIncomingShareTaken,
}: Props) {
  const [phase, setPhase] = useState<Phase>('paste');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [today, setToday] = useState(localDay());
  const [keyState, setKeyState] = useState<'checking' | 'ready' | 'missing'>('checking');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<Record<string, SaveResult>>({});
  const [picker, setPicker] = useState<{ key: string; what: 'case' | 'partner'; query: string } | null>(null);
  // "New case" on a row: cases made in this review for a family not in
  // ReferralFit yet, created only when a row on them is approved; and the
  // row whose name-the-case form is open.
  const [newCases, setNewCases] = useState<PendingCase[]>([]);
  const [caseDraft, setCaseDraft] = useState<{ key: string; title: string } | null>(null);
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
  // The day review reminder: the time this account picked ('off' for none),
  // and whether this phone lets ReferralFit send one at all.
  const [reminder, setReminder] = useState(DAY_REVIEW_DEFAULT_TIME);
  const [remindersAllowed, setRemindersAllowed] = useState(true);
  // One save at a time, in the order tapped: the last tap is the one kept.
  const reminderSaveRef = useRef<Promise<unknown>>(Promise.resolve());
  const reminderChangeRef = useRef(0);
  // The recordings this review was read from (those still in the box), which
  // recording each row came from, and those skipped for having no text.
  // `everyId`: every recording of the read, where an item whose quote is in
  // none of them is remembered once saved (one edited in the box may be its
  // source). `held`: read again next time whatever happens here (the review
  // stopped at its cap and listed nothing from them).
  const recorderReadRef = useRef<{
    recorder: Recorder; blocks: FieldyBlock[]; everyId: string[]; rowIds: Map<string, string[]>; skipped: string[]; held: string[];
  } | null>(null);
  // Rows the practitioner switched off: set aside (one off from the start, unchecked, is not).
  const switchedOffRef = useRef<Set<string>>(new Set());
  // This opening has read the key and the recorders (and started a recorder
  // read when it was opened for one): a share can go into the box now.
  const [openReady, setOpenReady] = useState(false);
  // The share last put in the box, and the one last told about while a review was on screen.
  const takenShareRef = useRef<string | null>(null);
  const noticedShareRef = useRef<string | null>(null);
  // A voice note writes after what was in the box when it started.
  const voiceBaseRef = useRef('');
  const voice = useVoiceNote({
    onText: (spoken) => {
      const base = voiceBaseRef.current;
      setNotes(spoken ? (base ? `${base}\n\n${spoken}` : spoken) : base);
    },
    onNotice: (text, ok) => setMessage({ ok, text }),
  });
  const voiceActive = voice.state !== 'idle';
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
    setNewCases([]);
    setCaseDraft(null);
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
    voice.cancel();
    setOpenReady(false);
    if (!visible) return;
    setToday(localDay());
    setKeyState('checking');
    const opening = openingRef.current;
    setRecorders(RECORDERS_CHECKING);
    void reminderSaveRef.current.then(() => loadDayReviewReminder(userId)).then((time) => { if (opening === openingRef.current) setReminder(time); });
    void Promise.all([getAnthropicKey(userId), ...RECORDERS.map((recorder) => recorderStatus(recorder, userId))]).then(([key, ...statuses]) => {
      if (opening !== openingRef.current) return;
      setKeyState(key ? 'ready' : 'missing');
      setOpenReady(true);
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
    }).catch(() => {
      // The key could not be read: Find stays off, but a share can still go in the box.
      if (opening === openingRef.current) setOpenReady(true);
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
  const view = useMemo(() => withPendingCases(withPendingLeads(workspace, rows), newCases), [workspace, rows, newCases]);
  const context: RowContext = { rows, licenseConcern: (partnerId) => Boolean(licenseConcernFor(partnerId)) };
  const isSaved = (row: ReviewRow) => saved[row.key]?.saved === true;
  const pending = rows.filter((row) => !isSaved(row));
  const ready = pending.filter((row) => rowReady(row, context));
  const waiting = pending.filter((row) => row.include && !rowReady(row, context)).length;
  const busy = phase === 'finding' || phase === 'saving';
  const locked = phase === 'saving' || phase === 'done';

  // A recording is done once every item from it is decided: saved; switched
  // off by the practitioner; or off for a reason the app gave (already a
  // follow-up, already in the referral history, found saved before as the
  // review was built). An item off only because it could not be checked against the
  // notes, never looked at, is not decided: closing asks about it. An item
  // still on and unsaved whose quote is in no one recording could be from
  // any: until it is decided, none is done (one off and unchecked, tied to
  // no recording, holds none). Saved before: as markSavedBefore found it
  // (one saved item marks one row), never worked out again here, where a
  // quote two items share could take one for the other.
  function rowDecided(row: ReviewRow, results: Record<string, SaveResult>): boolean {
    if (results[row.key]?.saved === true) return true;
    if (row.include) return false;
    return switchedOffRef.current.has(row.key) || row.found.verified || row.savedEarlier;
  }

  // An item still undecided that matches no one recording: closing asks, and "read again" holds them all.
  function unmatchedUndecided(results: Record<string, SaveResult>, current: ReviewRow[]): boolean {
    const read = recorderReadRef.current;
    return Boolean(read) && current.some((row) => !(read!.rowIds.get(row.key)?.length) && !rowDecided(row, results));
  }

  function recordingsDone(results: Record<string, SaveResult>, current: ReviewRow[]): string[] {
    const read = recorderReadRef.current;
    if (!read) return [];
    // One rule with the close question: an undecided item from no one recording keeps them all.
    if (unmatchedUndecided(results, current)) return [];
    // One held for the next read (nothing listed from it in a review that
    // stopped at its cap) is never done here.
    return read.blocks.map((block) => block.id)
      .filter((id) => !read.held.includes(id))
      .filter((id) => current.filter((row) => (read.rowIds.get(row.key) ?? []).includes(id)).every((row) => rowDecided(row, results)));
  }

  // Marked on this phone first; the Today card and the reminder drop by
  // that many at once (a recount may fail, or never come back).
  function markReviewed(recorder: Recorder, ids: string[]) {
    void markRecordingsReviewed(recorder, userId, ids)
      .then((count) => onRecordersChanged?.({ recorder: recorder.id, count }))
      .catch(() => undefined);
  }

  function settleRecordings(results: Record<string, SaveResult>, current: ReviewRow[]) {
    const read = recorderReadRef.current;
    if (!read || !current.length) return;
    const done = recordingsDone(results, current);
    if (done.length) markReviewed(read.recorder, done);
  }

  function finish(hold = false) {
    if (!hold && phase !== 'finding' && phase !== 'saving') settleRecordings(saved, rows);
    openingRef.current += 1;
    clearReview();
    voice.cancel();
    onClose();
  }

  // Text shared from another app: into the box, below what is there, never
  // sent on its own. Not while a read, a review's save or a voice note is
  // writing to the box; a review on screen keeps it until the practitioner
  // goes back to the notes, or everything is saved (then it starts a new one).
  useEffect(() => {
    if (!visible || !incomingShare || !openReady || takenShareRef.current === incomingShare.id || voiceActive) return;
    if (phase === 'review') {
      if (noticedShareRef.current !== incomingShare.id) {
        noticedShareRef.current = incomingShare.id;
        setMessage({ ok: true, text: 'You shared something to ReferralFit. It goes into the notes box when you tap Back to the notes, or once this review is saved.' });
      }
      return;
    }
    if (phase !== 'paste' && phase !== 'done') return;
    takenShareRef.current = incomingShare.id;
    let before = notes;
    if (phase === 'done') {
      // Everything from that review is saved: a new review for what was shared.
      settleRecordings(saved, rows);
      openingRef.current += 1;
      clearReview();
      before = '';
    }
    const next = appendToNotes(before, incomingShare.text);
    setNotes(next);
    setMessage({ ok: true, text: sharedNoteMessage(incomingShare, { appended: Boolean(before.trim()), totalLength: next.length }) });
    onIncomingShareTaken?.(incomingShare.id);
    // notes, saved and rows are read as they are when the share is taken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, incomingShare, openReady, phase, voiceActive]);

  function startVoiceNote() {
    if (busy || voiceActive) return;
    const base = notes.trimEnd();
    voiceBaseRef.current = base;
    setMessage({
      ok: true,
      text: `Listening. Say what happened; the words appear in the box. Tap Stop when you are done. ${voice.onDevice ? 'Your voice stays on this phone.' : 'Apple turns your voice into text; the sound is not saved.'}`,
    });
    void voice.start(REVIEW_TEXT_MAX - (base ? base.length + 2 : 0));
  }

  function close() {
    if (phase === 'saving') return;
    // What a voice note has heard so far is in the box; the box's own question below covers it.
    if (voiceActive) voice.cancel();
    // A read or a review can be stopped (what comes back late is ignored);
    // notes the practitioner typed, pasted, shared or spoke there (anything
    // in the box besides the recordings) are not thrown away without asking.
    const recorderText = Boolean(recorderReadRef.current) && !notesBesides(notes, recorderReadRef.current?.blocks ?? []);
    if (phase === 'finding' && (!notes.trim() || recorderText)) { finish(); return; }
    const unsaved = phase === 'review'
      ? pending.some((row) => row.include)
      : (phase === 'paste' || phase === 'finding') && notes.trim().length > 0;
    const read = recorderReadRef.current;
    // Recordings with items not decided on (off from the start, never
    // looked at): read again next time, or done with, as the practitioner says.
    // An undecided item tied to no one recording could be from any: all of them are in question.
    const holdAll = Boolean(read && rows.length) && unmatchedUndecided(saved, rows);
    // Those held for the next read come back anyway: they are not in question.
    const inQuestion = read ? read.blocks.length - read.held.length : 0;
    const undecided = read && rows.length ? (holdAll ? inQuestion : inQuestion - recordingsDone(saved, rows).length) : 0;
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
              markReviewed(read.recorder, read.blocks.map((block) => block.id).filter((id) => !read.held.includes(id)));
              finish();
            },
          },
        ]);
      return;
    }
    if (!unsaved) { finish(); return; }
    const kept = savedCountRef.current;
    // Said as it will happen: Discard settles the recordings whose items are
    // all decided (none while a review is being read); the rest are read again.
    const settling = read && rows.length && phase !== 'finding' ? recordingsDone(saved, rows).length : 0;
    const again = read ? readAgainLine(read.blocks.length - settling, read.recorder) : '';
    const againText = again ? ` ${again}` : '';
    Alert.alert(
      'Discard this review?',
      (kept
        ? `${kept} ${kept === 1 ? 'item you approved stays' : 'items you approved stay'} saved. Nothing else from these notes is saved.`
        : 'Nothing from these notes has been saved yet.') + againText,
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

  async function find(read: { recorder: Recorder; text: string; blocks: FieldyBlock[]; skipped?: string[]; later?: number } | null = null) {
    setCaseDraft(null);
    if ((busy || voiceActive) && !read) return;
    // "Back to the notes", then Find again: still the recordings whose text
    // is in the box, word for word. Notes typed, shared or spoken beside them
    // are read with them; one edited or deleted there is read again next time.
    const linked = read ? null : recorderReadRef.current;
    const kept = linked ? blocksInNotes(notes, linked.blocks) : [];
    let fromRecorder = read
      ? { recorder: read.recorder, blocks: read.blocks, everyId: read.blocks.map((block) => block.id), skipped: read.skipped ?? [] }
      : linked && kept.length ? { recorder: linked.recorder, blocks: kept, everyId: linked.everyId, skipped: linked.skipped } : null;
    let text = (read ? read.text : notes).trim();
    // All of them, as read (before any are set aside below).
    const first = fromRecorder;
    // Until a new review lands, the one on screen keeps its link (which
    // recording each row came from, and those held), limited to the
    // recordings still in the box: closing after a failed read then settles
    // only what that review decided. A fresh read that failed keeps its
    // recordings; the rows on screen were of other notes, and go.
    // Kept before the review runs, so a retry after a failed one is still these recordings.
    const keepLink = () => {
      if (read && first) {
        recorderReadRef.current = { ...first, rowIds: new Map(), held: [] };
        setRows([]);
        setSaved({});
        setPicker(null);
        setNewCases([]);
        return;
      }
      recorderReadRef.current = linked && kept.length
        ? { ...linked, blocks: kept, held: linked.held.filter((id) => kept.some((block) => block.id === id)) }
        : null;
    };
    if (text.length < 20) { keepLink(); setMessage({ ok: false, text: 'Paste a little more: there is not enough here to review.' }); return; }
    const opening = openingRef.current;
    const day = localDay();
    setToday(day);
    setMessage(null);
    setPhase('finding');
    try {
      const key = await getAnthropicKey(userId);
      if (!key) {
        if (opening === openingRef.current) { keepLink(); setKeyState('missing'); setPhase('paste'); }
        return;
      }
      let answer = await requestDayReview(text, day, key);
      if (opening !== openingRef.current) return;
      // Several recordings that held more than one review can list: the older
      // half is read again on its own (a few extra reads at most, down to
      // one recording), the rest wait for the next read. Only when the box is
      // just the recordings: notes typed beside them are never dropped.
      const firstCount = fromRecorder?.blocks.length ?? 0;
      let setAside = 0;
      if (fromRecorder && !notesBesides(text, fromRecorder.blocks)) {
        for (let extra = 0; answer.truncated && extra < NARROWED_READS; extra += 1) {
          const fewer: FieldyBlock[] | null = olderHalf(fromRecorder.blocks);
          if (!fewer) break;
          const fewerText = fewer.map((block) => block.text).join('\n\n');
          let narrowed;
          try {
            narrowed = await requestDayReview(fewerText, day, key);
          } catch {
            // That read failed (the day's cap, the network): the review
            // already in hand is shown, its recordings held for the next read.
            if (opening !== openingRef.current) return;
            break;
          }
          if (opening !== openingRef.current) return;
          setAside += fromRecorder.blocks.length - fewer.length;
          fromRecorder = { ...fromRecorder, blocks: fewer, everyId: fewer.map((block) => block.id) };
          text = fewerText;
          answer = narrowed;
        }
      }
      const { items, truncated } = answer;
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
        workspaceRef.current,
      );
      // The box holds what this review read: those set aside come back on the next read.
      if (setAside) setNotes(text);
      setRows(built);
      // Rows are keyed by position: what was switched off in an earlier review is not this one's.
      switchedOffRef.current = new Set();
      setSaved({});
      setPicker(null);
      setPhase('review');
      let held: string[] = [];
      if (fromRecorder) {
        const rowIds = new Map(built.map((row) => [row.key, blocksFor(row.found.evidence, fromRecorder!.blocks).map((block) => block.id)]));
        const { skipped } = fromRecorder;
        const blockIds = fromRecorder.blocks.map((block) => block.id);
        // The review stopped at its cap: what it left out may be in any of
        // its recordings, so they are read again next time (of one alone,
        // only when nothing was listed from it).
        held = recordingsHeld(blockIds, rowIds.values(), truncated);
        recorderReadRef.current = { ...fromRecorder, rowIds, held };
        // A recording nothing was found in is done now (unless an item's
        // quote is in none of them: it could be from any; or the review
        // stopped at its cap); so is one with no text a day after it ended.
        const done = recordingsDoneOnRead(blockIds, rowIds.values(), truncated).concat(skipped);
        if (done.length) markReviewed(fromRecorder.recorder, done);
      } else {
        recorderReadRef.current = null;
      }
      const recorder = fromRecorder?.recorder ?? null;
      const parts: string[] = [];
      if (setAside && recorder) parts.push(narrowedMessage(firstCount, fromRecorder!.blocks.length, recorder));
      if (!items.length) {
        parts.push(recorder
          ? `Nothing in ${setAside ? (fromRecorder!.blocks.length === 1 ? 'it' : 'them') : `your new ${recorder.name} ${recorder.noun}s`} needs to go into ReferralFit.`
          : 'Nothing in these notes needs to go into ReferralFit.');
      } else if (truncated) {
        const skippedToo = read?.skipped?.length ? ` ${read.skipped.length} with no summary or transcript a day after ending ${read.skipped.length === 1 ? 'was' : 'were'} skipped.` : '';
        parts.push(`${stoppedAtCapMessage(held.length, recorder, fromRecorder?.blocks.length ?? 0)}${skippedToo}`);
      } else if (read?.skipped?.length) {
        parts.push(`${read.skipped.length} ${read.skipped.length === 1 ? read.recorder.noun : `${read.recorder.noun}s`} had no summary or transcript a day after ${read.skipped.length === 1 ? 'it' : 'they'} ended and ${read.skipped.length === 1 ? 'was' : 'were'} skipped.`);
      }
      // Those waiting (beyond this read, or set aside above) are always said, beside any other line.
      if (recorder) parts.push(waitingLine((read?.later ?? 0) + setAside, recorder));
      const said = parts.filter(Boolean).join(' ');
      if (said) setMessage({ ok: true, text: said });
    } catch (error) {
      if (opening !== openingRef.current) return;
      keepLink();
      if (error instanceof ReviewUnavailableError && error.reason === 'key') setKeyState('missing');
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Review is unavailable right now.' });
      setPhase('paste');
    }
  }

  // ─── The reminder's time ────────────────────────────────────────────────

  // Whether this phone lets ReferralFit send it: asked as the sheet opens and
  // each time the app comes back (from Settings, where it is turned on).
  useEffect(() => {
    if (!visible) return undefined;
    let current = true;
    const check = () => { void getNotificationPermissionState().then((permission) => { if (current) setRemindersAllowed(permission === 'authorized'); }); };
    check();
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') check(); });
    return () => { current = false; subscription.remove(); };
  }, [visible]);

  function changeReminder(next: string) {
    const opening = openingRef.current;
    const change = ++reminderChangeRef.current;
    setReminder(next);
    reminderSaveRef.current = reminderSaveRef.current
      .then(() => saveDayReviewReminder(userId, next))
      .catch(async () => {
        // Not saved: show what is really stored, and say so (unless a later
        // tap is still being saved; its own result is the one shown).
        const stored = await loadDayReviewReminder(userId);
        if (opening !== openingRef.current || change !== reminderChangeRef.current) return;
        setReminder(stored);
        setMessage({ ok: false, text: 'The reminder time could not be saved on this phone. Try again.' });
      });
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
      // Counted afresh as they are read: the count this review lowers is
      // then the one that matches what it read (a recording may have
      // arrived since the last count).
      onRecordersChanged?.();
    } catch (error) {
      if (opening !== openingRef.current) return;
      setPhase('paste');
      if (error instanceof FieldyError && error.reason === 'disconnected') {
        setRecorder(recorder.id, { state: 'off', email: '' });
        // Its count and the reminder go with it, now, not at the next recount.
        onRecordersChanged?.();
      }
      setMessage({ ok: false, text: error instanceof Error ? error.message : `${recorder.name} could not be read right now.` });
      return;
    }
    if (opening !== openingRef.current) return;
    if (!read.blocks.length) {
      setPhase('paste');
      if (read.skipped.length) markReviewed(recorder, read.skipped);
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
    // The review says how many more wait, beside anything else it says.
    await find({ recorder, text: read.text, blocks: read.blocks, skipped: read.skipped, later: read.later });
  }

  // Reading puts the recordings in the box: notes typed or pasted there (or
  // a recording edited there) are not replaced without asking.
  function readRecorderAsking(recorder: Recorder) {
    const linked = recorderReadRef.current;
    const typed = linked ? notesBesides(notes, blocksInNotes(notes, linked.blocks)) : notes.trim();
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
    const { recorder, blocks, held } = read;
    // Said plainly when the review stopped at its cap: some were not read in full.
    const partly = held.length
      ? ` This review stopped at 20 items, so ${held.length === 1 ? `one ${recorder.noun} was` : `${held.length} ${recorder.noun}s were`} not read in full.`
      : '';
    Alert.alert(`Done with these ${recorder.noun}s?`, `ReferralFit will not read these ${blocks.length} ${recorder.name} ${blocks.length === 1 ? recorder.noun : `${recorder.noun}s`} again. Anything you have not saved from them is not saved.${partly}`, [
      { text: 'Keep reviewing', style: 'cancel' },
      {
        text: 'Done with them',
        onPress: () => {
          markReviewed(recorder, blocks.map((block) => block.id));
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
    // The day as it is now: a review found before midnight and approved after
    // dates a new lead's first call (and a referral) today, not yesterday.
    const day = localDay();
    if (day !== today) setToday(day);
    let any = false;
    // New cases made in this review, created first: only those a row being
    // saved is on, and each once (a retry sends the same id; a repeat that
    // already landed is taken as done).
    const caseProblems = new Map<string, string>();
    const known = new Set(workspace.cases.map((record) => record.id));
    for (const pending of newCases) {
      if (known.has(pending.id) || !order.some((row) => row.caseId === pending.id)) continue;
      const at = new Date().toISOString();
      const record: CaseRecord = {
        id: pending.id, title: pending.title, status: 'inquiry', summary: '', leadSource: 'Unspecified', leadSourceDetail: '',
        lostReason: '', stageChangedAt: at, paymentStatus: 'none', quotedAmount: null, paidAmount: 0, createdAt: at, updatedAt: at,
      };
      const contact: CaseContact | null = pending.contact ? {
        id: newUuid(), caseId: pending.id, name: pending.contact.name.slice(0, 120),
        relationship: pending.contact.about ? leadCallerRelationship(pending.contact.about) : '',
        phone: pending.contact.phone, email: pending.contact.email, isPrimary: true, note: '',
      } : null;
      // No first call (the conversation in the notes was it), but never no
      // next step: unless a follow-up in this review goes on the case, a
      // follow-up in 48 hours, as the app's own new cases get.
      const hasNextStep = order.some((row) => row.kind === 'follow_up' && row.caseId === pending.id);
      const nextStep = hasNextStep ? null : initialCaseFollowUp(newUuid(), { ...record, status: 'consult' }, new Date());
      try {
        await createCaseBundle(record, contact, nextStep, userId);
        any = true;
      } catch (error) {
        caseProblems.set(pending.id, `The new case “${pending.title}” could not be created${error instanceof Error && error.message ? `: ${error.message}` : ''}. Try Approve again.`);
      }
      if (opening !== openingRef.current) break;
    }
    try {
      // One at a time: new leads first, then what may go on their cases.
      for (const row of order) {
        if (opening !== openingRef.current) break;
        const caseProblem = row.caseId ? caseProblems.get(row.caseId) : undefined;
        if (caseProblem) {
          results[row.key] = { saved: false, message: caseProblem };
          continue;
        }
        const lead = leadFor(row, rows);
        if (lead && !results[lead.key]?.saved) {
          results[row.key] = { saved: false, message: 'This saves once the new lead above is saved.' };
          continue;
        }
        const result = await saveReviewRow(row, userId, { today: day, leadDueTime: dueTime, licenseNote: licenseNoteFor(row) });
        results[row.key] = result;
        if (result.saved) {
          any = true;
          savedCountRef.current += 1;
          const signatures = laterSignatures(row);
          for (const signature of signatures) savedSignaturesRef.current.add(signature);
          // Kept with each recording it came from (every one in this read when
          // its quote is in none), for when that recording is read again.
          // Remembered at once, row by row: if the app is closed or killed
          // part way through, what was saved is still known next time.
          const read = recorderReadRef.current;
          if (read) {
            const from = read.rowIds.get(row.key)?.length ? read.rowIds.get(row.key)! : read.everyId;
            const hashes = signatures.map(signatureHash);
            await rememberSaved(read.recorder, userId, Object.fromEntries(from.map((id) => [id, hashes]))).catch(() => undefined);
          }
        }
        if (opening !== openingRef.current) break;
      }
    } finally {
      savingRef.current = false;
    }
    if (any) onSaved();
    settleRecordings(results, rows);
    if (opening !== openingRef.current) return;
    setSaved(results);
    const failed = order.filter((row) => !results[row.key]?.saved);
    const savedKinds = order.filter((row) => results[row.key]?.saved).map((row) => row.kind);
    const notesToAct = order.filter((row) => results[row.key]?.saved && results[row.key].message).length;
    const extra = notesToAct ? ` ${notesToAct} ${notesToAct === 1 ? 'needs' : 'need'} a step by hand; see the row.` : '';
    // "Saved: …" only when something was (never "Saved: Nothing to add.").
    const savedText = savedLine(savedKinds);
    if (failed.length) {
      setPhase('review');
      setMessage({ ok: false, text: `${failed.length} could not be saved; see the rows.${savedText ? ` ${savedText}` : ''}${extra}` });
    } else if (rows.some((row) => !results[row.key]?.saved && row.include)) {
      setPhase('review');
      setMessage({ ok: true, text: `${savedText ? `${savedText} ` : ''}The rest still need a choice.${extra}` });
    } else {
      setPhase('done');
      setMessage({ ok: true, text: savedText ? `${savedText}${extra}` : `Nothing new was saved.${extra}` });
    }
  }

  // ─── Rows ───────────────────────────────────────────────────────────────

  // A case for a family not in ReferralFit yet: chosen for this row now,
  // created at Approve (nothing is saved before), and offered to the other
  // rows of this review like any case.
  function addNewCase(key: string, title: string) {
    const name = title.trim().slice(0, 120);
    if (!name) return;
    // A case of that name already in ReferralFit (or a new lead's above): that one, not a second.
    const existing = view.cases.find((record) => record.status !== NEW_CASE_STATUS && !CLOSED_STATUSES.has(record.status) && comparable(record.title) === comparable(name));
    const closed = view.cases.find((record) => CLOSED_STATUSES.has(record.status) && comparable(record.title) === comparable(name));
    if (!existing && closed) {
      setMessage({ ok: false, text: `“${closed.title}” is a closed case. Reopen it on Cases, or give the new case another name.` });
      return;
    }
    if (existing) {
      updateRow(key, (current) => chooseCase(current, existing.id, view));
      setCaseDraft(null);
      setMessage({ ok: true, text: `“${existing.title}” is already a case, so the row is on it.` });
      return;
    }
    const same = newCases.find((item) => comparable(item.title) === comparable(name));
    // The person the notes name (with their phone or email) becomes the
    // case's contact, as a new lead's caller does.
    // Only when that person is the family: a follow-up about a professional,
    // or a referral (whose phone is often the program's), gives none.
    const row = rows.find((item) => item.key === key);
    const source = row && (row.kind === 'case_note' || (row.kind === 'follow_up' && row.found.regarding === 'family' && !row.found.organization)) ? row.found : undefined;
    const contact = source && source.personName.trim() && (source.phone || source.email)
      ? { name: source.personName.trim(), phone: source.phone, email: source.email, about: source.aboutRelationship }
      : undefined;
    const pending: PendingCase = same ?? { id: newUuid(), title: name, contact };
    const next = same ? newCases : [...newCases, pending];
    if (!same) setNewCases(next);
    const withIt = withPendingCases(view, next);
    updateRow(key, (current) => chooseCase(current, pending.id, withIt));
    setCaseDraft(null);
  }

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
            onPress={() => { setCaseDraft(null); setPicker(open ? null : { key: row.key, what, query: '' }); }}
            style={styles.pill}
          >
            <Text style={styles.pillText}>{open ? 'Done' : `Find another ${noun}`}</Text>
          </TouchableOpacity>
          {what === 'case' && row.kind !== 'new_lead' && caseDraft?.key !== row.key ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="New case: make a case for this family"
              onPress={() => { setPicker(null); setCaseDraft({ key: row.key, title: suggestedCaseTitle(row) }); }}
              style={styles.pill}
            >
              <Text style={styles.pillText}>+ New case</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {what === 'case' && caseDraft?.key === row.key ? (
          <View style={styles.newCaseForm}>
            <Text style={styles.hint}>Name the new case (the family name and who it is about works well). It is created when you approve this row.</Text>
            <TextInput
              value={caseDraft.title}
              onChangeText={(value) => setCaseDraft({ key: row.key, title: value })}
              maxLength={120}
              returnKeyType="done"
              onSubmitEditing={() => { if (caseDraft.title.trim()) addNewCase(row.key, caseDraft.title); }}
              placeholder="Case name, e.g. Rivera family — son Luis"
              placeholderTextColor={COLORS.gray}
              accessibilityLabel="New case name"
              autoFocus
              style={styles.input}
            />
            <View style={styles.pillRow}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ disabled: !caseDraft.title.trim() }}
                disabled={!caseDraft.title.trim()}
                onPress={() => addNewCase(row.key, caseDraft.title)}
                style={[styles.pill, styles.pillOn, !caseDraft.title.trim() && styles.off]}
              >
                <Text style={[styles.pillText, styles.pillTextOn]}>Use this new case</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" onPress={() => setCaseDraft(null)} style={styles.pill}>
                <Text style={styles.pillText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
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
        {shareToAppSupported || voice.supported
          ? 'Paste notes from your day, share them here from another app (a text thread, an email, a Voice Memos transcript, a note), or record a voice note after a call. ReferralFit finds new leads, notes, follow-ups and referrals, and you approve each one before anything is saved.'
          : 'Paste notes from your day: a summary from Fieldy or Plaud, or your own call notes. ReferralFit finds new leads, notes, follow-ups and referrals, and you approve each one before anything is saved.'}
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
                  <TouchableOpacity accessibilityRole="button" disabled={busy || voiceActive} onPress={() => readRecorderAsking(recorder)} style={[styles.primaryButton, (busy || voiceActive) && styles.off]}>
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
      {fieldySupported && !keyMissing && RECORDERS.some((recorder) => recorders[recorder.id].state === 'on') ? (
        <View style={styles.fieldyCard}>
          <Text style={styles.label}>REMINDER</Text>
          <Text style={styles.hint}>
            {reminder === DAY_REVIEW_REMINDER_OFF
              ? 'No reminder. New recordings still show on Today when you open ReferralFit.'
              : `While recordings wait for your review, ReferralFit reminds you at ${dayReviewReminderLabel(reminder)}.`}
          </Text>
          {reminder !== DAY_REVIEW_REMINDER_OFF && !remindersAllowed ? (
            <Text style={styles.problem}>Notifications are off for ReferralFit on this phone, so no reminder is sent.</Text>
          ) : null}
          <View style={styles.reminderRow}>
            {reminder === DAY_REVIEW_REMINDER_OFF ? (
              <TouchableOpacity accessibilityRole="button" onPress={() => changeReminder(DAY_REVIEW_DEFAULT_TIME)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Turn on the reminder</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remind me earlier, at ${dayReviewReminderLabel(stepDayReviewReminderTime(reminder, -1))}`} onPress={() => changeReminder(stepDayReviewReminderTime(reminder, -1))} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Earlier</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remind me later, at ${dayReviewReminderLabel(stepDayReviewReminderTime(reminder, 1))}`} onPress={() => changeReminder(stepDayReviewReminderTime(reminder, 1))} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Later</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Turn off the reminder" onPress={() => changeReminder(DAY_REVIEW_REMINDER_OFF)} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Turn off</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      ) : null}
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
        <TouchableOpacity accessibilityRole="button" disabled={busy || voiceActive} onPress={() => { void pasteFromClipboard(); }} style={[styles.secondaryButton, voiceActive && styles.off]}>
          <Text style={styles.secondaryButtonText}>Paste</Text>
        </TouchableOpacity>
        {voice.supported ? (
          voiceActive ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Stop the voice note"
              accessibilityState={{ busy: voice.state !== 'listening' }}
              disabled={voice.state === 'stopping'}
              onPress={voice.stop}
              style={[styles.secondaryButton, styles.stopButton]}
            >
              {voice.state === 'listening' ? (
                <Text style={[styles.secondaryButtonText, styles.stopButtonText]}>Stop</Text>
              ) : <ActivityIndicator color={COLORS.white} accessibilityLabel={voice.state === 'asking' ? 'Starting the voice note' : 'Finishing the voice note'} />}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Voice note: say your notes and they are typed into the box" disabled={busy} onPress={startVoiceNote} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Voice note</Text>
            </TouchableOpacity>
          )
        ) : null}
        {notes && !voiceActive ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear the notes" disabled={busy} onPress={() => setNotes('')} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {voice.supported && !voiceActive ? (
        <Text style={styles.hint}>
          Voice note: right after a call, say what happened and it is typed into the box for you to check. {voice.onDevice ? 'Your voice stays on this phone.' : 'Apple turns your voice into text; the sound is not saved.'}
        </Text>
      ) : null}
      {voice.state === 'listening' ? (
        <Text style={styles.listening} accessibilityLiveRegion="polite">Listening… tap Stop when you are done.</Text>
      ) : null}
      <TextInput
        value={notes}
        onChangeText={setNotes}
        multiline
        editable={!busy && !voiceActive}
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
                accessibilityState={{ disabled: busy || voiceActive || keyMissing, busy }}
                disabled={busy || voiceActive || keyMissing || keyState === 'checking'}
                onPress={() => { void find(); }}
                style={[styles.primaryButton, (busy || voiceActive || keyMissing || keyState === 'checking') && styles.off]}
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
  newCaseForm: { gap: 8, marginTop: 8 },
  reminderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
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
  stopButton: { backgroundColor: COLORS.coral, borderColor: COLORS.coral, minWidth: 88 },
  stopButtonText: { color: COLORS.white },
  listening: { fontSize: 13, fontWeight: '700', color: COLORS.coralText, marginTop: 8 },
  off: { opacity: 0.5 },
});
