// The family assessment on a case (docs/FAMILY_ASSESSMENT.md): send the
// family a private link in the practice's name (ReferralFit emails it, or
// the practitioner texts it), see where it stands, and once it is finished,
// read the answers by section, see the card photos and the signed consent,
// and rate the level of care: by hand with the family's answers under each
// area, or starting from an AI suggestion on the practitioner's own key.
// Shown inside the case file's own modal (App.tsx CaseDetailModal swaps it in).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { AssistUnavailableError, requestLevelSuggestion } from './ai-assist-api';
import {
  answerSections,
  assessmentAlerts,
  currentAssessment,
  dimensionHints,
  dsmLine,
  isOpen,
  levelOfCareFacts,
  linkMessage,
  statusLine,
  type FamilyAssessment,
} from './family-assessment';
import {
  cardPhotoUrls,
  deleteFamilyAssessment,
  listFamilyAssessments,
  revokeFamilyAssessment,
  sendFamilyAssessment,
} from './family-assessment-api';
import type { LevelOfCareSeed } from './LevelOfCareSheet';
import type { DimensionKey } from './level-of-care';
import { aiKeysSupported, fetchPracticeName, getAnthropicKey } from './outreach-api';
import { WEB_PAGE } from './web-layout';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coral: '#B4513A',
  coralPale: '#F7E7E1',
  coralText: '#8E3B28',
  gold: '#8A6A1F',
  goldPale: '#F6EFD9',
  muted: '#55645F',
  gray: '#73827D',
  line: '#DDE4DF',
};

