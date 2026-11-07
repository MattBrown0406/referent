// "Level of care" on the case file, and the "Assessed: Inpatient" line on
// the match criteria. Practitioner-facing; nothing here is sent anywhere.
// Inline views only (no Modal): the assessment itself opens inside the case
// file's own sheet (LevelOfCareSheet).
//
// DECISION SUPPORT, NOT A DIAGNOSIS: the card says so, and shows the level
// the practitioner chose beside the one recommended.

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { ReferralMatch } from '../data';
import {
  LEVEL_LABELS,
  assessedLevelLine,
  followsRecommendation,
  formatAssessedDate,
  matchLevelNote,
  pathLabel,
  safetyFlags,
  sortAssessments,
  type CaseAssessment,
  type PlacementLevel,
} from './level-of-care';
import type { CaseAssessmentsEntry } from './level-of-care-api';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  white: '#FFFFFF',
  coral: '#B9553B',
  coralPale: '#F7E7E1',
  gray: '#73827D',
  line: '#DDE4DF',
};

export const DECISION_SUPPORT_LINE = 'Decision support, not a diagnosis. You can always choose a different level and say why.';
export const ONLINE_ONLY_LINE = 'Assessment loads when you\'re online.';

type CardProps = {
  entry: CaseAssessmentsEntry | undefined;
  /** A teammate's name for an assessor's user id. */
  nameFor: (userId: string | null) => string;
  onStart: () => void;
  onFindPlacement: (level: PlacementLevel) => void;
};

