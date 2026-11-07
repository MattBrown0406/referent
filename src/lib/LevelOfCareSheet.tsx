import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { OfflineError, describeError } from './errors';
import {
  DIMENSIONS,
  DIMENSION_KEYS,
  EMERGENCY_FLAG,
  LEVEL_LABELS,
  NOTE_MAX,
  PLACEMENT_LEVELS,
  RATINGS,
  REASON_HINT,
  REASON_MAX,
  completeRatings,
  defaultChoice,
  emptyDraft,
  followsRecommendation,
  inlineFlags,
  pathLabel,
  prepareAssessment,
  rationale,
  reasonProblem,
  recommend,
  safetyFlags,
  type AssessmentDraft,
  type CaseAssessment,
  type PlacementLevel,
  type Rating,
  type SafetyFlag,
} from './level-of-care';
import { newAssessmentId, saveCaseAssessment, type SavedAssessment } from './level-of-care-api';
import { WEB_PAGE } from './web-layout';

// The level-of-care assessment, opened from the case file. CONTENT ONLY: the
// app puts it inside the case file's own native Modal (CaseDetailModal swaps
// its contents), because iOS cannot present a second sheet over the case
// sheet (Fabric). It never presents anything itself; every question is an
// Alert.
//
// Steps: a safety question, the six areas (five ratings each, with a short
// optional note), the result (recommendation, rationale, safety flags, the
// level to place at), then "Find placement with this level".
//
// DECISION SUPPORT, NOT A DIAGNOSIS: the practitioner can always choose a
// different level, with a one-line reason. Online-only save: offline, the
// answers stay on screen and "Try again" reuses the same id, so the server
// never saves twice.

type Props = {
  caseId: string;
  /** The case's title and contact names: the override reason, which the program reads, may not carry them. */
  names: string[];
  /** The case's current assessment, for "Last time" hints. */
  previous: CaseAssessment | null;
  /** The app's Modal onRequestClose (Android back) calls this, so leaving asks first. */
  backRef: React.MutableRefObject<() => void>;
  /** Back to the case file. */
  onClose: () => void;
  onSaved: (saved: SavedAssessment) => void;
  /** Hands off to the case's "Find placement" with this level on the match. */
  onFindPlacement: (level: PlacementLevel) => void;
};

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
  gold: '#8A6A1F',
  goldPale: '#FBF3DF',
  gray: '#73827D',
  line: '#DDE4DF',
};

const INTRO = -1;
const RESULT = DIMENSION_KEYS.length;
const SAVED = DIMENSION_KEYS.length + 1;

type ChoiceMode = 'recommended' | 'different';

