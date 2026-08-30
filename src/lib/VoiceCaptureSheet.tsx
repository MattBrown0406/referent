import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorCode,
} from 'expo-speech-recognition';

import type { Partner } from '../data';
import {
  parseVoiceTranscript,
  type VoiceFollowUpDraft,
  type VoiceTouchKind,
  type VoiceTranscriptDraft,
} from './voice';

export type ApprovedVoiceDraft = {
  partnerId: string;
  touchKind: VoiceTouchKind;
  note: string;
  followUp?: VoiceFollowUpDraft;
};

type Props = {
  visible: boolean;
  partners: Partner[];
  onClose: () => void;
  onApprove: (draft: ApprovedVoiceDraft) => Promise<void> | void;
};

type Screen = 'capture' | 'review';

const COLORS = {
  cream: '#F6F4EE',
  card: '#FFFFFF',
  forest: '#1F5A49',
  forestDark: '#16352E',
  forestPale: '#E6EFEA',
  muted: '#66756F',
  line: '#DDE4DF',
  coral: '#A84232',
  coralPale: '#F7E7E1',
  amber: '#8A5A12',
  amberPale: '#FFF4D8',
};

const TOUCH_KINDS: { value: VoiceTouchKind; label: string }[] = [
  { value: 'call', label: 'Call' },
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'other', label: 'Other' },
];

function recognitionErrorMessage(code: ExpoSpeechRecognitionErrorCode): string {
  switch (code) {
    case 'not-allowed':
      return 'Microphone or speech recognition access was denied. Enable access in device Settings, then try again.';
    case 'service-not-allowed':
    case 'language-not-supported':
      return 'Speech recognition is not available for this device or language.';
    case 'busy':
      return 'Speech recognition is busy. Wait a moment, then try again.';
    case 'no-speech':
    case 'speech-timeout':
      return 'No speech was detected. Try again and speak after “Listening” appears.';
    case 'network':
      return 'The speech recognition service could not connect. Check your connection and try again.';
    case 'audio-capture':
      return 'The microphone could not be used. Check that another app is not recording, then try again.';
    case 'interrupted':
      return 'Dictation was interrupted by another audio session. You can try again when it ends.';
    default:
      return 'Dictation ended unexpectedly. Nothing was saved; please try again.';
  }
}

function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function emptyFollowUp(): VoiceFollowUpDraft {
  return { title: '', dueOn: '' };
}

