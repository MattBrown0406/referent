// Workspace: "Referrals from treatment programs". The owner's switch for
// whether programs on ReferralFit can refer families to this practice
// (program-referrals.ts). Renders nothing on a server without program
// referrals, or while it cannot be loaded.

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';

import { OfflineError } from './errors';
import {
  acceptsExplanation,
  fetchProgramReferralSettings,
  setAcceptsProgramReferrals,
  type ProgramReferralSettings,
} from './program-referrals';

const COLORS = {
  ink: '#101828',
  gray: '#667085',
  line: '#EAECF0',
  card: '#FFFFFF',
  blue: '#175CD3',
};

type Props = {
  // Reload when the Workspace screen is shown again.
  visible: boolean;
};

export default function ProgramReferralSettingsCard({ visible }: Props) {
  const [settings, setSettings] = useState<ProgramReferralSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchProgramReferralSettings()
      .then((result) => setSettings(result.settings))
      .catch(() => setSettings(null));
  }, []);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  if (!settings) return null;

  function toggle(next: boolean) {
    if (!settings || busy) return;
    const previous = settings;
    setSettings({ ...settings, accepts: next });
    setBusy(true);
    setAcceptsProgramReferrals(next)
      .catch((error: unknown) => {
        setSettings(previous);
        Alert.alert(
          'Setting not changed',
          error instanceof OfflineError ? 'You are offline. Try again when you have a connection.' : (error as Error).message,
        );
      })
      .finally(() => setBusy(false));
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Referrals from treatment programs</Text>
      <View style={styles.row}>
        <Text style={styles.rowText}>Accept referrals from programs</Text>
        <Switch
          accessibilityLabel="Accept referrals from treatment programs"
          value={settings.accepts}
          disabled={busy || !settings.canChange}
          onValueChange={toggle}
          trackColor={{ true: COLORS.blue }}
        />
      </View>
      <Text style={styles.help}>{acceptsExplanation(settings)}</Text>
      {!settings.canChange ? <Text style={styles.help}>The workspace owner can change this.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.line,
    padding: 16,
    gap: 10,
  },
  label: { fontSize: 13, fontWeight: '700', color: COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowText: { flex: 1, fontSize: 16, fontWeight: '600', color: COLORS.ink },
  help: { fontSize: 14, color: COLORS.gray, lineHeight: 20 },
});