type Props = {
  caseId: string;
  userId: string;
  /** The case's primary contact, to send to. */
  recipient: { name: string; email: string };
  onClose: () => void;
  /** Rate the level of care, starting from what the assessment says. */
  onRateLevel: (seed: LevelOfCareSeed) => void;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function FamilyAssessmentSheet({ caseId, userId, recipient, onClose, onRateLevel }: Props) {
  const [practiceName, setPracticeName] = useState('Your practice');
  const [list, setList] = useState<FamilyAssessment[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState(recipient.name);
  const [email, setEmail] = useState(recipient.email);
  const [busy, setBusy] = useState<'' | 'email' | 'share' | 'stop' | 'delete' | 'ai'>('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [photos, setPhotos] = useState<{ front: string | null; back: string | null }>({ front: null, back: null });
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  // An earlier assessment the practitioner opened (the newest is shown otherwise).
  const [shownId, setShownId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // One action at a time, even with two quick taps before a re-render.
  const busyRef = useRef(false);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const rows = await listFamilyAssessments(caseId);
      if (mountedRef.current) { setList(rows); setLoadError(''); }
    } catch (error) {
      if (mountedRef.current) setLoadError(error instanceof Error ? error.message : 'The family assessment could not be loaded.');
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void fetchPracticeName().then((value) => { if (mountedRef.current && value.trim()) setPracticeName(value.trim()); });
  }, []);
  useEffect(() => {
    if (!aiKeysSupported) return;
    void getAnthropicKey(userId).then((key) => { if (mountedRef.current) setHasKey(Boolean(key)); });
  }, [userId]);

  const newest = useMemo(() => (list ? currentAssessment(list) : null), [list]);
  const current = useMemo(() => (list && shownId ? list.find((item) => item.id === shownId) ?? newest : newest), [list, shownId, newest]);
  const earlier = useMemo(() => (list && newest ? list.filter((item) => item.id !== newest.id) : []), [list, newest]);
  const finished = current?.status === 'submitted' ? current : null;
  const live = current && current.id === newest?.id && isOpen(current) ? current : null;
  // Danger in answers saved before the family finished: the alerts show (the answers do not, until they send it).
  const earlyAlerts = current && !finished && Object.keys(current.answers).length ? assessmentAlerts(current) : [];

  // Card photos: short-lived links, fetched when a finished assessment has them.
  useEffect(() => {
    if (!finished || (!finished.cardFront && !finished.cardBack)) { setPhotos({ front: null, back: null }); return; }
    let active = true;
    void cardPhotoUrls(finished).then((urls) => { if (active) setPhotos(urls); });
    return () => { active = false; };
  }, [finished]);

  // From the form: the name and address typed. Again for a live link: the
  // family member it was sent to (the form is hidden then), so sending
  // again never switches who it is for; a link to text keeps the address.
  async function send(how: 'email' | 'share', again: FamilyAssessment | null = null) {
    if (busyRef.current) return;
    const typed = email.trim();
    // A link to text from the form keeps a valid typed address for later; a mistyped one never blocks the text.
    const address = how === 'share' ? (again || !EMAIL.test(typed) ? '' : typed) : (again ? again.recipientEmail : typed).trim();
    const who = again ? again.recipientName : name;
    if (how === 'email' && !EMAIL.test(address)) { setMessage({ ok: false, text: 'Add the family member’s email address.' }); return; }
    busyRef.current = true;
    setBusy(how);
    setMessage(null);
    try {
      const sent = await sendFamilyAssessment(caseId, who, address, how === 'email');
      setShownId(null);
      if (how === 'share' && sent.link) {
        const shared = await Share.share({ message: linkMessage(practiceName, sent.link) });
        setMessage(shared?.action === Share.dismissedAction
          ? { ok: true, text: 'Not sent. The new link was made anyway; only the ten newest links work.' }
          : { ok: true, text: 'The link is ready to send. It works for 30 days; only the ten newest links work.' });
      } else {
        setMessage({ ok: true, text: `Emailed to ${address} in your practice’s name. Replies come to you.` });
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'The assessment could not be sent.' });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) { setBusy(''); void load(); }
    }
  }

  function stop() {
    if (!live || busy) return;
    Alert.alert('Stop this link?', 'The family can no longer open or finish it. Their unfinished answers are kept but not shown here; you can delete them.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Stop the link',
        style: 'destructive',
        onPress: () => {
          setBusy('stop');
          void revokeFamilyAssessment(live.id)
            .then(() => load())
            .catch((error) => setMessage({ ok: false, text: error instanceof Error ? error.message : 'The link could not be stopped.' }))
            .finally(() => { if (mountedRef.current) setBusy(''); });
        },
      },
    ]);
  }

  function remove() {
    if (!current || busy) return;
    Alert.alert('Delete this assessment?', 'The answers, the card photos and the signed consent are deleted for good. This cannot be undone.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setBusy('delete');
          void deleteFamilyAssessment(current)
            .then(() => { setShownId(null); setMessage({ ok: true, text: 'Deleted.' }); return load(); })
            .catch((error) => setMessage({ ok: false, text: error instanceof Error ? error.message : 'It could not be deleted.' }))
            .finally(() => { if (mountedRef.current) setBusy(''); });
        },
      },
    ]);
  }

  function rateByHand() {
    if (!finished) return;
    onRateLevel({ fromAi: false, hints: dimensionHints(finished.answers) });
  }

  function suggest() {
    if (!finished || busy) return;
    Alert.alert(
      'Suggest ratings with AI?',
      'This sends the family’s answers to Anthropic on your own key, without names, contact details, the birth date or insurance numbers. Written answers may still mention people. Nothing is stored by ReferralFit, and you confirm every rating.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Suggest', onPress: () => { void runSuggestion(finished); } },
      ],
    );
  }

  async function runSuggestion(assessment: FamilyAssessment) {
    setBusy('ai');
    setMessage(null);
    try {
      const key = await getAnthropicKey(userId);
      if (!key) { setHasKey(false); setMessage({ ok: false, text: 'Add your Anthropic key in Workspace and settings, AI drafts.' }); return; }
      const suggestion = await requestLevelSuggestion(levelOfCareFacts(assessment.answers), key);
      if (!mountedRef.current) return;
      const ratings: LevelOfCareSeed['ratings'] = {};
      const notes: LevelOfCareSeed['notes'] = {};
      const evidence: LevelOfCareSeed['evidence'] = {};
      for (const item of suggestion) {
        ratings[item.dimension as DimensionKey] = item.rating;
        if (item.reason) notes[item.dimension as DimensionKey] = item.reason;
        if (item.evidence) evidence[item.dimension as DimensionKey] = item.evidence;
      }
      onRateLevel({ fromAi: true, ratings, notes, evidence, hints: dimensionHints(assessment.answers) });
    } catch (error) {
      if (error instanceof AssistUnavailableError && error.reason === 'key') setHasKey(false);
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'The suggestion is unavailable right now.' });
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }

  const sendForm = (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{current ? 'Send a new assessment' : 'Send the family assessment'}</Text>
      <Text style={styles.body}>
        The family gets a private link to a full intake assessment in {practiceName}’s name, with your logo. It saves as they go, asks for one consent to share with other ethical providers to find the best fit, and comes back to this case.
      </Text>
      <Text style={styles.label}>FAMILY MEMBER</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={COLORS.gray} accessibilityLabel="Family member's name" maxLength={120} style={styles.input} />
      <Text style={styles.label}>EMAIL</Text>
      <TextInput value={email} onChangeText={setEmail} placeholder="Email address" placeholderTextColor={COLORS.gray} accessibilityLabel="Family member's email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} maxLength={254} style={styles.input} />
      <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: busy === 'email' }} disabled={Boolean(busy)} onPress={() => { void send('email'); }} style={[styles.primaryButton, busy && styles.off]}>
        {busy === 'email' ? <ActivityIndicator color={COLORS.white} accessibilityLabel="Sending" /> : <Text style={styles.primaryButtonText}>Email the link</Text>}
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={() => { void send('share'); }} style={[styles.secondaryButton, busy && styles.off]}>
        <Text style={styles.secondaryButtonText}>{busy === 'share' ? 'Getting the link…' : 'Text or copy the link instead'}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to case file" disabled={busy === 'ai'} onPress={onClose} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} accessibilityRole="header">Family assessment</Text>
        <View style={styles.headerButton} />
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          {message ? (
            <View style={[styles.notice, message.ok && styles.noticeOk]} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Text style={[styles.noticeText, message.ok && styles.noticeTextOk]}>{message.text}</Text>
            </View>
          ) : null}
          {!list && !loadError ? <ActivityIndicator style={styles.loading} color={COLORS.forest} accessibilityLabel="Loading" /> : null}
          {loadError ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{loadError}</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => { void load(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Try again</Text></TouchableOpacity>
            </View>
          ) : null}

          {list && current ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{current.id === newest?.id ? 'Status' : 'An earlier assessment'}</Text>
              <Text style={styles.body}>{statusLine(current)}</Text>
              {current.id !== newest?.id ? (
                <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={() => setShownId(null)} style={styles.textButton}>
                  <Text style={styles.textButtonText}>Back to the newest assessment</Text>
                </TouchableOpacity>
              ) : null}
              {live ? (
                <>
                  <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={() => { void send('share', live); }} style={[styles.secondaryButton, busy && styles.off]}>
                    <Text style={styles.secondaryButtonText}>Text or copy a new link</Text>
                  </TouchableOpacity>
                  {live.recipientEmail ? (
                    <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={() => { void send('email', live); }} style={[styles.secondaryButton, busy && styles.off]}>
                      <Text style={styles.secondaryButtonText}>Email it again to {live.recipientEmail}</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={stop} style={styles.textButton}>
                    <Text style={styles.dangerText}>Stop the link</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          ) : null}

          {earlyAlerts.length ? (
            <>
              {earlyAlerts.map((alert) => (
                <View key={alert.text} style={[styles.alert, alert.severity === 'medical' && styles.alertMedical]} accessibilityRole="alert">
                  <Text style={[styles.alertText, alert.severity === 'medical' && styles.alertTextMedical]}>{alert.text}</Text>
                </View>
              ))}
              {earlyAlerts.some((alert) => alert.severity === 'urgent') ? (
                <Text style={styles.urgentNote}>The family has not finished, but an answer they saved suggests someone may be in danger. Reach out today. If someone may be in danger, call 911; for a mental health crisis, call or text 988.</Text>
              ) : null}
            </>
          ) : null}

          {finished ? (
            <>
              {assessmentAlerts(finished).map((alert) => (
                <View key={alert.text} style={[styles.alert, alert.severity === 'medical' && styles.alertMedical]} accessibilityRole="alert">
                  <Text style={[styles.alertText, alert.severity === 'medical' && styles.alertTextMedical]}>{alert.text}</Text>
                </View>
              ))}
              {assessmentAlerts(finished).some((alert) => alert.severity === 'urgent') ? (
                <Text style={styles.urgentNote}>Reach out to the family today. If someone may be in danger, call 911; for a mental health crisis, call or text 988.</Text>
              ) : null}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Level of care</Text>
                <Text style={styles.body}>{dsmLine(finished.answers)}</Text>
                <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={rateByHand} style={[styles.primaryButton, busy && styles.off]}>
                  <Text style={styles.primaryButtonText}>Rate the level of care</Text>
                </TouchableOpacity>
                <Text style={styles.hint}>The family’s answers show under each of the six areas.</Text>
                {aiKeysSupported && hasKey ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: busy === 'ai' }} disabled={Boolean(busy)} onPress={suggest} style={[styles.secondaryButton, busy && styles.off]}>
                    {busy === 'ai' ? <ActivityIndicator color={COLORS.forest} accessibilityLabel="Reading the answers" /> : <Text style={styles.secondaryButtonText}>Start from an AI suggestion</Text>}
                  </TouchableOpacity>
                ) : null}
              </View>

              {photos.front || photos.back ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Insurance card</Text>
                  {photos.front ? <Image source={{ uri: photos.front }} style={styles.photo} resizeMode="contain" accessibilityLabel="Front of the insurance card" /> : null}
                  {photos.back ? <Image source={{ uri: photos.back }} style={styles.photo} resizeMode="contain" accessibilityLabel="Back of the insurance card" /> : null}
                  <Text style={styles.hint}>Private: these links stop working after five minutes.</Text>
                </View>
              ) : null}

              <Text style={styles.sectionLabel}>THE FAMILY’S ANSWERS</Text>
              {answerSections(finished.answers).map((section) => {
                const expanded = openSection === section.id;
                return (
                  <View key={section.id} style={styles.card}>
                    <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setOpenSection(expanded ? null : section.id)}>
                      <Text style={styles.cardTitle}>{section.title}</Text>
                      <Text style={styles.hint}>{expanded ? 'Hide' : `${section.lines.length} ${section.lines.length === 1 ? 'answer' : 'answers'} · Show`}</Text>
                    </TouchableOpacity>
                    {expanded ? section.lines.map((line) => (
                      <View key={line.label} style={styles.answer}>
                        <Text style={styles.answerLabel}>{line.label}</Text>
                        <Text style={styles.answerValue} selectable>{line.value}</Text>
                      </View>
                    )) : null}
                  </View>
                );
              })}

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Consent</Text>
                <Text style={styles.body}>
                  Signed by {finished.consentName || 'the family'}{finished.consentAt ? ` on ${new Date(finished.consentAt).toLocaleString()}` : ''} (version {finished.consentVersion || 'unknown'}): one consent to share with other ethical, licensed providers to find the best fit.
                </Text>
                <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: showConsent }} onPress={() => setShowConsent(!showConsent)} style={styles.textButton}>
                  <Text style={styles.textButtonText}>{showConsent ? 'Hide the words they signed' : 'Show the words they signed'}</Text>
                </TouchableOpacity>
                {showConsent ? <Text style={styles.consent} selectable>{finished.consentText}</Text> : null}
              </View>
            </>
          ) : null}

          {list && !live && current?.id === newest?.id ? sendForm : null}

          {current ? (
            <TouchableOpacity accessibilityRole="button" disabled={Boolean(busy)} onPress={remove} style={styles.textButton}>
              <Text style={styles.dangerText}>{busy === 'delete' ? 'Deleting…' : 'Delete this assessment'}</Text>
            </TouchableOpacity>
          ) : null}

          {earlier.length && current?.id === newest?.id ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Earlier assessments</Text>
              {earlier.map((item) => (
                <TouchableOpacity key={item.id} accessibilityRole="button" disabled={Boolean(busy)} onPress={() => { setOpenSection(null); setShowConsent(false); setShownId(item.id); }} style={styles.textButton}>
                  <Text style={styles.textButtonText}>{statusLine(item)} · Open</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1, minWidth: 0 },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  content: { padding: 18, paddingBottom: 56, gap: 12 },
  loading: { marginTop: 40 },
  card: { backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 14, gap: 6 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  body: { fontSize: 14, lineHeight: 20, color: COLORS.inkSoft },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.muted },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.muted, marginTop: 8 },
  sectionLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.muted, marginTop: 6 },
  input: { minHeight: 44, borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: COLORS.ink },
  primaryButton: { minHeight: 50, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  secondaryButton: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 14 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  textButtonText: { color: COLORS.forest, fontSize: 14, fontWeight: '700' },
  dangerText: { color: COLORS.coralText, fontSize: 14, fontWeight: '700' },
  notice: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12 },
  noticeOk: { backgroundColor: COLORS.mintPale },
  noticeText: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, fontWeight: '600' },
  noticeTextOk: { color: COLORS.forest },
  alert: { backgroundColor: COLORS.coral, borderRadius: 12, padding: 12 },
  alertMedical: { backgroundColor: COLORS.goldPale },
  alertText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  alertTextMedical: { color: COLORS.gold },
  urgentNote: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, fontWeight: '700' },
  photo: { width: '100%', height: 200, borderRadius: 10, backgroundColor: COLORS.mintPale },
  answer: { borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 8, marginTop: 6 },
  answerLabel: { fontSize: 12, color: COLORS.muted },
  answerValue: { fontSize: 15, lineHeight: 21, color: COLORS.ink, marginTop: 2 },
  consent: { fontSize: 13, lineHeight: 19, color: COLORS.inkSoft },
  off: { opacity: 0.5 },
});
