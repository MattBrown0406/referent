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
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { CaseEvent } from './cases';
import {
  buildDraftRequest,
  channelAvailable,
  describeDue,
  firstName,
  OUTREACH_INTERVAL_HOURS,
  outreachHistory,
  suggestedChannel,
  targetAnchor,
  templateDraft,
  type CallDraft,
  type CallResult,
  type OutreachChannel,
  type OutreachDraft,
  type OutreachRecipient,
  type OutreachTarget,
} from './outreach';
import { AiKeySetup } from './AiDraftKey';
import {
  aiKeysSupported,
  DraftUnavailableError,
  fetchPracticeName,
  getAnthropicKey,
  placeCall,
  releaseComposeOverlay,
  requestOutreachDraft,
  sendEmailMessage,
  sendTextMessage,
} from './outreach-api';
import type { FollowUp, Touch } from './store';

// The outreach sheet: pick who and how (text, email, or call), start from a
// plain draft or ask the AI for one, edit it, and send it from the phone's own
// Messages or Mail (or dial). When the send is confirmed — or the call is
// logged — the app records it and sets the next follow-up 48 hours out
// (OutreachSent → App.recordOutreach). Nothing is ever sent from the server.

export type OutreachSheetRequest = {
  target: OutreachTarget;
  recipients: OutreachRecipient[];
  initialRecipientKey?: string;
  startedFrom?: FollowUp;
};

export type OutreachSent = {
  target: OutreachTarget;
  recipient: OutreachRecipient;
  channel: OutreachChannel;
  sentAt: Date;
  startedFromId?: string;
  callResult?: CallResult;
};

type Props = {
  request: OutreachSheetRequest | null;
  userId: string;
  senderName: string;
  touches: Touch[];
  caseEvents: CaseEvent[]; // events already loaded for the open case, if any
  loadCaseEvents: (caseId: string) => Promise<CaseEvent[]>;
  onClose: () => void;
  // Records the outreach; resolves to the next follow-up that was set, or
  // null when the write was refused (the app has already said why).
  onSent: (sent: OutreachSent) => Promise<FollowUp | null>;
};

type Stage = 'compose' | 'setup' | 'confirm_sent' | 'call_result' | 'saving' | 'done';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#D9795F',
  coralPale: '#F7E7E1',
  coralInk: '#B0603F',
  gray: '#73827D',
  line: '#DDE4DF',
};

const CHANNEL_LABEL: Record<OutreachChannel, string> = { text: 'Text', email: 'Email', call: 'Call' };

function sendLabel(channel: OutreachChannel, recipient: OutreachRecipient | null): string {
  const who = recipient ? firstName(recipient.name) || recipient.name : '';
  if (channel === 'text') return 'Open in Messages';
  if (channel === 'email') return 'Open in Mail';
  return who ? `Call ${who}` : 'Call';
}

function draftIsEmpty(draft: OutreachDraft | undefined): boolean {
  if (!draft) return true;
  if (draft.channel === 'call') return !draft.opener.trim() && !draft.voicemail.trim();
  return !draft.body.trim();
}

