import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  decideProgramClaimRequest,
  fetchProgramClaimRequests,
  requestedAgo,
  type ProgramClaimRequest,
} from './claim-requests';
import { describeError, isServerUnreachable } from './errors';

// ReferralFit's queue of programs asking to manage their directory listing
// (migration 20261108150000). Rendered inside the Workspace sheet like the
// other admin queues: no second modal. Showing it is only a convenience:
// list_program_claim_requests and decide_program_claim_request re-check
// platform-admin status on the server. Approving binds the account to the
// listing exactly as a claim code does; the program is emailed either way.

type Props = {
  onBack: () => void;
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
  green: '#067647',
  greenSoft: '#ECFDF3',
  amber: '#93370D',
  amberSoft: '#FFFAEB',
};

function open(url: string) {
  Linking.openURL(url).catch(() => Alert.alert('Could not open it', url));
}

function websiteUrl(website: string): string {
  const value = website.trim();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export const DECLINE_NOTE_LABEL = 'The program reads this note in its email and in the portal';

export default function ClaimRequestQueue({ onBack, onCountChange }: Props) {
  const [items, setItems] = useState<ProgramClaimRequest[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const next = await fetchProgramClaimRequests();
      setItems(next || []);
      onCountChangeRef.current((next || []).length);
    } catch (error) {
      setLoadError(isServerUnreachable(error) ? "Claim requests load when you're online." : describeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: ProgramClaimRequest, approve: boolean, decisionNote = '') {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await decideProgramClaimRequest(item.id, approve, decisionNote);
      setDecliningId(null);
      setNote('');
    } catch (error) {
      Alert.alert(approve ? 'Could not approve' : 'Could not decline', describeError(error));
    } finally {
      setBusyId(null);
      await load();
    }
  }

  function confirmApprove(item: ProgramClaimRequest) {
    Alert.alert(
      `Let this account manage ${item.listingName}?`,
      item.emailMatchesWebsite
        ? `${item.requesterEmail} matches the program's website. They will manage the listing in the program portal and get an email now.`
        : `${item.requesterEmail} does not match the program's website. Approve only if you confirmed it, for example by calling the program's main number.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Approve', onPress: () => { void decide(item, true); } },
      ],
    );
  }

  return (
    <>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to workspace" onPress={onBack} style={styles.closeButton}>
          <Text style={styles.closeText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Program claim requests</Text>
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
          <Text style={styles.emptyTitle}>Nothing waiting</Text>
          <Text style={styles.helpText}>When a program asks to manage its listing in the program portal, it shows up here and you get an email.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <Text style={styles.helpText}>
            Oldest first. Approve when you are confident the person works at the program: their email matches the program's website, or you called the program's main number.
          </Text>
          {items.map((item) => {
            const busy = busyId === item.id;
            return (
              <View key={item.id} style={styles.card}>
                <Text style={styles.title}>{item.listingName}</Text>
                {item.place ? <Text style={styles.subtle}>{item.place}</Text> : null}
                <View style={item.emailMatchesWebsite ? styles.matchBadge : styles.noMatchBadge}>
                  <Text style={item.emailMatchesWebsite ? styles.matchText : styles.noMatchText}>
                    {item.emailMatchesWebsite ? 'Email matches the program’s website' : 'Email does not match the website: check first'}
                  </Text>
                </View>
                <View style={styles.fieldList}>
                  <View style={styles.fieldRow}><Text style={styles.fieldLabel}>Email</Text><Text style={styles.fieldValue}>{item.requesterEmail}</Text></View>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel}>Name</Text>
                    <Text style={styles.fieldValue}>{item.contactRole ? `${item.contactName}, ${item.contactRole}` : item.contactName}</Text>
                  </View>
                  {item.contactPhone ? <View style={styles.fieldRow}><Text style={styles.fieldLabel}>Their phone</Text><Text style={styles.fieldValue}>{item.contactPhone}</Text></View> : null}
                  {item.note ? <View style={styles.fieldRow}><Text style={styles.fieldLabel}>Note</Text><Text style={styles.fieldValue}>{item.note}</Text></View> : null}
                  <View style={styles.fieldRow}><Text style={styles.fieldLabel}>Asked</Text><Text style={styles.fieldValue}>{requestedAgo(item.createdAt)}</Text></View>
                </View>
                <View style={styles.linkRow}>
                  {item.website ? (
                    <TouchableOpacity accessibilityRole="link" onPress={() => open(websiteUrl(item.website))} style={styles.linkButton}>
                      <Text style={styles.linkText}>Program website</Text>
                    </TouchableOpacity>
                  ) : null}
                  {item.listingPhone ? (
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Call ${item.listingName}'s main number`} onPress={() => open(`tel:${item.listingPhone.replace(/[^0-9+]/g, '')}`)} style={styles.linkButton}>
                      <Text style={styles.linkText}>Call the program's main number</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {item.listingClaimed ? (
                  <Text style={styles.warning}>Another account already manages this listing. Decline this request.</Text>
                ) : null}
                {decliningId === item.id ? (
                  <View style={styles.rejectBox}>
                    <Text style={styles.rejectLabel}>{DECLINE_NOTE_LABEL}</Text>
                    <TextInput
                      accessibilityLabel="Note to the program (optional)"
                      value={note}
                      onChangeText={setNote}
                      placeholder="Optional, for example: Please ask again from your program's email address."
                      placeholderTextColor={COLORS.gray}
                      multiline
                      maxLength={500}
                      style={styles.noteInput}
                    />
                    <View style={styles.buttonRow}>
                      <TouchableOpacity accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => { setDecliningId(null); setNote(''); }} style={styles.ghostButton}>
                        <Text style={styles.ghostButtonText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Decline the request for ${item.listingName}`} disabled={Boolean(busyId)} onPress={() => void decide(item, false, note)} style={styles.dangerButton}>
                        {busy ? <ActivityIndicator color={COLORS.coral} /> : <Text style={styles.dangerButtonText}>Decline</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.buttonRow}>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Decline the request for ${item.listingName}`} disabled={Boolean(busyId)} onPress={() => { setDecliningId(item.id); setNote(''); }} style={styles.dangerButton}>
                      <Text style={styles.dangerButtonText}>Decline</Text>
                    </TouchableOpacity>
                    {item.listingClaimed ? null : (
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Approve the request for ${item.listingName}`} accessibilityState={{ disabled: Boolean(busyId), busy }} disabled={Boolean(busyId)} onPress={() => confirmApprove(item)} style={styles.primaryButton}>
                        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Approve</Text>}
                      </TouchableOpacity>
                    )}
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
  card: { backgroundColor: COLORS.card, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 16, gap: 8 },
  title: { fontSize: 18, fontWeight: '700', color: COLORS.ink },
  subtle: { fontSize: 13, color: COLORS.gray },
  matchBadge: { alignSelf: 'flex-start', backgroundColor: COLORS.greenSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  matchText: { color: COLORS.green, fontSize: 13, fontWeight: '700' },
  noMatchBadge: { alignSelf: 'flex-start', backgroundColor: COLORS.amberSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  noMatchText: { color: COLORS.amber, fontSize: 13, fontWeight: '700' },
  warning: { fontSize: 14, color: COLORS.coral, fontWeight: '600' },
  fieldList: { gap: 6 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldLabel: { width: 88, fontSize: 13, fontWeight: '600', color: COLORS.gray },
  fieldValue: { flex: 1, fontSize: 14, color: COLORS.ink, lineHeight: 19 },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  linkButton: { minHeight: 36, flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.blueSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  linkText: { color: COLORS.blue, fontSize: 13, fontWeight: '700' },
  rejectBox: { gap: 10 },
  rejectLabel: { fontSize: 12, fontWeight: '700', color: COLORS.gray, marginBottom: 4 },
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
