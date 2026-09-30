import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { formatMoney } from '../data';
import {
  fetchPendingDirectorySubmissions,
  reviewDirectorySubmission,
  type PendingDirectorySubmission,
} from './directory';
import { DIRECTORY_SUBMISSION_FIELDS, PRIVATE_PAY_ONLY, directoryCostLabel } from './directory-submission';

// Platform-admin review queue for the programs and professionals practices
// submitted to the shared directory. Rendered inside the Workspace sheet (no second modal). Showing
// it is only a convenience: list_pending_global_listings and
// review_global_listing both re-check platform-admin status on the server.

type Props = {
  onBack: () => void;
  // Lets the Workspace card keep its pending count current.
  onCountChange: (count: number) => void;
};

const COLORS = {
  ink: '#101828',
  gray: '#667085',
  line: '#EAECF0',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  blue: '#175CD3',
  blueSoft: '#EFF4FF',
  coral: '#D92D20',
  coralSoft: '#FEF3F2',
  amber: '#93370D',
  amberSoft: '#FFFAEB',
};

function insuranceSummary(item: PendingDirectorySubmission): string {
  const plans = item.insurance
    .filter((plan) => plan !== PRIVATE_PAY_ONLY)
    .map((plan) => {
      const statuses = item.insuranceNetworks[plan] ?? ['In-network'];
      const tags = [statuses.includes('In-network') ? 'IN' : '', statuses.includes('Out-of-network') ? 'OON' : ''].filter(Boolean);
      return tags.length ? `${plan} (${tags.join(' + ')})` : plan;
    });
  if (plans.length) return plans.join(' · ');
  return item.insurance.includes(PRIVATE_PAY_ONLY) ? 'Private pay only' : 'Not recorded';
}

function submittedBy(item: PendingDirectorySubmission): string {
  const who = [item.submittedByPractice, item.submittedByMember ? `(${item.submittedByMember})` : ''].filter(Boolean).join(' ');
  return [who || 'Unknown practice', item.submittedAt ? item.submittedAt.slice(0, 10) : ''].filter(Boolean).join(' · ');
}

function missingLabels(item: PendingDirectorySubmission): string {
  return DIRECTORY_SUBMISSION_FIELDS
    .filter((field) => item.missingFields.includes(field.key))
    .map((field) => field.label)
    .join(', ');
}

