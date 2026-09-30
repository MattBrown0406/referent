import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  acceptWorkspaceInvite,
  createWorkspaceInvite,
  fetchWorkspace,
  removeWorkspaceMember,
  renameWorkspace,
  type Workspace,
} from './org';
import { type Entitlement, type EntitlementState } from './entitlements';
import { fetchIsPlatformAdmin, fetchOrgDirectoryProfile, fetchPendingDirectorySubmissions, type OrgDirectoryProfileState } from './directory';
import DirectoryReviewQueue from './DirectoryReviewQueue';
import { prepareForWorkspaceChange } from './store';
import { deleteOwnAccount } from './account';

type Props = {
  visible: boolean;
  userId: string;
  entitlements: EntitlementState;
  onClose: () => void;
  // Joining another practice changes the account's active workspace, so the
  // caller must rehydrate everything from the server afterward.
  onWorkspaceChanged: () => void;
  // Opens the directory-profile form (owned by the caller so it can reuse
  // the partner form fields). The caller closes this screen first.
  onEditDirectoryProfile: () => void;
  // The account and its local session are already gone when this fires; the
  // caller resets in-memory state and lets the auth listener show sign-in.
  onAccountDeleted: () => void;
};

const FEATURE_ROWS: { key: Entitlement; label: string; description: string }[] = [
  { key: 'pro', label: 'Team workspace', description: 'Invite colleagues and share one practice file' },
  { key: 'directory', label: 'Directory', description: 'Shared, verified placement directory' },
  { key: 'benchmarks', label: 'Benchmarks', description: 'Anonymized cross-practice benchmarks' },
];

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
  green: '#067647',
  greenSoft: '#ECFDF3',
};

function inviteExpiryLabel(expiresAt: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000));
  if (days === 0) return 'expires today';
  return days === 1 ? 'expires in 1 day' : `expires in ${days} days`;
}

function profileSummary(profile: NonNullable<OrgDirectoryProfileState['profile']>): string {
  const place = [profile.city, profile.state].filter(Boolean).join(', ');
  return [profile.types.join(' · '), place].filter(Boolean).join('  ·  ');
}

function profileStatusLabel(profile: NonNullable<OrgDirectoryProfileState['profile']>): string {
  if (profile.status === 'archived') return 'Archived by ReferralFit — not shown in the directory';
  if (profile.status === 'pending') return 'Pending ReferralFit review';
  return profile.verifiedAt ? `Live · Verified ${profile.verifiedAt.slice(0, 10)}` : 'Live in the directory';
}

