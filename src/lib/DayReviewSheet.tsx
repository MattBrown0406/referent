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
import type { CaseContact, CaseRecord } from './cases';
import {
  addDays,
  buildRows,
  comparable,
  countLine,
  destination,
  KIND_LABEL,
  rowProblem,
  rowReady,
  type ReviewRow,
  type Workspace,
} from './day-review';
import { requestDayReview, ReviewUnavailableError, saveReviewRow } from './day-review-api';
import { fetchGlobalDirectory } from './directory';
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
  onClose: () => void;
  /** Something was saved: the app reloads. */
  onSaved: () => void;
};

type Phase = 'paste' | 'finding' | 'review' | 'saving' | 'done';

function localDay(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export default function DayReviewSheet({ visible, userId, cases, contacts, partners, followUps, referrals, directoryEntitled, onClose, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>('paste');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [today, setToday] = useState(localDay());
  const [keyState, setKeyState] = useState<'checking' | 'ready' | 'missing'>('checking');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({}); // row key -> '' saved, else the reason
  const [picker, setPicker] = useState<{ key: string; what: 'case' | 'partner'; query: string } | null>(null);
  const [index, setIndex] = useState<DirectoryIndex | null>(null);
  // Bumped on every close: a review or save finishing afterwards changes nothing.
  const openingRef = useRef(0);

  const workspace: Workspace = useMemo(() => ({
    cases, contacts, partners, followUps, referrals, directory: index,
  }), [cases, contacts, partners, followUps, referrals, index]);

  // A fresh sheet each time it opens, and for each account.
  useEffect(() => {
    openingRef.current += 1;
    if (!visible) return;
    setPhase('paste');
    setNotes('');
    setRows([]);
    setSaved({});
    setPicker(null);
    setMessage(null);
    setToday(localDay());
    setKeyState('checking');
    const opening = openingRef.current;
    void getAnthropicKey(userId).then((key) => {
      if (opening === openingRef.current) setKeyState(key ? 'ready' : 'missing');
    });
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

  const pending = rows.filter((row) => saved[row.key] !== '');
  const ready = pending.filter(rowReady);
  const waiting = pending.filter((row) => row.include && !rowReady(row)).length;
  const busy = phase === 'finding' || phase === 'saving';

  function close() {
    if (busy) return;
    const unsaved = phase === 'review' ? pending.some((row) => row.include) : notes.trim().length > 0 && phase === 'paste';
    if (!unsaved) { onClose(); return; }
    Alert.alert('Discard this review?', 'Nothing from these notes has been saved yet.', [
      { text: 'Keep reviewing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
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

  async function find() {
    if (busy) return;
    const text = notes.trim();
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
      setRows(buildRows(items, workspace, day));
      setSaved({});
      setPhase('review');
      if (!items.length) setMessage({ ok: true, text: 'Nothing in these notes needs to go into ReferralFit.' });
    } catch (error) {
      if (opening !== openingRef.current) return;
      if (error instanceof ReviewUnavailableError && error.reason === 'key') setKeyState('missing');
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Review is unavailable right now.' });
      setPhase('paste');
    }
  }

  function patch(key: string, change: Partial<ReviewRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  async function approve() {
    if (busy || !ready.length) return;
    const opening = openingRef.current;
    setPhase('saving');
    setMessage(null);
    const results: Record<string, string> = { ...saved };
    let any = false;
    // One at a time, in order: a lead before the follow-up written about it.
    for (const row of ready) {
      const problem = await saveReviewRow(row, userId, today);
      results[row.key] = problem;
      if (!problem) any = true;
      if (opening !== openingRef.current) break;
    }
    if (any) onSaved();
    if (opening !== openingRef.current) return;
    setSaved(results);
    const failed = ready.filter((row) => results[row.key]);
    const savedKinds = ready.filter((row) => results[row.key] === '').map((row) => row.kind);
    if (failed.length) {
      setPhase('review');
      setMessage({ ok: false, text: `${failed.length} could not be saved. See the rows below. Saved: ${countLine(savedKinds)}` });
    } else if (rows.some((row) => results[row.key] !== '' && row.include)) {
      setPhase('review');
      setMessage({ ok: true, text: `Saved: ${countLine(savedKinds)} The rest still need a choice.` });
    } else {
      setPhase('done');
      setMessage({ ok: true, text: `Saved: ${countLine(savedKinds)}` });
    }
  }

  // ─── Rows ───────────────────────────────────────────────────────────────

  function caseTitle(id: string): string {
    return cases.find((record) => record.id === id)?.title || 'A case';
  }

  function partnerLabel(id: string): string {
    const partner = partners.find((item) => item.id === id);
    return partner ? partner.organization || partner.name : 'A partner';
  }

  function renderChoices(row: ReviewRow, what: 'case' | 'partner') {
    const ids = what === 'case' ? row.caseChoices : row.partnerChoices;
    const chosen = what === 'case' ? row.caseId : row.partnerId;
    const open = picker?.key === row.key && picker.what === what;
    const query = open ? comparable(picker!.query) : '';
    const searched = open && query
      ? (what === 'case'
        ? cases.filter((record) => comparable(record.title).includes(query)).map((record) => record.id)
        : partners.filter((partner) => comparable(`${partner.organization} ${partner.name}`).includes(query)).map((partner) => partner.id)
      ).slice(0, 8)
      : [];
    const shown = [...new Set([...(chosen ? [chosen] : []), ...ids, ...searched])];
    const label = what === 'case' ? caseTitle : partnerLabel;
    return (
      <View style={styles.choices}>
        <Text style={styles.label}>{what === 'case' ? 'CASE' : 'PARTNER'}</Text>
        <View style={styles.pillRow}>
          {shown.map((id) => {
            const on = id === chosen;
            return (
              <TouchableOpacity
                key={id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => patch(row.key, what === 'case'
                  ? { caseId: on ? null : id, clientLabel: !on && row.kind === 'referral' && !row.clientLabel ? caseTitle(id) : row.clientLabel, unsure: false }
                  : { partnerId: on ? null : id, unsure: false })}
                style={[styles.pill, on && styles.pillOn]}
              >
                <Text style={[styles.pillText, on && styles.pillTextOn]} numberOfLines={1}>{label(id)}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setPicker(open ? null : { key: row.key, what, query: '' })}
            style={styles.pill}
          >
            <Text style={styles.pillText}>{open ? 'Done' : 'Find another'}</Text>
          </TouchableOpacity>
        </View>
        {open ? (
          <TextInput
            value={picker!.query}
            onChangeText={(value) => setPicker({ key: row.key, what, query: value })}
            placeholder={what === 'case' ? 'Search cases' : 'Search partners'}
            placeholderTextColor={COLORS.gray}
            autoFocus
            style={styles.input}
          />
        ) : null}
      </View>
    );
  }

  function renderRow(row: ReviewRow) {
    const result = saved[row.key];
    const done = result === '';
    const problem = rowProblem(row);
    const found = row.found;
    return (
      <View key={row.key} style={[styles.row, (!row.include || done) && styles.rowOff]}>
        <View style={styles.rowTop}>
          <View style={styles.flex}>
            <Text style={styles.kind}>{KIND_LABEL[row.kind].toUpperCase()}{found.urgent ? ' · URGENT' : ''}</Text>
            <Text style={styles.destination}>{destination(row, workspace)}</Text>
          </View>
          {done ? <Text style={styles.savedTag}>Saved</Text> : (
            <Switch
              accessibilityLabel={`Include this ${KIND_LABEL[row.kind].toLowerCase()}`}
              value={row.include}
              disabled={busy}
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

        {done ? <Text style={styles.body}>{row.text}</Text> : (
          <TextInput
            value={row.text}
            onChangeText={(value) => patch(row.key, { text: value })}
            multiline
            editable={!busy}
            accessibilityLabel={row.kind === 'follow_up' ? 'Task' : 'Note'}
            style={[styles.input, styles.inputMultiline]}
          />
        )}

        {!done && row.include && row.kind === 'new_lead' ? (
          <View style={styles.fields}>
            <Text style={styles.fieldLabel}>CALLER</Text>
            <TextInput value={row.callerName} onChangeText={(value) => patch(row.key, { callerName: value })} placeholder="Caller's name" placeholderTextColor={COLORS.gray} accessibilityLabel="Caller's name" style={styles.input} />
            <Text style={styles.fieldLabel}>PHONE</Text>
            <TextInput value={row.phone} onChangeText={(value) => patch(row.key, { phone: value })} placeholder="Required" placeholderTextColor={COLORS.gray} keyboardType="phone-pad" accessibilityLabel="Phone" style={styles.input} />
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

        {!done && row.include && (row.kind === 'case_note' || (row.kind === 'follow_up' && (row.caseId || row.caseChoices.length)) || row.kind === 'referral') ? renderChoices(row, 'case') : null}
        {!done && row.include && (row.kind === 'partner_note' || row.kind === 'referral' || (row.kind === 'follow_up' && !row.caseId)) ? renderChoices(row, 'partner') : null}

        {!done && row.include && row.kind === 'follow_up' ? (
          <View style={styles.choices}>
            <Text style={styles.label}>DUE</Text>
            <View style={styles.pillRow}>
              {[...new Set([today, addDays(today, 1), ...(found.dueDate ? [found.dueDate] : [])])].map((day) => {
                const on = row.dueOn === day;
                const label = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : day;
                return (
                  <TouchableOpacity key={day} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => patch(row.key, { dueOn: day })} style={[styles.pill, on && styles.pillOn]}>
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TextInput value={row.dueOn} onChangeText={(value) => patch(row.key, { dueOn: value.trim() })} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.gray} style={styles.input} />
          </View>
        ) : null}

        {!done && row.include && row.kind === 'referral' ? (
          <View style={styles.choices}>
            <Text style={styles.label}>{found.direction === 'received' ? 'REFERRED TO YOU' : 'YOU REFERRED'} · CLIENT LABEL</Text>
            <TextInput value={row.clientLabel} onChangeText={(value) => patch(row.key, { clientLabel: value })} placeholder="Initials or a private label" placeholderTextColor={COLORS.gray} style={styles.input} />
          </View>
        ) : null}

        {!done && row.include && row.kind === 'new_partner' && row.candidate ? (
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
                      onPress={() => patch(row.key, { candidate: { ...row.candidate!, types: on ? row.candidate!.types.filter((item) => item !== type) : [...row.candidate!.types, type] } })}
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
        {row.hint && !done ? <Text style={styles.hint}>{row.hint}</Text> : null}
        {row.unsure && !done && row.include ? <Text style={styles.hint}>Matched by name only. Check it.</Text> : null}
        {result ? <Text style={styles.problem}>{result}</Text> : null}
        {!done && row.include && problem && !result ? <Text style={styles.problem}>{problem}</Text> : null}
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
          <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => setNotes('')} style={styles.secondaryButton}>
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
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close review" disabled={busy} onPress={close} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, busy && styles.off]}>{phase === 'done' ? 'Done' : 'Cancel'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Review notes</Text>
          <View style={styles.headerButton} />
        </View>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {phase === 'paste' || phase === 'finding' ? pasteScreen : null}
            {message ? (
              <View style={[styles.notice, message.ok && styles.noticeOk]} accessibilityRole="alert">
                <Text style={[styles.noticeText, message.ok && styles.noticeTextOk]}>{message.text}</Text>
              </View>
            ) : null}
            {phase === 'review' || phase === 'saving' || phase === 'done' ? (
              <>
                {rows.length ? <Text style={styles.label}>FROM YOUR NOTES · {countLine(rows.map((row) => row.kind)).replace(/\.$/, '').toUpperCase()}</Text> : null}
                {rows.map(renderRow)}
                {phase !== 'done' ? (
                  <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { setPhase('paste'); setMessage(null); }} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Back to the notes</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : null}
          </ScrollView>
          <View style={styles.footer}>
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
                    <ActivityIndicator color={COLORS.white} />
                    <Text style={styles.primaryButtonText}>Reading your notes…</Text>
                  </View>
                ) : <Text style={styles.primaryButtonText}>Find what's in it</Text>}
              </TouchableOpacity>
            ) : phase === 'done' ? (
              <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.primaryButton}>
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
                  {phase === 'saving' ? <ActivityIndicator color={COLORS.white} /> : (
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
  intro: { fontSize: 14, lineHeight: 20, color: COLORS.gray },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 4 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 14, marginBottom: 8 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  notice: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12, marginTop: 12 },
  noticeOk: { backgroundColor: COLORS.mintPale },
  noticeText: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, fontWeight: '600' },
  noticeTextOk: { color: COLORS.forest },
  input: { minHeight: 44, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: COLORS.ink },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  notesInput: { minHeight: 220, marginTop: 12, textAlignVertical: 'top' },
  fields: { gap: 6 },
  fieldLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 4 },
  fieldRow: { flexDirection: 'row', gap: 8 },
  row: { backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 14, marginBottom: 10, gap: 8 },
  rowOff: { opacity: 0.6 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  kind: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.forest },
  destination: { fontSize: 13, color: COLORS.inkSoft, marginTop: 3 },
  body: { fontSize: 15, lineHeight: 21, color: COLORS.ink },
  savedTag: { fontSize: 13, fontWeight: '800', color: COLORS.forest },
  urgent: { backgroundColor: COLORS.coralPale, borderRadius: 10, padding: 10 },
  urgentText: { fontSize: 13, lineHeight: 18, color: COLORS.coralText, fontWeight: '700' },
  quote: { fontSize: 12, lineHeight: 17, color: COLORS.gray, fontStyle: 'italic' },
  problem: { fontSize: 12, fontWeight: '700', color: COLORS.coralText },
  choices: { gap: 6 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 36, maxWidth: '100%', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillOn: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextOn: { color: COLORS.white },
  footer: { padding: 14, gap: 8, borderTopWidth: 1, borderTopColor: COLORS.line, backgroundColor: COLORS.white },
  footerHint: { fontSize: 12, color: COLORS.gray, textAlign: 'center' },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  secondaryButton: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', marginTop: 8 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 15, fontWeight: '800' },
  off: { opacity: 0.5 },
});