export default function OutreachSheet({ request, userId, senderName, touches, caseEvents, loadCaseEvents, onClose, onSent }: Props) {
  const visible = Boolean(request);
  const [stage, setStage] = useState<Stage>('compose');
  const [recipientKey, setRecipientKey] = useState<string>('');
  const [channel, setChannel] = useState<OutreachChannel>('text');
  const [drafts, setDrafts] = useState<Partial<Record<OutreachChannel, OutreachDraft>>>({});
  const [edited, setEdited] = useState<Partial<Record<OutreachChannel, boolean>>>({});
  const [instructions, setInstructions] = useState('');
  const [practiceName, setPracticeName] = useState('');
  const [history, setHistory] = useState(() => ({ count: 0, lastChannel: '' as OutreachChannel | '', lastAt: '' }));
  const [drafting, setDrafting] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [nextFollowUp, setNextFollowUp] = useState<FollowUp | null>(null);
  const [pendingCallResult, setPendingCallResult] = useState<CallResult | null>(null);
  const [logNotice, setLogNotice] = useState('');
  const [keyProblem, setKeyProblem] = useState(false); // Anthropic refused the saved key
  const [composerSaidSent, setComposerSaidSent] = useState(false); // Messages/Mail reported it sent
  const openGeneration = useRef(0);
  const sendingRef = useRef(false); // a second tap before re-render must not open Messages twice
  const draftingRef = useRef(false); // …or request (and bill) two drafts
  const stageRef = useRef<Stage>('compose');
  stageRef.current = stage;
  const recordingRef = useRef(false); // …or log the same send twice
  const sentAtRef = useRef<Date | null>(null);

  const target = request?.target ?? null;
  const recipients = request?.recipients ?? [];
  const recipient = recipients.find((item) => item.key === recipientKey) || recipients[0] || null;
  const draft = drafts[channel];

  // Closed (or gone): no Messages / Mail sheet can still be up over it.
  useEffect(() => {
    if (!request) releaseComposeOverlay();
  }, [request]);
  useEffect(() => releaseComposeOverlay, []);

  // Fresh state every time the sheet opens for a new request.
  useEffect(() => {
    if (!request) return;
    const generation = ++openGeneration.current;
    const first = request.recipients.find((item) => item.key === request.initialRecipientKey) || request.recipients[0] || null;
    const knownHistory = outreachHistory(request.target, caseEvents, touches);
    setStage('compose');
    setRecipientKey(first?.key || '');
    setDrafts({});
    setEdited({});
    setInstructions('');
    setDraftNotice('');
    setDrafting(false);
    setSending(false);
    setNextFollowUp(null);
    setPendingCallResult(null);
    setLogNotice('');
    setKeyProblem(false);
    setComposerSaidSent(false);
    draftingRef.current = false; // a draft still in flight from before belongs to the old sheet
    setHistory(knownHistory);
    setChannel(suggestedChannel(first, knownHistory, request.startedFrom?.kind));
    sentAtRef.current = null;

    void fetchPracticeName().then((name) => {
      if (openGeneration.current === generation) setPracticeName(name);
    });
    // A case opened from Today has no events in memory yet; the case file's
    // saved copy (or the server) says how many times the family was reached.
    if (request.target.kind === 'case' && !caseEvents.some((event) => event.caseId === (request.target as { caseId: string }).caseId)) {
      const caseId = request.target.caseId;
      void loadCaseEvents(caseId)
        .then((events) => {
          if (openGeneration.current !== generation) return;
          const loaded = outreachHistory(request.target, events, touches);
          setHistory(loaded);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // A plain starting draft for the chosen channel, refreshed until the user
  // edits it (so the practice name lands once it loads).
  useEffect(() => {
    if (!request || !recipient || edited[channel]) return;
    setDrafts((current) => ({
      ...current,
      [channel]: templateDraft({ channel, target: request.target, recipient, senderName, practiceName, history }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, recipientKey, channel, practiceName, history, senderName]);

  const channelChoices = useMemo(() => (['text', 'email', 'call'] as OutreachChannel[]).map((item) => ({
    channel: item,
    enabled: channelAvailable(recipient, item),
  })), [recipient]);

  function updateDraft(next: OutreachDraft) {
    setDrafts((current) => ({ ...current, [next.channel]: next }));
    setEdited((current) => ({ ...current, [next.channel]: true }));
  }

  function chooseRecipient(key: string) {
    setRecipientKey(key);
    setEdited({});
    const next = recipients.find((item) => item.key === key) || null;
    if (!channelAvailable(next, channel)) setChannel(suggestedChannel(next, history, request?.startedFrom?.kind));
  }

  // AI drafts run on the user's own Anthropic key (the app is free). No key on
  // this phone yet → the setup screen, which explains what is shared first.
  async function draftWithAi(savedKey?: string) {
    if (!request || !recipient || draftingRef.current) return;
    if (!aiKeysSupported) {
      setDraftNotice('AI drafts are set up in the iPhone app. The starting draft below is yours to edit.');
      return;
    }
    draftingRef.current = true;
    const generation = openGeneration.current;
    const apiKey = savedKey || await getAnthropicKey(userId);
    if (!apiKey) {
      draftingRef.current = false;
      if (openGeneration.current === generation) setStage('setup');
      return;
    }
    const forChannel = channel;
    setDrafting(true);
    setDraftNotice('');
    try {
      const { draft: aiDraft, remaining } = await requestOutreachDraft(buildDraftRequest({
        channel: forChannel,
        target: request.target,
        recipient,
        senderName,
        practiceName,
        history,
        purposeKind: request.startedFrom?.kind,
        instructions,
        now: new Date(),
      }), apiKey);
      if (openGeneration.current !== generation) return;
      if (aiDraft.channel !== forChannel) throw new DraftUnavailableError('The draft came back for the wrong channel. Try again.', 'unavailable');
      updateDraft(aiDraft);
      if (remaining !== null && remaining <= 5) setDraftNotice(`${remaining} AI ${remaining === 1 ? 'draft' : 'drafts'} left today.`);
    } catch (error) {
      if (openGeneration.current !== generation) return;
      setKeyProblem(error instanceof DraftUnavailableError && error.reason === 'key');
      setDraftNotice(error instanceof DraftUnavailableError ? error.message : 'Drafting is unavailable right now. The starting draft below is yours to edit.');
    } finally {
      draftingRef.current = false;
      if (openGeneration.current === generation) setDrafting(false);
    }
  }

  function keySaved(apiKey: string) {
    if (stageRef.current !== 'setup') return; // the user moved on; nothing is drafted
    setKeyProblem(false);
    setDraftNotice('');
    setStage('compose');
    void draftWithAi(apiKey);
  }

  async function record(callResult?: CallResult) {
    if (!request || !recipient || recordingRef.current) return;
    const generation = openGeneration.current;
    recordingRef.current = true;
    setStage('saving');
    let next: FollowUp | null;
    try {
      next = await onSent({
        target: request.target,
        recipient,
        channel,
        sentAt: sentAtRef.current || new Date(),
        startedFromId: request.startedFrom?.id,
        callResult,
      });
    } finally {
      recordingRef.current = false;
    }
    if (openGeneration.current !== generation) return;
    if (next) {
      setNextFollowUp(next);
      setStage('done');
    } else {
      // The message already went out; only the log failed (the app said
      // why). Stay on the question so it can be logged again without
      // sending twice.
      setLogNotice('It is not logged yet. Try again in a moment.');
      setStage(channel === 'call' ? 'call_result' : 'confirm_sent');
    }
  }

  async function send() {
    if (!request || !recipient || sendingRef.current) return;
    if (!channelAvailable(recipient, channel)) {
      Alert.alert('Nothing to send to', channel === 'email' ? `${recipient.name} has no email address on file.` : `${recipient.name} has no phone number on file.`);
      return;
    }
    if (channel !== 'call' && draftIsEmpty(draft)) {
      Alert.alert('Nothing to send', 'Write a message first, or draft one.');
      return;
    }
    sendingRef.current = true;
    setSending(true);
    const startedAt = new Date();
    let result;
    try {
      if (channel === 'text' && draft?.channel === 'text') result = await sendTextMessage(recipient.phone, draft.body.trim());
      else if (channel === 'email' && draft?.channel === 'email') result = await sendEmailMessage(recipient.email, draft.subject.trim(), draft.body.trim());
      else result = await placeCall(recipient.phone);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    sentAtRef.current = startedAt;
    if (result === 'failed') {
      Alert.alert('Unable to open', channel === 'email' ? 'This device has no way to send email. Nothing was logged.' : channel === 'text' ? 'This device cannot send texts. Nothing was logged.' : 'This device cannot place calls. Nothing was logged.');
      return;
    }
    if (channel === 'call') {
      setPendingCallResult(null);
      setStage('call_result');
      return;
    }
    if (result === 'cancelled') {
      setDraftNotice('Not sent, so nothing was logged. Your draft is still here.');
      return;
    }
    if (result === 'sent') {
      setComposerSaidSent(true);
      await record();
      return;
    }
    setStage('confirm_sent');
  }

  if (!request || !target) return null;
  const anchor = targetAnchor(target);
  const noRecipients = recipients.length === 0;

  function renderDraftEditor() {
    if (!draft) return null;
    if (draft.channel === 'text') {
      return (
        <>
          <Text style={styles.label}>MESSAGE</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={draft.body}
            onChangeText={(body) => updateDraft({ channel: 'text', body })}
            multiline
            accessibilityLabel="Text message"
          />
          <Text style={styles.hint}>{draft.body.length} characters</Text>
        </>
      );
    }
    if (draft.channel === 'email') {
      return (
        <>
          <Text style={styles.label}>SUBJECT</Text>
          <TextInput
            style={styles.input}
            value={draft.subject}
            onChangeText={(subject) => updateDraft({ ...draft, subject })}
            accessibilityLabel="Email subject"
          />
          <Text style={styles.label}>MESSAGE</Text>
          <TextInput
            style={[styles.input, styles.multilineTall]}
            value={draft.body}
            onChangeText={(body) => updateDraft({ ...draft, body })}
            multiline
            accessibilityLabel="Email message"
          />
        </>
      );
    }
    const call = draft as CallDraft;
    return (
      <>
        <Text style={styles.label}>OPENER</Text>
        <TextInput style={[styles.input, styles.multiline]} value={call.opener} onChangeText={(opener) => updateDraft({ ...call, opener })} multiline accessibilityLabel="Call opener" />
        <Text style={styles.label}>TALKING POINTS</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={call.talkingPoints.join('\n')}
          onChangeText={(text) => updateDraft({ ...call, talkingPoints: text.split('\n') })}
          multiline
          accessibilityLabel="Talking points, one per line"
        />
        <Text style={styles.hint}>One per line. These are notes for you, not a script to read.</Text>
        <Text style={styles.label}>IF IT GOES TO VOICEMAIL</Text>
        <TextInput style={[styles.input, styles.multiline]} value={call.voicemail} onChangeText={(voicemail) => updateDraft({ ...call, voicemail })} multiline accessibilityLabel="Voicemail" />
      </>
    );
  }

  function renderCompose() {
    if (noRecipients) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No one to reach yet</Text>
          <Text style={styles.emptyBody}>
            {target?.kind === 'case'
              ? 'Add a contact with a phone number or email to this case, then draft the follow-up.'
              : 'Add a phone number or email to this partner, then draft the follow-up.'}
          </Text>
        </View>
      );
    }
    return (
      <>
        {recipients.length > 1 ? (
          <>
            <Text style={styles.label}>TO</Text>
            <View style={styles.pillRow}>
              {recipients.map((item) => {
                const selected = item.key === recipient?.key;
                return (
                  <TouchableOpacity key={item.key} accessibilityRole="button" accessibilityState={{ selected, disabled: drafting }} disabled={drafting} onPress={() => chooseRecipient(item.key)} style={[styles.pill, selected && styles.pillSelected]}>
                    <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{item.relationship ? `${item.name} (${item.relationship})` : item.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        ) : (
          <Text style={styles.toLine}>To {recipient?.name}{recipient?.relationship ? ` (${recipient.relationship})` : ''}</Text>
        )}

        <Text style={styles.label}>HOW</Text>
        <View style={styles.segment}>
          {channelChoices.map((choice) => {
            const selected = choice.channel === channel;
            return (
              <TouchableOpacity
                key={choice.channel}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: !choice.enabled || drafting }}
                accessibilityLabel={choice.enabled ? CHANNEL_LABEL[choice.channel] : `${CHANNEL_LABEL[choice.channel]} — not on file`}
                disabled={!choice.enabled || drafting}
                onPress={() => setChannel(choice.channel)}
                style={[styles.segmentItem, selected && styles.segmentItemSelected, !choice.enabled && styles.segmentItemDisabled]}
              >
                <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{CHANNEL_LABEL[choice.channel]}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.hint}>
          {history.count === 0 ? 'First outreach on this timeline.' : `Outreach #${history.count + 1}${history.lastChannel ? ` · last was a ${history.lastChannel === 'call' ? 'call' : history.lastChannel}` : ''}.`}
        </Text>

        <Text style={styles.label}>ANYTHING TO MENTION? (OPTIONAL)</Text>
        <TextInput
          style={[styles.input, styles.multilineShort]}
          value={instructions}
          onChangeText={setInstructions}
          placeholder="e.g. I can talk Thursday afternoon"
          placeholderTextColor="#99A6A1"
          multiline
          maxLength={500}
          accessibilityLabel="Anything to mention in the draft"
        />
        <Text style={styles.hint}>Used only for the AI draft. Leave out health details and last names.</Text>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Draft a ${CHANNEL_LABEL[channel].toLowerCase()} with AI`}
          disabled={drafting}
          onPress={() => { void draftWithAi(); }}
          style={[styles.secondaryButton, drafting && styles.buttonBusy]}
        >
          {drafting ? <ActivityIndicator color={COLORS.forest} /> : <Text style={styles.secondaryButtonText}>✦ Draft with AI</Text>}
        </TouchableOpacity>
        {draftNotice ? <Text style={styles.notice}>{draftNotice}</Text> : null}
        {keyProblem ? (
          <TouchableOpacity accessibilityRole="button" onPress={() => setStage('setup')} style={styles.textButton}>
            <Text style={styles.textButtonText}>Update your Anthropic key</Text>
          </TouchableOpacity>
        ) : null}

        {renderDraftEditor()}

        <TouchableOpacity accessibilityRole="button" disabled={sending} onPress={() => { void send(); }} style={[styles.primaryButton, sending && styles.buttonBusy]}>
          {sending ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>{sendLabel(channel, recipient)}</Text>}
        </TouchableOpacity>
        <Text style={styles.footnote}>
          {channel === 'call'
            ? `After the call, log how it went and the next follow-up is set ${OUTREACH_INTERVAL_HOURS} hours out.`
            : `You send it from ${channel === 'text' ? 'Messages' : 'Mail'}. Once it is sent, it is logged and the next follow-up is set ${OUTREACH_INTERVAL_HOURS} hours out.`}
        </Text>
      </>
    );
  }

  function renderSetup() {
    return (
      <View>
        <Text style={styles.consentTitle}>Turn on AI drafts</Text>
        <AiKeySetup
          userId={userId}
          saveLabel="Save key and draft"
          onSaved={keySaved}
          onCancel={() => setStage('compose')}
          cancelLabel="Not now — I’ll write it myself"
        />
      </View>
    );
  }

  function renderConfirmSent() {
    return (
      <View>
        <Text style={styles.consentTitle}>{composerSaidSent ? 'Sent, but not logged yet' : 'Did it go out?'}</Text>
        {logNotice ? <Text style={styles.notice}>{logNotice}</Text> : null}
        <Text style={styles.consentBody}>
          {composerSaidSent
            ? `Your message went out. Log it to set the next follow-up ${OUTREACH_INTERVAL_HOURS} hours out — there is no need to send it again.`
            : `${channel === 'text' ? 'Messages' : 'Your mail app'} doesn’t tell ReferralFit whether you sent it. If you did, it’s logged and the next follow-up is set ${OUTREACH_INTERVAL_HOURS} hours out.`}
        </Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => { void record(); }} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{composerSaidSent ? 'Log it' : 'Yes, I sent it'}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={() => { setDraftNotice('Not sent, so nothing was logged.'); setStage('compose'); }} style={styles.textButton}>
          <Text style={styles.textButtonText}>No, not yet</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function renderCallResult() {
    const choices: { value: CallResult; label: string }[] = [
      { value: 'talked', label: 'We talked' },
      { value: 'voicemail', label: 'Left a voicemail' },
      { value: 'no_answer', label: 'No answer' },
    ];
    return (
      <View>
        <Text style={styles.consentTitle}>How did the call go?</Text>
        {logNotice ? <Text style={styles.notice}>{logNotice}</Text> : null}
        <Text style={styles.consentBody}>The call is logged and the next follow-up is set {OUTREACH_INTERVAL_HOURS} hours out. You can change that step afterward.</Text>
        {choices.map((choice) => {
          const selected = pendingCallResult === choice.value;
          return (
            <TouchableOpacity
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setPendingCallResult(choice.value)}
              style={[styles.choice, selected && styles.choiceSelected]}
            >
              <View style={[styles.radio, selected && styles.radioSelected]} />
              <Text style={styles.choiceTitle}>{choice.label}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          accessibilityRole="button"
          disabled={!pendingCallResult}
          onPress={() => { if (pendingCallResult) void record(pendingCallResult); }}
          style={[styles.primaryButton, !pendingCallResult && styles.buttonDisabled]}
        >
          <Text style={styles.primaryButtonText}>Log the call</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={() => { setDraftNotice('No call logged.'); setStage('compose'); }} style={styles.textButton}>
          <Text style={styles.textButtonText}>I didn’t call</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function renderDone() {
    const due = nextFollowUp ? describeDue(nextFollowUp.dueOn, nextFollowUp.dueTime, new Date()) : '';
    return (
      <View>
        <Text style={styles.consentTitle}>{channel === 'call' ? 'Call logged' : 'Sent and logged'}</Text>
        <Text style={styles.consentBody}>
          Next follow-up with {anchor}: {due}. It will be on Today when it comes due.
        </Text>
        <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const busyClose = stage === 'saving';
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={busyClose ? () => undefined : onClose}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close follow-up" disabled={busyClose} onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>{stage === 'done' ? 'Close' : 'Cancel'}</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>Follow up</Text>
            <View style={styles.headerButton} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.anchor} numberOfLines={2}>{anchor}</Text>
            {stage === 'compose' ? renderCompose() : null}
            {stage === 'setup' ? renderSetup() : null}
            {stage === 'confirm_sent' ? renderConfirmSent() : null}
            {stage === 'call_result' ? renderCallResult() : null}
            {stage === 'saving' ? <ActivityIndicator style={styles.saving} color={COLORS.forest} /> : null}
            {stage === 'done' ? renderDone() : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  content: { padding: 18, paddingBottom: 48 },
  anchor: { fontSize: 20, fontWeight: '800', color: COLORS.ink, marginBottom: 4 },
  toLine: { fontSize: 15, color: COLORS.inkSoft, marginTop: 4 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 16, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.ink },
  multilineShort: { minHeight: 64, textAlignVertical: 'top' },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  multilineTall: { minHeight: 180, textAlignVertical: 'top' },
  hint: { fontSize: 12, color: COLORS.gray, marginTop: 6 },
  notice: { fontSize: 13, lineHeight: 18, color: COLORS.coralInk, marginTop: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillSelected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextSelected: { color: COLORS.white },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, overflow: 'hidden', backgroundColor: COLORS.white },
  segmentItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  segmentItemSelected: { backgroundColor: COLORS.forest },
  segmentItemDisabled: { opacity: 0.35 },
  segmentText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  segmentTextSelected: { color: COLORS.white },
  secondaryButton: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.mintPale, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 15, fontWeight: '800' },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  buttonBusy: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.4 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  textButtonText: { color: COLORS.inkSoft, fontSize: 15, fontWeight: '700' },
  footnote: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 10, textAlign: 'center' },
  consentTitle: { fontSize: 18, fontWeight: '800', color: COLORS.ink, marginTop: 12 },
  consentBody: { fontSize: 15, lineHeight: 21, color: COLORS.inkSoft, marginTop: 10 },
  consentBullet: { fontSize: 14, lineHeight: 20, color: COLORS.inkSoft, marginTop: 6, paddingLeft: 4 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginTop: 10 },
  choiceSelected: { borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: COLORS.line },
  radioSelected: { borderColor: COLORS.forest, backgroundColor: COLORS.forest },
  choiceTitle: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  empty: { padding: 16, borderRadius: 12, backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.line, marginTop: 12 },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  emptyBody: { fontSize: 14, lineHeight: 20, color: COLORS.gray, marginTop: 4 },
  saving: { marginTop: 40 },
});
