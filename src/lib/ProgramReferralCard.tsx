// "Referred by <program>" on the case file, with the practice's switch for
// sharing progress with that program (program-referrals.ts), and where the
// referral stands in the referral history: logged (automatic when the
// program was already a partner), or one tap to add the program to the
// network and log it (migration 20261108180000). Renders nothing for a case
// no program referred, offline, or on a server without program referrals.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';

import { OfflineError } from './errors';
import {
  fetchCaseProgramReferral,
  ledgerAction,
  localDateOf,
  logProgramReferral,
  setProgramReferralSharing,
  sharingExplanation,
  type CaseProgramReferral,
} from './program-referrals';

const COLORS = {
  ink: '#16352E',
  forest: '#1F5A49',
  mintPale: '#EDF4EF',
  white: '#FFFFFF',
  gray: '#73827D',
  line: '#DDE4DF',
};

type Props = {
  caseId: string;
  /** The program was added to the network or the referral logged: reload partners and referrals. */
  onLedgerChanged?: () => void;
};

export default function ProgramReferralCard({ caseId, onLedgerChanged }: Props) {
  const [referral, setReferral] = useState<CaseProgramReferral | null>(null);
  const [busy, setBusy] = useState(false);
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    let live = true;
    setReferral(null);
    fetchCaseProgramReferral(caseId)
      .then((result) => { if (live) setReferral(result.referral); })
      .catch(() => { /* Offline or a server error: the card stays hidden. */ });
    return () => { live = false; };
  }, [caseId]);

  if (!referral) return null;

  function toggle(next: boolean) {
    if (!referral || busy) return;
    const previous = referral;
    setReferral({ ...referral, shareProgress: next });
    setBusy(true);
    setProgramReferralSharing(referral.id, next)
      .catch((error: unknown) => {
        setReferral(previous);
        Alert.alert(
          'Sharing not changed',
          error instanceof OfflineError ? 'You are offline. Try again when you have a connection.' : (error as Error).message,
        );
      })
      .finally(() => setBusy(false));
  }

  async function log() {
    if (!referral || logging) return;
    const current = referral;
    setLogging(true);
    try {
      const result = await logProgramReferral(current.id, localDateOf(current.createdAt));
      setReferral((shown) => (shown && shown.id === current.id ? { ...shown, inNetwork: true, logged: true } : shown));
      onLedgerChanged?.();
      if (result.addedPartner) {
        Alert.alert('Added to your network', `${current.fromDisplay} is now a partner, and this referral is in your referral history.`);
      }
    } catch (error) {
      Alert.alert(
        'Not logged',
        error instanceof OfflineError ? 'You are offline. Try again when you have a connection.' : (error as Error).message,
      );
    } finally {
      setLogging(false);
    }
  }

  const action = ledgerAction(referral);

  return (
    <View style={styles.card} accessibilityLabel={`Referred by ${referral.fromDisplay}`}>
      <Text style={styles.label}>Referred by a program</Text>
      <Text style={styles.program}>{referral.fromDisplay}</Text>
      <View style={styles.row}>
        <Text style={styles.rowText}>Sharing progress with {referral.fromDisplay}</Text>
        <Switch
          accessibilityLabel={`Share progress with ${referral.fromDisplay}`}
          value={referral.shareProgress}
          disabled={busy}
          onValueChange={toggle}
          trackColor={{ true: COLORS.forest }}
        />
      </View>
      <Text style={styles.help}>{sharingExplanation(referral.fromDisplay, referral.shareProgress)}</Text>
      {referral.logged ? (
        <Text style={styles.logged}>In your referral history as an inbound referral from {referral.fromDisplay}.</Text>
      ) : action !== 'none' ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ busy: logging, disabled: logging }}
          disabled={logging}
          onPress={() => { void log(); }}
          style={[styles.logButton, logging && styles.logButtonBusy]}
        >
          {logging ? <ActivityIndicator color={COLORS.forest} /> : (
            <Text style={styles.logButtonText} numberOfLines={2}>
              {action === 'log' ? 'Log in referral history' : `Add ${referral.fromDisplay} to your network and log`}
            </Text>
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.line,
    padding: 16,
    gap: 6,
  },
  label: { fontSize: 12, fontWeight: '700', color: COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.4 },
  program: { fontSize: 17, fontWeight: '700', color: COLORS.ink },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: COLORS.mintPale,
  },
  rowText: { flex: 1, fontSize: 15, fontWeight: '600', color: COLORS.ink },
  help: { fontSize: 13, lineHeight: 19, color: COLORS.gray },
  logged: { fontSize: 13, lineHeight: 19, color: COLORS.forest, fontWeight: '600', marginTop: 4 },
  logButton: {
    minHeight: 44,
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logButtonBusy: { opacity: 0.6 },
  logButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.forest, textAlign: 'center' },
});
