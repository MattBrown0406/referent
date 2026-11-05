// Program Integrity Watch on screen: the "Credentials" card on a partner's
// profile, the small shield chip on match and directory cards, and the hook
// that loads what both show. The rules live in integrity.ts; the server
// calls in credentials.ts. No Modal here: the editor opens inside the card
// and every question is an Alert, so nothing presents over the profile
// sheet (Fabric: one sheet at a time).

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { Partner } from '../data';
import {
  CREDENTIAL_KEPT_TITLE,
  CredentialKeptError,
  EMPTY_CREDENTIAL_INDEX,
  deleteCredential,
  fetchCredentialIndex,
  fetchListingCredentialNotes,
  lookupNpi,
  mayKeepNpiHint,
  recordNpiLookup,
  saveCredential,
  verifyCredential,
  type CredentialIndex,
  type ListingCredentialNotes,
} from './credentials';
import { fetchIsPlatformAdmin } from './directory';
import { OfflineError, describeError, isServerUnreachable } from './errors';
import {
  ACCREDITORS,
  ACCREDITOR_LABELS,
  CHIP_LABELS,
  CREDENTIAL_KINDS,
  KIND_LABELS,
  credentialStatus,
  credentialTitle,
  draftFromCredential,
  emptyCredentialDraft,
  expiryLine,
  formatStamp,
  integrityHeadline,
  isValidNpi,
  lookupLinksForCredential,
  normalizeCredentialDraft,
  normalizeNpi,
  programIntegrity,
  programLookupLinks,
  statusLabel,
  type CredentialDraft,
  type CredentialStatus,
  type IntegrityChip,
  type LookupLink,
  type ProgramCredential,
  type ProgramIntegrity,
} from './integrity';
import type { NpiLookupResult } from './npi';

const COLORS = {
  ink: '#16352E',
  inkSoft: '#38564F',
  forest: '#1F5A49',
  mint: '#DCEAE0',
  mintPale: '#EDF4EF',
  white: '#FFFFFF',
  coral: '#B9553B',
  coralPale: '#F7E7E1',
  gold: '#7A5A14',
  goldPale: '#F7EFD9',
  gray: '#73827D',
  grayPale: '#F3F3EF',
  line: '#DDE4DF',
};

// ─── The index: every credential the app shows, loaded once ─────────────────

export type CredentialIndexState = {
  // loading: the first read is on its way. ready: loaded (possibly stale
  // after a failed refresh). offline / error: never loaded. unavailable:
  // the server does not have the migration; every credential UI hides.
  status: 'loading' | 'ready' | 'offline' | 'error' | 'unavailable';
  index: CredentialIndex;
  error: string;
};

const INITIAL_STATE: CredentialIndexState = { status: 'loading', index: EMPTY_CREDENTIAL_INDEX, error: '' };

// The account and workspace a read belongs to: rows read for one never show
// for the other, even when the next read fails.
export function credentialScopeKey(userId: string | undefined, workspaceKey: string | number): string {
  return `${userId || ''}|${workspaceKey}`;
}

