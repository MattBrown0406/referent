import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Partner } from '../data';
import { ShieldChip } from './CredentialsCard';
import { OfflineError, describeError } from './errors';
import { formatStamp, type ProgramIntegrity } from './integrity';
import { releaseComposeOverlay, sendEmailMessage, sendTextMessage } from './outreach-api';
import {
  cancelPlacementRequest,
  closePlacementRequest,
  fetchPlacementPracticeName,
  logManualAnswer,
  type PlacementRequestsHook,
} from './placement-api';
import {
  ACCEPT_LABELS,
  BED_LABELS,
  COMPARE_SORTS,
  STATUS_LABELS,
  acceptingAnswers,
  canLogAnswer,
  draftFromRecipient,
  effectiveRecipientStatus,
  emptyAnswerDraft,
  isAnswered,
  normalizeAnswerDraft,
  placementRequestMessage,
  placementSummaryLines,
  quotedRateLine,
  requestProgress,
  requestStatusLine,
  sentOnStamp,
  sortRecipients,
  withRecipient,
  type AcceptAnswer,
  type AnswerDraft,
  type BedAnswer,
  type CompareSort,
  type PlacementRecipient,
  type PlacementRequest,
  type PlacementRequestView,
} from './placement-requests';
import { WEB_PAGE } from './web-layout';

// The answers, side by side: one row per program in the practice's own
// ranked order (rank: its place on the match screen when the request went
// out, sent as p_ranks, so the numbers here are the ones the practitioner
// saw there; never changed by an answer), with its status,
// bed, likely to accept, earliest admit, cost, and note. "Log answer" for a
// program that answered by phone or text; "Choose this program" hands off to
// the app's own Assign & refer / Send packet flow (this screen never refers
// anyone itself). One native Modal: the log form opens inside it.
//
// ETHICS: answers NEVER change ranking or scores. The other sorts (earliest
// admit, lowest rate) only reorder this list on screen; nothing is written
// back to matching. The family-cost estimate is the practitioner's own,
// never shown to a program.

export type CompareChoice = 'refer' | 'packet';

type Props = {
  /** The request to show; null hides the screen. */
  requestId: string | null;
  placement: PlacementRequestsHook;
  partnersById: Map<string, Partner>;
  senderName: string;
  /** How the practitioner labels this request (the saved match's label). */
  labelFor: (request: PlacementRequest) => string;
  integrityFor: (partnerId: string) => ProgramIntegrity | undefined;
  /** The family's estimated cost at this program (feature 2), when the estimator has what it needs. */
  familyCostLineFor: (view: PlacementRequestView, partner: Partner) => string | null;
  /** Whether the request's saved match is still there to refer from. */
  canChoose: (view: PlacementRequestView) => boolean;
  onClose: () => void;
  onSwitch: (requestId: string) => void;
  /** The app closes this screen first, then runs its own flow. */
  onChoose: (view: PlacementRequestView, partner: Partner, choice: CompareChoice) => void;
};

type LogState = { recipient: PlacementRecipient; draft: AnswerDraft; problem: string; saving: boolean };

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#B9553B',
  coralPale: '#F7E7E1',
  gold: '#7A5A14',
  goldPale: '#F7EFD9',
  gray: '#73827D',
  grayPale: '#F3F3EF',
  line: '#DDE4DF',
};

const STATUS_TONE: Record<string, { color: string; background: string }> = {
  responded: { color: COLORS.forest, background: COLORS.mintPale },
  declined: { color: COLORS.coral, background: COLORS.coralPale },
  viewed: { color: COLORS.gold, background: COLORS.goldPale },
  sent: { color: COLORS.gray, background: COLORS.grayPale },
  expired: { color: COLORS.gray, background: COLORS.grayPale },
};

