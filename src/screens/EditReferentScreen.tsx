import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip, ChipRow, PrimaryButton, SectionLabel } from '../components';
import { colors } from '../theme';
import { useStore } from '../store';
import { insuranceOptionsForState } from '../insurance';
import {
  PRICE_UNITS,
  PriceUnit,
  Referent,
  REFERENT_TYPES,
  ReferentType,
  SPECIALTIES,
} from '../types';

export default function EditReferentScreen({
  existing,
  onClose,
}: {
  existing: Referent | null;
  onClose: (saved?: Referent) => void;
}) {
  const { addReferent, updateReferent } = useStore();
  const [name, setName] = useState(existing?.name ?? '');
  const [organization, setOrganization] = useState(existing?.organization ?? '');
  const [type, setType] = useState<ReferentType>(existing?.type ?? 'Residential / Inpatient');
  const [city, setCity] = useState(existing?.city ?? '');
  const [state, setState] = useState(existing?.state ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [cashPrice, setCashPrice] = useState(existing?.cashPrice != null ? String(existing.cashPrice) : '');
  const [priceUnit, setPriceUnit] = useState<PriceUnit>(existing?.priceUnit ?? '/month');
  const [insurance, setInsurance] = useState<string[]>(existing?.insurance ?? []);
  const [specialties, setSpecialties] = useState<string[]>(existing?.specialties ?? []);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState('');

  const toggle = (list: string[], setList: (v: string[]) => void, item: string) =>
    setList(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  // National plans plus the state's Medicaid/regional plans (once a state is entered),
  // plus anything already selected on this referent.
  const insuranceOptions = useMemo(() => {
    const opts = insuranceOptionsForState(state.trim().toUpperCase());
    return Array.from(new Set([...opts, ...insurance]));
  }, [state, insurance]);

  const save = () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    const priceNum = parseFloat(cashPrice.replace(/[^0-9.]/g, ''));
    const payload = {
      name: name.trim(),
      organization: organization.trim() || undefined,
      type,
      city: city.trim(),
      state: state.trim().toUpperCase().slice(0, 2),
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      cashPrice: isFinite(priceNum) && priceNum > 0 ? priceNum : undefined,
      priceUnit: isFinite(priceNum) && priceNum > 0 ? priceUnit : undefined,
      insurance,
      specialties,
      notes: notes.trim() || undefined,
    };
    if (existing) {
      updateReferent(existing.id, payload);
      onClose({ ...existing, ...payload });
    } else {
      const created = addReferent(payload);
      onClose(created);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.navBar}>
        <Pressable onPress={() => onClose()}>
          <Text style={styles.navLink}>Cancel</Text>
        </Pressable>
        <Text style={styles.navTitle}>{existing ? 'Edit Referent' : 'New Referent'}</Text>
        <Pressable onPress={save}>
          <Text style={[styles.navLink, { fontWeight: '800' }]}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <SectionLabel>Basics</SectionLabel>
        <TextInput style={styles.input} placeholder="Name *" placeholderTextColor={colors.subtext} value={name} onChangeText={setName} />
        <TextInput style={styles.input} placeholder="Organization" placeholderTextColor={colors.subtext} value={organization} onChangeText={setOrganization} />

        <SectionLabel>Type</SectionLabel>
        <ChipRow>
          {REFERENT_TYPES.map((t) => (
            <Chip key={t} label={t} small selected={type === t} onPress={() => setType(t)} />
          ))}
        </ChipRow>

        <SectionLabel>Location & Contact</SectionLabel>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[styles.input, { flex: 2 }]} placeholder="City" placeholderTextColor={colors.subtext} value={city} onChangeText={setCity} />
          <TextInput style={[styles.input, { flex: 1 }]} placeholder="ST" placeholderTextColor={colors.subtext} value={state} onChangeText={setState} autoCapitalize="characters" maxLength={2} />
        </View>
        <TextInput style={styles.input} placeholder="Phone" placeholderTextColor={colors.subtext} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <TextInput style={styles.input} placeholder="Email" placeholderTextColor={colors.subtext} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />

        <SectionLabel>Cash Price</SectionLabel>
        <TextInput style={styles.input} placeholder="Amount (e.g. 28000)" placeholderTextColor={colors.subtext} value={cashPrice} onChangeText={setCashPrice} keyboardType="numeric" />
        <ChipRow>
          {PRICE_UNITS.map((u) => (
            <Chip key={u} label={u} small selected={priceUnit === u} onPress={() => setPriceUnit(u)} />
          ))}
        </ChipRow>

        <SectionLabel>Insurance Accepted</SectionLabel>
        <ChipRow>
          {insuranceOptions.map((i) => (
            <Chip key={i} label={i} small selected={insurance.includes(i)} onPress={() => toggle(insurance, setInsurance, i)} />
          ))}
        </ChipRow>

        <SectionLabel>Therapeutic Specialties</SectionLabel>
        <ChipRow>
          {SPECIALTIES.map((s) => (
            <Chip key={s} label={s} small selected={specialties.includes(s)} onPress={() => toggle(specialties, setSpecialties, s)} />
          ))}
        </ChipRow>

        <SectionLabel>Notes</SectionLabel>
        <TextInput
          style={[styles.input, { minHeight: 90, textAlignVertical: 'top' }]}
          placeholder="Program details, admissions contacts, what they're great at…"
          placeholderTextColor={colors.subtext}
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        <View style={{ marginTop: 20 }}>
          <PrimaryButton label={existing ? 'Save Changes' : 'Add Referent'} onPress={save} />
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
  error: { color: colors.danger, fontWeight: '600', marginBottom: 8 },
});
