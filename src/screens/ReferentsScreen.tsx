import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, Chip, NetBadge, TypeBadge } from '../components';
import { colors } from '../theme';
import { useStore } from '../store';
import { Referent, REFERENT_TYPES, ReferentType } from '../types';

export default function ReferentsScreen({ onSelect, onAdd }: { onSelect: (r: Referent) => void; onAdd: () => void }) {
  const { referents, referralStats } = useStore();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ReferentType | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return referents
      .filter((r) => (typeFilter ? r.type === typeFilter : true))
      .filter((r) => {
        if (!q) return true;
        return [r.name, r.organization, r.city, r.state, ...r.specialties, ...r.insurance]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(q));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [referents, query, typeFilter]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Referents</Text>
        <Pressable onPress={onAdd} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+ Add</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.search}
        placeholder="Search name, city, specialty, insurance…"
        placeholderTextColor={colors.subtext}
        value={query}
        onChangeText={setQuery}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={{ gap: 8, paddingRight: 16, alignItems: 'center' }}>
        <Chip label="All" small selected={typeFilter === null} onPress={() => setTypeFilter(null)} />
        {REFERENT_TYPES.map((t) => (
          <Chip key={t} label={t} small selected={typeFilter === t} onPress={() => setTypeFilter(typeFilter === t ? null : t)} />
        ))}
      </ScrollView>
      <FlatList
        data={filtered}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingBottom: 90 }}
        ListEmptyComponent={<Text style={styles.empty}>No referents match.</Text>}
        renderItem={({ item }) => {
          const stats = referralStats(item.id);
          return (
            <Pressable onPress={() => onSelect(item)}>
              <Card>
                <View style={styles.rowTop}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={styles.name}>{item.name}</Text>
                    {item.organization ? <Text style={styles.org}>{item.organization}</Text> : null}
                  </View>
                  <TypeBadge type={item.type} small />
                </View>
                <Text style={styles.meta}>
                  {item.city}, {item.state}
                  {item.cashPrice != null ? `  ·  $${item.cashPrice.toLocaleString()}${item.priceUnit ?? ''}` : ''}
                  {item.insurance.length > 0 ? `  ·  ${item.insurance.length} insurance` : '  ·  Cash only'}
                </Text>
                {item.specialties.length > 0 && (
                  <Text style={styles.specialties} numberOfLines={1}>
                    {item.specialties.join(' · ')}
                  </Text>
                )}
                <View style={{ marginTop: 8, flexDirection: 'row', gap: 6 }}>
                  <NetBadge net={stats.net} inbound={stats.inbound} />
                </View>
              </Card>
            </Pressable>
          );
        }}
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
  search: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: 10,
  },
  filterScroll: { flexGrow: 0, height: 40, marginBottom: 12 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  name: { fontSize: 16, fontWeight: '700', color: colors.text },
  org: { fontSize: 13, color: colors.subtext, marginTop: 1 },
  meta: { fontSize: 13, color: colors.subtext, marginTop: 6 },
  specialties: { fontSize: 12, color: colors.accent, marginTop: 4, fontWeight: '500' },
  empty: { textAlign: 'center', color: colors.subtext, marginTop: 40 },
});
