import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Chip, ChipRow } from '../components';
import { colors } from '../theme';
import { useStore } from '../store';

type Filter = 'all' | 'inbound' | 'outbound';

export default function ReferralsScreen({ onAdd }: { onAdd: () => void }) {
  const { referrals, referents, referralStats, deleteReferral } = useStore();
  const [filter, setFilter] = useState<Filter>('all');

  const nameOf = (id: string) => referents.find((r) => r.id === id)?.name ?? 'Unknown';

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const recent = referrals.filter((f) => f.date >= ninetyDaysAgo);
  const inbound90 = recent.filter((f) => f.direction === 'inbound').length;
  const outbound90 = recent.filter((f) => f.direction === 'outbound').length;

  const topReferrers = useMemo(() => {
    return referents
      .map((r) => ({ r, stats: referralStats(r.id) }))
      .filter((x) => x.stats.inbound > 0)
      .sort((a, b) => b.stats.inbound - a.stats.inbound || b.stats.net - a.stats.net)
      .slice(0, 3);
  }, [referents, referralStats]);

  const list = referrals
    .filter((f) => (filter === 'all' ? true : f.direction === filter))
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Referrals</Text>
        <Pressable onPress={onAdd} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+ Log</Text>
        </Pressable>
      </View>

      <View style={styles.statRow}>
        <Card style={styles.statCard}>
          <Text style={[styles.statNum, { color: colors.inbound }]}>{inbound90}</Text>
          <Text style={styles.statLabel}>Inbound · 90d</Text>
        </Card>
        <Card style={styles.statCard}>
          <Text style={[styles.statNum, { color: colors.outbound }]}>{outbound90}</Text>
          <Text style={styles.statLabel}>Outbound · 90d</Text>
        </Card>
        <Card style={styles.statCard}>
          <Text style={[styles.statNum, { color: inbound90 - outbound90 >= 0 ? colors.inbound : colors.outbound }]}>
            {inbound90 - outbound90 >= 0 ? '+' : ''}
            {inbound90 - outbound90}
          </Text>
          <Text style={styles.statLabel}>Net · 90d</Text>
        </Card>
      </View>

      {topReferrers.length > 0 && (
        <Card>
          <Text style={styles.topTitle}>🏆 Top Referral Sources</Text>
          {topReferrers.map(({ r, stats }, i) => (
            <Text key={r.id} style={styles.topRow}>
              {i + 1}. {r.name} — {stats.inbound} inbound (net {stats.net >= 0 ? '+' : ''}{stats.net})
            </Text>
          ))}
        </Card>
      )}

      <ChipRow style={{ marginVertical: 10 }}>
        <Chip label="All" small selected={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="⬇ Inbound" small selected={filter === 'inbound'} onPress={() => setFilter('inbound')} />
        <Chip label="⬆ Outbound" small selected={filter === 'outbound'} onPress={() => setFilter('outbound')} />
      </ChipRow>

      <FlatList
        data={list}
        keyExtractor={(f) => f.id}
        contentContainerStyle={{ paddingBottom: 90 }}
        ListEmptyComponent={<Text style={styles.dim}>No referrals logged.</Text>}
        renderItem={({ item }) => (
          <Card style={{ paddingVertical: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontWeight: '700', color: item.direction === 'inbound' ? colors.inbound : colors.outbound, flex: 1 }}>
                {item.direction === 'inbound' ? '⬇' : '⬆'} {nameOf(item.referentId)}
              </Text>
              <Text style={styles.dim}>{new Date(item.date).toLocaleDateString()}</Text>
            </View>
            <Text style={[styles.meta, { marginTop: 3 }]}>
              Client {item.clientLabel}
              {item.note ? ` — ${item.note}` : ''}
            </Text>
            <Pressable onPress={() => deleteReferral(item.id)} style={{ alignSelf: 'flex-end', marginTop: 4 }}>
              <Text style={{ color: colors.danger, fontSize: 12 }}>Remove</Text>
            </Pressable>
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '800', color: colors.text },
  addBtn: { backgroundColor: colors.accent, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  statRow: { flexDirection: 'row', gap: 8 },
  statCard: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  statNum: { fontSize: 24, fontWeight: '800' },
  statLabel: { fontSize: 11, color: colors.subtext, marginTop: 2 },
  topTitle: { fontWeight: '700', color: colors.text, marginBottom: 6 },
  topRow: { fontSize: 13, color: colors.text, marginVertical: 2 },
  meta: { fontSize: 13, color: colors.subtext },
  dim: { color: colors.subtext, fontSize: 13, textAlign: 'center', marginTop: 30 },
});
