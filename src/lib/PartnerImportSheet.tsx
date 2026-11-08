// Import partners: from the iPhone's contacts (iOS's own picker, one contact
// at a time, nothing else from the address book) or, on the web, from a .csv
// or .vcf file. Each contact is matched to the ReferralFit Directory on the
// device and checked against the network; the practitioner reviews every row
// (type, Directory listing or own details, include or not) before anything
// is saved. docs/PARTNER_IMPORT.md.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { fetchGlobalDirectory } from './directory';
import { describeError } from './errors';
import { beginOverlay } from './overlay';
import {
  addCandidates,
  directoryIndex,
  IMPORT_TYPES,
  importRows,
  importSummary,
  isReady,
  MAX_IMPORT_ROWS,
  type DirectoryIndex,
  type ImportCandidate,
  type ImportType,
  type NetworkPartnerLike,
  type RawContact,
} from './partner-import';
import {
  contactFilesAvailable,
  deviceContactsAvailable,
  importPartners,
  pickContactsFile,
  pickDeviceContact,
  type ImportResult,
} from './partner-import-api';
import { WEB_PAGE } from './web-layout';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  cream: '#F6F4EE',
  white: '#FFFFFF',
  coralPale: '#F7E7E1',
  coralText: '#7D594B',
  blue: '#2F5D8A',
  bluePale: '#EAF1F8',
  gray: '#73827D',
  line: '#DDE4DF',
};

type Props = {
  visible: boolean;
  userId: string;
  partners: NetworkPartnerLike[];
  /** The workspace reads the Directory (matching uses it; without it, contacts are added as they are). */
  directoryEntitled: boolean;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
};

