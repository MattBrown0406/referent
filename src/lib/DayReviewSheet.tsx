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
  saveOrder,
  switchKind,
  withPendingLeads,
  type ReviewRow,
  type RowContext,
  type Workspace,
} from './day-review';
import { requestDayReview, ReviewUnavailableError, saveReviewRow, type SaveResult } from './day-review-api';
import { fetchGlobalDirectory } from './directory';
import { sourceFor, type FieldyBlock } from './fieldy';
import {
  commitFieldyRead,
  connectFieldy,
  disconnectFieldy,
  FieldyError,
  fieldyStatus,
  fieldySupported,
  readNewFieldyConversations,
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
  /** Opened from "From your day" (the Today card or the evening reminder): read Fieldy at once. */
  startWithFieldy?: boolean;
  /** Fieldy was read, connected or disconnected: the Today card counts again. */
  onFieldyChanged?: () => void;
};

type Phase = 'paste' | 'finding' | 'review' | 'saving' | 'done';

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
  startWithFieldy = false, onFieldyChanged,
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
  // Fieldy: connected or not, and the conversations this review was read from
  // (committed as read once something from them is saved, or nothing was found).
  const [fieldy, setFieldy] = useState<{ state: 'checking' | 'off' | 'on' | 'busy'; email: string }>({ state: 'checking', email: '' });
  const fieldyReadRef = useRef<{ blocks: FieldyBlock[]; through: string | null } | null>(null);

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
    fieldyReadRef.current = null;
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
    setFieldy({ state: 'checking', email: '' });
    void Promise.all([getAnthropicKey(userId), fieldyStatus(userId)]).then(([key, status]) => {
      if (opening !== openingRef.current) return;
      setKeyState(key ? 'ready' : 'missing');
      setFieldy({ state: status.connected ? 'on' : 'off', email: status.email });
      if (startWithFieldy && status.connected && key) void readFieldy(opening);
    });
    // readFieldy is this opening's own; startWithFieldy is read once, as the sheet opens.
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

  function finish() {
    openingRef.current += 1;
    clearReview();
    onClose();
  }

  function close() {
    if (busy) return;
    const unsaved = phase === 'review'
      ? pending.some((row) => row.include)
      : phase === 'paste' && notes.trim().length > 0;
    if (!unsaved) { finish(); return; }
    const kept = savedCountRef.current;
    Alert.alert(
      'Discard this review?',
      kept
        ? `${kept} ${kept === 1 ? 'item you approved stays' : 'items you approved stay'} saved. Nothing else from these notes is saved.`
        : 'Nothing from these notes has been saved yet.',
      [
        { text: 'Keep reviewing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: finish },
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

  async function find(fromFieldy: { text: string; blocks: FieldyBlock[]; through: string | null } | null = null) {
    if (busy && !fromFieldy) return;
    const text = (fromFieldy ? fromFieldy.text : notes).trim();
    if (!fromFieldy) fieldyReadRef.current = null;
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
      const blocks = fromFieldy?.blocks ?? null;
      const built = markSavedBefore(
        buildRows(items, workspaceRef.current, day, newUuid, blocks ? (found) => sourceFor(found.evidence, blocks) : undefined),
        savedSignaturesRef.current,
      );
      setRows(built);
      setSaved({});
      setPicker(null);
      setPhase('review');
      if (fromFieldy) fieldyReadRef.current = { blocks: fromFieldy.blocks, through: fromFieldy.through };
      if (!items.length) {
        setMessage({ ok: true, text: fromFieldy ? 'Nothing in your new Fieldy conversations needs to go into ReferralFit.' : 'Nothing in these notes needs to go into ReferralFit.' });
        // Nothing to approve: these conversations are done.
        if (fromFieldy) void commitFieldyRead(userId, fromFieldy.through).then(() => onFieldyChanged?.());
      }
    } catch (error) {
      if (opening !== openingRef.current) return;
      if (error instanceof ReviewUnavailableError && error.reason === 'key') setKeyState('missing');
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Review is unavailable right now.' });
      setPhase('paste');
    }
  }

  // ─── Fieldy ──────────────────────────────────────────────────────────────

  async function connect() {
    if (busy || fieldy.state === 'busy') return;
    const opening = openingRef.current;
    setFieldy((current) => ({ ...current, state: 'busy' }));
    setMessage(null);
    try {
      const status = await connectFieldy(userId);
      if (opening !== openingRef.current) return;
      setFieldy({ state: 'on', email: status.email });
      onFieldyChanged?.();
      setMessage({ ok: true, text: status.email ? `Fieldy is connected (${status.email}).` : 'Fieldy is connected.' });
    } catch (error) {
      if (opening !== openingRef.current) return;
      setFieldy({ state: 'off', email: '' });
      if (!(error instanceof FieldyError && error.reason === 'cancelled')) {
        setMessage({ ok: false, text: error instanceof Error ? error.message : 'Fieldy could not connect right now.' });
      }
    }
  }

  function disconnect() {
    if (busy || fieldy.state === 'busy') return;
    Alert.alert('Disconnect Fieldy?', 'ReferralFit stops reading your Fieldy conversations, and its access is removed at Fieldy. Nothing already saved in ReferralFit changes.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          setFieldy((current) => ({ ...current, state: 'busy' }));
          void disconnectFieldy(userId).finally(() => {
            setFieldy({ state: 'off', email: '' });
            onFieldyChanged?.();
          });
        },
      },
    ]);
  }

  /** The conversations since the last read, straight into the review. */
  async function readFieldy(opening = openingRef.current) {
    if (fieldy.state === 'busy' || savingRef.current) return;
    setMessage(null);
    setPhase('finding');
    let read;
    try {
      read = await readNewFieldyConversations(userId);
    } catch (error) {
      if (opening !== openingRef.current) return;
      setPhase('paste');
      if (error instanceof FieldyError && error.reason === 'disconnected') setFieldy({ state: 'off', email: '' });
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Fieldy could not be read right now.' });
      return;
    }
    if (opening !== openingRef.current) return;
    if (!read.blocks.length) {
      setPhase('paste');
      setMessage({
        ok: true,
        text: read.later
          ? 'Fieldy is still writing the summary of your latest conversation. Try again in a little while.'
          : 'No new Fieldy conversations since the last review.',
      });
      if (read.through) void commitFieldyRead(userId, read.through).then(() => onFieldyChanged?.());
      return;
    }
    setNotes(read.text);
    await find({ text: read.text, blocks: read.blocks, through: read.through });
    if (opening === openingRef.current && read.later) {
      setMessage((current) => current ?? { ok: true, text: `${read.later} more ${read.later === 1 ? 'conversation waits' : 'conversations wait'} for the next review.` });
    }
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
          for (const signature of rowSignatures(row)) savedSignaturesRef.current.add(signature);
        }
        if (opening !== openingRef.current) break;
      }
    } finally {
      savingRef.current = false;
    }
    if (any) onSaved();
    // Something from these Fieldy conversations is saved: the next read starts after them.
    if (any && fieldyReadRef.current) {
      const through = fieldyReadRef.current.through;
      void commitFieldyRead(userId, through).then(() => onFieldyChanged?.());
    }
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
              onValueChange={(include) => patch(row.key, { include })}
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
      {fieldySupported && !keyMissing ? (
        <View style={styles.fieldyCard}>
          <Text style={styles.label}>FIELDY</Text>
          {fieldy.state === 'on' ? (
            <>
              <Text style={styles.hint}>Connected{fieldy.email ? ` as ${fieldy.email}` : ''}. ReferralFit reads your new conversations here; you approve each item.</Text>
              <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void readFieldy(); }} style={[styles.primaryButton, busy && styles.off]}>
                <Text style={styles.primaryButtonText}>Read new Fieldy conversations</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={disconnect} style={styles.textButton}>
                <Text style={styles.hint}>Disconnect Fieldy</Text>
              </TouchableOpacity>
            </>
          ) : fieldy.state === 'checking' ? (
            <ActivityIndicator color={COLORS.forest} accessibilityLabel="Checking Fieldy" />
          ) : (
            <>
              <Text style={styles.hint}>Wear Fieldy? Connect it once and ReferralFit reads your conversations for you: no copying or pasting. You sign in to Fieldy; your sign-in stays on this phone.</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: fieldy.state === 'busy' }} disabled={busy || fieldy.state === 'busy'} onPress={() => { void connect(); }} style={[styles.secondaryButton, (busy || fieldy.state === 'busy') && styles.off]}>
                {fieldy.state === 'busy' ? <ActivityIndicator color={COLORS.forest} accessibilityLabel="Connecting" /> : <Text style={styles.secondaryButtonText}>Connect Fieldy</Text>}
              </TouchableOpacity>
            </>
          )}
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
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={phase === 'done' ? 'Done' : 'Close review'} disabled={busy} onPress={close} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, busy && styles.off]}>{phase === 'done' ? 'Done' : 'Cancel'}</Text>
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
              <TouchableOpacity accessibilityRole="button" onPress={finish} style={styles.primaryButton}>
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