export default function VoiceCaptureSheet({ visible, partners, onClose, onApprove }: Props) {
  const [screen, setScreen] = useState<Screen>('capture');
  const [transcript, setTranscript] = useState('');
  const [parseRequested, setParseRequested] = useState(false);
  const [draft, setDraft] = useState<VoiceTranscriptDraft | null>(null);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [partnerSearch, setPartnerSearch] = useState('');
  const activeRecognition = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const reset = useCallback(() => {
    setScreen('capture');
    setTranscript('');
    setParseRequested(false);
    setDraft(null);
    setListening(false);
    setStarting(false);
    setFinishing(false);
    setCaptureError('');
    setSaveError('');
    setSaving(false);
    setPartnerSearch('');
  }, []);

  const abortRecognition = useCallback(() => {
    if (!activeRecognition.current) return;
    activeRecognition.current = false;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // The native recognizer may already have released its session.
    }
  }, []);

  const discard = useCallback(() => {
    abortRecognition();
    reset();
  }, [abortRecognition, reset]);

  const close = useCallback(() => {
    abortRecognition();
    reset();
    onClose();
  }, [abortRecognition, onClose, reset]);

  useEffect(() => {
    if (!visible) {
      abortRecognition();
      reset();
    }
  }, [visible, abortRecognition, reset]);

  useEffect(() => () => {
    abortRecognition();
  }, [abortRecognition]);

  useSpeechRecognitionEvent('start', () => {
    if (!activeRecognition.current || !visibleRef.current) return;
    setStarting(false);
    setListening(true);
    setFinishing(false);
  });

  useSpeechRecognitionEvent('result', (event) => {
    if (!activeRecognition.current || !visibleRef.current) return;
    const latest = event.results[0]?.transcript?.trim() ?? '';
    if (latest) setTranscript(latest);
    if (event.isFinal) setParseRequested(true);
  });

  useSpeechRecognitionEvent('end', () => {
    if (!activeRecognition.current || !visibleRef.current) return;
    activeRecognition.current = false;
    setListening(false);
    setStarting(false);
    setFinishing(false);
    setParseRequested(true);
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!activeRecognition.current || !visibleRef.current) return;
    activeRecognition.current = false;
    setListening(false);
    setStarting(false);
    setFinishing(false);
    setParseRequested(false);
    if (event.error !== 'aborted') setCaptureError(recognitionErrorMessage(event.error));
  });

  useEffect(() => {
    if (!parseRequested || !visible) return;
    setParseRequested(false);
    const latest = transcript.trim();
    if (!latest) {
      setCaptureError('No speech was detected. Try again and speak after “Listening” appears.');
      return;
    }
    setDraft(parseVoiceTranscript(latest, partners, new Date()));
    setSaveError('');
    setPartnerSearch('');
    setScreen('review');
  }, [parseRequested, transcript, partners, visible]);

  async function startDictation() {
    if (starting || listening || finishing) return;
    setCaptureError('');
    setTranscript('');
    setDraft(null);
    setStarting(true);

    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setCaptureError('Speech recognition is not available on this device.');
        setStarting(false);
        return;
      }

      // Permission prompts are intentionally reached only from this user action.
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!visibleRef.current) return;
      if (!permission.granted) {
        setCaptureError(
          permission.canAskAgain
            ? 'Microphone and speech recognition access are required to dictate a touch.'
            : 'Access was denied. Enable microphone and speech recognition in device Settings, then try again.',
        );
        setStarting(false);
        return;
      }

      activeRecognition.current = true;
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        contextualStrings: partners.slice(0, 100).flatMap((partner) => [partner.name, partner.organization]),
        recordingOptions: { persist: false },
      });
    } catch (error) {
      activeRecognition.current = false;
      setStarting(false);
      setCaptureError(error instanceof Error && error.message
        ? `Dictation could not start: ${error.message}`
        : 'Dictation could not start. Nothing was saved; please try again.');
    }
  }

  function stopDictation() {
    if (!activeRecognition.current || finishing) return;
    setFinishing(true);
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (error) {
      activeRecognition.current = false;
      setListening(false);
      setFinishing(false);
      setCaptureError(error instanceof Error ? error.message : 'Dictation could not be stopped cleanly. Nothing was saved.');
    }
  }

  function updateDraft(change: Partial<VoiceTranscriptDraft>) {
    setDraft((current) => current ? { ...current, ...change } : current);
    setSaveError('');
  }

  function updateFollowUp(change: Partial<VoiceFollowUpDraft>) {
    if (!draft?.followUp) return;
    updateDraft({ followUp: { ...draft.followUp, ...change } });
  }

  async function approve() {
    if (!draft || saving) return;
    if (!draft.partnerId) {
      setSaveError('Select a partner before saving this touch.');
      return;
    }
    const note = draft.note.trim();
    let followUp: VoiceFollowUpDraft | undefined;
    if (draft.followUp) {
      const title = draft.followUp.title.trim();
      const dueOn = draft.followUp.dueOn.trim();
      const dueTime = draft.followUp.dueTime?.trim();
      if (!title) {
        setSaveError('Add a title for the follow-up, or remove the follow-up.');
        return;
      }
      if (!isValidLocalDate(dueOn)) {
        setSaveError('Enter the follow-up date as a valid YYYY-MM-DD date.');
        return;
      }
      if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) {
        setSaveError('Enter the follow-up time in 24-hour HH:MM format, or leave it blank.');
        return;
      }
      followUp = { title, dueOn, ...(dueTime ? { dueTime } : {}) };
    }

    setSaving(true);
    setSaveError('');
    try {
      await onApprove({
        partnerId: draft.partnerId,
        touchKind: draft.touchKind,
        note,
        ...(followUp ? { followUp } : {}),
      });
      reset();
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error && error.message
        ? error.message
        : 'This touch could not be saved. Your draft is still here; please try again.');
      setSaving(false);
    }
  }

  const filteredPartners = useMemo(() => {
    const query = partnerSearch.trim().toLocaleLowerCase();
    if (!query) return partners;
    return partners.filter((partner) =>
      `${partner.name} ${partner.organization}`.toLocaleLowerCase().includes(query),
    );
  }, [partnerSearch, partners]);

  const selectedPartner = draft?.partnerId
    ? partners.find((partner) => partner.id === draft.partnerId)
    : undefined;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>VOICE CAPTURE</Text>
              <Text style={styles.headerTitle}>{screen === 'capture' ? 'Dictate a touch' : 'Review before saving'}</Text>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Close voice capture"
              disabled={saving}
              onPress={close}
              style={styles.headerButton}
            >
              <Text style={styles.headerButtonText}>Close</Text>
            </TouchableOpacity>
          </View>

          {screen === 'capture' ? (
            <ScrollView contentContainerStyle={styles.captureContent} keyboardShouldPersistTaps="handled">
              <View style={styles.heroIcon} accessibilityElementsHidden>
                <Text style={styles.heroIconText}>●</Text>
              </View>
              <Text style={styles.heroTitle}>Speak naturally. Approve deliberately.</Text>
              <Text style={styles.heroBody}>
                Say who you contacted, how you connected, a brief ledger-safe note, and an optional follow-up.
              </Text>

              <View style={styles.privacyCard}>
                <Text style={styles.cardTitle}>Before you start</Text>
                <Text style={styles.cardBody}>
                  ReferralFit requests microphone and speech recognition access only after you tap Start dictation. Your device’s recognition service may send audio to its provider for transcription.
                </Text>
                <View style={styles.rule} />
                <Text style={styles.privacyPoint}>• ReferralFit does not persist the audio.</Text>
                <Text style={styles.privacyPoint}>• The latest transcript stays temporary until you approve.</Text>
                <Text style={styles.privacyPoint}>• Avoid client names, diagnoses, and family details.</Text>
              </View>

              {captureError ? (
                <View style={styles.errorCard} accessibilityRole="alert">
                  <Text style={styles.errorTitle}>Dictation unavailable</Text>
                  <Text style={styles.errorText}>{captureError}</Text>
                </View>
              ) : null}

              {starting || listening || finishing ? (
                <View style={styles.listeningCard} accessibilityRole="text" accessibilityLiveRegion="polite">
                  <View style={styles.listeningRow}>
                    <View style={styles.liveDot} />
                    <Text style={styles.listeningTitle}>
                      {starting ? 'Requesting access…' : finishing ? 'Finishing transcript…' : 'Listening…'}
                    </Text>
                  </View>
                  <Text style={styles.liveTranscript}>
                    {transcript || 'Start speaking when you’re ready.'}
                  </Text>
                </View>
              ) : null}

              <View style={styles.exampleCard}>
                <Text style={styles.exampleLabel}>TRY SAYING</Text>
                <Text style={styles.exampleText}>
                  “Called Jordan at Northstar. Discussed availability. Follow up next Tuesday at 10 AM.”
                </Text>
              </View>

              {listening || finishing ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Stop dictation"
                  disabled={finishing}
                  onPress={stopDictation}
                  style={[styles.primaryButton, finishing && styles.disabledButton]}
                >
                  {finishing ? <ActivityIndicator color={COLORS.card} /> : <Text style={styles.primaryButtonText}>Stop dictation</Text>}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Start dictation and request microphone permission"
                  disabled={starting}
                  onPress={() => void startDictation()}
                  style={[styles.primaryButton, starting && styles.disabledButton]}
                >
                  {starting ? <ActivityIndicator color={COLORS.card} /> : <Text style={styles.primaryButtonText}>Start dictation</Text>}
                </TouchableOpacity>
              )}

              {(starting || listening || finishing || transcript) ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Discard dictation"
                  onPress={discard}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Discard</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          ) : draft ? (
            <ScrollView contentContainerStyle={styles.reviewContent} keyboardShouldPersistTaps="handled">
              <View style={styles.approvalBanner}>
                <Text style={styles.approvalTitle}>Nothing has been saved</Text>
                <Text style={styles.approvalText}>Check every field, then explicitly approve this ledger entry.</Text>
              </View>

              {draft.warnings.map((warning) => (
                <View key={warning.code} style={styles.warningCard} accessibilityRole="alert">
                  <Text style={styles.warningTitle}>Sensitive detail warning</Text>
                  <Text style={styles.warningText}>{warning.message}</Text>
                </View>
              ))}

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Partner <Text style={styles.required}>Required</Text></Text>
                {selectedPartner ? (
                  <View style={styles.selectedPartner}>
                    <Text style={styles.selectedPartnerName}>{selectedPartner.name}</Text>
                    <Text style={styles.selectedPartnerOrg}>{selectedPartner.organization}</Text>
                  </View>
                ) : (
                  <Text style={styles.fieldHint}>The transcript did not identify one partner. Choose one below.</Text>
                )}
                <TextInput
                  accessibilityLabel="Search partners"
                  placeholder="Search name or organization"
                  placeholderTextColor={COLORS.muted}
                  value={partnerSearch}
                  onChangeText={setPartnerSearch}
                  style={styles.input}
                />
                <View style={styles.partnerList}>
                  {filteredPartners.map((partner) => {
                    const selected = partner.id === draft.partnerId;
                    return (
                      <TouchableOpacity
                        key={partner.id}
                        accessibilityRole="radio"
                        accessibilityLabel={`${partner.name}, ${partner.organization}`}
                        accessibilityState={{ checked: selected }}
                        onPress={() => updateDraft({ partnerId: partner.id, partnerName: partner.name })}
                        style={[styles.partnerOption, selected && styles.partnerOptionSelected]}
                      >
                        <View style={styles.partnerCopy}>
                          <Text style={[styles.partnerName, selected && styles.partnerNameSelected]}>{partner.name}</Text>
                          <Text style={[styles.partnerOrg, selected && styles.partnerOrgSelected]}>{partner.organization}</Text>
                        </View>
                        <Text style={[styles.checkmark, selected && styles.checkmarkSelected]}>{selected ? '✓' : '○'}</Text>
                      </TouchableOpacity>
                    );
                  })}
                  {filteredPartners.length === 0 ? <Text style={styles.emptyText}>No matching partners.</Text> : null}
                </View>
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Touch type</Text>
                <View style={styles.chipRow} accessibilityRole="radiogroup">
                  {TOUCH_KINDS.map((kind) => {
                    const selected = draft.touchKind === kind.value;
                    return (
                      <TouchableOpacity
                        key={kind.value}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        onPress={() => updateDraft({ touchKind: kind.value })}
                        style={[styles.chip, selected && styles.chipSelected]}
                      >
                        <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{kind.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Ledger note</Text>
                <Text style={styles.fieldHint}>Keep it brief and operational. Do not include client-identifying, clinical, or family detail.</Text>
                <TextInput
                  accessibilityLabel="Ledger note"
                  multiline
                  textAlignVertical="top"
                  value={draft.note}
                  onChangeText={(note) => updateDraft({ note })}
                  placeholder="Brief touch note"
                  placeholderTextColor={COLORS.muted}
                  style={[styles.input, styles.noteInput]}
                />
              </View>

              <View style={styles.section}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionTitle}>Follow-up</Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={draft.followUp ? 'Remove follow-up' : 'Add follow-up'}
                    onPress={() => updateDraft({ followUp: draft.followUp ? undefined : emptyFollowUp() })}
                    style={styles.inlineButton}
                  >
                    <Text style={styles.inlineButtonText}>{draft.followUp ? 'Remove' : '+ Add'}</Text>
                  </TouchableOpacity>
                </View>
                {draft.followUp ? (
                  <View style={styles.followUpFields}>
                    <Text style={styles.inputLabel}>Title</Text>
                    <TextInput
                      accessibilityLabel="Follow-up title"
                      value={draft.followUp.title}
                      onChangeText={(title) => updateFollowUp({ title })}
                      placeholder="Follow up"
                      placeholderTextColor={COLORS.muted}
                      style={styles.input}
                    />
                    <View style={styles.splitRow}>
                      <View style={styles.splitField}>
                        <Text style={styles.inputLabel}>Date</Text>
                        <TextInput
                          accessibilityLabel="Follow-up date, YYYY-MM-DD"
                          value={draft.followUp.dueOn}
                          onChangeText={(dueOn) => updateFollowUp({ dueOn })}
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor={COLORS.muted}
                          autoCapitalize="none"
                          keyboardType="numbers-and-punctuation"
                          style={styles.input}
                        />
                      </View>
                      <View style={styles.splitField}>
                        <Text style={styles.inputLabel}>Time (optional)</Text>
                        <TextInput
                          accessibilityLabel="Follow-up time, 24-hour HH:MM"
                          value={draft.followUp.dueTime ?? ''}
                          onChangeText={(dueTime) => updateFollowUp({ dueTime: dueTime || undefined })}
                          placeholder="HH:MM"
                          placeholderTextColor={COLORS.muted}
                          autoCapitalize="none"
                          keyboardType="numbers-and-punctuation"
                          style={styles.input}
                        />
                      </View>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.fieldHint}>No follow-up will be created.</Text>
                )}
              </View>

              <View style={styles.ledgerReminder}>
                <Text style={styles.ledgerReminderTitle}>Ledger privacy check</Text>
                <Text style={styles.ledgerReminderText}>
                  Save only professional relationship activity. Remove client names, health information, and sensitive family details.
                </Text>
              </View>

              {saveError ? (
                <View style={styles.errorCard} accessibilityRole="alert">
                  <Text style={styles.errorTitle}>Not saved</Text>
                  <Text style={styles.errorText}>{saveError}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Approve and save touch"
                accessibilityState={{ disabled: saving }}
                disabled={saving}
                onPress={() => void approve()}
                style={[styles.primaryButton, saving && styles.disabledButton]}
              >
                {saving ? <ActivityIndicator color={COLORS.card} /> : <Text style={styles.primaryButtonText}>Approve & save</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Discard voice draft"
                disabled={saving}
                onPress={discard}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Discard draft</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: COLORS.cream },
  header: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    backgroundColor: COLORS.card,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  headerCopy: { flex: 1 },
  eyebrow: { color: COLORS.forest, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  headerTitle: { color: COLORS.forestDark, fontSize: 21, fontWeight: '900', marginTop: 2 },
  headerButton: { minHeight: 44, minWidth: 58, alignItems: 'center', justifyContent: 'center' },
  headerButtonText: { color: COLORS.forest, fontSize: 15, fontWeight: '800' },
  captureContent: { padding: 20, paddingBottom: 34 },
  reviewContent: { padding: 16, paddingBottom: 34 },
  heroIcon: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: COLORS.forestPale,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: 8,
  },
  heroIconText: { color: COLORS.forest, fontSize: 36, lineHeight: 42 },
  heroTitle: { color: COLORS.forestDark, fontSize: 25, fontWeight: '900', textAlign: 'center', marginTop: 18 },
  heroBody: { color: COLORS.muted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8, marginBottom: 20 },
  privacyCard: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line, borderRadius: 18, padding: 17 },
  cardTitle: { color: COLORS.forestDark, fontSize: 16, fontWeight: '900', marginBottom: 7 },
  cardBody: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  rule: { height: 1, backgroundColor: COLORS.line, marginVertical: 13 },
  privacyPoint: { color: COLORS.forestDark, fontSize: 13, lineHeight: 21 },
  exampleCard: { borderLeftWidth: 3, borderLeftColor: COLORS.forest, paddingLeft: 13, marginVertical: 20 },
  exampleLabel: { color: COLORS.forest, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 5 },
  exampleText: { color: COLORS.forestDark, fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  listeningCard: { backgroundColor: COLORS.forestDark, borderRadius: 18, padding: 17, marginTop: 14 },
  listeningRow: { flexDirection: 'row', alignItems: 'center' },
  liveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF8C7E', marginRight: 9 },
  listeningTitle: { color: COLORS.card, fontSize: 15, fontWeight: '900' },
  liveTranscript: { color: '#E6EFEA', fontSize: 14, lineHeight: 21, marginTop: 11 },
  primaryButton: {
    minHeight: 54,
    borderRadius: 16,
    backgroundColor: COLORS.forest,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  primaryButtonText: { color: COLORS.card, fontSize: 16, fontWeight: '900' },
  disabledButton: { opacity: 0.55 },
  secondaryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 7 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 14, fontWeight: '800' },
  approvalBanner: { backgroundColor: COLORS.forestPale, borderRadius: 15, padding: 14, marginBottom: 12 },
  approvalTitle: { color: COLORS.forestDark, fontSize: 14, fontWeight: '900' },
  approvalText: { color: COLORS.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  warningCard: { backgroundColor: COLORS.amberPale, borderWidth: 1, borderColor: '#E8C77D', borderRadius: 15, padding: 14, marginBottom: 12 },
  warningTitle: { color: COLORS.amber, fontSize: 14, fontWeight: '900' },
  warningText: { color: '#67430D', fontSize: 13, lineHeight: 19, marginTop: 4 },
  section: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line, borderRadius: 17, padding: 14, marginBottom: 12 },
  sectionTitle: { color: COLORS.forestDark, fontSize: 16, fontWeight: '900', marginBottom: 9 },
  required: { color: COLORS.coral, fontSize: 11, fontWeight: '900' },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inlineButton: { minHeight: 44, minWidth: 60, alignItems: 'flex-end', justifyContent: 'center' },
  inlineButtonText: { color: COLORS.forest, fontSize: 14, fontWeight: '900' },
  selectedPartner: { backgroundColor: COLORS.forestPale, borderRadius: 12, padding: 12, marginBottom: 10 },
  selectedPartnerName: { color: COLORS.forestDark, fontSize: 14, fontWeight: '900' },
  selectedPartnerOrg: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  fieldHint: { color: COLORS.muted, fontSize: 12, lineHeight: 18, marginBottom: 9 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    color: COLORS.forestDark,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noteInput: { minHeight: 112 },
  partnerList: { maxHeight: 226, marginTop: 8, borderTopWidth: 1, borderTopColor: COLORS.line },
  partnerOption: { minHeight: 54, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingHorizontal: 10, paddingVertical: 8 },
  partnerOptionSelected: { backgroundColor: COLORS.forest },
  partnerCopy: { flex: 1, paddingRight: 8 },
  partnerName: { color: COLORS.forestDark, fontSize: 13, fontWeight: '800' },
  partnerNameSelected: { color: COLORS.card },
  partnerOrg: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  partnerOrgSelected: { color: '#D8E7E0' },
  checkmark: { color: COLORS.line, fontSize: 18, fontWeight: '900' },
  checkmarkSelected: { color: COLORS.card },
  emptyText: { color: COLORS.muted, fontSize: 13, paddingVertical: 16, textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  chip: { minHeight: 44, minWidth: 68, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, margin: 4 },
  chipSelected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  chipText: { color: COLORS.forestDark, fontSize: 13, fontWeight: '800' },
  chipTextSelected: { color: COLORS.card },
  followUpFields: { gap: 7 },
  inputLabel: { color: COLORS.muted, fontSize: 11, fontWeight: '800', marginTop: 2 },
  splitRow: { flexDirection: 'row', gap: 9 },
  splitField: { flex: 1, gap: 5 },
  ledgerReminder: { backgroundColor: COLORS.coralPale, borderRadius: 15, padding: 14, marginBottom: 12 },
  ledgerReminderTitle: { color: COLORS.coral, fontSize: 14, fontWeight: '900' },
  ledgerReminderText: { color: '#71382F', fontSize: 13, lineHeight: 19, marginTop: 4 },
  errorCard: { backgroundColor: COLORS.coralPale, borderWidth: 1, borderColor: '#E9C5B8', borderRadius: 15, padding: 14, marginTop: 14, marginBottom: 12 },
  errorTitle: { color: COLORS.coral, fontSize: 14, fontWeight: '900' },
  errorText: { color: '#71382F', fontSize: 13, lineHeight: 19, marginTop: 4 },
});