export default function PlacementCompare({
  requestId, placement, partnersById, senderName, labelFor, integrityFor, familyCostLineFor, canChoose, onClose, onSwitch, onChoose,
}: Props) {
  const visible = Boolean(requestId);
  const [sort, setSort] = useState<CompareSort>('ranked');
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [log, setLog] = useState<LogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [practiceName, setPracticeName] = useState('');
  const generationRef = useRef(0);
  const composingRef = useRef(false);
  const placementRef = useRef(placement);
  placementRef.current = placement;

  const view = requestId ? placement.state.requests.find((item) => item.request.id === requestId) || null : null;

  useEffect(() => {
    if (!requestId) {
      releaseComposeOverlay();
      placementRef.current.releaseKept();
    }
  }, [requestId]);
  useEffect(() => () => {
    generationRef.current += 1;
    releaseComposeOverlay();
  }, []);

  // Answers are read fresh every time the screen opens (online only).
  useEffect(() => {
    if (!requestId) return;
    const generation = ++generationRef.current;
    setSort('ranked');
    setLog(null);
    setBusy(false);
    setOffline(false);
    setLoading(true);
    setNow(new Date());
    void fetchPlacementPracticeName().then((name) => { if (generationRef.current === generation) setPracticeName(name); });
    // Its own request too: a push can be about one older than the newest read.
    void placementRef.current.reload(requestId).then((status) => {
      if (generationRef.current !== generation) return;
      setLoading(false);
      setOffline(status === 'offline');
    });
  }, [requestId]);

  // What the practitioner has now seen (Today stops calling these new).
  const seenKey = view ? `${view.request.id}:${view.recipients.map((item) => item.respondedAt || '').join(',')}` : '';
  useEffect(() => {
    if (view && !loading && !offline) placementRef.current.markSeen(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenKey, loading, offline]);

  // Deadlines read right while the screen stays open.
  useEffect(() => {
    if (!requestId) return undefined;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [requestId]);

  if (!requestId) return null;

  async function refresh() {
    const generation = generationRef.current;
    setLoading(true);
    const status = await placement.reload(requestId ?? undefined);
    if (generationRef.current !== generation) return;
    setLoading(false);
    setOffline(status === 'offline');
    setNow(new Date());
  }

  function startLog(recipient: PlacementRecipient) {
    setLog({ recipient, draft: recipient.respondedAt ? draftFromRecipient(recipient) : emptyAnswerDraft(), problem: '', saving: false });
  }

  async function saveLog() {
    if (!log || !view || log.saving) return;
    const checked = normalizeAnswerDraft(log.draft, sentOnStamp(view.request));
    if ('problem' in checked) {
      setLog({ ...log, problem: checked.problem });
      return;
    }
    const generation = generationRef.current;
    setLog({ ...log, problem: '', saving: true });
    try {
      const saved = await logManualAnswer(log.recipient.id, checked.fields);
      if (generationRef.current !== generation) return;
      placement.replace(withRecipient(view, saved));
      setLog(null);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setLog((current) => current && {
        ...current,
        saving: false,
        problem: error instanceof OfflineError ? 'You are offline, so it is not logged yet. Try again when you are back online.' : describeError(error, 'Could not log the answer.'),
      });
    }
  }

  function finish(kind: 'close' | 'cancel') {
    if (!view || busy) return;
    const title = kind === 'close' ? 'Close this request?' : 'Cancel this request?';
    const message = kind === 'close'
      ? 'Programs see that you found a placement and can no longer answer. Answers you have stay here.'
      : 'Programs see that the request is closed and can no longer answer. Answers you have stay here.';
    Alert.alert(title, message, [
      { text: 'Keep it open', style: 'cancel' },
      {
        text: kind === 'close' ? 'Close request' : 'Cancel request',
        style: kind === 'cancel' ? 'destructive' : 'default',
        onPress: () => {
          const generation = generationRef.current;
          setBusy(true);
          (kind === 'close' ? closePlacementRequest(view.request.id) : cancelPlacementRequest(view.request.id))
            .then((next) => { if (generationRef.current === generation) placement.replace(next); })
            .catch((error) => {
              if (generationRef.current !== generation) return;
              Alert.alert('Not changed', error instanceof OfflineError ? 'You are offline. Try again when you are back online.' : describeError(error));
            })
            .finally(() => { if (generationRef.current === generation) setBusy(false); });
        },
      },
    ]);
  }

  function choose(partner: Partner) {
    if (!view) return;
    const name = partner.organization || partner.name;
    Alert.alert(
      `Choose ${name}?`,
      'Next, refer the family the usual way. Nothing about the client goes to the program until you send the packet.',
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Send packet', onPress: () => onChoose(view, partner, 'packet') },
        { text: 'Assign & refer', onPress: () => onChoose(view, partner, 'refer') },
      ],
    );
  }

  async function reach(recipient: PlacementRecipient, partner: Partner, how: 'text' | 'email') {
    if (!view || composingRef.current) return;
    const message = placementRequestMessage({
      payload: view.request.payload,
      programName: partner.organization || partner.name,
      practiceName,
      senderName,
      respondBy: view.request.respondBy,
    });
    composingRef.current = true;
    let result;
    try {
      result = how === 'text' ? await sendTextMessage(partner.phone, message.text) : await sendEmailMessage(partner.email, message.subject, message.body);
    } finally {
      composingRef.current = false;
    }
    if (result === 'failed') Alert.alert('Unable to open', 'This device cannot send that. Call them instead, then log their answer.');
  }

  function renderRow(recipient: PlacementRecipient) {
    if (!view) return null;
    const partner = recipient.partnerId ? partnersById.get(recipient.partnerId) || null : null;
    const status = effectiveRecipientStatus(recipient.status, view.request.respondBy, now);
    const tone = STATUS_TONE[status] || STATUS_TONE.sent;
    const integrity = partner ? integrityFor(partner.id) : undefined;
    const cost = partner ? familyCostLineFor(view, partner) : null;
    const answered = isAnswered(recipient);
    const rate = quotedRateLine(recipient.dailyRate);
    const loggable = canLogAnswer(view.request, recipient);
    // The summary asks for an answer by the deadline: only while it is still ahead.
    const reachable = partner && recipient.channel === 'manual' && !answered && acceptingAnswers(view.request, now);
    return (
      <View key={recipient.id} style={styles.row}>
        <View style={styles.rowTop}>
          <View style={styles.rankBadge}><Text style={styles.rankText}>{recipient.rank}</Text></View>
          <View style={styles.flex}>
            <Text style={styles.programName} numberOfLines={2}>{partner?.organization || recipient.programName}</Text>
            <Text style={styles.rowMeta}>{recipient.channel === 'portal' ? (recipient.enteredByPractice ? 'Logged by your practice' : 'Answers in ReferralFit') : answered ? 'Logged by your practice' : 'Answers by phone or text'}</Text>
          </View>
          <View style={[styles.statusPill, { backgroundColor: tone.background }]}><Text style={[styles.statusText, { color: tone.color }]}>{STATUS_LABELS[status]}</Text></View>
        </View>
        {integrity ? <View style={styles.chipRow}><ShieldChip integrity={integrity} /></View> : null}
        {answered ? (
          <View style={styles.answer}>
            <View style={styles.answerGrid}>
              <AnswerCell label="Bed" value={recipient.bedAvailable ? BED_LABELS[recipient.bedAvailable] : 'Not said'} />
              <AnswerCell label="Likely to accept" value={recipient.likelyAccept ? ACCEPT_LABELS[recipient.likelyAccept] : 'Not said'} />
              <AnswerCell label="Earliest admit" value={recipient.earliestAdmitOn ? formatStamp(recipient.earliestAdmitOn) : 'Not said'} />
            </View>
            {rate ? <Text style={styles.costLine}>{rate}</Text> : null}
            {recipient.costNote ? <Text style={styles.costLine}>Cost: {recipient.costNote}</Text> : null}
            {recipient.note ? <Text style={styles.programNote}>“{recipient.note}”</Text> : null}
          </View>
        ) : (
          <Text style={styles.waiting}>{status === 'expired' ? 'No answer by the deadline. You can still log one if they call back.' : recipient.channel === 'portal' ? (status === 'viewed' ? 'They opened it and have not answered yet.' : 'Not opened yet.') : 'Waiting for their reply.'}</Text>
        )}
        {cost ? <Text style={styles.familyCost}>Family's estimate: {cost}</Text> : null}
        <View style={styles.rowActions}>
          {reachable && partner?.phone.trim() ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Text the summary to ${partner.organization}`} onPress={() => { void reach(recipient, partner, 'text'); }} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Text summary</Text>
            </TouchableOpacity>
          ) : null}
          {reachable && partner?.email.trim() ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Email the summary to ${partner.organization}`} onPress={() => { void reach(recipient, partner, 'email'); }} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Email summary</Text>
            </TouchableOpacity>
          ) : null}
          {loggable ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Log ${recipient.programName}'s answer`} onPress={() => startLog(recipient)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{answered ? 'Edit answer' : 'Log answer'}</Text>
            </TouchableOpacity>
          ) : null}
          {partner && canChoose(view) ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Choose ${partner.organization}`} onPress={() => choose(partner)} style={styles.chooseButton}>
              <Text style={styles.chooseButtonText}>Choose this program</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  function renderLog() {
    if (!log || !view) return null;
    const draft = log.draft;
    const update = (patch: Partial<AnswerDraft>) => setLog({ ...log, draft: { ...draft, ...patch }, problem: '' });
    return (
      <>
        <Text style={styles.sectionTitle}>{log.recipient.programName}</Text>
        <Text style={styles.body}>What did they tell you? This stays in your workspace; the program does not see it.</Text>
        <Text style={styles.label}>BED</Text>
        <View style={styles.pillRow}>
          {(['yes', 'no', 'waitlist'] as BedAnswer[]).map((value) => (
            <Choice key={value} label={BED_LABELS[value]} selected={draft.bed === value} onPress={() => update({ bed: value })} />
          ))}
        </View>
        <Text style={styles.label}>LIKELY TO ACCEPT</Text>
        <View style={styles.pillRow}>
          {(['yes', 'maybe', 'no'] as AcceptAnswer[]).map((value) => (
            <Choice key={value} label={value === 'yes' ? 'Yes' : value === 'maybe' ? 'Maybe' : 'No'} selected={draft.likely === value} onPress={() => update({ likely: value })} />
          ))}
        </View>
        <Text style={styles.label}>EARLIEST ADMIT (OPTIONAL)</Text>
        <TextInput style={styles.input} value={draft.admitOn} onChangeText={(admitOn) => update({ admitOn })} placeholder="YYYY-MM-DD" placeholderTextColor="#99A6A1" autoCapitalize="none" accessibilityLabel="Earliest admit date" />
        <Text style={styles.label}>DAILY RATE (OPTIONAL)</Text>
        <TextInput style={styles.input} value={draft.dailyRate} onChangeText={(dailyRate) => update({ dailyRate })} placeholder="Whole dollars per day" placeholderTextColor="#99A6A1" keyboardType="number-pad" accessibilityLabel="Daily rate in dollars" />
        <Text style={styles.label}>COST NOTE (OPTIONAL)</Text>
        <TextInput style={styles.input} value={draft.costNote} onChangeText={(costNote) => update({ costNote })} placeholder="e.g. In-network with most plans" placeholderTextColor="#99A6A1" maxLength={200} accessibilityLabel="Cost note" />
        <Text style={styles.label}>NOTE (OPTIONAL)</Text>
        <TextInput style={[styles.input, styles.multiline]} value={draft.note} onChangeText={(note) => update({ note })} multiline maxLength={300} accessibilityLabel="Note" />
        {log.problem ? <Text style={styles.notice}>{log.problem}</Text> : null}
        <TouchableOpacity accessibilityRole="button" disabled={log.saving} onPress={() => { void saveLog(); }} style={[styles.primaryButton, log.saving && styles.buttonBusy]}>
          {log.saving ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>Save answer</Text>}
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" disabled={log.saving} onPress={() => setLog(null)} style={styles.textButton}>
          <Text style={styles.textButtonText}>Back to answers</Text>
        </TouchableOpacity>
      </>
    );
  }

  function renderList() {
    if (offline) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Answers load when you're online</Text>
          <Text style={styles.emptyBody}>Programs answer on ReferralFit's server, so this screen needs a connection.</Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => { void refresh(); }} style={styles.secondaryButtonWide}><Text style={styles.secondaryButtonText}>Try again</Text></TouchableOpacity>
        </View>
      );
    }
    if (!view) {
      return loading
        ? <ActivityIndicator style={styles.loading} color={COLORS.forest} />
        : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>This request is not available</Text>
            <Text style={styles.emptyBody}>It may belong to another workspace, or it was sent before you joined. Pull to refresh on Today and try again.</Text>
          </View>
        );
    }
    const progress = requestProgress(view, now);
    const rows = sortRecipients(view.recipients, sort);
    const siblings = placement.state.requests
      .filter((item) => item.request.matchProfileId && item.request.matchProfileId === view.request.matchProfileId)
      .sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt));
    return (
      <>
        <Text style={styles.anchor} numberOfLines={2}>{labelFor(view.request)}</Text>
        <Text style={styles.progress}>{progress.label}</Text>
        <Text style={styles.hint}>{requestStatusLine(view, now)}</Text>
        {siblings.length > 1 ? (
          <View style={styles.pillRow}>
            {siblings.map((item) => (
              <Choice key={item.request.id} label={`Sent ${formatStamp(item.request.createdAt.slice(0, 10))}`} selected={item.request.id === view.request.id} onPress={() => onSwitch(item.request.id)} />
            ))}
          </View>
        ) : null}
        <Text style={styles.label}>ORDER</Text>
        <View style={styles.pillRow}>
          {COMPARE_SORTS.map((option) => <Choice key={option.value} label={option.label} selected={sort === option.value} onPress={() => setSort(option.value)} />)}
        </View>
        <Text style={styles.hint}>Numbers are each program's place in your match results when you asked. Answers never change it; sorting only reorders this list.</Text>
        {loading ? <ActivityIndicator style={styles.inlineLoading} color={COLORS.forest} /> : null}
        {rows.map(renderRow)}
        <Text style={styles.label}>WHAT YOU ASKED</Text>
        <View style={styles.summaryCard}>
          {placementSummaryLines(view.request.payload).map((line) => (
            <Text key={line.label} style={styles.summaryLine}><Text style={styles.summaryLabel}>{line.label}: </Text>{line.value}</Text>
          ))}
        </View>
        {view.request.status === 'open' ? (
          <View style={styles.finishRow}>
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => finish('close')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>We found a placement</Text></TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => finish('cancel')} style={styles.textButtonInline}><Text style={styles.cancelText}>Cancel request</Text></TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity accessibilityRole="button" onPress={() => { void refresh(); }} style={styles.textButton}><Text style={styles.textButtonText}>Refresh answers</Text></TouchableOpacity>
      </>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={log?.saving ? () => undefined : onClose}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close answers" disabled={Boolean(log?.saving)} onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>Program answers</Text>
            <View style={styles.headerButton} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            {log ? renderLog() : renderList()}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function AnswerCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.answerCell}>
      <Text style={styles.answerLabel}>{label}</Text>
      <Text style={styles.answerValue}>{value}</Text>
    </View>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.pill, selected && styles.pillSelected]}>
      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  content: { padding: 18, paddingBottom: 48 },
  anchor: { fontSize: 20, fontWeight: '800', color: COLORS.ink },
  progress: { fontSize: 15, fontWeight: '800', color: COLORS.forest, marginTop: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: COLORS.ink, marginTop: 4 },
  body: { fontSize: 14, lineHeight: 20, color: COLORS.inkSoft, marginTop: 6 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 16, marginBottom: 6 },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 6 },
  notice: { fontSize: 13, lineHeight: 18, color: COLORS.coral, marginTop: 8 },
  loading: { marginTop: 40 },
  inlineLoading: { marginTop: 10 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  pill: { minHeight: 38, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillSelected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextSelected: { color: COLORS.white },
  row: { marginTop: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  rankBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.mint, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontSize: 13, fontWeight: '900', color: COLORS.forest },
  programName: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  rowMeta: { fontSize: 12, color: COLORS.gray, marginTop: 2 },
  statusPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { fontSize: 11, fontWeight: '800' },
  chipRow: { flexDirection: 'row', marginTop: 8 },
  answer: { marginTop: 10 },
  answerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  answerCell: { minWidth: 92, flexGrow: 1, padding: 8, borderRadius: 10, backgroundColor: COLORS.mintPale },
  answerLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: COLORS.gray },
  answerValue: { fontSize: 13, fontWeight: '700', color: COLORS.ink, marginTop: 2 },
  costLine: { fontSize: 13, color: COLORS.inkSoft, marginTop: 8 },
  programNote: { fontSize: 13, lineHeight: 18, color: COLORS.ink, marginTop: 8, fontStyle: 'italic' },
  waiting: { fontSize: 13, color: COLORS.gray, marginTop: 10 },
  familyCost: { fontSize: 12, fontWeight: '700', color: COLORS.inkSoft, marginTop: 8 },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  secondaryButton: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.mintPale, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonWide: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.mintPale, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 13, fontWeight: '800' },
  chooseButton: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  chooseButtonText: { color: COLORS.white, fontSize: 13, fontWeight: '800' },
  summaryCard: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white },
  summaryLine: { fontSize: 13, lineHeight: 19, color: COLORS.ink },
  summaryLabel: { fontWeight: '800', color: COLORS.inkSoft },
  finishRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 },
  textButtonInline: { minHeight: 40, justifyContent: 'center' },
  cancelText: { color: COLORS.coral, fontSize: 14, fontWeight: '700' },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.ink },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  buttonBusy: { opacity: 0.7 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  textButtonText: { color: COLORS.inkSoft, fontSize: 15, fontWeight: '700' },
  empty: { padding: 16, borderRadius: 12, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, marginTop: 12 },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  emptyBody: { fontSize: 14, lineHeight: 20, color: COLORS.gray, marginTop: 4 },
});