export default function DirectoryReviewQueue({ onBack, onCountChange }: Props) {
  const [items, setItems] = useState<PendingDirectorySubmission[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // The submission whose reject note is open, and the note being typed.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  // Held in a ref so an inline callback from the parent cannot retrigger the load.
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const next = await fetchPendingDirectorySubmissions();
      setItems(next);
      onCountChangeRef.current(next.length);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(item: PendingDirectorySubmission, approve: boolean, note?: string) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await reviewDirectorySubmission(item.id, approve, note);
      setRejectingId(null);
      setRejectNote('');
      await load();
    } catch (error) {
      Alert.alert(approve ? 'Could not approve' : 'Could not reject', (error as Error).message);
      // Someone else may have reviewed it already; show the current queue.
      await load();
    } finally {
      setBusyId(null);
    }
  }

  function confirmApprove(item: PendingDirectorySubmission) {
    Alert.alert(
      'Approve this listing?',
      `${item.organization || item.name} will appear in the shared directory as a verified listing.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Approve', onPress: () => { void review(item, true); } },
      ],
    );
  }

  return (
    <>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to workspace" onPress={onBack} style={styles.closeButton}>
          <Text style={styles.closeText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Directory submissions</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loadError ? (
        <View style={styles.centered}>
          <Text accessibilityRole="alert" style={styles.errorText}>{loadError}</Text>
          <TouchableOpacity accessibilityRole="button" style={styles.retryButton} onPress={() => void load()}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : items === null ? (
        <View style={styles.centered}><ActivityIndicator color={COLORS.blue} /></View>
      ) : items.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>Nothing waiting for review</Text>
          <Text style={styles.helpText}>When a practice submits a complete program or professional, it shows up here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <Text style={styles.helpText}>
            Oldest first. Approving publishes it as a verified listing. Rejecting leaves it in the practice's own list and shows them your note.
          </Text>
          {items.map((item) => {
            const busy = busyId === item.id;
            const place = [item.city, item.state].filter(Boolean).join(', ');
            return (
              <View key={item.id} style={styles.card}>
                <View style={styles.typeRow}>
                  {(item.types.length ? item.types : ['No type']).map((type) => (
                    <View key={type} style={styles.typePill}><Text style={styles.typePillText}>{type}</Text></View>
                  ))}
                </View>
                <Text style={styles.orgName}>{item.organization || item.name}</Text>
                {place ? <Text style={styles.subtle}>{place}</Text> : null}

                <View style={styles.fieldList}>
                  <Field label="Contact" value={item.name} />
                  <Field label="Phone" value={item.phone} />
                  <Field label="Email" value={item.email} />
                  <Field label="Website" value={item.website} />
                  <Field label={directoryCostLabel(item.types)} value={item.monthlyCost > 0 ? formatMoney(item.monthlyCost) : ''} />
                  <Field label="Insurance" value={insuranceSummary(item)} />
                  {item.therapies.length ? <Field label="Specialties" value={item.therapies.join(' · ')} /> : null}
                  {item.description ? <Field label="Notes" value={item.description} /> : null}
                  <Field label="Submitted by" value={submittedBy(item)} />
                </View>

                {item.missingFields.length ? (
                  <View style={styles.notice}>
                    <Text style={styles.noticeText}>Still missing: {missingLabels(item)}</Text>
                  </View>
                ) : null}

                {rejectingId === item.id ? (
                  <View style={styles.rejectBox}>
                    <TextInput
                      style={styles.noteInput}
                      value={rejectNote}
                      onChangeText={setRejectNote}
                      placeholder="Optional note for the practice — what would help this get listed?"
                      placeholderTextColor={COLORS.gray}
                      accessibilityLabel="Note for the practice"
                      multiline
                      maxLength={2000}
                    />
                    <View style={styles.buttonRow}>
                      <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { setRejectingId(null); setRejectNote(''); }} style={styles.ghostButton}>
                        <Text style={styles.ghostButtonText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => { void review(item, false, rejectNote); }} style={styles.dangerButton}>
                        {busy ? <ActivityIndicator color={COLORS.coral} /> : <Text style={styles.dangerButtonText}>Reject submission</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.buttonRow}>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Reject ${item.organization || item.name}`} disabled={Boolean(busyId)} onPress={() => { setRejectingId(item.id); setRejectNote(''); }} style={styles.dangerButton}>
                      <Text style={styles.dangerButtonText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Approve ${item.organization || item.name}`} accessibilityState={{ disabled: Boolean(busyId), busy }} disabled={Boolean(busyId)} onPress={() => confirmApprove(item)} style={styles.primaryButton}>
                      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Approve</Text>}
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} selectable>{value || 'Not recorded'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    backgroundColor: COLORS.card,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.ink },
  headerSpacer: { width: 52 },
  closeButton: { paddingVertical: 4, paddingHorizontal: 8, minWidth: 52 },
  closeText: { fontSize: 16, fontWeight: '600', color: COLORS.blue },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  errorText: { fontSize: 15, color: COLORS.coral, textAlign: 'center' },
  retryButton: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: COLORS.blueSoft, borderRadius: 8 },
  retryText: { color: COLORS.blue, fontWeight: '600' },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: COLORS.ink },
  content: { padding: 16, gap: 16 },
  helpText: { fontSize: 14, color: COLORS.gray, lineHeight: 20, textAlign: 'left' },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.line,
    padding: 16,
    gap: 10,
  },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  typePill: { backgroundColor: COLORS.blueSoft, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  typePillText: { fontSize: 13, fontWeight: '700', color: COLORS.blue },
  orgName: { fontSize: 18, fontWeight: '700', color: COLORS.ink },
  subtle: { fontSize: 13, color: COLORS.gray },
  fieldList: { gap: 8, marginTop: 2 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldLabel: { width: 96, fontSize: 13, fontWeight: '600', color: COLORS.gray },
  fieldValue: { flex: 1, fontSize: 14, color: COLORS.ink, lineHeight: 19 },
  notice: { backgroundColor: COLORS.amberSoft, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  noticeText: { fontSize: 13, color: COLORS.amber, lineHeight: 18 },
  rejectBox: { gap: 10 },
  noteInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: COLORS.ink,
    backgroundColor: COLORS.bg,
    textAlignVertical: 'top',
  },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  primaryButton: { flex: 1, minHeight: 44, backgroundColor: COLORS.blue, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  dangerButton: { flex: 1, minHeight: 44, backgroundColor: COLORS.coralSoft, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  dangerButtonText: { color: COLORS.coral, fontSize: 16, fontWeight: '700' },
  ghostButton: { flex: 1, minHeight: 44, backgroundColor: COLORS.blueSoft, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  ghostButtonText: { color: COLORS.blue, fontSize: 16, fontWeight: '700' },
});
