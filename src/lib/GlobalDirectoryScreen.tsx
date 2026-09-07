import React, { useEffect, useMemo, useRef, useState } from 'react';
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

import {
  fetchFavoriteIds,
  fetchGlobalDirectoryStates,
  fetchGlobalPartnerStats,
  importGlobalPartner,
  searchGlobalDirectory,
  toggleFavorite,
  type GlobalPartner,
  type GlobalPartnerStats,
} from './directory';
import type { Partner } from '../data';

type Props = {
  visible: boolean;
  entitled: boolean;
  entitlementKnown: boolean;
  userId: string;
  // Global listing ids already imported into this workspace's network.
  importedGlobalIds: ReadonlySet<string>;
  onClose: () => void;
  onImported: (partner: Partner, globalId: string, initiatingUserId: string) => void;
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
  amber: '#B54708',
};

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

function statsLine(stats: GlobalPartnerStats | undefined): string {
  if (!stats || !stats.disclosed) return '';
  const parts: string[] = [];
  if (stats.importingOrgs !== null) parts.push(`Used by ${stats.importingOrgs} practices`);
  if (stats.referrals12m !== null && stats.referrals12m > 0) parts.push(`${stats.referrals12m} referrals this year`);
  if (stats.admitRate !== null) parts.push(`${Math.round(stats.admitRate * 100)}% admitted`);
  if (stats.familyExperience !== null) parts.push(`${stats.familyExperience.toFixed(1)}/5 family experience`);
  return parts.join('  ·  ');
}

function listingSubtitle(listing: GlobalPartner): string {
  const parts = [
    [listing.city, listing.state].filter(Boolean).join(', '),
    listing.levels.slice(0, 2).join(' · '),
    listing.monthlyCost > 0 ? `$${listing.monthlyCost.toLocaleString()}/mo` : '',
  ].filter(Boolean);
  return parts.join('  ·  ');
}