export default function PartnerImportSheet({ visible, userId, partners, directoryEntitled, onClose, onImported }: Props) {
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [index, setIndex] = useState<DirectoryIndex | null>(null);
  const [directoryState, setDirectoryState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const pickingRef = useRef(false);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  // The latest Directory and network, read when a contact is added (a tap
  // made while the Directory was loading still gets matched).
  const indexRef = useRef(index);
  indexRef.current = index;
  const partnersRef = useRef(partners);
  partnersRef.current = partners;
  // iOS presents the contact picker only once this sheet has finished
  // presenting; before that the picker would silently never appear.
  const [shown, setShown] = useState(Platform.OS === 'web');
  // Bumped on every close: a pick or a save finishing afterwards changes nothing.
  const openingRef = useRef(0);
  const endPickerOverlayRef = useRef<(() => void) | null>(null);
  const contactsHere = deviceContactsAvailable();
  const filesHere = contactFilesAvailable();

  // A fresh sheet each time it opens, and for each account. Closing releases
  // a picker that never answered, so nothing stays blocked.
  useEffect(() => {
    openingRef.current += 1;
    pickingRef.current = false;
    endPickerOverlayRef.current?.();
    endPickerOverlayRef.current = null;
    if (!visible) { if (Platform.OS !== 'web') setShown(false); return; }
    setCandidates([]);
    setNotice(null);
    setBusy(false);
  }, [visible, userId]);

  // The Directory, once per opening, for matching on the device.
  useEffect(() => {
    if (!visible) return;
    if (!directoryEntitled) { setIndex(null); setDirectoryState('unavailable'); return; }
    let live = true;
    setDirectoryState('loading');
    fetchGlobalDirectory()
      .then((listings) => { if (live) { setIndex(directoryIndex(listings)); setDirectoryState('ready'); } })
      .catch(() => { if (live) { setIndex(null); setDirectoryState('unavailable'); } });
    return () => { live = false; };
  }, [visible, directoryEntitled, userId]);

  // Directory matches arrive after contacts were added: match those rows now,
  // without undoing choices already made on them.
  useEffect(() => {
    if (!index) return;
    setCandidates((current) => {
      if (!current.some((candidate) => !candidate.match)) return current;
      const rematched = addCandidates([], current, index, partners).candidates;
      return current.map((candidate, i) => (candidate.match || !rematched[i]?.match ? candidate : {
        ...candidate,
        match: rematched[i].match,
        useListing: rematched[i].useListing,
        existingPartnerId: candidate.existingPartnerId || rematched[i].existingPartnerId,
        include: candidate.include && !rematched[i].existingPartnerId,
        types: candidate.types.length ? candidate.types : rematched[i].types,
      }));
    });
  }, [index, partners]);

  const ready = useMemo(() => candidates.filter(isReady), [candidates]);
  const needType = candidates.filter((candidate) => candidate.include && !candidate.existingPartnerId && !isReady(candidate)).length;

  function add(contacts: RawContact[], source: string) {
    const result = addCandidates(candidatesRef.current, contacts, indexRef.current, partnersRef.current);
    candidatesRef.current = result.candidates;
    setCandidates(result.candidates);
    if (result.truncated) {
      setNotice({ ok: false, text: `Only the first ${MAX_IMPORT_ROWS} contacts are shown. Import the rest in another file.` });
    } else if (!result.added) {
      setNotice({ ok: false, text: `${source} is already on the list.` });
    } else {
      setNotice(null);
    }
  }

  async function pickContact() {
    if (pickingRef.current || busy || !shown) return;
    pickingRef.current = true;
    const opening = openingRef.current;
    // iOS presents the picker over this sheet: nothing else may present meanwhile.
    const endOverlay = beginOverlay();
    endPickerOverlayRef.current = endOverlay;
    try {
      const contact = await pickDeviceContact();
      if (opening !== openingRef.current) return;
      if (contact) add([contact], contact.organization || contact.name || 'That contact');
    } catch (error) {
      if (opening === openingRef.current) Alert.alert('Contacts unavailable', describeError(error));
    } finally {
      endOverlay();
      if (endPickerOverlayRef.current === endOverlay) endPickerOverlayRef.current = null;
      if (opening === openingRef.current) pickingRef.current = false;
    }
  }

  function pickFile() {
    if (busy) return;
    const opening = openingRef.current;
    // Called inside the tap: the browser opens a file chooser only then. Not
    // guarded by pickingRef: a browser without the 'cancel' event (Safari
    // before 16.4) never reports a closed chooser, and each tap makes a new
    // chooser anyway.
    void pickContactsFile().then((picked) => {
      if (!picked || opening !== openingRef.current) return;
      if ('problem' in picked) { setNotice({ ok: false, text: picked.problem }); return; }
      add(picked.contacts, picked.fileName);
    });
  }

  function close() {
    if (busy) return;
    if (!candidates.length) { onClose(); return; }
    Alert.alert('Discard this list?', 'None of these contacts have been added yet.', [
      { text: 'Keep reviewing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  function patch(key: string, change: Partial<ImportCandidate>) {
    setCandidates((current) => current.map((candidate) => (candidate.key === key ? { ...candidate, ...change } : candidate)));
    setNotice(null);
  }

  function toggleType(candidate: ImportCandidate, type: ImportType) {
    const has = candidate.types.includes(type);
    patch(candidate.key, { types: has ? candidate.types.filter((item) => item !== type) : [...candidate.types, type] });
  }

  function setTypeForRest(type: ImportType) {
    setCandidates((current) => current.map((candidate) => (
      candidate.include && !candidate.existingPartnerId && !(candidate.useListing && candidate.match) && !candidate.types.length
        ? { ...candidate, types: [type] }
        : candidate
    )));
  }

  async function save() {
    if (busy || !ready.length) return;
    const opening = openingRef.current;
    setBusy(true);
    setNotice(null);
    try {
      const result = await importPartners(importRows(candidates), userId);
      onImported(result);
      if (opening !== openingRef.current) return;
      setCandidates([]);
      setNotice({ ok: true, text: importSummary(result) });
    } catch (error) {
      if (opening === openingRef.current) setNotice({ ok: false, text: describeError(error) });
    } finally {
      if (opening === openingRef.current) setBusy(false);
    }
  }

  function renderRow({ item }: { item: ImportCandidate }) {
    const contactLine = [item.email, item.phone, [item.city, item.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const title = item.organization || item.name;
    const person = item.organization && item.name && item.name !== item.organization ? item.name : '';
    const usingListing = item.useListing && Boolean(item.match);
    return (
      <View style={[styles.row, !item.include && styles.rowOff]}>
        <View style={styles.rowTop}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle} numberOfLines={2}>{title}</Text>
            {person ? <Text style={styles.rowLine} numberOfLines={1}>{person}</Text> : null}
            {contactLine ? <Text style={styles.rowLine} numberOfLines={2}>{contactLine}</Text> : null}
          </View>
          {item.existingPartnerId ? null : (
            <Switch
              accessibilityLabel={`Add ${title}`}
              value={item.include}
              onValueChange={(include) => patch(item.key, { include })}
              trackColor={{ true: COLORS.forest }}
            />
          )}
        </View>
        {item.existingPartnerId ? <Text style={styles.already}>Already in your network</Text> : null}
        {!item.existingPartnerId && item.match ? (
          <View style={styles.matchBox}>
            <View style={styles.flex}>
              <Text style={styles.matchLabel}>ON REFERRALFIT</Text>
              <Text style={styles.matchName} numberOfLines={2}>
                {item.match.organization}{item.match.city || item.match.state ? `, ${[item.match.city, item.match.state].filter(Boolean).join(', ')}` : ''}
              </Text>
              <Text style={styles.matchHelp}>{usingListing ? 'Adds the Directory listing (kept up to date by ReferralFit).' : 'Adds this contact as you have it instead.'}</Text>
            </View>
            <Switch
              accessibilityLabel={`Use the ReferralFit listing for ${item.match.organization}`}
              value={usingListing}
              disabled={!item.include}
              onValueChange={(useListing) => patch(item.key, { useListing })}
              trackColor={{ true: COLORS.blue }}
            />
          </View>
        ) : null}
        {!item.existingPartnerId && item.include && !usingListing ? (
          <>
            <View style={styles.pillRow}>
              {IMPORT_TYPES.map((type) => {
                const on = item.types.includes(type);
                return (
                  <TouchableOpacity
                    key={type}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`${type} for ${title}`}
                    onPress={() => toggleType(item, type)}
                    style={[styles.pill, on && styles.pillOn]}
                  >
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{type}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {item.types.length ? null : <Text style={styles.needType}>Choose a type to add this one.</Text>}
          </>
        ) : null}
      </View>
    );
  }

  const header = (
    <View>
      <Text style={styles.intro}>
        {contactsHere
          ? 'Pick contacts one at a time. iOS shows ReferralFit only the contact you pick, never the rest of your address book.'
          : 'Choose a contacts file: a spreadsheet saved as .csv with a header row (name, organization, email, phone, city, state, type), or a .vcf exported from Apple Contacts, Google Contacts or Outlook. The file is read on this device; only the contacts you add are saved.'}
      </Text>
      <View style={styles.sourceRow}>
        {contactsHere ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !shown }}
            disabled={busy || !shown}
            onPress={() => { void pickContact(); }}
            style={[styles.sourceButton, (busy || !shown) && styles.primaryButtonOff]}
          >
            <Text style={styles.sourceButtonText}>{candidates.length ? 'Pick another contact' : 'Pick a contact'}</Text>
          </TouchableOpacity>
        ) : null}
        {filesHere ? (
          <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={pickFile} style={styles.sourceButton}>
            <Text style={styles.sourceButtonText}>{candidates.length ? 'Add another file' : 'Choose a file'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {directoryState === 'loading' ? <Text style={styles.hint}>Checking the ReferralFit Directory…</Text> : null}
      {directoryState === 'ready' && candidates.length ? (
        <Text style={styles.hint}>Contacts that are on ReferralFit add the Directory listing; switch it off to keep your own details.</Text>
      ) : null}
      {notice ? (
        <View style={[styles.notice, notice.ok && styles.noticeOk]} accessibilityRole="alert">
          <Text style={[styles.noticeText, notice.ok && styles.noticeTextOk]}>{notice.text}</Text>
        </View>
      ) : null}
      {needType > 1 ? (
        <>
          <Text style={styles.label}>TYPE FOR THE {needType} WITHOUT ONE</Text>
          <View style={styles.pillRow}>
            {IMPORT_TYPES.map((type) => (
              <TouchableOpacity key={type} accessibilityRole="button" onPress={() => setTypeForRest(type)} style={styles.pill}>
                <Text style={styles.pillText}>{type}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      ) : null}
      {candidates.length ? <Text style={styles.label}>REVIEW ({candidates.length})</Text> : null}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close} onShow={() => setShown(true)}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Close import"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={close}
            style={styles.headerButton}
          >
            <Text style={[styles.headerButtonText, busy && styles.primaryButtonOff]}>{candidates.length ? 'Cancel' : 'Done'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Import partners</Text>
          <View style={styles.headerButton} />
        </View>
        <FlatList
          data={candidates}
          keyExtractor={(item) => item.key}
          renderItem={renderRow}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={20}
        />
        {candidates.length ? (
          <View style={styles.footer}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !ready.length, busy }}
              disabled={busy || !ready.length}
              onPress={() => { void save(); }}
              style={[styles.primaryButton, (busy || !ready.length) && styles.primaryButtonOff]}
            >
              {busy ? <ActivityIndicator color={COLORS.white} /> : (
                <Text style={styles.primaryButtonText}>
                  {ready.length ? `Add ${ready.length} ${ready.length === 1 ? 'partner' : 'partners'}` : 'Nothing to add yet'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.cream, ...WEB_PAGE },
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line, backgroundColor: COLORS.white },
  headerTitle: { fontSize: 17, fontWeight: '800', color: COLORS.ink },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  headerButtonText: { fontSize: 15, fontWeight: '700', color: COLORS.inkSoft },
  content: { padding: 18, paddingBottom: 48 },
  intro: { fontSize: 14, lineHeight: 20, color: COLORS.gray },
  hint: { fontSize: 12, lineHeight: 17, color: COLORS.gray, marginTop: 8 },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: COLORS.gray, marginTop: 18, marginBottom: 8 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  sourceButton: { minHeight: 46, paddingHorizontal: 16, borderRadius: 12, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  sourceButtonText: { color: COLORS.white, fontSize: 15, fontWeight: '800' },
  notice: { backgroundColor: COLORS.coralPale, borderRadius: 12, padding: 12, marginTop: 12 },
  noticeOk: { backgroundColor: COLORS.mintPale },
  noticeText: { fontSize: 13, lineHeight: 19, color: COLORS.coralText, fontWeight: '600' },
  noticeTextOk: { color: COLORS.forest },
  row: { backgroundColor: COLORS.white, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, padding: 14, marginBottom: 10, gap: 8 },
  rowOff: { opacity: 0.6 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowTitle: { fontSize: 16, fontWeight: '800', color: COLORS.ink },
  rowLine: { fontSize: 13, color: COLORS.gray, marginTop: 2 },
  already: { fontSize: 13, fontWeight: '700', color: COLORS.gray },
  matchBox: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.bluePale, borderRadius: 10, padding: 10 },
  matchLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: COLORS.blue },
  matchName: { fontSize: 14, fontWeight: '700', color: COLORS.ink, marginTop: 2 },
  matchHelp: { fontSize: 12, color: COLORS.gray, marginTop: 2 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.white, justifyContent: 'center' },
  pillOn: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { fontSize: 13, fontWeight: '700', color: COLORS.inkSoft },
  pillTextOn: { color: COLORS.white },
  needType: { fontSize: 12, fontWeight: '700', color: COLORS.coralText },
  footer: { padding: 14, borderTopWidth: 1, borderTopColor: COLORS.line, backgroundColor: COLORS.white },
  primaryButton: { minHeight: 52, borderRadius: 14, backgroundColor: COLORS.forest, alignItems: 'center', justifyContent: 'center' },
  primaryButtonOff: { opacity: 0.5 },
  primaryButtonText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
});
