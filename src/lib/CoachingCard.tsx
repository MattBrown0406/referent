import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  coachingLine,
  fetchOwnCoaching,
  MAX_COACHING_NOTE,
  parseCoachingRate,
  saveListingCoaching,
  type ListingCoaching,
} from './coaching';
import { describeError } from './errors';

// Workspace > Your directory profile > Hourly coaching (an interventionist's
// or therapist's own profile; migration 20261108160000). The owner turns it
// on with a rate and a short note; practices see it on the Directory card
// and programs see it when they refer a family.

const COLORS = {
  ink: '#101828',
  gray: '#667085',
  line: '#EAECF0',
  bg: '#F8FAFC',
  blue: '#175CD3',
  blueSoft: '#EFF4FF',
  coral: '#D92D20',
  green: '#067647',
};

type Props = { listingId: string; canEdit: boolean };

export default function CoachingCard({ listingId, canEdit }: Props) {
  const [saved, setSaved] = useState<ListingCoaching | null | undefined>(undefined);
  const [offered, setOffered] = useState(false);
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetchOwnCoaching(listingId)
      .then((coaching) => {
        if (!live) return;
        setSaved(coaching);
        if (coaching) {
          setOffered(coaching.offered);
          setRate(coaching.hourlyRate ? String(coaching.hourlyRate) : '');
          setNote(coaching.note);
        }
      })
      .catch(() => { if (live) setSaved(null); });
    return () => { live = false; };
  }, [listingId]);

  // An older server (no coaching yet), or the profile could not be read: nothing to show.
  if (saved === null) return null;
  if (saved === undefined) return <ActivityIndicator color={COLORS.blue} style={styles.loading} />;

  const parsedRate = parseCoachingRate(rate);
  const dirty = offered !== saved.offered || (offered && parsedRate !== saved.hourlyRate) || note.trim() !== saved.note;
  const invalid = offered && parsedRate === null;

  async function save() {
    if (busy || invalid) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await saveListingCoaching(listingId, offered, offered ? parsedRate : null, note);
      setSaved(next);
      setNote(next.note);
      setMessage({ ok: true, text: next.offered ? 'Saved. Practices and programs see your hourly coaching now.' : 'Saved. Hourly coaching is off.' });
    } catch (error) {
      setMessage({ ok: false, text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) {
    const line = coachingLine(saved);
    return line ? <Text style={styles.readOnly}>{line}</Text> : null;
  }

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.title}>Hourly coaching</Text>
          <Text style={styles.help}>Let programs and other practices know you coach families (or professionals) by the hour, and your rate.</Text>
        </View>
        <Switch
          accessibilityLabel="I offer hourly coaching"
          value={offered}
          disabled={busy}
          onValueChange={(value) => { setOffered(value); setMessage(null); }}
          trackColor={{ true: COLORS.blue }}
        />
      </View>
      {offered ? (
        <>
          <Text style={styles.label}>Hourly rate (US dollars)</Text>
          <View style={styles.rateRow}>
            <Text style={styles.dollar}>$</Text>
            <TextInput
              accessibilityLabel="Hourly rate in dollars"
              value={rate}
              onChangeText={(text) => { setRate(text); setMessage(null); }}
              keyboardType="number-pad"
              placeholder="150"
              placeholderTextColor={COLORS.gray}
              maxLength={6}
              style={[styles.input, styles.rateInput]}
            />
            <Text style={styles.perHour}>per hour</Text>
          </View>
          {invalid && rate.trim() ? <Text style={styles.error}>Enter a whole-dollar rate from $1 to $5,000.</Text> : null}
          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            accessibilityLabel="Coaching note"
            value={note}
            onChangeText={(text) => { setNote(text); setMessage(null); }}
            placeholder="For example: By Zoom or phone, for families and professionals"
            placeholderTextColor={COLORS.gray}
            maxLength={MAX_COACHING_NOTE}
            style={styles.input}
          />
        </>
      ) : null}
      {offered && parsedRate !== null ? (
        <Text style={styles.preview}>Shows as: {coachingLine({ offered: true, hourlyRate: parsedRate, note })}</Text>
      ) : null}
      {message ? <Text style={message.ok ? styles.ok : styles.error}>{message.text}</Text> : null}
      {dirty ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || invalid, busy }}
          disabled={busy || invalid}
          onPress={() => void save()}
          style={[styles.button, (busy || invalid) && styles.buttonDisabled]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save coaching</Text>}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 12 },
  box: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.line, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '700', color: COLORS.ink },
  help: { fontSize: 13, color: COLORS.gray, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '700', color: COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dollar: { fontSize: 17, fontWeight: '700', color: COLORS.ink },
  perHour: { fontSize: 15, color: COLORS.gray },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: COLORS.ink, backgroundColor: COLORS.bg },
  rateInput: { width: 110 },
  preview: { fontSize: 13, color: COLORS.ink, fontStyle: 'italic' },
  readOnly: { marginTop: 10, fontSize: 14, color: COLORS.ink },
  ok: { fontSize: 13, color: COLORS.green, fontWeight: '600' },
  error: { fontSize: 13, color: COLORS.coral, fontWeight: '600' },
  button: { minHeight: 44, borderRadius: 10, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, marginTop: 4 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
