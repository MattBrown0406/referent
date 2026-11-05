// "True cost to the family" on the case file's Benefits card: the plan's
// amounts, a length of stay, and the estimate for each program on the case
// (the one the family was referred to, then every program asked for a VOB).
// The numbers come from src/lib/family-cost.ts; this only lays them out.
// Practitioner-facing: nothing here is sent anywhere.

import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { Partner } from '../data';
import { planNetworkStatusForPartner, type CaseBenefits, type VobRequest } from './insurance';
import {
  ESTIMATE_FOOTNOTE,
  ESTIMATE_LABEL,
  STAY_DAY_CHOICES,
  caseCostPrograms,
  familyCostForProgram,
  formatCostRange,
  hasPlanCosts,
  networkBenefitsSummary,
  outOfNetworkSummary,
} from './family-cost';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mintPale: '#EDF4EF',
  white: '#FFFFFF',
  coral: '#D9795F',
  gray: '#73827D',
  line: '#DDE4DF',
};

type Props = {
  plan: CaseBenefits | null;
  requests: VobRequest[];
  partners: Partner[];
  /** The family's payment for this case: the linked match's plan, the plan on file, or 'Cash pay'. */
  insurance: string;
  /** The program the case's match was referred to, if any. */
  assignedPartnerId?: string;
  days: number;
  onDaysChange: (days: number) => void;
  /** false on a server without the family-cost migration. */
  costsAvailable: boolean;
};

export default function FamilyCostPanel({ plan, requests, partners, insurance, assignedPartnerId, days, onDaysChange, costsAvailable }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!costsAvailable) {
    return (
      <View style={styles.block}>
        <Text style={styles.label}>TRUE COST TO THE FAMILY</Text>
        <Text style={styles.note}>Cost estimates need a server update that has not been applied yet. Everything else on this card works as before.</Text>
      </View>
    );
  }
  const cashPay = insurance === 'Cash pay';
  const programs = caseCostPrograms(requests, partners, assignedPartnerId);
  return (
    <View style={styles.block}>
      <Text style={styles.label}>TRUE COST TO THE FAMILY</Text>
      {!cashPay ? (
        <View style={styles.amounts}>
          <Text style={styles.amountLine}><Text style={styles.amountHead}>In-network: </Text>{networkBenefitsSummary(plan?.inNetwork)}</Text>
          <Text style={styles.amountLine}><Text style={styles.amountHead}>Out-of-network: </Text>{outOfNetworkSummary(plan)}</Text>
          {!hasPlanCosts(plan) ? <Text style={styles.note}>Add the deductible, out-of-pocket max and coinsurance under Edit to see what each program would cost this family.</Text> : null}
        </View>
      ) : null}
      <View style={styles.days} accessibilityRole="radiogroup" accessibilityLabel="Length of stay">
        {STAY_DAY_CHOICES.map((choice) => {
          const active = choice === days;
          return (
            <TouchableOpacity
              key={choice}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${choice} days`}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
              onPress={() => onDaysChange(choice)}
              style={[styles.dayChip, active && styles.dayChipActive]}
            >
              <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>{choice} days</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {programs.map((program, index) => {
        const partner = program.partnerId ? partners.find((item) => item.id === program.partnerId) : undefined;
        const result = familyCostForProgram({
          insurance,
          plan,
          // The linked match may pay with another plan than the one on file:
          // then nothing is estimated from this plan's numbers.
          planCarrier: plan ? plan.carrier : undefined,
          requests,
          partner: partner || null,
          programName: program.programName,
          perProgram: partner && insurance && !cashPay ? planNetworkStatusForPartner(partner, insurance) : 'unknown',
          days,
        });
        const open = expanded === program.key;
        const lines = open ? result.basis : result.basis.slice(0, 1);
        return (
          <TouchableOpacity
            key={program.key}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${program.programName}: estimated family cost for ${days} days, ${formatCostRange(result)}. ${open ? 'Tap to show less.' : 'Tap to see how it was worked out.'}`}
            onPress={() => setExpanded(open ? null : program.key)}
            style={[styles.row, index === programs.length - 1 && styles.rowLast]}
          >
            <View style={styles.rowTop}>
              <Text style={styles.program} numberOfLines={2}>{program.programName}</Text>
              <Text style={result.known ? styles.value : styles.valueUnknown}>{formatCostRange(result)}</Text>
            </View>
            {lines.map((line) => <Text key={line} style={styles.detail}>{line}</Text>)}
            {result.missing.length ? <Text style={styles.detail}>Still needed: {result.missing.join('; ')}</Text> : null}
            {result.warnings.map((warning) => <Text key={warning} style={styles.warning}>{warning}</Text>)}
            {!open && result.basis.length > 1 ? <Text style={styles.more}>How it was worked out</Text> : null}
          </TouchableOpacity>
        );
      })}
      {!programs.length ? (
        <Text style={styles.note}>{cashPay ? 'Refer the family to a program from Find placement to see its cost here.' : 'Request a VOB from a program to see what it would cost this family.'}</Text>
      ) : null}
      <Text style={styles.footnote}>{ESTIMATE_LABEL}. {ESTIMATE_FOOTNOTE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: 14, borderTopWidth: 1, borderTopColor: '#EDF0ED', paddingTop: 12 },
  label: { color: COLORS.gray, fontSize: 10, marginBottom: 6 },
  amounts: { marginBottom: 8 },
  amountLine: { color: COLORS.inkSoft, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  amountHead: { color: COLORS.ink, fontWeight: '700' },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  dayChip: { minHeight: 36, justifyContent: 'center', borderRadius: 18, paddingHorizontal: 11, backgroundColor: COLORS.mintPale, borderWidth: 1, borderColor: COLORS.line },
  dayChipActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  dayChipText: { color: COLORS.inkSoft, fontSize: 11, fontWeight: '700' },
  dayChipTextActive: { color: COLORS.white },
  row: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#EDF0ED' },
  rowLast: { borderBottomWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  program: { flex: 1, color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  value: { color: COLORS.ink, fontSize: 13, fontWeight: '800', textAlign: 'right', flexShrink: 0, maxWidth: '55%' },
  valueUnknown: { color: COLORS.gray, fontSize: 12, fontWeight: '700', textAlign: 'right', flexShrink: 0 },
  detail: { color: COLORS.gray, fontSize: 10, lineHeight: 14, marginTop: 3 },
  warning: { color: COLORS.coral, fontSize: 10, lineHeight: 14, marginTop: 4, fontWeight: '600' },
  more: { color: COLORS.forest, fontSize: 10, fontWeight: '700', marginTop: 4 },
  note: { color: COLORS.gray, fontSize: 11, lineHeight: 16, marginTop: 6 },
  footnote: { color: COLORS.gray, fontSize: 9, lineHeight: 14, marginTop: 9 },
});