export default function GlobalDirectoryScreen({ visible, entitled, entitlementKnown, userId, importedGlobalIds, onClose, onImported }: Props) {
  const [listings, setListings] = useState<GlobalPartner[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [states, setStates] = useState<string[]>([]);
  const [stats, setStats] = useState<Map<string, GlobalPartnerStats>>(new Map());
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);
  const operationGenerationRef = useRef(0);
  const searchGenerationRef = useRef(0);

  // States for the filter pills + the user's favorites, once per open.
  useEffect(() => {
    if (!visible || !entitled) return;
    let active = true;
    fetchGlobalDirectoryStates()
      .then((next) => { if (active) setStates(next); })
      .catch(() => { /* pills are a convenience; search still works without them */ });
    fetchFavoriteIds('global_partner')
      .then((next) => { if (active) setFavoriteIds(next); })
      .catch(() => { /* favorites are non-blocking */ });
    return () => { active = false; };
  }, [visible, entitled, userId]);

  // Server-side search, debounced. Each keystroke supersedes the previous
  // request; stale responses are dropped by generation.
  useEffect(() => {
    if (!visible || !entitled) return;
    const generation = ++searchGenerationRef.current;
    setLoadError('');
    const timer = setTimeout(() => {
      searchGlobalDirectory({ query: search, state: stateFilter, limit: PAGE_SIZE, offset: 0 })
        .then((page) => {
          if (generation !== searchGenerationRef.current) return;
          setListings(page);
          setHasMore(page.length === PAGE_SIZE);
          return fetchGlobalPartnerStats(page.map((listing) => listing.id))
            .then((next) => { if (generation === searchGenerationRef.current) setStats(next); })
            .catch(() => { /* stats are decoration */ });
        })
        .catch((error) => {
          if (generation !== searchGenerationRef.current) return;
          setLoadError((error as Error).message);
        });
    }, listings === null ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, entitled, userId, search, stateFilter]);

  useEffect(() => {
    operationGenerationRef.current += 1;
    setImportingId(null);
  }, [visible, entitled, userId]);

  const filtered = useMemo(() => listings || [], [listings]);

  function loadMore() {
    if (loadingMore || !hasMore || listings === null) return;
    const generation = searchGenerationRef.current;
    setLoadingMore(true);
    searchGlobalDirectory({ query: search, state: stateFilter, limit: PAGE_SIZE, offset: listings.length })
      .then((page) => {
        if (generation !== searchGenerationRef.current) return;
        const seen = new Set(listings.map((listing) => listing.id));
        const fresh = page.filter((listing) => !seen.has(listing.id));
        setListings([...listings, ...fresh]);
        setHasMore(page.length === PAGE_SIZE);
        return fetchGlobalPartnerStats(fresh.map((listing) => listing.id))
          .then((next) => {
            if (generation !== searchGenerationRef.current) return;
            setStats((current) => new Map([...current, ...next]));
          })
          .catch(() => { /* stats are decoration */ });
      })
      .catch((error) => Alert.alert('Could not load more', (error as Error).message))
      .finally(() => setLoadingMore(false));
  }

  function toggleListingFavorite(listing: GlobalPartner) {
    const wasFavorite = favoriteIds.has(listing.id);
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (wasFavorite) next.delete(listing.id); else next.add(listing.id);
      return next;
    });
    toggleFavorite('global_partner', listing.id)
      .then((isFavorite) => {
        setFavoriteIds((current) => {
          const next = new Set(current);
          if (isFavorite) next.add(listing.id); else next.delete(listing.id);
          return next;
        });
      })
      .catch((error) => {
        setFavoriteIds((current) => {
          const next = new Set(current);
          if (wasFavorite) next.add(listing.id); else next.delete(listing.id);
          return next;
        });
        Alert.alert('Could not update favorite', (error as Error).message);
      });
  }

  function addToNetwork(listing: GlobalPartner) {
    if (importingId) return;
    const operationGeneration = ++operationGenerationRef.current;
    const initiatingUserId = userId;
    setImportingId(listing.id);
    importGlobalPartner(listing, initiatingUserId)
      .then((partner) => {
        if (operationGeneration !== operationGenerationRef.current) return;
        onImported(partner, listing.id, initiatingUserId);
      })
      .catch((error) => {
        if (operationGeneration !== operationGenerationRef.current) return;
        Alert.alert('Could not add program', (error as Error).message);
      })
      .finally(() => {
        if (operationGeneration === operationGenerationRef.current) setImportingId(null);
      });
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

        {!entitlementKnown ? (
          <View style={styles.centered}>
            <Text accessibilityRole="alert" style={styles.errorText}>Subscription status is unavailable. Reopen the screen when the app is online.</Text>
          </View>
        ) : !entitled ? (
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
            <Text accessibilityRole="alert" style={styles.errorText}>{loadError}</Text>
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
                  accessibilityRole="button"
                  accessibilityState={{ selected: stateFilter === '' }}
                  style={stateFilter === '' ? styles.statePillActive : styles.statePill}
                  onPress={() => setStateFilter('')}
                >
                  <Text style={stateFilter === '' ? styles.statePillActiveText : styles.statePillText}>All states</Text>
                </TouchableOpacity>
                {states.map((state) => (
                  <TouchableOpacity
                    key={state}
                    accessibilityRole="button"
                    accessibilityState={{ selected: stateFilter === state }}
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
                const isFavorite = favoriteIds.has(listing.id);
                const usage = statsLine(stats.get(listing.id));
                return (
                  <View key={listing.id} style={styles.card}>
                    <View style={styles.cardHeaderRow}>
                      <View style={styles.cardBody}>
                        <Text style={styles.cardTitle}>{listing.organization || listing.name}</Text>
                        {listing.organization && listing.name !== listing.organization ? (
                          <Text style={styles.cardContact}>{listing.name}</Text>
                        ) : null}
                        <Text style={styles.cardSubtitle}>{listingSubtitle(listing)}</Text>
                        {listing.description ? (
                          <Text style={styles.cardDescription} numberOfLines={3}>{listing.description}</Text>
                        ) : null}
                        {usage ? <Text style={styles.usage}>{usage}</Text> : null}
                        {listing.verifiedAt ? (
                          listing.verifiedCurrent
                            ? <Text style={styles.verified}>Verified {listing.verifiedAt.slice(0, 10)}</Text>
                            : <Text style={styles.verificationStale}>Verification expired — last verified {listing.verifiedAt.slice(0, 10)}</Text>
                        ) : null}
                      </View>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={isFavorite ? `Remove ${listing.organization || listing.name} from favorites` : `Add ${listing.organization || listing.name} to favorites`}
                        accessibilityState={{ selected: isFavorite }}
                        onPress={() => toggleListingFavorite(listing)}
                        style={styles.favoriteButton}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={isFavorite ? styles.favoriteOn : styles.favoriteOff}>{isFavorite ? '★' : '☆'}</Text>
                      </TouchableOpacity>
                    </View>
                    {imported ? (
                      <View style={styles.importedBadge}><Text style={styles.importedText}>In your network</Text></View>
                    ) : (
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${listing.organization || listing.name} to my network`}
                        accessibilityState={{ disabled: importingId !== null, busy: importingId === listing.id }}
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
              {hasMore ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ busy: loadingMore, disabled: loadingMore }}
                  disabled={loadingMore}
                  onPress={loadMore}
                  style={styles.loadMore}
                >
                  {loadingMore ? <ActivityIndicator color={COLORS.blue} /> : <Text style={styles.loadMoreText}>Load more programs</Text>}
                </TouchableOpacity>
              ) : null}
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
  cardHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardBody: { gap: 4, flex: 1 },
  favoriteButton: { paddingHorizontal: 4, paddingVertical: 2 },
  favoriteOn: { fontSize: 22, color: COLORS.amber },
  favoriteOff: { fontSize: 22, color: COLORS.gray },
  usage: { fontSize: 12, fontWeight: '600', color: COLORS.blue, marginTop: 4 },
  verificationStale: { fontSize: 12, fontWeight: '600', color: COLORS.amber, marginTop: 4 },
  loadMore: { alignItems: 'center', paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.card },
  loadMoreText: { color: COLORS.blue, fontWeight: '600', fontSize: 14 },
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
