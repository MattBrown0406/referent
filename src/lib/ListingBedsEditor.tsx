import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { bedsCadenceLine, bedsLine, type ListingBeds } from './beds';
import { setListingBeds } from './directory';

// "Beds available today" for one directory listing, in the app. Shown only
// to platform admins (the directory card checks fetchIsPlatformAdmin); the
// server re-checks on every save through set_listing_beds, which also admits
// the program that claimed the listing. The portal has the same card for
// programs. Two steppers (men / women), "Full" sets both to 0, "Unknown"
// clears a gender, plus the on-call admissions contact.

type Props = {
  listingId: string;
  beds: ListingBeds | undefined;
  onSaved: (beds: ListingBeds) => void;
  onClose: () => void;
};

const COLORS = {
  ink: '#101828',
  gray: '#667085',
  line: '#EAECF0',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  blue: '#175CD3',
  blueSoft: '#EFF4FF',
  amber: '#B54708',
};

const MAX_BEDS = 999;

function Stepper({ label, value, onChange, disabled }: { label: string; value: number | null; onChange: (next: number | null) => void; disabled: boolean }) {
  const current = value ?? 0;
  return (
    <View style={styles.stepperRow}>
      <View style={styles.stepperLabelBlock}>
        <Text style={styles.stepperLabel}>{label}</Text>
        <Text style={styles.stepperHint}>{value === null ? 'Unknown' : value === 0 ? 'Full' : `${value} open`}</Text>
      </View>
      <View style={styles.stepperControls}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Fewer beds for ${label.toLowerCase()}`}
          disabled={disabled || value === null || value <= 0}
          onPress={() => onChange(Math.max(0, current - 1))}
          style={[styles.stepButton, (disabled || value === null || value <= 0) && styles.stepButtonOff]}
        >
          <Text style={styles.stepButtonText}>−</Text>
        </TouchableOpacity>
        <Text accessibilityLabel={`${label}: ${value === null ? 'unknown' : value}`} style={styles.stepValue}>{value === null ? '–' : value}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`More beds for ${label.toLowerCase()}`}
          disabled={disabled || current >= MAX_BEDS}
          onPress={() => onChange(Math.min(MAX_BEDS, current + 1))}
          style={[styles.stepButton, (disabled || current >= MAX_BEDS) && styles.stepButtonOff]}
        >
          <Text style={styles.stepButtonText}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Mark beds for ${label.toLowerCase()} unknown`}
          disabled={disabled || value === null}
          onPress={() => onChange(null)}
          style={styles.unknownButton}
        >
          <Text style={[styles.unknownButtonText, (disabled || value === null) && { opacity: 0.4 }]}>Unknown</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ListingBedsEditor({ listingId, beds, onSaved, onClose }: Props) {
  const [bedsMale, setBedsMale] = useState<number | null>(beds?.bedsMale ?? null);
  const [bedsFemale, setBedsFemale] = useState<number | null>(beds?.bedsFemale ?? null);
  const [contactName, setContactName] = useState(beds?.admissionsContactName || '');
  const [contactPhone, setContactPhone] = useState(beds?.admissionsContactPhone || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBedsMale(beds?.bedsMale ?? null);
    setBedsFemale(beds?.bedsFemale ?? null);
    setContactName(beds?.admissionsContactName || '');
    setContactPhone(beds?.admissionsContactPhone || '');
  }, [listingId, beds?.bedsMale, beds?.bedsFemale, beds?.admissionsContactName, beds?.admissionsContactPhone]);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await setListingBeds(listingId, { bedsMale, bedsFemale, admissionsContactName: contactName, admissionsContactPhone: contactPhone });
      onSaved({ ...saved, bedsCadenceDays: saved.bedsCadenceDays ?? beds?.bedsCadenceDays ?? null });
      onClose();
    } catch (error) {
      Alert.alert('Could not save beds', (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = bedsLine(beds);
  const cadence = bedsCadenceLine(beds);

  return (
    <View style={styles.box}>
      <Text style={styles.title}>Beds available today</Text>
      <Text style={styles.help}>
        Counts show on directory cards and in match results for seven days, then read as Unconfirmed until they are confirmed again. Unknown is fine when a program has not said.
      </Text>
      {current ? <Text style={styles.current}>{current}{cadence ? `  ·  ${cadence}` : ''}</Text> : null}
      <Stepper label="Men" value={bedsMale} onChange={setBedsMale} disabled={busy} />
      <Stepper label="Women" value={bedsFemale} onChange={setBedsFemale} disabled={busy} />
      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy}
        onPress={() => { setBedsMale(0); setBedsFemale(0); }}
        style={styles.fullButton}
      >
        <Text style={styles.fullButtonText}>Full today (0 men, 0 women)</Text>
      </TouchableOpacity>
      <Text style={styles.fieldLabel}>On-call admissions contact (optional)</Text>
      <TextInput
        style={styles.input}
        value={contactName}
        onChangeText={setContactName}
        placeholder="Name"
        placeholderTextColor={COLORS.gray}
        accessibilityLabel="Admissions contact name"
        maxLength={120}
        editable={!busy}
      />
      <TextInput
        style={styles.input}
        value={contactPhone}
        onChangeText={setContactPhone}
        placeholder="Phone"
        placeholderTextColor={COLORS.gray}
        accessibilityLabel="Admissions contact phone"
        keyboardType="phone-pad"
        maxLength={40}
        editable={!busy}
      />
      <View style={styles.buttonRow}>
        <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onClose} style={styles.ghostButton}>
          <Text style={styles.ghostButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => { void save(); }} style={styles.primaryButton}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Confirm beds</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 10, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 12 },
  title: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  help: { fontSize: 13, color: COLORS.gray, lineHeight: 18 },
  current: { fontSize: 13, fontWeight: '600', color: COLORS.amber },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 4 },
  stepperLabelBlock: { flex: 1 },
  stepperLabel: { fontSize: 14, fontWeight: '700', color: COLORS.ink },
  stepperHint: { fontSize: 12, color: COLORS.gray },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.blueSoft, alignItems: 'center', justifyContent: 'center' },
  stepButtonOff: { opacity: 0.4 },
  stepButtonText: { fontSize: 20, fontWeight: '700', color: COLORS.blue, lineHeight: 22 },
  stepValue: { minWidth: 32, textAlign: 'center', fontSize: 18, fontWeight: '800', color: COLORS.ink },
  unknownButton: { paddingHorizontal: 8, paddingVertical: 6 },
  unknownButtonText: { fontSize: 12, fontWeight: '600', color: COLORS.gray },
  fullButton: { alignSelf: 'flex-start', backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  fullButtonText: { fontSize: 13, fontWeight: '600', color: COLORS.ink },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, color: COLORS.ink, backgroundColor: COLORS.bg },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  primaryButton: { flex: 1, minHeight: 44, backgroundColor: COLORS.blue, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  ghostButton: { flex: 1, minHeight: 44, backgroundColor: COLORS.blueSoft, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  ghostButtonText: { color: COLORS.blue, fontSize: 15, fontWeight: '700' },
});
