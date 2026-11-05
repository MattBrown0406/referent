import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { fetchPendingListingCredentials, lookupNpi, verifyCredential, type PendingListingCredential } from './credentials';
import { describeError, isServerUnreachable } from './errors';
import { credentialTitle, expiryLine, localTodayStamp, lookupLinksForCredential, statusLabel, type CredentialStatus } from './integrity';
import type { NpiLookupResult } from './npi';

// ReferralFit's review queue for the credentials programs add to their
// directory listings (Program Integrity Watch). Rendered inside the
// Workspace sheet, like the directory submissions queue: no second modal.
// Showing it is only a convenience: list_pending_listing_credentials and
// verify_program_credential both re-check platform-admin status on the
// server. The reviewer checks each one by hand on the issuer's public page
// (the app never scrapes those sites), then verifies or declines with a
// note the program sees in the portal.

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
  amber: '#93370D',
  amberSoft: '#FFFAEB',
};

// Who reads a rejection note: the program, in its portal (the listing's
// claimant). Practitioners never do (fetch_listing_credential_notes).
export const REJECTION_NOTE_LABEL = 'The program sees this note; practitioners do not';

function openLink(url: string) {
  Linking.openURL(url).catch(() => Alert.alert('Could not open the page', url));
}

export default function CredentialReviewQueue({ onBack, onCountChange }: Props) {
  const [items, setItems] = useState<PendingListingCredential[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [npi, setNpi] = useState<Record<string, { busy: boolean; result?: NpiLookupResult }>>({});
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  const today = localTodayStamp();

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const next = await fetchPendingListingCredentials();
      setItems(next.items);
      onCountChangeRef.current(next.items.length);
    } catch (error) {
      setLoadError(isServerUnreachable(error) ? "Credentials load when you're online." : describeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(item: PendingListingCredential, verdict: 'verified' | 'rejected', reviewNote = '') {
    if (busyId) return;
    if (verdict === 'rejected' && !reviewNote.trim()) {
      Alert.alert('Add a note', 'Say what could not be confirmed, so the program can fix it.');
      return;
    }
    setBusyId(item.id);
    try {
      await verifyCredential(item.id, verdict, reviewNote, item.updatedAt);
      setRejectingId(null);
      setNote('');
    } catch (error) {
      Alert.alert(verdict === 'verified' ? 'Could not verify' : 'Could not reject', describeError(error));
    } finally {
      setBusyId(null);
      // Someone may have reviewed or edited it meanwhile: show the queue as it is.
      await load();
    }
  }

  function confirmVerify(item: PendingListingCredential) {
    Alert.alert(
      'Verify this credential?',
      `You checked the ${credentialTitle(item).toLowerCase()} for ${item.listing} on the issuer's public page and it matches. Practitioners will see it as verified by ReferralFit.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Verify', onPress: () => { void review(item, 'verified'); } },
      ],
    );
  }

  async function checkNpi(item: PendingListingCredential) {
    setNpi((current) => ({ ...current, [item.id]: { busy: true } }));
    const result = await lookupNpi(item.identifier);
    setNpi((current) => ({ ...current, [item.id]: { busy: false, result } }));
  }

  return (
    <>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to workspace" onPress={onBack} style={styles.closeButton}>
          <Text style={styles.closeText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Program credentials</Text>
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
          <Text style={styles.helpText}>When a program adds or changes a credential on its listing, it shows up here.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          <Text style={styles.helpText}>
            Oldest first. Check each one on the issuer's public page, then verify it or reject it with a note. A program's later change sends it back here.
          </Text>
          {items.map((item) => {
            const busy = busyId === item.id;
            const check = npi[item.id];
            return (
              <View key={item.id} style={styles.card}>
                <Text style={styles.listing}>{item.listing}{item.listingState ? ` · ${item.listingState}` : ''}</Text>
                {item.listingStatus && item.listingStatus !== 'active' ? <Text style={styles.subtle}>Listing is {item.listingStatus}</Text> : null}
                <Text style={styles.title}>{credentialTitle(item)}</Text>
                <View style={styles.fieldList}>
                  <Field label={item.kind === 'npi' ? 'NPI' : 'Number'} value={item.identifier} />
                  <Field label="Expires" value={expiryLine(item, today)} />
                  <Field label="Today" value={statusLabel((item.statusToday || 'pending') as CredentialStatus, 'listing')} />
                  <Field label="Program's note" value={item.note} />
                  <Field label="Changed" value={item.updatedAt.slice(0, 10)} />
                </View>
                <View style={styles.linkRow}>
                  {item.proofUrl ? (
                    <TouchableOpacity accessibilityRole="link" onPress={() => openLink(item.proofUrl as string)} style={styles.linkButton}>
                      <Ionicons name="document-text-outline" size={13} color={COLORS.blue} /><Text style={styles.linkText}>Open the record</Text>
                    </TouchableOpacity>
                  ) : null}
                  {lookupLinksForCredential(item, item.listingWebsite).map((link) => (
                    <TouchableOpacity key={link.url} accessibilityRole="link" onPress={() => openLink(link.url)} style={styles.linkButton}>
                      <Ionicons name="open-outline" size={13} color={COLORS.blue} /><Text style={styles.linkText}>{link.label}</Text>
                    </TouchableOpacity>
                  ))}
                  {item.kind === 'npi' ? (
                    <TouchableOpacity accessibilityRole="button" onPress={() => { void checkNpi(item); }} style={styles.linkButton}>
                      <Ionicons name="search-outline" size={13} color={COLORS.blue} /><Text style={styles.linkText}>Check NPI registry</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {check?.busy ? <ActivityIndicator color={COLORS.blue} /> : null}
                {check?.result ? (
                  <Text style={styles.helpText}>
                    {check.result.ok
                      ? `Registered to ${check.result.name}${check.result.place ? ` (${check.result.place})` : ''}. Compare it with ${item.listing}; a matching name is a hint, not proof.`
                      : check.result.message}
                  </Text>
                ) : item.npiLookupName ? (
                  <Text style={styles.helpText}>The program's last registry lookup: {item.npiLookupName}</Text>
                ) : null}

                {rejectingId === item.id ? (
                  <View style={styles.rejectBox}>
                    <Text style={styles.rejectLabel}>{REJECTION_NOTE_LABEL}</Text>
                    <TextInput
                      style={styles.noteInput}
                      value={note}
                      onChangeText={setNote}
                      placeholder="What could not be confirmed, and what would fix it?"
                      placeholderTextColor={COLORS.gray}
                      accessibilityLabel={`Note for the program. ${REJECTION_NOTE_LABEL}`}
                      multiline
                      maxLength={1000}
                    />
                    <View style={styles.buttonRow}>
                      <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => { setRejectingId(null); setNote(''); }} style={styles.ghostButton}>
                        <Text style={styles.ghostButtonText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => { void review(item, 'rejected', note); }} style={styles.dangerButton}>
                        {busy ? <ActivityIndicator color={COLORS.coral} /> : <Text style={styles.dangerButtonText}>Reject with note</Text>}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={styles.buttonRow}>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Reject ${credentialTitle(item)} for ${item.listing}`} disabled={Boolean(busyId)} onPress={() => { setRejectingId(item.id); setNote(''); }} style={styles.dangerButton}>
                      <Text style={styles.dangerButtonText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Verify ${credentialTitle(item)} for ${item.listing}`} accessibilityState={{ disabled: Boolean(busyId), busy }} disabled={Boolean(busyId)} onPress={() => confirmVerify(item)} style={styles.primaryButton}>
                      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Verify</Text>}
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
  if (!value) return null;
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} selectable>{value}</Text>
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
  helpText: { fontSize: 14, color: COLORS.gray, lineHeight: 20 },
  card: { backgroundColor: COLORS.card, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, padding: 16, gap: 8 },
  listing: { fontSize: 13, fontWeight: '700', color: COLORS.gray },
  title: { fontSize: 18, fontWeight: '700', color: COLORS.ink },
  subtle: { fontSize: 13, color: COLORS.amber },
  fieldList: { gap: 6 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldLabel: { width: 80, fontSize: 13, fontWeight: '600', color: COLORS.gray },
  rejectLabel: { fontSize: 12, fontWeight: '700', color: COLORS.gray, marginBottom: 4 },
  fieldValue: { flex: 1, fontSize: 14, color: COLORS.ink, lineHeight: 19 },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  linkButton: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.blueSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  linkText: { color: COLORS.blue, fontSize: 13, fontWeight: '700' },
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