export default function LevelOfCareSheet({ caseId, names, previous, backRef, onClose, onSaved, onFindPlacement }: Props) {
  const [step, setStep] = useState(INTRO);
  const [draft, setDraft] = useState<AssessmentDraft>(emptyDraft);
  const [mode, setMode] = useState<ChoiceMode>('recommended');
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const [savedResult, setSavedResult] = useState<SavedAssessment | null>(null);
  // One id per set of answers: a retry of the same answers reuses it (a
  // no-op on the server if the first try landed); changed answers get a new
  // one, so they are never mistaken for the earlier try.
  const attemptRef = useRef<{ id: string; signature: string } | null>(null);
  const triedOfflineRef = useRef(false);
  const mountedRef = useRef(true);
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const ratings = useMemo(() => completeRatings(draft.ratings), [draft.ratings]);
  const recommendation = useMemo(() => (ratings ? recommend(ratings) : null), [ratings]);
  const started = draft.imminentDanger !== null || Object.keys(draft.ratings).length > 0;

  // The result screen opens on "Use recommended" with the first step (where
  // the client goes now) unless the practitioner already chose. Answers
  // changed since: a choice the new recommendation no longer covers goes
  // back to its default; a "different" level it now covers is just followed.
  useEffect(() => {
    if (step !== RESULT || !recommendation) return;
    const chosen = draft.chosenLevel;
    const follows = Boolean(chosen && followsRecommendation(recommendation, chosen));
    if (mode === 'different') {
      if (follows) setMode('recommended');
      return;
    }
    if (follows) return;
    setDraft((current) => ({ ...current, chosenLevel: defaultChoice(recommendation), overrideReason: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, recommendation?.level, recommendation?.firstStep]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step]);

  function requestBack() {
    if (saving) return;
    if (step === SAVED || !started) {
      onClose();
      return;
    }
    Alert.alert(
      'Leave the assessment?',
      triedOfflineRef.current
        ? 'Your answers are not saved here. If you were offline, the last try may still have gone through: pull to refresh the case to check.'
        : 'Your answers have not been saved.',
      [
        { text: 'Keep going', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: onClose },
      ],
    );
  }
  // The Modal's onRequestClose (Android back) asks the same way.
  useEffect(() => {
    backRef.current = requestBack;
  });

  function setRating(rating: Rating) {
    const key = DIMENSION_KEYS[step];
    if (!key) return;
    setDraft((current) => ({ ...current, ratings: { ...current.ratings, [key]: rating } }));
  }

  function setNote(value: string) {
    const key = DIMENSION_KEYS[step];
    if (!key) return;
    setDraft((current) => ({ ...current, notes: { ...current.notes, [key]: value } }));
  }

  function chooseMode(next: ChoiceMode) {
    setMode(next);
    if (!recommendation) return;
    if (next === 'recommended') setDraft((current) => ({ ...current, chosenLevel: defaultChoice(recommendation), overrideReason: '' }));
    else setDraft((current) => ({ ...current, chosenLevel: current.chosenLevel && !followsRecommendation(recommendation, current.chosenLevel) ? current.chosenLevel : null }));
  }

  async function save() {
    if (saving) return;
    const prepared = prepareAssessment(draft, names);
    if ('problem' in prepared) {
      Alert.alert('Before you save', prepared.problem);
      return;
    }
    const signature = JSON.stringify(prepared.input);
    const id = attemptRef.current?.signature === signature ? attemptRef.current.id : newAssessmentId();
    attemptRef.current = { id, signature };
    setSaving(true);
    setSaveNotice('');
    try {
      const result = await saveCaseAssessment(id, caseId, prepared.input);
      if (!mountedRef.current) return;
      setSavedResult(result);
      setStep(SAVED);
      onSaved(result);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof OfflineError) triedOfflineRef.current = true;
      setSaveNotice(error instanceof OfflineError
        ? 'You are offline, so it may not have saved. Your answers are still here: try again when you are back online. It will not be saved twice.'
        : describeError(error, 'Could not save the assessment.'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  function renderFlag(flag: SafetyFlag) {
    const tone = flag.severity === 'advice' ? styles.flagAdvice : styles.flagUrgent;
    const icon = flag.severity === 'advice' ? 'information-circle-outline' : 'warning-outline';
    return (
      <View key={flag.key} accessibilityRole={flag.severity === 'advice' ? undefined : 'alert'} style={[styles.flag, tone]}>
        <Ionicons name={icon} size={18} color={flag.severity === 'advice' ? COLORS.gold : COLORS.coral} />
        <View style={styles.flex}>
          <Text style={styles.flagTitle}>{flag.title}</Text>
          <Text style={styles.flagText}>{flag.text}</Text>
        </View>
      </View>
    );
  }

  function renderIntro() {
    return (
      <>
        <Text style={styles.title}>Level-of-care assessment</Text>
        <Text style={styles.lead}>Six short questions, each rated 0 to 4, give a recommended level of care with a written rationale for the program's packet and for insurance authorization.</Text>
        <View style={styles.supportBox}>
          <Ionicons name="hand-left-outline" size={18} color={COLORS.forest} />
          <Text style={styles.supportText}>Decision support, not a diagnosis. The recommendation is a starting point for your clinical judgment: you can always choose a different level and say why.</Text>
        </View>

        <Text style={styles.label}>FIRST: IS ANYONE IN IMMEDIATE DANGER RIGHT NOW?</Text>
        <Text style={styles.hint}>Thoughts of suicide with a plan, an overdose, violence, or a medical emergency.</Text>
        <View style={styles.segment}>
          {[{ value: false, label: 'No' }, { value: true, label: 'Yes, someone may be' }].map((option) => {
            const active = draft.imminentDanger === option.value;
            return (
              <TouchableOpacity
                key={option.label}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => setDraft((current) => ({ ...current, imminentDanger: option.value }))}
                style={[styles.segmentItem, active && (option.value ? styles.segmentDanger : styles.segmentItemSelected)]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextSelected]}>{option.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {draft.imminentDanger ? renderFlag(EMERGENCY_FLAG) : null}

        <TouchableOpacity
          accessibilityRole="button"
          disabled={draft.imminentDanger === null}
          onPress={() => setStep(0)}
          style={[styles.primaryButton, draft.imminentDanger === null && styles.buttonDisabled]}
        >
          <Text style={styles.primaryButtonText}>{draft.imminentDanger ? 'Continue the assessment' : 'Start'}</Text>
        </TouchableOpacity>
        <Text style={styles.fine}>The six areas follow the widely used six-dimension framework. The questions, descriptions and rules here are ReferralFit's own.</Text>
      </>
    );
  }

  function renderDimension() {
    const key = DIMENSION_KEYS[step];
    const info = DIMENSIONS[key];
    const chosen = draft.ratings[key];
    const note = draft.notes[key] || '';
    const last = previous ? previous.ratings[key] : null;
    const inline = inlineFlags(key, chosen);
    return (
      <>
        <Text style={styles.progress}>AREA {info.number} OF {DIMENSION_KEYS.length}</Text>
        <Text style={styles.title}>{info.title}</Text>
        <Text style={styles.lead}>{info.covers}</Text>
        {last !== null ? <Text style={styles.hint}>Last time: {last} · {info.ratings[last].label}. Rate what you see now.</Text> : null}
        <View accessibilityRole="radiogroup" accessibilityLabel={info.title}>
          {RATINGS.map((rating) => {
            const active = chosen === rating;
            const option = info.ratings[rating];
            return (
              <TouchableOpacity
                key={rating}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${rating}, ${option.label}. ${option.descriptor}`}
                onPress={() => setRating(rating)}
                style={[styles.rating, active && styles.ratingActive]}
              >
                <View style={[styles.ratingBadge, active && styles.ratingBadgeActive]}>
                  <Text style={[styles.ratingNumber, active && styles.ratingNumberActive]}>{rating}</Text>
                </View>
                <View style={styles.flex}>
                  <Text style={styles.ratingLabel}>{option.label}</Text>
                  <Text style={styles.ratingDescriptor}>{option.descriptor}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
        {inline.map((rule) => renderFlag(rule))}
        <Text style={styles.label}>A SHORT NOTE (OPTIONAL)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={note}
          onChangeText={setNote}
          placeholder="What you saw or heard. Stays in your workspace."
          placeholderTextColor="#99A6A1"
          multiline
          maxLength={NOTE_MAX}
          accessibilityLabel={`A short note on ${info.title.toLowerCase()}`}
        />
        <Text style={styles.hint}>{note.trim().length} of {NOTE_MAX} characters. Notes never go into a packet.</Text>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={chosen === undefined}
          onPress={() => setStep(step + 1)}
          style={[styles.primaryButton, chosen === undefined && styles.buttonDisabled]}
        >
          <Text style={styles.primaryButtonText}>{step === DIMENSION_KEYS.length - 1 ? 'See the recommendation' : 'Next'}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={() => setStep(step - 1)} style={styles.textButton}>
          <Text style={styles.textButtonText}>Back</Text>
        </TouchableOpacity>
      </>
    );
  }

  function renderResult() {
    if (!ratings || !recommendation) return null;
    const sentences = rationale(ratings, recommendation);
    const flags = safetyFlags(ratings, Boolean(draft.imminentDanger));
    const followed = draft.chosenLevel ? followsRecommendation(recommendation, draft.chosenLevel) : mode === 'recommended';
    const reasonIssue = mode === 'different' && draft.chosenLevel && !followed && draft.overrideReason.trim() ? reasonProblem(draft.overrideReason, names) : null;
    const otherLevels = PLACEMENT_LEVELS.filter((level) => !followsRecommendation(recommendation, level));
    // "Use recommended" is where the recommendation sends the client now:
    // the first step when there is one. Going straight to the level after
    // a recommended detox is a different level, with a reason.
    const followOptions: { level: PlacementLevel; label: string }[] = recommendation.firstStep
      ? [{ level: defaultChoice(recommendation), label: `${LEVEL_LABELS[recommendation.firstStep]}: the recommended first step, then ${LEVEL_LABELS[recommendation.level]}` }]
      : [{ level: recommendation.level, label: LEVEL_LABELS[recommendation.level] }];
    return (
      <>
        <Text style={styles.progress}>RECOMMENDATION</Text>
        <View style={styles.resultCard}>
          {recommendation.firstStep ? <Text style={styles.resultStep}>First: {LEVEL_LABELS[recommendation.firstStep]}</Text> : null}
          <Text style={styles.resultLevel}>{recommendation.firstStep ? 'Then: ' : ''}{LEVEL_LABELS[recommendation.level]}</Text>
          {recommendation.support ? <Text style={styles.resultStep}>With: {LEVEL_LABELS[recommendation.support]} as support</Text> : null}
          <View style={styles.rationale}>
            {sentences.map((sentence) => <Text key={sentence} style={styles.rationaleLine}>{sentence}</Text>)}
          </View>
        </View>
        {flags.map((flag) => renderFlag(flag))}

        <Text style={styles.label}>LEVEL TO PLACE AT</Text>
        <View style={styles.segment}>
          {(['recommended', 'different'] as ChoiceMode[]).map((value) => {
            const active = mode === value;
            return (
              <TouchableOpacity key={value} accessibilityRole="radio" accessibilityState={{ selected: active }} onPress={() => chooseMode(value)} style={[styles.segmentItem, active && styles.segmentItemSelected]}>
                <Text style={[styles.segmentText, active && styles.segmentTextSelected]}>{value === 'recommended' ? 'Use recommended' : 'Choose a different level'}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {mode === 'recommended' ? (
          <View accessibilityRole="radiogroup">
            {followOptions.map((option) => {
              const active = draft.chosenLevel === option.level;
              return (
                <TouchableOpacity
                  key={option.level}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => setDraft((current) => ({ ...current, chosenLevel: option.level, overrideReason: '' }))}
                  style={[styles.choice, active && styles.choiceActive]}
                >
                  <Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={20} color={active ? COLORS.forest : COLORS.gray} />
                  <Text style={styles.choiceText}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <>
            <View style={styles.pillRow}>
              {otherLevels.map((level) => {
                const active = draft.chosenLevel === level;
                return (
                  <TouchableOpacity key={level} accessibilityRole="radio" accessibilityState={{ selected: active }} onPress={() => setDraft((current) => ({ ...current, chosenLevel: level }))} style={[styles.pill, active && styles.pillSelected]}>
                    <Text style={[styles.pillText, active && styles.pillTextSelected]}>{LEVEL_LABELS[level]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.label}>WHY A DIFFERENT LEVEL? (REQUIRED)</Text>
            <TextInput
              style={styles.input}
              value={draft.overrideReason}
              onChangeText={(overrideReason) => setDraft((current) => ({ ...current, overrideReason }))}
              placeholder="e.g. Family declined residential; daily IOP near home"
              placeholderTextColor="#99A6A1"
              maxLength={REASON_MAX}
              accessibilityLabel="Why a different level"
            />
            <Text style={reasonIssue ? styles.notice : styles.hint}>{reasonIssue || REASON_HINT}</Text>
          </>
        )}
        <Text style={styles.hint}>The rationale goes in the program's copy of the packet. The family's copy never shows ratings.</Text>

        {saveNotice ? <Text accessibilityRole="alert" style={styles.notice}>{saveNotice}</Text> : null}
        <TouchableOpacity accessibilityRole="button" disabled={saving} onPress={() => { void save(); }} style={[styles.primaryButton, saving && styles.buttonBusy]}>
          {saving ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonText}>{saveNotice ? 'Try again' : 'Save assessment'}</Text>}
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" disabled={saving} onPress={() => setStep(RESULT - 1)} style={styles.textButton}>
          <Text style={styles.textButtonText}>Back to the answers</Text>
        </TouchableOpacity>
        <Text style={styles.fine}>You decide. This is decision support, not a diagnosis.</Text>
      </>
    );
  }

  function renderSaved() {
    if (!savedResult) return null;
    const { assessment } = savedResult;
    return (
      <>
        <View style={styles.savedHead}>
          <Ionicons name="checkmark-circle" size={24} color={COLORS.forest} />
          <Text style={styles.title}>Assessment saved</Text>
        </View>
        <Text style={styles.body}>Recommended: {pathLabel(assessment.recommendation)}.</Text>
        <Text style={styles.body}>Chosen: {LEVEL_LABELS[assessment.chosenLevel]}.</Text>
        <Text style={styles.hint}>It is on the case timeline, and the rationale goes in the program's copy of the packet.</Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => onFindPlacement(assessment.chosenLevel)} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Find placement with this level</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.textButton}>
          <Text style={styles.textButtonText}>Back to the case file</Text>
        </TouchableOpacity>
      </>
    );
  }

  const stepLabel = step >= 0 && step < DIMENSION_KEYS.length ? `${step + 1} of ${DIMENSION_KEYS.length}` : '';
  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to case file" disabled={saving} onPress={requestBack} style={styles.headerButton}>
            <Ionicons name="arrow-back" size={21} color={COLORS.ink} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>Level of care</Text>
          <View style={styles.headerButton}><Text style={styles.headerStep}>{stepLabel}</Text></View>
        </View>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          {step === INTRO ? renderIntro() : null}
          {step >= 0 && step < DIMENSION_KEYS.length ? renderDimension() : null}
          {step === RESULT ? renderResult() : null}
          {step === SAVED ? renderSaved() : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1 },
  handle: { width: 42, height: 5, borderRadius: 3, backgroundColor: '#C8D0CC', alignSelf: 'center', marginTop: 8 },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 14, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 56, minHeight: 44, justifyContent: 'center' },
  headerStep: { textAlign: 'right', fontSize: 12, fontWeight: '700', color: COLORS.gray },
  content: { padding: 18, paddingBottom: 48 },
  title: { fontSize: 20, fontWeight: '800', color: COLORS.ink },
  lead: { fontSize: 14, lineHeight: 20, color: COLORS.inkSoft, marginTop: 6 },
  body: { fontSize: 15, lineHeight: 21, color: COLORS.inkSoft, marginTop: 8 },
  progress: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.forest, marginBottom: 4 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 18, marginBottom: 6 },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 6 },
  fine: { fontSize: 11, lineHeight: 16, color: COLORS.gray, marginTop: 16, textAlign: 'center' },
  notice: { fontSize: 13, lineHeight: 18, color: COLORS.coral, marginTop: 10 },
  supportBox: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.mint, marginTop: 14 },
  supportText: { flex: 1, fontSize: 13, lineHeight: 19, color: COLORS.ink, fontWeight: '600' },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, overflow: 'hidden', backgroundColor: COLORS.white },
  segmentItem: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segmentItemSelected: { backgroundColor: COLORS.forest },
  segmentDanger: { backgroundColor: COLORS.coral },
  segmentText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft, textAlign: 'center' },
  segmentTextSelected: { color: COLORS.white },
  rating: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginTop: 8 },
  ratingActive: { borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  ratingBadge: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.white },
  ratingBadgeActive: { borderColor: COLORS.forest, backgroundColor: COLORS.forest },
  ratingNumber: { fontSize: 14, fontWeight: '900', color: COLORS.inkSoft },
  ratingNumberActive: { color: COLORS.white },
  ratingLabel: { fontSize: 14, fontWeight: '800', color: COLORS.ink },
  ratingDescriptor: { fontSize: 13, lineHeight: 18, color: COLORS.inkSoft, marginTop: 2 },
  input: { minHeight: 48, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, backgroundColor: COLORS.white, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.ink },
  multiline: { minHeight: 76, textAlignVertical: 'top' },
  flag: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, marginTop: 10 },
  flagUrgent: { backgroundColor: COLORS.coralPale, borderColor: '#EBC3B6' },
  flagAdvice: { backgroundColor: COLORS.goldPale, borderColor: '#EEDDB0' },
  flagTitle: { fontSize: 14, fontWeight: '800', color: COLORS.ink },
  flagText: { fontSize: 13, lineHeight: 19, color: COLORS.inkSoft, marginTop: 2 },
  resultCard: { padding: 14, borderRadius: 16, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.white },
  resultStep: { fontSize: 14, fontWeight: '700', color: COLORS.inkSoft },
  resultLevel: { fontSize: 19, fontWeight: '900', color: COLORS.forest, marginVertical: 2 },
  rationale: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#EEF0EE', gap: 6 },
  rationaleLine: { fontSize: 13, lineHeight: 19, color: COLORS.ink },
  choice: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, marginTop: 8 },
  choiceActive: { borderColor: COLORS.forest, backgroundColor: COLORS.mintPale },
  choiceText: { flex: 1, fontSize: 14, fontWeight: '700', color: COLORS.ink },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  pill: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillSelected: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextSelected: { color: COLORS.white },
  savedHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
  buttonBusy: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.4 },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  textButtonText: { color: COLORS.inkSoft, fontSize: 15, fontWeight: '700' },
});
