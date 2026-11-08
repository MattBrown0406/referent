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

import type { Partner, ReferralMatch } from '../data';
import { ShieldChip } from './CredentialsCard';
import { OfflineError, describeError } from './errors';
import type { ProgramIntegrity } from './integrity';
import { releaseComposeOverlay, sendEmailMessage, sendTextMessage } from './outreach-api';
import {
  cachedPlacementAnswerLink,
  cancelPlacementRequest,
  createPlacementRequest,
  fetchPlacementAnswerLink,
  prefetchPlacementAnswerLinks,
  fetchPlacementChannels,
  fetchPlacementPracticeName,
  newPlacementRequestId,
  placementRequestExists,
  sendFailureOf,
} from './placement-api';
import {
  ADMIT_WINDOWS,
  ALREADY_SENT_PROBLEM,
  DEFAULT_RESPONSE_HOURS,
  MAX_RECIPIENTS,
  NEW_SEND_KEY,
  NOTE_MAX,
  NOTE_WARNING,
  NOT_SHARED_LINE,
  PROGRAM_INTRO,
  RESPONSE_WINDOW_HOURS,
  UNNAMED_PRACTICE,
  acceptingAnswers,
  deadlineLabel,
  nextSendKey,
  placementNoteNames,
  placementNoteProblem,
  placementRequestMessage,
  placementRequestSignature,
  placementSummaryLines,
  preparePlacementRequest,
  sendKeyId,
  sentDiffersFromReview,
  showsTryAgain,
  type AdmitWindow,
  type PlacementChannel,
  type PlacementRequestView,
  type ResponseWindowHours,
  type ReviewedRequest,
  type SendKey,
} from './placement-requests';
import { WEB_PAGE } from './web-layout';

// "Ask programs": from a saved match's ranked results, send ONE
// de-identified request to up to 8 programs, then (for programs that do not
// answer in the center portal) text or email them the same summary from the
// phone's own Messages or Mail. One native Modal whose content changes by
// stage (Fabric: never a second sheet on top); every question is an Alert;
// Messages and Mail present over it the way the follow-up sheet's do.
//
// ETHICS: programs are listed in the practice's own ranked order and asked
// in that order. Answers never change ranking or scores, programs cannot pay
// to be asked, and nothing here identifies the client: the server builds the
// payload itself from the saved match's criteria.

export type PlacementOption = {
  partner: Partner;
  /** 1-based place in the ranked results on screen. */
  rank: number;
  /** Type and place, as the match card shows it. */
  line: string;
  integrity?: ProgramIntegrity | null;
};

export type PlacementSheetRequest = {
  /** Saved: the server builds the payload from it. */
  match: ReferralMatch;
  /** The linked case's title: the note may not mention it. */
  caseTitle?: string;
  /** The linked case's contact names: the note may not mention them either. */
  contactNames?: string[];
  /** The ranked results, best first. */
  options: PlacementOption[];
};

type Props = {
  request: PlacementSheetRequest | null;
  senderName: string;
  onClose: () => void;
  /** The request went out (shown at once on Today and the match). */
  onSent: (view: PlacementRequestView) => void;
  /** "See answers": the app closes this sheet, then opens the comparison. */
  onOpenAnswers: (requestId: string) => void;
};

type Stage = 'pick' | 'review' | 'sending' | 'sent';
type Outreach = 'texted' | 'emailed' | 'opened';

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
  gray: '#73827D',
  line: '#DDE4DF',
};

// How many of the ranked results are offered (the request goes to at most 8).
const OPTIONS_SHOWN = 15;
const PRESELECTED = 3;

// A request id the server has not definitely answered for, by saved match
// (lower case), kept while the app runs: closing and reopening the sheet
// for that match sends the next request under the same id, so one that did
// go out (the sheet closed, or the answer was lost) is never sent twice.
// Cleared by a definite answer: sent, refused, or the earlier one cancelled.
// Kept only until it is known to have gone out (it exists on the server),
// and cleared on sign-out and workspace changes (clearUnansweredSendKeys).
const unansweredSendKeys = new Map<string, SendKey>();

/** Forget every kept id: called when the account or workspace changes. */
export function clearUnansweredSendKeys(): void {
  unansweredSendKeys.clear();
}

