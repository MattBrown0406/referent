import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, Dropdown, MultiDropdown, NetBadge, PrimaryButton, ScoreBar, SectionLabel, TypeBadge } from '../components';
import { colors } from '../theme';
import { useStore } from '../store';
import { scoreReferents } from '../match';
import { CASH_PAY, paymentSectionsForState } from '../insurance';
import { MatchCriteria, Referent, REFERENT_TYPES, SPECIALTIES } from '../types';

const ANY_TYPE = 'Any level of care';
const ANYWHERE = 'Anywhere';

const EMPTY: MatchCriteria = {
  type: null,
  state: null,
  payment: CASH_PAY,
  cashBudget: '',
  specialties: [],
};

export default function MatchScreen({ onSelect }: { onSelect: (r: Referent) => void }) {
  const { referents, referralStats } = useStore();
  const [criteria, setCriteria] = useState<MatchCriteria>(EMPTY);
  const [showResults, setShowResults] = useState(false);

  const states = useMemo(
    () => Array.from(new Set(referents.map((r) => r.state))).filter(Boolean).sort(),
    [referents]
  );

  const paymentSections = useMemo(() => paymentSectionsForState(criteria.state), [criteria.state]);

  const results = useMemo(
    () => (showResults ? scoreReferents(referents, criteria, referralStats) : []),
    [showResults, referents, criteria, referralStats]
  );

  const set = (patch: Partial<MatchCriteria>) => {
    setCriteria((c) => ({ ...c, ...patch }));
    setShowResults(false);
  };

  const setState = (label: string) => {
    const state = label === ANYWHERE ? null : label;
    // If the selected insurance plan isn't offered in the new state's list, fall back to Cash Pay.
    const stillAvailable = paymentSectionsForState(state).some((s) => s.items.includes(criteria.payment));
    set({ state, payment: stillAvailable ? criteria.payment : CASH_PAY });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 90 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Find Placement</Text>
      <Text style={styles.subtitle}>
        Clinical fit and budget come first — reciprocity breaks the tie.
      </Text>

      <SectionLabel>Location</SectionLabel>
      <Dropdown
        title="Location"
        placeholder={ANYWHERE}
        value={criteria.state ?? ANYWHERE}
        sections={[{ items: [ANYWHERE] }, { header: 'States', items: states }]}
        onSelect={setState}
      />

      <SectionLabel>Payment / Insurance</SectionLabel>
      <Dropdown
        title="Payment / Insurance"
        placeholder={CASH_PAY}
        value={criteria.payment}
        sections={paymentSections}
        onSelect={(payment) => set({ payment })}
      />
      {criteria.payment === CASH_PAY && (
        <TextInput
          style={styles.input}
          placeholder="Maximum monthly budget, e.g. 30000"
          placeholderTextColor={colors.subtext}
          value={criteria.cashBudget}
          onChangeText={(v) => set({ cashBudget: v })}
          keyboardType="numeric"
        />
      )}

      <SectionLabel>Level of Care</SectionLabel>
      <Dropdown
        title="Level of Care"
        placeholder={ANY_TYPE}
        value={criteria.type ?? ANY_TYPE}
        sections={[{ items: [ANY_TYPE] }, { header: 'Levels of Care', items: [...REFERENT_TYPES] }]}
        onSelect={(v) => set({ type: v === ANY_TYPE ? null : (v as MatchCriteria['type']) })}
      />

      <SectionLabel>Therapeutic Needs</SectionLabel>
      <MultiDropdown
        title="Therapeutic Needs"
        placeholder="Any — tap to select"
        values={criteria.specialties}
        options={[...SPECIALTIES]}
        onChange={(specialties) => set({ specialties })}
      />

      <View style={{ marginTop: 20, flexDirection: 'row', gap: 10 }}>
        <PrimaryButton label="Find Matches" onPress={() => setShowResults(true)} style={{ flex: 1 }} />
        <PrimaryButton label="Reset" variant="secondary" onPress={() => { setCriteria(EMPTY); setShowResults(false); }} />
      </View>

      {showResults && (
        <>
          <SectionLabel>
            {results.length} Match{results.length === 1 ? '' : 'es'} — Ranked
          </SectionLabel>
          {results.length === 0 && <Text style={styles.dim}>No referents match that level of care. Try broadening.</Text>}
          {results.map((res, idx) => (
            <Pressable key={res.referent.id} onPress={() => onSelect(res.referent)}>
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={styles.rankCircle}>
                    <Text style={styles.rankText}>{idx + 1}</Text>
                  </View>
                  <View style={{ flex: 1, paddingHorizontal: 10 }}>
                    <Text style={styles.name}>{res.referent.name}</Text>
                    <Text style={styles.meta}>
                      {res.referent.city}, {res.referent.state} · {res.referent.type}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.score}>{res.total}</Text>
                    <Text style={styles.scoreOutOf}>/ 100</Text>
                  </View>
                </View>

                <View style={{ marginTop: 10 }}>
                  <ScoreBar label="Clinical fit" value={res.clinical} max={40} />
                  <ScoreBar label="Payment" value={res.payment} max={30} />
                  <ScoreBar label="Geography" value={res.geography} max={20} />
                  <ScoreBar label="Reciprocity" value={res.reciprocity} max={10} />
                </View>

                {res.paymentNote ? <Text style={[styles.meta, { marginTop: 8 }]}>{res.paymentNote}</Text> : null}
                {res.matchedSpecialties.length > 0 && (
                  <Text style={styles.matched}>✓ {res.matchedSpecialties.join(' · ')}</Text>
                )}
                <View style={{ marginTop: 8, flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  <TypeBadge type={res.referent.type} small />
                  <NetBadge net={res.netInbound} inbound={res.netInbound > 0 ? res.netInbound : 0} />
                </View>
              </Card>
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 8 },
  subtitle: { fontSize: 14, color: colors.subtext, marginTop: 4 },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.text,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginTop: 8,
  },
  dim: { color: colors.subtext, fontSize: 13 },
  rankCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: { fontWeight: '800', color: colors.accent },
  name: { fontSize: 16, fontWeight: '700', color: colors.text },
  meta: { fontSize: 13, color: colors.subtext, marginTop: 2 },
  matched: { fontSize: 13, color: colors.inbound, marginTop: 4, fontWeight: '600' },
  score: { fontSize: 22, fontWeight: '800', color: colors.accent },
  scoreOutOf: { fontSize: 11, color: colors.subtext },
});
