import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip, ChipRow, PrimaryButton, SectionLabel } from '../components';
import { colors } from '../theme';
import { useStore } from '../store';
import { ReferralDirection } from '../types';

export default function LogReferralScreen({
  presetReferentId,
  presetDirection,
  onClose,
}: {
  presetReferentId?: string;
  presetDirection?: ReferralDirection;
  onClose: () => void;
}) {
  const { referents, addReferral } = useStore();
  const [referentId, setReferentId] = useState<string | null>(presetReferentId ?? null);
  const [direction, setDirection] = useState<ReferralDirection>(presetDirection ?? 'inbound');
  const [clientLabel, setClientLabel] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const options = useMemo(() => {
    const q = search.trim().toLowerCase();
    return referents
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [referents, search]);

  const save = () => {
    if (!referentId) {
      setError('Pick a referent.');
      return;
    }
    if (!clientLabel.trim()) {
      setError('Enter client initials (e.g. J.D.).');
      return;
    }
    addReferral({
      referentId,
      direction,
      clientLabel: clientLabel.trim(),
      note: note.trim() || undefined,
      date: new Date().toISOString(),
    });
    onClose();
  };

  return (
    <View style={styles.container}>
      <View style={styles.navBar}>
        <Pressable onPress={onClose}>
          <Text style={styles.navLink}>Cancel</Text>
        </Pressable>
        <Text style={styles.navTitle}>Log Referral</Text>
        <Pressable onPress={save}>
          <Text style={[styles.navLink, { fontWeight: '800' }]}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <SectionLabel>Direction</SectionLabel>
        <ChipRow>
          <Chip label="⬇ Inbound — they sent us a client" selected={direction === 'inbound'} onPress={() => setDirection('inbound')} />
          <Chip label="⬆ Outbound — we sent them a client" selected={direction === 'outbound'} onPress={() => setDirection('outbound')} />
        </ChipRow>

        <SectionLabel>Client (initials only)</SectionLabel>
        <TextInput style={styles.input} placeholder="e.g. J.D." placeholderTextColor={colors.subtext} value={clientLabel} onChangeText={setClientLabel} />

        <SectionLabel>Referent</SectionLabel>
        <TextInput style={styles.input} placeholder="Search referents…" placeholderTextColor={colors.subtext} value={search} onChangeText={setSearch} />
        <View style={{ gap: 6 }}>
          {options.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => setReferentId(r.id)}
              style={[styles.option, referentId === r.id && styles.optionSelected]}
            >
              <Text style={[styles.optionText, referentId === r.id && { color: '#fff', fontWeight: '700' }]}>
                {r.name} · {r.type} · {r.city}, {r.state}
              </Text>
            </Pressable>
          ))}
        </View>

        <SectionLabel>Note</SectionLabel>
        <TextInput
          style={[styles.input, { minHeight: 70, textAlignVertical: 'top' }]}
          placeholder="Context — level of care, insurance, outcome…"
          placeholderTextColor={colors.subtext}
          value={note}
          onChangeText={setNote}
          multiline
        />

        <View style={{ marginTop: 20 }}>
          <PrimaryButton label="Save Referral" onPress={save} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  navBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  navLink: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  navTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.text,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: 8,
  },
  option: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  optionSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  optionText: { fontSize: 14, color: colors.text },
  error: { color: colors.danger, fontWeight: '600', marginBottom: 8 },
});