function hoursLabel(hours: ResponseWindowHours): string {
  return `${hours} hours`;
}

export default function PlacementRequestSheet({ request, senderName, onClose, onSent, onOpenAnswers }: Props) {
  const visible = Boolean(request);
  const [stage, setStage] = useState<Stage>('pick');
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState<ResponseWindowHours>(DEFAULT_RESPONSE_HOURS);
  const [admitWindow, setAdmitWindow] = useState<AdmitWindow>('asap');
  const [note, setNote] = useState('');
  const [channels, setChannels] = useState<Record<string, PlacementChannel> | null>(null);
  const [channelNotice, setChannelNotice] = useState('');
  const [practiceName, setPracticeName] = useState('');
  const [sendNotice, setSendNotice] = useState('');
  const [sent, setSent] = useState<PlacementRequestView | null>(null);
  const [outreach, setOutreach] = useState<Record<string, Outreach>>({});
  // The program whose answer link is being made right now (native only).
  const [preparingId, setPreparingId] = useState<string | null>(null);

  // Programs asked by hand: make their answer links now, so a tap never waits.
  useEffect(() => {
    if (sent) prefetchPlacementAnswerLinks(sent.recipients.filter((item) => item.channel === 'manual').map((item) => item.id));
  }, [sent]);
  // The server kept an earlier request under this id as first written: the
  // practitioner is told, and offered Cancel before sending a new one.
  const [conflict, setConflict] = useState<{ requestId: string; cancelling: boolean } | null>(null);
  const generationRef = useRef(0);
  // The request id (placement-requests.ts SendKey): kept after a send whose
  // outcome is unknown, whatever is changed before the next send, so a
  // request that did go out is never sent twice; new only after a definite
  // refusal or a confirmed cancel. A ref for the id the next send uses; the
  // state copy decides whether the button says "Try again".
  const sendKeyRef = useRef<SendKey>(NEW_SEND_KEY);
  const [sendKey, setSendKeyState] = useState<SendKey>(NEW_SEND_KEY);
  const sendingRef = useRef(false);
  const composingRef = useRef(false);

  const options = useMemo(() => (request?.options || []).slice(0, OPTIONS_SHOWN), [request]);

  function setSendKey(key: SendKey) {
    sendKeyRef.current = key;
    setSendKeyState(key);
  }

  // The key, and whether this match keeps an unanswered id beyond the sheet.
  function keepSendKey(matchId: string, key: SendKey) {
    setSendKey(key);
    if (key.id) unansweredSendKeys.set(matchId.toLowerCase(), { id: key.id, retryFor: null });
    else unansweredSendKeys.delete(matchId.toLowerCase());
  }

  // Closed (or gone): no Messages / Mail sheet can still be up over it, and
  // a send or cancel still in flight is ignored when it answers, so no
  // Alert ever appears while the sheet is going away.
  useEffect(() => {
    if (request) return;
    generationRef.current += 1;
    releaseComposeOverlay();
  }, [request]);
  useEffect(() => () => {
    generationRef.current += 1;
    releaseComposeOverlay();
  }, []);

  // Fresh state every time the sheet opens.
  useEffect(() => {
    if (!request) return;
    const generation = ++generationRef.current;
    setStage('pick');
    setSelected(request.options.slice(0, Math.min(PRESELECTED, MAX_RECIPIENTS)).map((option) => option.partner.id));
    setHours(DEFAULT_RESPONSE_HOURS);
    setAdmitWindow('asap');
    setNote('');
    setChannels(null);
    setChannelNotice('');
    setSendNotice('');
    setSent(null);
    setOutreach({});
    setConflict(null);
    const kept = unansweredSendKeys.get(request.match.id.toLowerCase());
    setSendKey(kept ?? NEW_SEND_KEY);
    if (kept?.id) {
      // If the request it was kept for is on the server, it went out: the
      // next request is a new one. If the server can't be asked, keep it.
      const keptId = kept.id;
      const matchKey = request.match.id.toLowerCase();
      void placementRequestExists(keptId).then((exists) => {
        if (exists !== true) return;
        if (unansweredSendKeys.get(matchKey)?.id === keptId) unansweredSendKeys.delete(matchKey);
        if (generationRef.current !== generation || sendKeyRef.current.id !== keptId) return;
        setSendKey(NEW_SEND_KEY);
        setSendNotice('Your earlier request went out. Its answers are on Today; this one will be a new request.');
      });
    }
    sendingRef.current = false;
    composingRef.current = false;
    void fetchPlacementPracticeName().then((name) => { if (generationRef.current === generation) setPracticeName(name); });
    fetchPlacementChannels(request.options.slice(0, OPTIONS_SHOWN).map((option) => option.partner.id))
      .then((result) => { if (generationRef.current === generation) setChannels(result || {}); })
      .catch((error) => {
        if (generationRef.current !== generation) return;
        setChannels({});
        setChannelNotice(error instanceof OfflineError
          ? 'You are offline. Placement requests send when you are back online.'
          : 'Could not check which programs answer in ReferralFit. You can still send.');
      });
  }, [request]);

  // The note may not name the client: the match's label (its words and its
  // initials), the linked case's title, or any of its contacts
  // (identifying-text.ts, as the server checks).
  const names = useMemo(
    () => (request ? placementNoteNames({ caseTitle: request.caseTitle, contactNames: request.contactNames }) : []),
    [request],
  );
  const prepared = useMemo(() => {
    if (!request) return null;
    return preparePlacementRequest({ criteria: request.match, admitWindow, note, names, label: request.match.clientLabel });
  }, [request, admitWindow, note, names]);

  if (!request) return null;
  const match = request.match;
  const noteProblem = note.trim() ? placementNoteProblem(note, names, match.clientLabel) : null;
  const chosen = options.filter((option) => selected.includes(option.partner.id)); // ranked order
  // What programs read as the sender (public.placement_practice_name); ''
  // only while it loads or when it could not be read.
  const practiceShown = practiceName || UNNAMED_PRACTICE;
  const reviewed: ReviewedRequest | null = prepared && !('problem' in prepared)
    ? { partnerIds: chosen.map((option) => option.partner.id), note: prepared.note, respondHours: hours, admitWindow }
    : null;
  const reviewedSignature = reviewed ? placementRequestSignature(reviewed) : null;

  function toggle(partnerId: string) {
    if (stage !== 'pick') return;
    setSelected((current) => {
      if (current.includes(partnerId)) return current.filter((id) => id !== partnerId);
      if (current.length >= MAX_RECIPIENTS) return current;
      return [...current, partnerId];
    });
  }

  function channelLine(partner: Partner): { text: string; portal: boolean } {
    const channel = channels?.[partner.id.toLowerCase()];
    if (channel === 'portal') return { text: 'Answers in ReferralFit', portal: true };
    if (channels === null) return { text: 'Checking how they answer…', portal: false };
    if (partner.phone.trim() || partner.email.trim()) return { text: 'You text or email them the summary', portal: false };
    return { text: 'No phone or email on file: call them, then log the answer', portal: false };
  }

  function goToReview() {
    if (!chosen.length) {
      Alert.alert('Choose a program', 'Pick at least one program to ask.');
      return;
    }
    if (prepared && 'problem' in prepared) {
      Alert.alert('Check the note', prepared.problem);
      return;
    }
    setSendNotice('');
    setStage('review');
  }

  async function send() {
    if (!prepared || 'problem' in prepared || !reviewed || sendingRef.current || conflict) return;
    sendingRef.current = true;
    const generation = generationRef.current;
    const signature = placementRequestSignature(reviewed);
    const id = sendKeyId(sendKeyRef.current, newPlacementRequestId);
    // Unanswered until the server answers: kept even if the sheet goes away.
    keepSendKey(match.id, { id, retryFor: null });
    setStage('sending');
    setSendNotice('');
    try {
      const view = await createPlacementRequest({
        id,
        matchProfileId: match.id,
        partnerIds: reviewed.partnerIds,
        // Each program's place on the match screen: the answers screen
        // numbers them the same way.
        ranks: chosen.map((option) => option.rank),
        respondHours: reviewed.respondHours,
        admitWindow: reviewed.admitWindow,
        note: reviewed.note,
      });
      if (generationRef.current !== generation) return;
      if (!acceptingAnswers(view.request, new Date())) {
        // The id was kept for a request that has since been cancelled,
        // closed, or has expired: nothing new went out. The next send is a
        // new request.
        keepSendKey(match.id, NEW_SEND_KEY);
        setStage('review');
        setSendNotice('Your earlier request is already closed, so nothing new went out. Tap Send to ask again.');
        return;
      }
      onSent(view);
      if (sentDiffersFromReview(view, reviewed)) {
        // The server kept what this id first carried: not what was just
        // reviewed. Say so, and offer to cancel it.
        setStage('review');
        setConflict({ requestId: view.request.id, cancelling: false });
        return;
      }
      keepSendKey(match.id, NEW_SEND_KEY);
      setSent(view);
      setStage('sent');
    } catch (error) {
      if (generationRef.current !== generation) return;
      setStage('review');
      const failure = sendFailureOf(error);
      // Refused: nothing went out, and the next send is a new request.
      // Already sent: the id stays with that request until it is cancelled.
      // Unknown: it may have gone out, so the next send keeps this id.
      keepSendKey(match.id, nextSendKey(id, { type: 'failed', failure, signature }));
      if (failure === 'already_sent') {
        setConflict({ requestId: id, cancelling: false });
        return;
      }
      setSendNotice(error instanceof OfflineError
        ? 'You are offline, so it may not have gone out. Try again when you are back online; it will not be sent twice.'
        : describeError(error, 'Could not send the request.'));
    } finally {
      sendingRef.current = false;
    }
  }

  // Cancel the request the server kept, then this one can go out as a new
  // request (a new id).
  async function cancelEarlier() {
    if (!conflict || conflict.cancelling) return;
    const generation = generationRef.current;
    setConflict({ ...conflict, cancelling: true });
    try {
      const view = await cancelPlacementRequest(conflict.requestId);
      if (generationRef.current !== generation) return;
      onSent(view);
      keepSendKey(match.id, nextSendKey(conflict.requestId, { type: 'cancelled' }));
      setConflict(null);
      setSendNotice('The earlier request is cancelled. Send this one when you are ready.');
    } catch (error) {
      if (generationRef.current !== generation) return;
      setConflict((current) => (current ? { ...current, cancelling: false } : current));
      Alert.alert('Not cancelled', error instanceof OfflineError ? 'You are offline. Try again when you are back online.' : describeError(error));
    }
  }

  async function reach(recipientId: string, partner: Partner, how: 'text' | 'email') {
    if (!sent || composingRef.current) return;
    composingRef.current = true;
    const generation = generationRef.current;
    let result;
    try {
      // The program's own answer link (made ahead of time when the row showed).
      // On the web nothing may be awaited before Messages or Mail opens:
      // Safari allows the clipboard and mail only during the tap, so the web
      // uses a link already made, or sends without one.
      let answerLink = cachedPlacementAnswerLink(recipientId);
      if (!answerLink && Platform.OS !== 'web') {
        setPreparingId(recipientId);
        try {
          answerLink = await fetchPlacementAnswerLink(recipientId);
        } finally {
          setPreparingId(null);
        }
      }
      if (generationRef.current !== generation) return;
      const message = placementRequestMessage({
        payload: sent.request.payload,
        programName: partner.organization || partner.name,
        practiceName,
        senderName,
        respondBy: sent.request.respondBy,
        answerLink,
      });
      result = how === 'text'
        ? await sendTextMessage(partner.phone, message.text)
        : await sendEmailMessage(partner.email, message.subject, message.body);
    } finally {
      composingRef.current = false;
    }
    if (generationRef.current !== generation) return;
    if (result === 'failed') {
      Alert.alert('Unable to open', how === 'text' ? 'This device cannot send texts. Call them instead, then log their answer.' : 'This device has no way to send email. Call them instead, then log their answer.');
      return;
    }
    if (result === 'cancelled') return;
    setOutreach((current) => ({ ...current, [recipientId]: result === 'sent' ? (how === 'text' ? 'texted' : 'emailed') : 'opened' }));
  }

  function renderPick() {
    return (
      <>
        <Text style={styles.lead}>One request, de-identified, to the programs you choose. Their answers come back side by side.</Text>
        <Text style={styles.label}>ASK UP TO {MAX_RECIPIENTS} PROGRAMS · {chosen.length} CHOSEN</Text>
        {channelNotice ? <Text style={styles.notice}>{channelNotice}</Text> : null}
        {options.map((option) => {
          const checked = selected.includes(option.partner.id);
          const full = !checked && selected.length >= MAX_RECIPIENTS;
          const how = channelLine(option.partner);
          return (
            <TouchableOpacity
              key={option.partner.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: full }}
              accessibilityLabel={`${option.rank}. ${option.partner.organization}. ${how.text}`}
              disabled={full}
              onPress={() => toggle(option.partner.id)}
              style={[styles.option, checked && styles.optionChecked, full && styles.optionDisabled]}
            >
              <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked ? <Text style={styles.checkmark}>✓</Text> : null}</View>
              <View style={styles.flex}>
                <Text style={styles.optionName} numberOfLines={2}>{option.rank}. {option.partner.organization || option.partner.name}</Text>
                <Text style={styles.optionLine} numberOfLines={1}>{option.line}</Text>
                <Text style={how.portal ? styles.portalLine : styles.manualLine}>{how.text}</Text>
                {option.integrity ? <View style={styles.chipRow}><ShieldChip integrity={option.integrity} /></View> : null}
              </View>
            </TouchableOpacity>
          );
        })}
        <Text style={styles.hint}>Listed in your ranking. Answers never change it, and programs cannot pay to be asked.</Text>

        <Text style={styles.label}>PROGRAMS ANSWER WITHIN</Text>
        <View style={styles.segment}>
          {RESPONSE_WINDOW_HOURS.map((value) => (
            <TouchableOpacity key={value} accessibilityRole="button" accessibilityState={{ selected: hours === value }} onPress={() => setHours(value)} style={[styles.segmentItem, hours === value && styles.segmentItemSelected]}>
              <Text style={[styles.segmentText, hours === value && styles.segmentTextSelected]}>{hoursLabel(value)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>COULD BE ADMITTED</Text>
        <View style={styles.pillRow}>
          {ADMIT_WINDOWS.map((option) => (
            <TouchableOpacity key={option.value} accessibilityRole="button" accessibilityState={{ selected: admitWindow === option.value }} onPress={() => setAdmitWindow(option.value)} style={[styles.pill, admitWindow === option.value && styles.pillSelected]}>
              <Text style={[styles.pillText, admitWindow === option.value && styles.pillTextSelected]}>{option.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>A SHORT NOTE (OPTIONAL)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={note}
          onChangeText={setNote}
          placeholder="e.g. Prefers a smaller program; open to out of state"
          placeholderTextColor="#99A6A1"
          multiline
          // One line of text (it wraps): Return closes the keyboard rather
          // than adding a line break the shared check would refuse.
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
          maxLength={NOTE_MAX}
          accessibilityLabel="A short note for the programs"
        />
        <Text style={noteProblem ? styles.notice : styles.warning}>{noteProblem || NOTE_WARNING}</Text>
        <Text style={styles.hint}>{note.trim().length} of {NOTE_MAX} characters</Text>

        <TouchableOpacity accessibilityRole="button" disabled={!chosen.length} onPress={goToReview} style={[styles.primaryButton, !chosen.length && styles.buttonDisabled]}>
          <Text style={styles.primaryButtonText}>Review what programs will see</Text>
        </TouchableOpacity>
      </>
    );
  }

  function renderReview() {
    if (!prepared || 'problem' in prepared) return null;
    const lines = placementSummaryLines(prepared.payload);
    const busy = stage === 'sending';
    return (
      <>
        <Text style={styles.sectionTitle}>What programs will see</Text>
        <View style={styles.previewCard}>
          <Text style={styles.previewFrom}>From {practiceShown}</Text>
          <Text style={styles.previewIntro}>{PROGRAM_INTRO}</Text>
          {lines.map((line) => (
            <View key={line.label} style={styles.previewLine}>
              <Text style={styles.previewLabel}>{line.label}</Text>
              <Text style={styles.previewValue}>{line.value}</Text>
            </View>
          ))}
          <Text style={styles.previewAsk}>They answer: a bed (yes, no or waitlist), likely to accept, the earliest admit date, and the daily rate or cost.</Text>
        </View>
        {practiceShown === UNNAMED_PRACTICE ? <Text style={styles.hint}>Your workspace has no name or directory profile yet, so programs see "{UNNAMED_PRACTICE}". You can name it in Workspace settings.</Text> : null}
        <Text style={styles.notShared}>{NOT_SHARED_LINE}</Text>

        <Text style={styles.label}>GOING TO {chosen.length} {chosen.length === 1 ? 'PROGRAM' : 'PROGRAMS'}, IN YOUR ORDER</Text>
        {chosen.map((option) => (
          <Text key={option.partner.id} style={styles.reviewProgram}>{option.rank}. {option.partner.organization || option.partner.name} · {channelLine(option.partner).portal ? 'answers in ReferralFit' : 'you send the summary'}</Text>
        ))}
        <Text style={styles.hint}>Numbers are each program's place in your match results. Answers are due within {hoursLabel(hours)}.</Text>

        {conflict ? (
          <>
            <Text accessibilityRole="alert" style={styles.notice}>{ALREADY_SENT_PROBLEM}</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: conflict.cancelling, disabled: conflict.cancelling }} disabled={conflict.cancelling} onPress={() => { void cancelEarlier(); }} style={[styles.primaryButton, conflict.cancelling && styles.buttonBusy]}>
              {conflict.cancelling ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>Cancel the earlier request</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <>
            {sendNotice ? <Text style={styles.notice}>{sendNotice}</Text> : null}
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { void send(); }} style={[styles.primaryButton, busy && styles.buttonBusy]}>
              {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>{showsTryAgain(sendKey, reviewedSignature, sendNotice) ? 'Try again' : `Send to ${chosen.length} ${chosen.length === 1 ? 'program' : 'programs'}`}</Text>}
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity accessibilityRole="button" disabled={busy || Boolean(conflict?.cancelling)} onPress={() => setStage('pick')} style={styles.textButton}>
          <Text style={styles.textButtonText}>Back</Text>
        </TouchableOpacity>
      </>
    );
  }

  function renderSent() {
    if (!sent) return null;
    const portal = sent.recipients.filter((item) => item.channel === 'portal');
    const manual = sent.recipients.filter((item) => item.channel === 'manual');
    return (
      <>
        <Text style={styles.sectionTitle}>Request sent</Text>
        <Text style={styles.body}>Answers are due {deadlineLabel(sent.request.respondBy)}.</Text>
        {portal.length ? (
          <Text style={styles.body}>{portal.length === 1 ? '1 program answers' : `${portal.length} programs answer`} in ReferralFit. Their answers show up on Today and on this match.</Text>
        ) : null}
        {manual.length ? (
          <>
            <Text style={styles.label}>SEND THE SUMMARY TO THESE</Text>
            <Text style={styles.hint}>They do not answer in ReferralFit yet. Text or email them the same de-identified summary, with a link they can answer from themselves. If they reply instead, log what they say from the answers screen.</Text>
            {manual.map((recipient) => {
              const option = options.find((item) => item.partner.id.toLowerCase() === recipient.partnerId);
              const partner = option?.partner;
              const done = outreach[recipient.id];
              return (
                <View key={recipient.id} style={styles.manualRow}>
                  <View style={styles.flex}>
                    <Text style={styles.optionName}>{recipient.programName}</Text>
                    <Text style={styles.optionLine}>{done === 'texted' ? 'Texted' : done === 'emailed' ? 'Emailed' : done === 'opened' ? 'Opened to send' : partner && (partner.phone.trim() || partner.email.trim()) ? 'Not sent yet' : 'No phone or email on file: call them'}</Text>
                  </View>
                  {partner?.phone.trim() ? (
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Text the summary to ${recipient.programName}`} accessibilityState={{ busy: preparingId === recipient.id }} onPress={() => { void reach(recipient.id, partner, 'text'); }} style={styles.smallButton}>
                      <Text style={styles.smallButtonText}>{preparingId === recipient.id ? 'Preparing…' : 'Text'}</Text>
                    </TouchableOpacity>
                  ) : null}
                  {partner?.email.trim() ? (
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Email the summary to ${recipient.programName}`} accessibilityState={{ busy: preparingId === recipient.id }} onPress={() => { void reach(recipient.id, partner, 'email'); }} style={styles.smallButton}>
                      <Text style={styles.smallButtonText}>{preparingId === recipient.id ? 'Preparing…' : 'Email'}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}
          </>
        ) : null}
        <TouchableOpacity accessibilityRole="button" onPress={() => onOpenAnswers(sent.request.id)} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>See answers</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.textButton}>
          <Text style={styles.textButtonText}>Done</Text>
        </TouchableOpacity>
      </>
    );
  }

  // Not while a send or a cancel is on its way: its answer must land here.
  const busyClose = stage === 'sending' || Boolean(conflict?.cancelling);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={busyClose ? () => undefined : onClose}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close placement request" disabled={busyClose} onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>{stage === 'sent' ? 'Close' : 'Cancel'}</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>Ask programs</Text>
            <View style={styles.headerButton} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <Text style={styles.anchor} numberOfLines={2}>{match.clientLabel}</Text>
            <Text style={styles.anchorHint}>Only you see this label. Programs never do.</Text>
            {stage === 'pick' ? renderPick() : null}
            {stage === 'review' || stage === 'sending' ? renderReview() : null}
            {stage === 'sent' ? renderSent() : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
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
  anchorHint: { fontSize: 12, color: COLORS.gray, marginTop: 2 },
  lead: { fontSize: 15, lineHeight: 21, color: COLORS.inkSoft, marginTop: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: COLORS.ink, marginTop: 16 },
  body: { fontSize: 15, lineHeight: 21, color: COLORS.inkSoft, marginTop: 8 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 18, marginBottom: 6 },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 6 },
  warning: { fontSize: 12, lineHeight: 17, color: COLORS.inkSoft, marginTop: 6 },
  notice: { fontSize: 13, lineHeight: 18, color: COLORS.coral, marginTop: 8 },
  option: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginTop: 8 },
  optionChecked: { borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  optionDisabled: { opacity: 0.45 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center', marginTop: 2, backgroundColor: COLORS.white },
  checkboxChecked: { borderColor: COLORS.forest, backgroundColor: COLORS.forest },
  checkmark: { color: COLORS.white, fontSize: 14, fontWeight: '900' },
  optionName: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  optionLine: { fontSize: 12, color: COLORS.gray, marginTop: 2 },
  portalLine: { fontSize: 12, fontWeight: '700', color: COLORS.forest, marginTop: 4 },
  manualLine: { fontSize: 12, fontWeight: '600', color: COLORS.inkSoft, marginTop: 4 },
  chipRow: { flexDirection: 'row', marginTop: 6 },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, overflow: 'hidden', backgroundColor: COLORS.white },
  segmentItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  segmentItemSelected: { backgroundColor: COLORS.forest },
  segmentText: { fontSize: 14, fontWeight: '700', color: COLORS.inkSoft },
  segmentTextSelected: { color: COLORS.white },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillSelected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextSelected: { color: COLORS.white },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.ink },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  previewCard: { marginTop: 10, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white },
  previewFrom: { fontSize: 13, fontWeight: '800', color: COLORS.forest },
  previewIntro: { fontSize: 13, lineHeight: 18, color: COLORS.inkSoft, marginTop: 6, marginBottom: 6 },
  previewLine: { flexDirection: 'row', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#EEF0EE' },
  previewLabel: { width: 108, fontSize: 12, fontWeight: '800', color: COLORS.gray },
  previewValue: { flex: 1, fontSize: 14, color: COLORS.ink },
  previewAsk: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 8 },
  notShared: { fontSize: 12, lineHeight: 17, color: COLORS.forest, fontWeight: '700', marginTop: 10 },
  reviewProgram: { fontSize: 14, color: COLORS.ink, marginTop: 4 },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginTop: 8 },
  smallButton: { minHeight: 40, minWidth: 64, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.mintPale, alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  buttonBusy: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.4 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  textButtonText: { color: COLORS.inkSoft, fontSize: 15, fontWeight: '700' },
});