export default function LevelOfCareCard({ entry, nameFor, onStart, onFindPlacement }: CardProps) {
  // A server without the feature: nothing at all.
  if (!entry || entry.status === 'unavailable') return null;
  const list = entry.status === 'ready' ? sortAssessments(entry.assessments) : [];
  const current = list[0] || null;
  const earlier = list.slice(1, 4);
  const ready = entry.status === 'ready';
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={styles.title}>Level of care</Text>
          <Text style={styles.hint}>Six areas, rated 0 to 4, give a recommended level with a written rationale for the program and the payer.</Text>
        </View>
        {ready ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={current ? 'Reassess the level of care' : 'Start a level-of-care assessment'} onPress={onStart} style={styles.action}>
            <Ionicons name={current ? 'refresh' : 'clipboard-outline'} size={14} color={COLORS.forest} />
            <Text style={styles.actionText}>{current ? 'Reassess' : 'Start assessment'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {entry.status === 'loading' ? <Text style={styles.note}>Loading the assessment…</Text> : null}
      {entry.status === 'offline' ? <Text style={styles.note}>{ONLINE_ONLY_LINE}</Text> : null}
      {entry.status === 'error' ? <Text style={styles.note}>Could not load the assessment. Pull to refresh to try again.</Text> : null}

      {ready && !current ? (
        <>
          <Text style={styles.note}>No assessment yet. It takes a few minutes and puts the clinical reasoning for this placement on paper.</Text>
          <TouchableOpacity accessibilityRole="button" onPress={onStart} style={styles.primaryButton}>
            <Ionicons name="clipboard-outline" size={16} color={COLORS.white} />
            <Text style={styles.primaryButtonText}>Start assessment</Text>
          </TouchableOpacity>
        </>
      ) : null}

      {current ? <CurrentAssessment assessment={current} nameFor={nameFor} onFindPlacement={onFindPlacement} /> : null}

      {earlier.length ? (
        <View style={styles.earlier}>
          <Text style={styles.label}>EARLIER</Text>
          {earlier.map((item) => (
            <Text key={item.id} style={styles.earlierLine}>
              {formatAssessedDate(item.assessedAt)} · recommended {pathLabel(item.recommendation)}{followsRecommendation(item.recommendation, item.chosenLevel) ? '' : ` · chose ${item.chosenLevel}`}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.footnote}>{DECISION_SUPPORT_LINE}</Text>
    </View>
  );
}

function CurrentAssessment({ assessment, nameFor, onFindPlacement }: { assessment: CaseAssessment; nameFor: (userId: string | null) => string; onFindPlacement: (level: PlacementLevel) => void }) {
  const different = !followsRecommendation(assessment.recommendation, assessment.chosenLevel);
  const flags = safetyFlags(assessment.ratings, assessment.imminentDanger).filter((flag) => flag.severity !== 'advice');
  const by = assessment.assessedBy ? nameFor(assessment.assessedBy) : '';
  return (
    <>
      <View style={styles.row}>
        <View style={styles.metric}>
          <Text style={styles.label}>RECOMMENDED</Text>
          <Text style={styles.value}>{pathLabel(assessment.recommendation)}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.label}>CHOSEN</Text>
          <Text style={styles.value}>{assessment.chosenLevel}</Text>
        </View>
      </View>
      {different && assessment.overrideReason ? <Text style={styles.reason}>Different from the recommendation: {assessment.overrideReason}</Text> : null}
      <Text style={styles.meta}>Assessed {formatAssessedDate(assessment.assessedAt)}{by ? ` by ${by}` : ''}</Text>
      {flags.length ? (
        <View style={styles.flags}>
          <Text style={styles.label}>SAFETY NOTES FROM THIS ASSESSMENT</Text>
          {flags.map((flag) => (
            <View key={flag.key} style={styles.flagRow}>
              <Ionicons name="warning-outline" size={13} color={COLORS.coral} />
              <Text style={styles.flagText}>{flag.key === 'imminent_danger' ? 'Immediate danger was reported at this assessment.' : flag.title}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Find placement at ${LEVEL_LABELS[assessment.chosenLevel]}`}
        onPress={() => onFindPlacement(assessment.chosenLevel)}
        style={styles.secondaryButton}
      >
        <Ionicons name="sparkles-outline" size={15} color={COLORS.forest} />
        <Text style={styles.secondaryButtonText}>Find placement with this level</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── On the match criteria ──────────────────────────────────────────────────

type NoteProps = {
  assessment: CaseAssessment | null;
  matchLevel: ReferralMatch['levelOfCare'];
};

/** "Assessed: Inpatient", and a gentle note when the match's level is moved away from it. The level stays editable. */
export function AssessedLevelNote({ assessment, matchLevel }: NoteProps) {
  if (!assessment) return null;
  const note = matchLevelNote(assessment, matchLevel);
  return (
    <View style={styles.assessedWrap}>
      <View style={styles.assessedChip}>
        <Ionicons name="clipboard-outline" size={12} color={COLORS.forest} />
        <Text style={styles.assessedChipText}>{assessedLevelLine(assessment)}</Text>
      </View>
      {note ? <Text style={styles.gentle}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.white, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: COLORS.line, marginTop: 12 },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: COLORS.ink, fontSize: 14, fontWeight: '800', marginBottom: 4 },
  hint: { color: COLORS.gray, fontSize: 9, lineHeight: 13, marginTop: 2, maxWidth: 250 },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 6 },
  actionText: { color: COLORS.forest, fontSize: 12, fontWeight: '800' },
  note: { color: COLORS.gray, fontSize: 11, lineHeight: 17, backgroundColor: COLORS.white, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line, padding: 13, marginTop: 9 },
  row: { flexDirection: 'row', gap: 12, marginTop: 10 },
  metric: { flex: 1 },
  label: { color: COLORS.gray, fontSize: 10, marginBottom: 3 },
  value: { color: COLORS.ink, fontSize: 13, lineHeight: 18, fontWeight: '800' },
  reason: { color: COLORS.inkSoft, fontSize: 11, lineHeight: 16, marginTop: 8 },
  meta: { color: COLORS.gray, fontSize: 10, marginTop: 6 },
  flags: { marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: COLORS.coralPale },
  flagRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 2 },
  flagText: { flex: 1, color: COLORS.ink, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  primaryButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, backgroundColor: COLORS.forest, marginTop: 10 },
  primaryButtonText: { color: COLORS.white, fontSize: 13, fontWeight: '800' },
  secondaryButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, borderWidth: 1, borderColor: COLORS.forest, backgroundColor: COLORS.mintPale, marginTop: 12 },
  secondaryButtonText: { color: COLORS.forest, fontSize: 13, fontWeight: '800' },
  earlier: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#EDF0ED' },
  earlierLine: { color: COLORS.inkSoft, fontSize: 10, lineHeight: 15 },
  footnote: { color: COLORS.gray, fontSize: 9, lineHeight: 14, marginTop: 9 },
  assessedWrap: { marginTop: -6, marginBottom: 14 },
  assessedChip: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.mintPale, borderRadius: 999, borderWidth: 1, borderColor: COLORS.mint, paddingHorizontal: 9, paddingVertical: 5 },
  assessedChipText: { color: COLORS.forest, fontSize: 11, fontWeight: '800' },
  gentle: { color: COLORS.inkSoft, fontSize: 10, lineHeight: 15, marginTop: 6, paddingHorizontal: 2 },
});
