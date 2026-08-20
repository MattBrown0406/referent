import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { StoreProvider, useStore } from './src/store';
import { colors } from './src/theme';
import { Referent, ReferralDirection } from './src/types';
import ReferentsScreen from './src/screens/ReferentsScreen';
import ReferentDetailScreen from './src/screens/ReferentDetailScreen';
import EditReferentScreen from './src/screens/EditReferentScreen';
import MatchScreen from './src/screens/MatchScreen';
import ReferralsScreen from './src/screens/ReferralsScreen';
import LogReferralScreen from './src/screens/LogReferralScreen';

type Tab = 'referents' | 'match' | 'referrals';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'referents', label: 'Referents', icon: '👥' },
  { key: 'match', label: 'Match', icon: '🎯' },
  { key: 'referrals', label: 'Referrals', icon: '🔄' },
];

function Main() {
  const { referents, loaded } = useStore();
  const [tab, setTab] = useState<Tab>('referents');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; referent: Referent } | null>(null);
  const [logging, setLogging] = useState<{ referentId?: string; direction?: ReferralDirection } | null>(null);

  const detail = detailId ? referents.find((r) => r.id === detailId) ?? null : null;

  if (!loaded) {
    return (
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: colors.subtext }}>Loading…</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>
        {tab === 'referents' && (
          <ReferentsScreen onSelect={(r) => setDetailId(r.id)} onAdd={() => setEditing({ mode: 'new' })} />
        )}
        {tab === 'match' && <MatchScreen onSelect={(r) => setDetailId(r.id)} />}
        {tab === 'referrals' && <ReferralsScreen onAdd={() => setLogging({})} />}
      </View>

      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable key={t.key} style={styles.tabItem} onPress={() => setTab(t.key)}>
            <Text style={{ fontSize: 20 }}>{t.icon}</Text>
            <Text style={[styles.tabLabel, tab === t.key && { color: colors.accent, fontWeight: '700' }]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={detail !== null} animationType="slide" onRequestClose={() => setDetailId(null)}>
        {detail && (
          <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
            <ReferentDetailScreen
              referent={detail}
              onClose={() => setDetailId(null)}
              onEdit={() => setEditing({ mode: 'edit', referent: detail })}
              onLogReferral={(direction) => setLogging({ referentId: detail.id, direction })}
            />
          </SafeAreaView>
        )}
      </Modal>

      <Modal visible={editing !== null} animationType="slide" onRequestClose={() => setEditing(null)}>
        <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
          <EditReferentScreen
            existing={editing?.mode === 'edit' ? editing.referent : null}
            onClose={(saved) => {
              const wasNew = editing?.mode === 'new';
              setEditing(null);
              if (saved && wasNew) setDetailId(saved.id);
            }}
          />
        </SafeAreaView>
      </Modal>

      <Modal visible={logging !== null} animationType="slide" onRequestClose={() => setLogging(null)}>
        <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
          <LogReferralScreen
            presetReferentId={logging?.referentId}
            presetDirection={logging?.direction}
            onClose={() => setLogging(null)}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <Main />
      </StoreProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    ...(Platform.OS === 'web'
      ? ({ maxWidth: 480, width: '100%', alignSelf: 'center' } as const)
      : null),
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingBottom: Platform.OS === 'ios' ? 20 : 8,
    paddingTop: 8,
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { fontSize: 11, color: colors.subtext },
});
