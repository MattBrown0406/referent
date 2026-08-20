import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { fetchGlobalDirectory, importGlobalPartner, type GlobalPartner } from './directory';
import type { Partner } from '../data';

type Props = {
  visible: boolean;
  entitled: boolean;
  // Global listing ids already imported into this workspace's network.
  importedGlobalIds: ReadonlySet<string>;
  onClose: () => void;
  onImported: (partner: Partner, globalId: string) => void;
};

const COLORS = {
  ink: '#101828',
  gray: '#667085',
  line: '#EAECF0',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  blue: '#175CD3',
  blueSoft: '#EFF4FF',
  green: '#067647',
  greenSoft: '#ECFDF3',
  coral: '#D92D20',
};

function listingSubtitle(listing: GlobalPartner): string {
  const parts = [
    [listing.city, listing.state].filter(Boolean).join(', '),
    listing.levels.slice(0, 2).join(' · '),
    listing.monthlyCost > 0 ? `$${listing.monthlyCost.toLocaleString()}/mo` : '',
  ].filter(Boolean);
  return parts.join('  ·  ');
}

export default function GlobalDirectoryScreen({ visible, entitled, importedGlobalIds, onClose, onImported }: Props) {
  const [listings, setListings] = useState<GlobalPartner[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !entitled) return;
    let active = true;
    setLoadError('');
    fetchGlobalDirectory()
      .then((next) => { if (active) setListings(next); })
      .catch((error) => { if (active) setLoadError((error as Error).message); });
    return () => { active = false; };
  }, [visible, entitled]);

  const states = useMemo(() => {
    const unique = new Set((listings || []).map((listing) => listing.state).filter(Boolean));
    return [...unique].sort();
  }, [listings]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (listings || []).filter((listing) => {
      if (stateFilter && listing.state !== stateFilter) return false;
      if (!query) return true;
      return [listing.name, listing.organization, listing.city, listing.state,
        ...listing.levels, ...listing.populations, ...listing.therapies]
        .join(' ').toLowerCase().includes(query);
    });
  }, [listings, search, stateFilter]);

  function addToNetwork(listing: GlobalPartner) {
    if (importingId) return;
    setImportingId(listing.id);
    importGlobalPartner(listing)
      .then((partner) => {
        onImported(partner, listing.id);
      })
      .catch((error) => {
        Alert.alert('Could not add program', (error as Error).message);
      })
      .finally(() => setImportingId(null));
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>ReferralFit Directory</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close directory" onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>

        {!entitled ? (
          <View style={styles.centered}>
            <Text style={styles.teaserTitle}>A verified network, maintained for you</Text>
            <Text style={styles.teaserBody}>
              The ReferralFit Directory is a continuously verified list of treatment programs —
              levels of care, insurance panels, and admissions contacts — ready to add to your
              network in one tap. It's part of the Directory plan.
            </Text>
            <Text style={styles.teaserFootnote}>
              Upgrade from the Workspace screen once subscriptions launch.
            </Text>
          </View>
        ) : loadError ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{loadError}</Text>
          </View>
        ) : listings === null ? (
          <View style={styles.centered}><ActivityIndicator color={COLORS.blue} /></View>
        ) : (
          <>
            <View style={styles.filters}>
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search programs, levels, populations"
                placeholderTextColor={COLORS.gray}
                autoCorrect={false}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stateRow}>
                <TouchableOpacity
                  style={stateFilter === '' ? styles.statePillActive : styles.statePill}
                  onPress={() => setStateFilter('')}
                >
                  <Text style={stateFilter === '' ? styles.statePillActiveText : styles.statePillText}>All states</Text>
                </TouchableOpacity>
                {states.map((state) => (
                  <TouchableOpacity
                    key={state}
                    style={stateFilter === state ? styles.statePillActive : styles.statePill}
                    onPress={() => setStateFilter(stateFilter === state ? '' : state)}
                  >
                    <Text style={stateFilter === state ? styles.statePillActiveText : styles.statePillText}>{state}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
              {filtered.length === 0 ? (
                <Text style={styles.emptyText}>
                  {listings.length === 0
                    ? 'The directory is filling up — verified programs appear here as they are added.'
                    : 'No programs match this search.'}
                </Text>
              ) : filtered.map((listing) => {
                const imported = importedGlobalIds.has(listing.id);
                return (
                  <View key={listing.id} style={styles.card}>
                    <View style={styles.cardBody}>
                      <Text style={styles.cardTitle}>{listing.organization || listing.name}</Text>
                      {listing.organization && listing.name !== listing.organization ? (
                        <Text style={styles.cardContact}>{listing.name}</Text>
                      ) : null}
                      <Text style={styles.cardSubtitle}>{listingSubtitle(listing)}</Text>
                      {listing.description ? (
                        <Text style={styles.cardDescription} numberOfLines={3}>{listing.description}</Text>
                      ) : null}
                      {listing.verifiedAt ? (
                        <Text style={styles.verified}>Verified {listing.verifiedAt.slice(0, 10)}</Text>
                      ) : null}
                    </View>
                    {imported ? (
                      <View style={styles.importedBadge}><Text style={styles.importedText}>In your network</Text></View>
                    ) : (
                      <TouchableOpacity
                        disabled={importingId !== null}
                        onPress={() => addToNetwork(listing)}
                        style={styles.addButton}
                      >
                        {importingId === listing.id
                          ? <ActivityIndicator color="#fff" />
                          : <Text style={styles.addButtonText}>Add to my network</Text>}
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
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
  closeButton: { paddingVertical: 4, paddingHorizontal: 8 },
  closeText: { fontSize: 16, fontWeight: '600', color: COLORS.blue },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  errorText: { fontSize: 15, color: COLORS.coral, textAlign: 'center' },
  teaserTitle: { fontSize: 20, fontWeight: '700', color: COLORS.ink, textAlign: 'center' },
  teaserBody: { fontSize: 15, color: COLORS.gray, textAlign: 'center', lineHeight: 22 },
  teaserFootnote: { fontSize: 13, color: COLORS.gray, textAlign: 'center' },
  filters: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  searchInput: {
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: COLORS.ink,
    backgroundColor: COLORS.card,
  },
  stateRow: { gap: 8, paddingBottom: 4 },
  statePill: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line },
  statePillText: { fontSize: 13, fontWeight: '600', color: COLORS.gray },
  statePillActive: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: COLORS.blueSoft, borderWidth: 1, borderColor: COLORS.blue },
  statePillActiveText: { fontSize: 13, fontWeight: '600', color: COLORS.blue },
  list: { padding: 16, gap: 12 },
  emptyText: { fontSize: 14, color: COLORS.gray, textAlign: 'center', paddingTop: 40, lineHeight: 20 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.line,
    padding: 16,
    gap: 12,
  },
  cardBody: { gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: COLORS.ink },
  cardContact: { fontSize: 14, color: COLORS.ink },
  cardSubtitle: { fontSize: 13, color: COLORS.gray },
  cardDescription: { fontSize: 13, color: COLORS.gray, lineHeight: 18, marginTop: 4 },
  verified: { fontSize: 12, fontWeight: '600', color: COLORS.green, marginTop: 4 },
  importedBadge: { alignSelf: 'flex-start', backgroundColor: COLORS.greenSoft, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  importedText: { color: COLORS.green, fontWeight: '600', fontSize: 14 },
  addButton: { backgroundColor: COLORS.blue, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  addButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