export default function WorkspaceScreen({ visible, userId, entitlements, onClose, onWorkspaceChanged, onEditDirectoryProfile, onAccountDeleted }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [directoryProfile, setDirectoryProfile] = useState<OrgDirectoryProfileState | null>(null);
  const [directoryProfileError, setDirectoryProfileError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  // Platform admins only: how many directory submissions are waiting (null
  // for everyone else, which hides the card), and whether the queue is open.
  const [pendingSubmissions, setPendingSubmissions] = useState<number | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setWorkspace(await fetchWorkspace(userId));
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
    // The profile card is secondary: its failure never blocks the screen.
    setDirectoryProfileError('');
    try {
      setDirectoryProfile(await fetchOrgDirectoryProfile());
    } catch (error) {
      setDirectoryProfile(null);
      setDirectoryProfileError((error as Error).message);
    }
    // Display-only check; the queue RPCs enforce platform-admin status.
    try {
      setPendingSubmissions(await fetchIsPlatformAdmin() ? (await fetchPendingDirectorySubmissions()).length : null);
    } catch {
      setPendingSubmissions(null);
    }
  }, [userId]);

  useEffect(() => {
    if (visible) void load();
    else setReviewOpen(false);
  }, [visible, load]);

  const isOwner = workspace?.myRole === 'owner';
  const soloOwner = isOwner && (workspace?.members.length ?? 0) <= 1;

  async function run(action: () => Promise<void>, failureTitle: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert(failureTitle, (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // App Store guideline 5.1.1(v): in-app account deletion. Two confirmations,
  // each spelling out exactly what goes away for this account's situation.
  const otherMembers = Math.max(0, (workspace?.members.length ?? 1) - 1);
  function confirmDeleteAccount() {
    if (isOwner && otherMembers > 0) {
      Alert.alert(
        'Remove your team first',
        `Your workspace still has ${otherMembers} other member${otherMembers === 1 ? '' : 's'}. Remove them above (each keeps a workspace of their own), or contact ReferralFit to transfer ownership. Then you can delete your account.`,
      );
      return;
    }
    const whatIsDeleted = soloOwner
      ? 'Your sign-in and your entire workspace are deleted permanently: partners, activity, referrals, cases, case documents, follow-ups, invites, and favorites. Any directory listing your practice claimed stays public but becomes unclaimed.'
      : 'Your sign-in is deleted permanently. Work you added for your practice stays in the practice workspace, no longer attributed to you.';
    Alert.alert('Delete your account?', `${whatIsDeleted}\n\nThis cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', style: 'destructive', onPress: () => {
        Alert.alert('Delete permanently?', 'You will be signed out on this device immediately and the account cannot be recovered.', [
          { text: 'Keep my account', style: 'cancel' },
          { text: 'Delete account', style: 'destructive', onPress: () => run(async () => {
            await deleteOwnAccount({ userId, removeWorkspaceFiles: soloOwner });
            onAccountDeleted();
          }, 'Could not delete the account') },
        ]);
      } },
    ]);
  }

  function saveName() {
    if (!workspace || editingName === null) return;
    const next = editingName.trim();
    setEditingName(null);
    if (!next || next === workspace.name) return;
    void run(async () => {
      await renameWorkspace(workspace.orgId, next);
      await load();
    }, 'Could not rename');
  }

  function makeInvite() {
    if (!entitlements.entitlements.pro) {
      Alert.alert('Team invitations unavailable', 'Team workspace invitations are not enabled for this workspace. Contact ReferralFit if you expected them.');
      return;
    }
    void run(async () => {
      const invite = await createWorkspaceInvite();
      await load();
      await Share.share({
        message: `Join my ${workspace?.name || 'ReferralFit'} workspace on ReferralFit. In the app, open Workspace → Join a practice and enter the code: ${invite.code} (${inviteExpiryLabel(invite.expiresAt)}).`,
      }).catch(() => undefined);
    }, 'Could not create invite');
  }

  function joinWorkspace() {
    const code = joinCode.trim();
    if (!code) return;
    Alert.alert(
      'Join this practice?',
      soloOwner
        ? 'Your personal-workspace partners, referrals, cases, and follow-ups move into the practice you are joining. Everyone in that workspace will be able to see and work on them.'
        : 'Your account will leave its current practice and join the new one. Work created for your current practice stays with that practice.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Join',
          style: 'destructive',
          onPress: () => void run(async () => {
            await prepareForWorkspaceChange(userId);
            await acceptWorkspaceInvite(code);
            setJoinCode('');
            await load();
            onWorkspaceChanged();
          }, 'Could not join'),
        },
      ],
    );
  }

  function confirmRemove(memberId: string, name: string) {
    Alert.alert(
      `Remove ${name}?`,
      'Their past work stays with this workspace. They keep their account and get a fresh empty workspace of their own.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void run(async () => {
            await removeWorkspaceMember(memberId);
            await load();
          }, 'Could not remove member'),
        },
      ],
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        {reviewOpen && pendingSubmissions !== null ? (
          <DirectoryReviewQueue onBack={() => setReviewOpen(false)} onCountChange={setPendingSubmissions} />
        ) : (
        <>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Workspace</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close workspace" onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>

        {loading && !workspace ? (
          <View style={styles.centered}><ActivityIndicator color={COLORS.blue} /></View>
        ) : loadError ? (
          <View style={styles.centered}>
            <Text accessibilityRole="alert" style={styles.errorText}>{loadError}</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: loading }} style={styles.retryButton} onPress={() => void load()}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : workspace ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Practice name</Text>
              {editingName !== null ? (
                <View style={styles.nameRow}>
                  <TextInput
                    style={styles.nameInput}
                    value={editingName}
                    onChangeText={setEditingName}
                    autoFocus
                    maxLength={120}
                    onSubmitEditing={saveName}
                    returnKeyType="done"
                  />
                  <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} onPress={saveName} disabled={busy} style={styles.smallButton}>
                    <Text style={styles.smallButtonText}>Save</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.nameRow}>
                  <Text style={styles.orgName}>{workspace.name}</Text>
                  {isOwner ? (
                    <TouchableOpacity accessibilityRole="button" onPress={() => setEditingName(workspace.name)} style={styles.smallButtonGhost}>
                      <Text style={styles.smallButtonGhostText}>Rename</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>Members</Text>
              {workspace.members.map((member) => (
                <View key={member.userId} style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName}>
                      {member.displayName}
                      {member.userId === userId.toLowerCase() ? ' (you)' : ''}
                    </Text>
                    <Text style={styles.memberRole}>{member.role === 'owner' ? 'Owner' : 'Member'}</Text>
                  </View>
                  {isOwner && member.userId !== userId.toLowerCase() ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy, busy }}
                      disabled={busy}
                      onPress={() => confirmRemove(member.userId, member.displayName)}
                      style={styles.removeButton}
                    >
                      <Text style={styles.removeText}>Remove</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>Your directory profile</Text>
              {directoryProfile?.profile ? (
                <>
                  <View style={styles.nameRow}>
                    <Text style={styles.orgName}>{directoryProfile.profile.organization || directoryProfile.profile.name}</Text>
                    {directoryProfile.canEdit ? (
                      <TouchableOpacity accessibilityRole="button" onPress={onEditDirectoryProfile} style={styles.smallButtonGhost}>
                        <Text style={styles.smallButtonGhostText}>Edit</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <Text style={styles.memberRole}>{profileSummary(directoryProfile.profile)}</Text>
                  <View style={directoryProfile.profile.status === 'active' ? styles.planBadgeActive : styles.planBadge}>
                    <Text style={directoryProfile.profile.status === 'active' ? styles.planBadgeActiveText : styles.planBadgeText}>
                      {profileStatusLabel(directoryProfile.profile)}
                    </Text>
                  </View>
                  <Text style={styles.helpText}>
                    This is your practice's own listing. Your edits publish immediately and keep it verified; other practices see it in the Directory and can add you to their network.
                  </Text>
                </>
              ) : directoryProfile?.pendingClaim ? (
                <>
                  <Text style={styles.helpText}>
                    We found an existing directory listing that looks like your practice. ReferralFit will confirm you own it before it becomes your profile — nothing else is needed from you.
                  </Text>
                  {directoryProfile.pendingClaim.note ? (
                    <Text style={[styles.memberRole, styles.helpTextSpaced]}>{directoryProfile.pendingClaim.note}</Text>
                  ) : null}
                </>
              ) : directoryProfileError ? (
                <Text style={styles.helpText}>Your directory profile could not be loaded: {directoryProfileError}</Text>
              ) : directoryProfile ? (
                <>
                  <Text style={styles.helpText}>
                    Let other practices find you. Your profile appears in the shared Directory as a verified listing you control — programs, interventionists, and therapists alike.
                  </Text>
                  {directoryProfile.canEdit ? (
                    <TouchableOpacity accessibilityRole="button" onPress={onEditDirectoryProfile} style={styles.primaryButton}>
                      <Text style={styles.primaryButtonText}>Build your verified profile</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={[styles.helpText, styles.helpTextSpaced]}>The workspace owner can build the profile from this screen.</Text>
                  )}
                </>
              ) : (
                <ActivityIndicator color={COLORS.blue} />
              )}
            </View>

            {pendingSubmissions !== null ? (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Directory submissions</Text>
                <View style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName}>{pendingSubmissions === 0 ? 'Nothing waiting' : `${pendingSubmissions} waiting for review`}</Text>
                    <Text style={styles.memberRole}>Programs practices submitted for the shared directory</Text>
                  </View>
                  <View style={pendingSubmissions > 0 ? styles.planBadgeActive : styles.planBadge}>
                    <Text accessibilityLabel={`${pendingSubmissions} pending`} style={pendingSubmissions > 0 ? styles.planBadgeActiveText : styles.planBadgeText}>{pendingSubmissions}</Text>
                  </View>
                </View>
                <TouchableOpacity accessibilityRole="button" onPress={() => setReviewOpen(true)} style={styles.primaryButton}>
                  <Text style={styles.primaryButtonText}>Review submissions</Text>
                </TouchableOpacity>
                <Text style={styles.helpText}>Only ReferralFit platform admins see this card.</Text>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.cardLabel}>Your data is private</Text>
              <Text style={styles.helpText}>
                Everything in this workspace — partners, cases, referrals, notes, and documents — belongs to your practice alone. Other practices using ReferralFit cannot see it, and ReferralFit staff do not have access to it. Only people you invite with a code can join this workspace.
              </Text>
              <Text style={[styles.helpText, styles.helpTextSpaced]}>
                The only shared space is the Directory: your own profile if you build one, and a program only when you choose to submit it and ReferralFit approves it. Benchmarks use anonymized totals and never identify a practice.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>Included</Text>
              {FEATURE_ROWS.map((row) => (
                <View key={row.key} style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName}>{row.label}</Text>
                    <Text style={styles.memberRole}>{row.description}</Text>
                  </View>
                  <View style={entitlements.entitlements[row.key] ? styles.planBadgeActive : styles.planBadge}>
                    <Text style={entitlements.entitlements[row.key] ? styles.planBadgeActiveText : styles.planBadgeText}>
                      {entitlements.entitlements[row.key] ? 'Included' : entitlements.loadedAt ? 'Not enabled' : 'Checking'}
                    </Text>
                  </View>
                </View>
              ))}
              <Text style={styles.helpText}>
                ReferralFit is free to use. There is nothing to buy in this app and no charge to your practice.
              </Text>
            </View>

            {isOwner && entitlements.entitlements.pro ? (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Invite a teammate</Text>
                <Text style={styles.helpText}>
                  Create a single-use code and share it. A solo practitioner's personal data moves
                  with them; work owned by another practice stays with that practice.
                </Text>
                {workspace.openInvites.map((invite) => (
                  <View key={invite.id} style={styles.inviteRow}>
                    <Text style={styles.inviteCode}>{invite.code}</Text>
                    <Text style={styles.inviteExpiry}>{inviteExpiryLabel(invite.expiresAt)}</Text>
                  </View>
                ))}
                <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={makeInvite} style={styles.primaryButton}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Create invite code</Text>}
                </TouchableOpacity>
              </View>
            ) : isOwner ? (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Invite a teammate</Text>
                <Text style={styles.helpText}>
                  Team invitations are not enabled for this workspace. Existing members keep their access; contact ReferralFit if you expected to invite colleagues.
                </Text>
              </View>
            ) : null}

            {soloOwner || !isOwner ? (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Join a practice</Text>
                <Text style={styles.helpText}>
                  {soloOwner
                    ? 'Have an invite code from another practice? Joining moves your personal-workspace data into their workspace and gives their members access to it.'
                    : 'Have an invite code from another practice? Your account will move, while work created for your current practice stays there.'}
                </Text>
                <View style={styles.nameRow}>
                  <TextInput
                    style={styles.nameInput}
                    value={joinCode}
                    onChangeText={setJoinCode}
                    placeholder="Invite code"
                    placeholderTextColor={COLORS.gray}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy || !joinCode.trim(), busy }} disabled={busy || !joinCode.trim()} onPress={joinWorkspace} style={styles.smallButton}>
                    <Text style={styles.smallButtonText}>Join</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            <View style={styles.card}>
              <Text style={styles.cardLabel}>Delete account</Text>
              <Text style={styles.helpText}>
                {isOwner && otherMembers > 0
                  ? 'Remove the other members of your workspace before deleting your account.'
                  : soloOwner
                    ? 'Permanently deletes your sign-in and this workspace, including every partner, case, and document.'
                    : 'Permanently deletes your sign-in. Work you added for your practice stays with the practice.'}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Delete account"
                accessibilityState={{ disabled: busy, busy }}
                disabled={busy}
                onPress={confirmDeleteAccount}
                style={[styles.dangerButton, styles.helpTextSpaced]}
              >
                <Text style={styles.dangerButtonText}>Delete account…</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        ) : (
          <View style={styles.centered}>
            <Text style={styles.errorText}>No workspace found for this account yet. Sign out and back in, then try again.</Text>
          </View>
        )}
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
  retryButton: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: COLORS.blueSoft, borderRadius: 8 },
  retryText: { color: COLORS.blue, fontWeight: '600' },
  content: { padding: 16, gap: 16 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.line,
    padding: 16,
    gap: 10,
  },
  cardLabel: { fontSize: 13, fontWeight: '700', color: COLORS.gray, textTransform: 'uppercase', letterSpacing: 0.4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orgName: { flex: 1, fontSize: 18, fontWeight: '700', color: COLORS.ink },
  nameInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: COLORS.ink,
    backgroundColor: COLORS.bg,
  },
  smallButton: { backgroundColor: COLORS.blue, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  smallButtonText: { color: '#fff', fontWeight: '600' },
  smallButtonGhost: { backgroundColor: COLORS.blueSoft, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  smallButtonGhostText: { color: COLORS.blue, fontWeight: '600' },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  memberInfo: { flex: 1 },
  memberName: { fontSize: 16, fontWeight: '600', color: COLORS.ink },
  memberRole: { fontSize: 13, color: COLORS.gray, marginTop: 2 },
  removeButton: { backgroundColor: COLORS.coralSoft, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  removeText: { color: COLORS.coral, fontWeight: '600' },
  dangerButton: { alignSelf: 'flex-start', backgroundColor: COLORS.coralSoft, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  dangerButtonText: { color: COLORS.coral, fontWeight: '700' },
  helpText: { fontSize: 14, color: COLORS.gray, lineHeight: 20 },
  helpTextSpaced: { marginTop: 10 },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.greenSoft,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  inviteCode: { fontSize: 16, fontWeight: '700', color: COLORS.green, letterSpacing: 1 },
  inviteExpiry: { fontSize: 13, color: COLORS.green },
  primaryButton: {
    backgroundColor: COLORS.blue,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  planBadge: { backgroundColor: COLORS.bg, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: COLORS.line },
  planBadgeText: { fontSize: 13, fontWeight: '600', color: COLORS.gray },
  planBadgeActive: { backgroundColor: COLORS.greenSoft, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  planBadgeActiveText: { fontSize: 13, fontWeight: '600', color: COLORS.green },
});