// `listingIdsKey`: the linked listing ids, sorted and comma-joined (App's
// linkedListingIds). `refreshKey` changes on every full refresh.
// `workspaceKey` changes when the account moves to another workspace (App's
// workspaceEpoch): what was read for the last one is dropped at once.
// `isPlatformAdmin` only shows ReferralFit's own controls (adding a
// listing's credentials); every write re-checks on the server.
export function useCredentialIndex(userId: string | undefined, listingIdsKey: string, refreshKey: number, workspaceKey: string | number = 0): { state: CredentialIndexState; reload: () => void; isPlatformAdmin: boolean } {
  const scope = credentialScopeKey(userId, workspaceKey);
  // The state remembers whose it is; another account's or workspace's reads
  // read as "loading" until this one's arrive.
  const [held, setHeld] = useState<{ scope: string; state: CredentialIndexState }>({ scope, state: INITIAL_STATE });
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const generationRef = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    const readScope = scope;
    if (!userId) {
      setHeld({ scope: readScope, state: INITIAL_STATE });
      return;
    }
    try {
      const index = await fetchCredentialIndex(listingIdsKey ? listingIdsKey.split(',') : []);
      if (generation !== generationRef.current || scopeRef.current !== readScope) return;
      setHeld({ scope: readScope, state: { status: index.available ? 'ready' : 'unavailable', index, error: '' } });
    } catch (error) {
      if (generation !== generationRef.current || scopeRef.current !== readScope) return;
      // Keep what is on screen after a failed refresh of THIS workspace;
      // with nothing of its own loaded yet, say why (never the last
      // workspace's rows).
      setHeld((current) => (current.scope === readScope && current.state.status === 'ready'
        ? current
        : { scope: readScope, state: { status: isServerUnreachable(error) ? 'offline' : 'error', index: EMPTY_CREDENTIAL_INDEX, error: describeError(error) } }));
    }
  }, [userId, listingIdsKey, scope]);

  // Another account's credentials never show for this one.
  useEffect(() => {
    setIsPlatformAdmin(false);
    if (!userId) return undefined;
    let active = true;
    fetchIsPlatformAdmin()
      .then((admin) => { if (active) setIsPlatformAdmin(admin); })
      .catch(() => { /* not an admin as far as the screen knows */ });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const state = held.scope === scope ? held.state : INITIAL_STATE;
  return { state, reload: () => { void load(); }, isPlatformAdmin };
}

// A partner's credentials: its directory listing's (when linked) and the
// practice's own, together.
export function credentialsForPartner(index: CredentialIndex, partner: Pick<Partner, 'id' | 'globalPartnerId'>): ProgramCredential[] {
  const listing = partner.globalPartnerId ? index.listing[partner.globalPartnerId.toLowerCase()] || [] : [];
  return [...listing, ...(index.local[partner.id.toLowerCase()] || [])];
}

// ─── The shield chip (display only) ─────────────────────────────────────────

// A license concern (integrity.ts licenseConcern) is always coral: 'expired'
// or 'concern', never the amber "Needs review".
export const CHIP_STYLE: Record<IntegrityChip, { icon: keyof typeof Ionicons.glyphMap; color: string; background: string }> = {
  verified: { icon: 'shield-checkmark', color: COLORS.forest, background: COLORS.mintPale },
  needs_review: { icon: 'shield-half-outline', color: COLORS.gold, background: COLORS.goldPale },
  expired: { icon: 'shield-outline', color: COLORS.coral, background: COLORS.coralPale },
  concern: { icon: 'shield-outline', color: COLORS.coral, background: COLORS.coralPale },
  none: { icon: 'shield-outline', color: COLORS.gray, background: COLORS.grayPale },
};

export function ShieldChip({ integrity, label }: { integrity: ProgramIntegrity | null | undefined; label?: string }) {
  if (!integrity) return null;
  const look = CHIP_STYLE[integrity.chip];
  const text = label ?? CHIP_LABELS[integrity.chip];
  return (
    <View accessible accessibilityLabel={`Credentials: ${text}`} style={[styles.chip, { backgroundColor: look.background }]}>
      <Ionicons name={look.icon} size={12} color={look.color} />
      <Text style={[styles.chipText, { color: look.color }]}>{text}</Text>
    </View>
  );
}

const STATUS_TONE: Record<CredentialStatus, { color: string; background: string }> = {
  verified: { color: COLORS.forest, background: COLORS.mintPale },
  pending: { color: COLORS.gold, background: COLORS.goldPale },
  expiring: { color: COLORS.gold, background: COLORS.goldPale },
  expired: { color: COLORS.coral, background: COLORS.coralPale },
  rejected: { color: COLORS.coral, background: COLORS.coralPale },
  missing: { color: COLORS.gray, background: COLORS.grayPale },
};

// ─── The Credentials card ───────────────────────────────────────────────────

// The program the card is about: one of the practice's partners (partnerId,
// with its linked listing when it has one), or a bare directory listing
// (ReferralFit's admin view in the Directory).
export type CredentialProgram = {
  partnerId: string | null;
  globalPartnerId: string | null;
  name: string;
  state: string;
  website?: string;
};

export function credentialProgramForPartner(partner: Pick<Partner, 'id' | 'globalPartnerId' | 'organization' | 'name' | 'state' | 'website'>): CredentialProgram {
  return { partnerId: partner.id, globalPartnerId: partner.globalPartnerId ?? null, name: partner.organization || partner.name, state: partner.state, website: partner.website };
}

type Props = {
  program: CredentialProgram;
  state: CredentialIndexState;
  today: string; // YYYY-MM-DD, the device's day
  // "you", a teammate's name, or '' when unknown.
  whoLabel: (userId: string | null) => string;
  onChanged: () => void;
  // Given only to a platform admin (ReferralFit): may add and edit a
  // listing's credentials, sees the listing's notes, and keeps NPI Registry
  // hints on them (the server re-checks every one); everyone else reads the
  // listing's credentials without their notes.
  canEditListing?: boolean;
};

type NotesState = { status: 'idle' | 'loading' | 'ready' | 'error'; byId: ListingCredentialNotes };

type Editing = { id?: string; scope: 'listing' | 'local'; draft: CredentialDraft; problem: string; busy: boolean };
type NpiCheck = { busy: boolean; result?: NpiLookupResult };

function openLink(url: string) {
  Linking.openURL(url).catch(() => Alert.alert('Could not open the page', `Open this address in your browser: ${url}`));
}

function writeFailure(error: unknown): string {
  if (error instanceof OfflineError || isServerUnreachable(error)) return "You're offline. Credentials save when you're online.";
  return describeError(error);
}

export default function CredentialsCard({ program, state, today, whoLabel, onChanged, canEditListing = false }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [npiChecks, setNpiChecks] = useState<Record<string, NpiCheck>>({});
  const [draftNpi, setDraftNpi] = useState<NpiCheck | null>(null);
  // The listing's notes, for ReferralFit only (fetch_listing_credential_notes).
  const [notes, setNotes] = useState<NotesState>({ status: 'idle', byId: {} });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const listingId = program.globalPartnerId ? program.globalPartnerId.toLowerCase() : '';
  const listingRowsKey = listingId ? (state.index.listing[listingId] || []).map((item) => `${item.id}:${item.updatedAt}`).join(',') : '';
  const loadNotes = useCallback(async () => {
    if (!canEditListing || !listingId) return;
    setNotes((current) => ({ status: 'loading', byId: current.byId }));
    try {
      const byId = await fetchListingCredentialNotes(listingId);
      if (!mountedRef.current) return;
      // null: an older server, which still sends the notes on the rows.
      setNotes({ status: 'ready', byId: byId ?? {} });
    } catch {
      if (mountedRef.current) setNotes((current) => ({ status: 'error', byId: current.byId }));
    }
  }, [canEditListing, listingId]);
  useEffect(() => {
    void loadNotes();
  }, [loadNotes, listingRowsKey]);

  if (state.status === 'unavailable') return null;

  const listing = listingId ? state.index.listing[listingId] || [] : [];
  const local = program.partnerId ? state.index.local[program.partnerId.toLowerCase()] || [] : [];
  const loaded = state.status === 'ready';
  const integrity = loaded ? programIntegrity([...listing, ...local], today) : null;

  function startAdd(scope: 'listing' | 'local') {
    setDraftNpi(null);
    setEditing({ scope, draft: emptyCredentialDraft('state_license', program.state), problem: '', busy: false });
  }

  // A listing's note, for ReferralFit's eyes only; '' for everyone else.
  function listingNote(credential: ProgramCredential): { note: string; verificationNote: string } {
    if (credential.scope !== 'listing' || !canEditListing) return { note: '', verificationNote: '' };
    return notes.byId[credential.id] ?? { note: '', verificationNote: '' };
  }

  function startEdit(credential: ProgramCredential) {
    // Saving sends the note too: a listing's is edited only once it has
    // loaded, so the program's note to ReferralFit is never wiped.
    if (credential.scope === 'listing' && notes.status !== 'ready') {
      Alert.alert(
        notes.status === 'error' ? 'Notes need a connection' : 'Notes are still loading',
        notes.status === 'error' ? 'The listing\'s notes could not be loaded, so it cannot be edited yet. Try again when you are back online.' : 'Try again in a moment.',
      );
      if (notes.status === 'error') void loadNotes();
      return;
    }
    setDraftNpi(null);
    const draft = draftFromCredential(credential);
    setEditing({ id: credential.id, scope: credential.scope, draft: credential.scope === 'listing' ? { ...draft, note: listingNote(credential).note } : draft, problem: '', busy: false });
  }

  function updateDraft(patch: Partial<CredentialDraft>) {
    setEditing((current) => (current ? { ...current, problem: '', draft: { ...current.draft, ...patch } } : current));
    if ('identifier' in patch || 'kind' in patch) setDraftNpi(null);
  }

  async function save() {
    if (!editing || editing.busy) return;
    const normalized = normalizeCredentialDraft(editing.draft);
    if ('problem' in normalized) {
      setEditing({ ...editing, problem: normalized.problem });
      return;
    }
    setEditing({ ...editing, busy: true, problem: '' });
    try {
      const owner = editing.scope === 'listing' && program.globalPartnerId
        ? { globalPartnerId: program.globalPartnerId }
        : { partnerId: program.partnerId as string };
      const saved = await saveCredential(owner, normalized.fields, editing.id);
      // A registry name looked up in the editor is kept with the NPI.
      const lookup = draftNpi?.result;
      if (saved.kind === 'npi' && lookup?.ok && lookup.npi === saved.identifier && mayKeepNpiHint(editing.scope, canEditListing)) {
        await recordNpiLookup(saved.id, lookup.name).catch(() => null);
      }
      if (!mountedRef.current) return;
      setEditing(null);
      setDraftNpi(null);
      onChanged();
    } catch (error) {
      if (!mountedRef.current) return;
      setEditing((current) => (current ? { ...current, busy: false, problem: writeFailure(error) } : current));
    }
  }

  async function runRowAction(credential: ProgramCredential, action: () => Promise<unknown>, failureTitle: string) {
    if (busyId) return;
    setBusyId(credential.id);
    try {
      await action();
      if (mountedRef.current) onChanged();
    } catch (error) {
      // The server keeping a credential on purpose is information, not a
      // failure: its own calm words, under a calm title.
      if (error instanceof CredentialKeptError) Alert.alert(CREDENTIAL_KEPT_TITLE, error.message);
      else Alert.alert(failureTitle, writeFailure(error));
      if (mountedRef.current) onChanged();
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  }

  function confirmChecked(credential: ProgramCredential) {
    Alert.alert(
      'Mark as checked?',
      `Record that you looked up this ${credentialTitle(credential).toLowerCase()} with the issuer and it matches. Your name and today's date are saved with it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark as checked', onPress: () => { void runRowAction(credential, () => verifyCredential(credential.id, 'verified', '', credential.updatedAt), 'Could not record the check'); } },
      ],
    );
  }

  function confirmNotConfirmed(credential: ProgramCredential) {
    Alert.alert(
      "Couldn't confirm it?",
      "Record that you could not confirm this with the issuer. It shows as \"Couldn't confirm it\" until someone edits or checks it again.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: "Couldn't confirm", onPress: () => { void runRowAction(credential, () => verifyCredential(credential.id, 'rejected', '', credential.updatedAt), 'Could not record the check'); } },
      ],
    );
  }

  function confirmRemove(credential: ProgramCredential) {
    Alert.alert('Remove this credential?', credential.scope === 'listing'
      ? `${credentialTitle(credential)} comes off the directory listing for ${program.name || 'this program'}, for everyone.`
      : `${credentialTitle(credential)} comes off ${program.name || 'this partner'} for everyone in your practice.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { void runRowAction(credential, () => deleteCredential(credential.id), 'Could not remove it'); } },
    ]);
  }

  async function checkNpi(credential: ProgramCredential) {
    if (npiChecks[credential.id]?.busy) return;
    setNpiChecks((current) => ({ ...current, [credential.id]: { busy: true } }));
    const result = await lookupNpi(credential.identifier);
    if (!mountedRef.current) return;
    setNpiChecks((current) => ({ ...current, [credential.id]: { busy: false, result } }));
    // The practice's own NPI keeps the registry name as a hint. A listing's
    // is ReferralFit's alone to keep (the server refuses anyone else); the
    // result shows here either way.
    if (result.ok && mayKeepNpiHint(credential.scope, canEditListing)) {
      recordNpiLookup(credential.id, result.name).then(() => { if (mountedRef.current) onChanged(); }).catch(() => undefined);
    }
  }

  async function checkDraftNpi() {
    if (!editing || draftNpi?.busy) return;
    setDraftNpi({ busy: true });
    const result = await lookupNpi(editing.draft.identifier);
    if (mountedRef.current) setDraftNpi({ busy: false, result });
  }

  function renderLinks(links: LookupLink[]) {
    return links.map((link) => (
      <TouchableOpacity key={link.site + link.url} accessibilityRole="link" accessibilityHint="Opens in your browser" onPress={() => openLink(link.url)} style={styles.linkButton}>
        <Ionicons name="open-outline" size={13} color={COLORS.forest} />
        <Text style={styles.linkText}>{link.label}</Text>
      </TouchableOpacity>
    ));
  }

  function renderNpiResult(check: NpiCheck | undefined, programName: string) {
    if (!check) return null;
    if (check.busy) return <View style={styles.npiRow}><ActivityIndicator color={COLORS.forest} /><Text style={styles.meta}>Asking the NPI Registry...</Text></View>;
    const result = check.result;
    if (!result) return null;
    if (!result.ok) return <Text style={styles.meta}>{result.message}</Text>;
    return (
      <View style={styles.npiResult}>
        <Text style={styles.npiName}>Registered to: {result.name}</Text>
        <Text style={styles.meta}>
          {[result.place, result.specialty, result.active ? '' : 'not active'].filter(Boolean).join(' · ') || 'No location on the record'}
        </Text>
        {result.otherNames.length ? <Text style={styles.meta}>Also known as: {result.otherNames.join(', ')}</Text> : null}
        <Text style={styles.meta}>Compare it with {programName}. A matching name is a good sign, not a verification.</Text>
      </View>
    );
  }

  function renderRow(credential: ProgramCredential) {
    const status = credentialStatus(credential, today);
    const tone = STATUS_TONE[status];
    const busy = busyId === credential.id;
    const editable = credential.scope === 'local' || canEditListing;
    const checkable = credential.scope === 'local';
    const who = credential.verifiedBy ? whoLabel(credential.verifiedBy) : '';
    // A listing's notes are never the row's own (the server leaves them
    // off; credentials.ts drops any it still sends): ReferralFit reads them
    // from fetch_listing_credential_notes, practitioners never see them.
    const { note, verificationNote } = credential.scope === 'listing' ? listingNote(credential) : credential;
    const reviewLine = credential.review === 'verified' && credential.verifiedAt
      ? credential.scope === 'listing'
        ? `Verified by ReferralFit on ${formatStamp(credential.verifiedAt.slice(0, 10))}`
        : `Checked${who ? ` by ${who}` : ''} on ${formatStamp(credential.verifiedAt.slice(0, 10))}`
      : credential.review === 'rejected' && credential.verifiedAt
        ? `${credential.scope === 'listing' ? "ReferralFit couldn't confirm it" : `Not confirmed${who ? ` by ${who}` : ''}`} on ${formatStamp(credential.verifiedAt.slice(0, 10))}${verificationNote ? `: ${verificationNote}` : ''}`
        : credential.scope === 'listing' ? 'Waiting for ReferralFit to check it' : 'Not checked yet. Look it up below, then mark it checked.';
    return (
      <View key={credential.id} style={styles.row}>
        <View style={styles.rowTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{credentialTitle(credential)}</Text>
            {credential.identifier ? <Text selectable style={styles.identifier}>{credential.kind === 'npi' ? `NPI ${credential.identifier}` : `No. ${credential.identifier}`}</Text> : null}
          </View>
          <View style={[styles.statusPill, { backgroundColor: tone.background }]}>
            <Text style={[styles.statusText, { color: tone.color }]}>{statusLabel(status, credential.scope)}</Text>
          </View>
        </View>
        <Text style={styles.meta}>{expiryLine(credential, today)}</Text>
        <Text style={styles.meta}>{reviewLine}</Text>
        {note ? <Text style={styles.meta}>{credential.scope === 'listing' ? 'Program\'s note to ReferralFit' : 'Note'}: {note}</Text> : null}
        {credential.kind === 'npi' && credential.npiLookupName && !npiChecks[credential.id]?.result ? (
          <Text style={styles.meta}>
            NPI Registry name: {credential.npiLookupName}{credential.npiCheckedAt ? ` (looked up ${formatStamp(credential.npiCheckedAt.slice(0, 10))})` : ''}. A hint, not a verification.
          </Text>
        ) : null}
        {credential.kind === 'npi' ? renderNpiResult(npiChecks[credential.id], program.name) : null}
        <View style={styles.linkRow}>
          {credential.proofUrl ? (
            <TouchableOpacity accessibilityRole="link" accessibilityHint="Opens the issuer's record in your browser" onPress={() => openLink(credential.proofUrl as string)} style={styles.linkButton}>
              <Ionicons name="document-text-outline" size={13} color={COLORS.forest} />
              <Text style={styles.linkText}>Open the record</Text>
            </TouchableOpacity>
          ) : null}
          {renderLinks(lookupLinksForCredential(credential, program.website))}
          {credential.kind === 'npi' ? (
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: npiChecks[credential.id]?.busy }} onPress={() => { void checkNpi(credential); }} style={styles.linkButton}>
              <Ionicons name="search-outline" size={13} color={COLORS.forest} />
              <Text style={styles.linkText}>Check NPI registry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {editable ? (
          <View style={styles.actionRow}>
            {busy ? <ActivityIndicator color={COLORS.forest} /> : (
              <>
                <TouchableOpacity accessibilityRole="button" disabled={Boolean(busyId) || Boolean(editing)} onPress={() => startEdit(credential)} style={styles.smallButton}><Text style={styles.smallButtonText}>Edit</Text></TouchableOpacity>
                {checkable && credential.review !== 'verified' ? (
                  <TouchableOpacity accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => confirmChecked(credential)} style={styles.smallButton}><Text style={styles.smallButtonText}>Mark as checked</Text></TouchableOpacity>
                ) : null}
                {checkable && credential.review !== 'rejected' ? (
                  <TouchableOpacity accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => confirmNotConfirmed(credential)} style={styles.smallButton}><Text style={styles.smallButtonText}>Couldn't confirm</Text></TouchableOpacity>
                ) : null}
                <TouchableOpacity accessibilityRole="button" disabled={Boolean(busyId)} onPress={() => confirmRemove(credential)} style={styles.smallButton}><Text style={[styles.smallButtonText, { color: COLORS.coral }]}>Remove</Text></TouchableOpacity>
              </>
            )}
          </View>
        ) : null}
      </View>
    );
  }

  function renderEditor(current: Editing) {
    const { draft } = current;
    const npiDigits = normalizeNpi(draft.identifier);
    const npiBad = draft.kind === 'npi' && npiDigits.length === 10 && !isValidNpi(npiDigits);
    return (
      <View style={styles.editor}>
        <Text style={styles.editorTitle}>{current.id ? 'Edit credential' : current.scope === 'listing' ? 'Add to the directory listing' : 'Add a credential'}</Text>
        {current.scope === 'listing' ? <Text style={styles.meta}>Every practitioner sees the listing's credentials. It stays pending until verified in Workspace, Program credentials.</Text> : null}
        <View style={styles.pillRow}>
          {CREDENTIAL_KINDS.map((kind) => (
            <TouchableOpacity
              key={kind}
              accessibilityRole="button"
              accessibilityState={{ selected: draft.kind === kind }}
              onPress={() => updateDraft({
                kind,
                accreditor: kind === 'accreditation' ? draft.accreditor || 'joint_commission' : null,
                issuingState: kind === 'state_license' ? draft.issuingState || program.state.trim().toUpperCase().slice(0, 2) : draft.issuingState,
              })}
              style={[styles.pill, draft.kind === kind && styles.pillActive]}
            >
              <Text style={[styles.pillText, draft.kind === kind && styles.pillTextActive]}>{KIND_LABELS[kind]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {draft.kind === 'accreditation' ? (
          <>
            <Text style={styles.fieldLabel}>Accredited by</Text>
            <View style={styles.pillRow}>
              {ACCREDITORS.map((accreditor) => (
                <TouchableOpacity key={accreditor} accessibilityRole="button" accessibilityState={{ selected: draft.accreditor === accreditor }} onPress={() => updateDraft({ accreditor })} style={[styles.pill, draft.accreditor === accreditor && styles.pillActive]}>
                  <Text style={[styles.pillText, draft.accreditor === accreditor && styles.pillTextActive]}>{ACCREDITOR_LABELS[accreditor]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {draft.accreditor === 'other' ? (
              <TextInput style={styles.input} value={draft.accreditorName} onChangeText={(accreditorName) => updateDraft({ accreditorName })} placeholder="Name of the accrediting body" placeholderTextColor={COLORS.gray} maxLength={120} accessibilityLabel="Name of the accrediting body" />
            ) : null}
          </>
        ) : null}
        <Text style={styles.fieldLabel}>{draft.kind === 'npi' ? 'NPI (10 digits)' : draft.kind === 'state_license' ? 'License number' : 'Certificate or program number'}</Text>
        <TextInput
          style={styles.input}
          value={draft.identifier}
          onChangeText={(identifier) => updateDraft({ identifier })}
          placeholder={draft.kind === 'npi' ? '1234567893' : draft.kind === 'state_license' ? 'As it appears on the license' : 'Optional when you add a link'}
          placeholderTextColor={COLORS.gray}
          keyboardType={draft.kind === 'npi' ? 'number-pad' : 'default'}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={64}
          accessibilityLabel={draft.kind === 'npi' ? 'NPI' : 'Number'}
        />
        {npiBad ? <Text style={styles.problem}>This NPI's check digit doesn't add up. Check the number.</Text> : null}
        {draft.kind === 'npi' && npiDigits.length === 10 && !npiBad ? (
          <View style={styles.linkRow}>
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: draftNpi?.busy }} onPress={() => { void checkDraftNpi(); }} style={styles.linkButton}>
              <Ionicons name="search-outline" size={13} color={COLORS.forest} />
              <Text style={styles.linkText}>Check NPI registry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {draft.kind === 'npi' ? renderNpiResult(draftNpi ?? undefined, program.name) : null}
        {draft.kind === 'state_license' ? (
          <>
            <Text style={styles.fieldLabel}>Issuing state (2 letters)</Text>
            <TextInput style={styles.input} value={draft.issuingState} onChangeText={(issuingState) => updateDraft({ issuingState: issuingState.toUpperCase() })} placeholder="OR" placeholderTextColor={COLORS.gray} autoCapitalize="characters" autoCorrect={false} maxLength={2} accessibilityLabel="Issuing state" />
          </>
        ) : null}
        {draft.kind !== 'npi' ? (
          <>
            <Text style={styles.fieldLabel}>Expires on (leave blank if there is no date)</Text>
            <TextInput style={styles.input} value={draft.expiresOn} onChangeText={(expiresOn) => updateDraft({ expiresOn })} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.gray} keyboardType="numbers-and-punctuation" autoCorrect={false} maxLength={10} accessibilityLabel="Expiration date" />
          </>
        ) : null}
        <Text style={styles.fieldLabel}>Link to the public record (https)</Text>
        <TextInput style={styles.input} value={draft.proofUrl} onChangeText={(proofUrl) => updateDraft({ proofUrl })} placeholder="https://... the issuer's lookup page" placeholderTextColor={COLORS.gray} keyboardType="url" autoCapitalize="none" autoCorrect={false} maxLength={500} accessibilityLabel="Link to the public record" />
        <Text style={styles.fieldLabel}>{current.scope === 'listing' ? 'Note for ReferralFit (only ReferralFit and the program see it)' : 'Note (optional, your practice only)'}</Text>
        <TextInput style={[styles.input, styles.noteInput]} value={draft.note} onChangeText={(note) => updateDraft({ note })} placeholder="Who you spoke with, what you saw" placeholderTextColor={COLORS.gray} multiline maxLength={1000} accessibilityLabel="Note" />
        {current.id ? <Text style={styles.meta}>{current.scope === 'listing' ? 'Saving a change sends it back for ReferralFit review.' : 'Saving a change marks it not checked again, so check it once more afterwards.'}</Text> : null}
        {current.problem ? <Text accessibilityRole="alert" style={styles.problem}>{current.problem}</Text> : null}
        <View style={styles.actionRow}>
          <TouchableOpacity accessibilityRole="button" disabled={current.busy} onPress={() => { setEditing(null); setDraftNpi(null); }} style={styles.smallButton}><Text style={styles.smallButtonText}>Cancel</Text></TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: current.busy, disabled: current.busy }} disabled={current.busy} onPress={() => { void save(); }} style={[styles.smallButton, styles.primaryButton]}>
            {current.busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={[styles.smallButtonText, { color: COLORS.white }]}>Save</Text>}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Credentials</Text>
        {integrity ? <ShieldChip integrity={integrity} /> : null}
      </View>
      {state.status === 'loading' ? (
        <View style={styles.npiRow}><ActivityIndicator color={COLORS.forest} /><Text style={styles.meta}>Loading credentials...</Text></View>
      ) : state.status === 'offline' ? (
        <Text style={styles.body}>Credentials load when you're online.</Text>
      ) : state.status === 'error' ? (
        <Text style={styles.body}>Credentials could not be loaded: {state.error}</Text>
      ) : integrity ? (
        <Text style={styles.body}>{integrityHeadline(integrity)}</Text>
      ) : null}

      {loaded && program.globalPartnerId ? (
        <>
          <Text style={styles.section}>FROM THE DIRECTORY LISTING</Text>
          {listing.length ? listing.map(renderRow) : <Text style={styles.meta}>The program has not added credentials to its directory listing yet.</Text>}
          {canEditListing ? (
            editing?.scope === 'listing' ? renderEditor(editing) : (
              <TouchableOpacity accessibilityRole="button" disabled={Boolean(editing)} onPress={() => startAdd('listing')} style={styles.addButton}>
                <Ionicons name="add" size={16} color={COLORS.forest} />
                <Text style={styles.addText}>Add to the listing (ReferralFit admin)</Text>
              </TouchableOpacity>
            )
          ) : null}
        </>
      ) : null}

      {loaded && program.partnerId ? (
        <>
          <Text style={styles.section}>{program.globalPartnerId ? "YOUR PRACTICE'S CHECKS" : 'ON FILE'}</Text>
          {local.length ? local.map(renderRow) : <Text style={styles.meta}>{program.globalPartnerId ? 'Nothing added by your practice. Add a credential you checked yourself.' : 'Add the state license, accreditation, LegitScript certification or NPI you checked.'}</Text>}
          {editing?.scope === 'local' ? renderEditor(editing) : (
            <TouchableOpacity accessibilityRole="button" disabled={Boolean(editing)} onPress={() => startAdd('local')} style={styles.addButton}>
              <Ionicons name="add" size={16} color={COLORS.forest} />
              <Text style={styles.addText}>Add a credential</Text>
            </TouchableOpacity>
          )}
        </>
      ) : null}

      {state.status !== 'loading' ? (
        <>
          <Text style={styles.section}>LOOK IT UP YOURSELF</Text>
          <View style={styles.linkRow}>{renderLinks(programLookupLinks({ state: program.state, website: program.website }))}</View>
          <Text style={styles.footnote}>These open the issuers' public search pages in your browser. ReferralFit never copies them; a person checks. Credentials are public business information about the program. They never change a match's score or rank.</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.white, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: COLORS.line, marginBottom: 12, gap: 6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: COLORS.ink, fontSize: 14, fontWeight: '800' },
  body: { color: COLORS.inkSoft, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  section: { color: COLORS.gray, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, marginTop: 10 },
  meta: { color: COLORS.gray, fontSize: 11, lineHeight: 16 },
  footnote: { color: COLORS.gray, fontSize: 10, lineHeight: 14, marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 4, alignSelf: 'flex-start' },
  chipText: { fontSize: 10, fontWeight: '800' },
  row: { borderTopWidth: 1, borderTopColor: '#EEF0EE', paddingTop: 10, marginTop: 4, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rowTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  identifier: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '600', marginTop: 1 },
  statusPill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, maxWidth: 170 },
  statusText: { fontSize: 10, fontWeight: '800', textAlign: 'center' },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  linkButton: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.mintPale, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 6 },
  linkText: { color: COLORS.forest, fontSize: 11, fontWeight: '800' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
  smallButton: { minHeight: 36, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 10, paddingVertical: 7, alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { color: COLORS.forest, fontSize: 12, fontWeight: '800' },
  primaryButton: { backgroundColor: COLORS.forest, borderColor: COLORS.forest, minWidth: 72 },
  addButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 6 },
  addText: { color: COLORS.forest, fontSize: 13, fontWeight: '800' },
  npiRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  npiResult: { backgroundColor: COLORS.mintPale, borderRadius: 10, padding: 9, marginTop: 4, gap: 2 },
  npiName: { color: COLORS.ink, fontSize: 12, fontWeight: '800' },
  editor: { borderTopWidth: 1, borderTopColor: '#EEF0EE', paddingTop: 10, marginTop: 6, gap: 4 },
  editorTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' },
  fieldLabel: { color: COLORS.gray, fontSize: 11, fontWeight: '700', marginTop: 6 },
  input: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14, color: COLORS.ink, backgroundColor: '#FAFBFA' },
  noteInput: { minHeight: 60, textAlignVertical: 'top' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  pill: { minHeight: 34, borderRadius: 17, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 11, paddingVertical: 7, justifyContent: 'center' },
  pillActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  pillText: { color: COLORS.inkSoft, fontSize: 12, fontWeight: '700' },
  pillTextActive: { color: COLORS.white },
  problem: { color: COLORS.coral, fontSize: 12, fontWeight: '700', marginTop: 4 },
});
