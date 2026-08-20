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

type Props = {
  visible: boolean;
  userId: string;
  entitlements: EntitlementState;
  onClose: () => void;
  // Joining another practice re-homes this account's data, so the caller must
  // rehydrate everything from the server afterward.
  onWorkspaceChanged: () => void;
};

const PLAN_ROWS: { key: Entitlement; label: string; description: string }[] = [
  { key: 'pro', label: 'Pro', description: 'Team workspace and full business analytics' },
  { key: 'directory', label: 'Directory', description: 'Shared, verified placement directory' },
  { key: 'benchmarks', label: 'Benchmarks', description: 'Cross-practice performance benchmarks' },
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

export default function WorkspaceScreen({ visible, userId, entitlements, onClose, onWorkspaceChanged }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');

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
  }, [userId]);

  useEffect(() => {
    if (visible) void load();
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
      'Your partners, referrals, cases, and follow-ups move into the practice workspace you are joining. Everyone in that workspace will be able to see and work on them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Join',
          style: 'destructive',
          onPress: () => void run(async () => {
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
            <Text style={styles.errorText}>{loadError}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => void load()}>
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
                  <TouchableOpacity onPress={saveName} disabled={busy} style={styles.smallButton}>
                    <Text style={styles.smallButtonText}>Save</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.nameRow}>
                  <Text style={styles.orgName}>{workspace.name}</Text>
                  {isOwner ? (
                    <TouchableOpacity onPress={() => setEditingName(workspace.name)} style={styles.smallButtonGhost}>
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
              <Text style={styles.cardLabel}>Plan</Text>
              {PLAN_ROWS.map((row) => (
                <View key={row.key} style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName}>{row.label}</Text>
                    <Text style={styles.memberRole}>{row.description}</Text>
                  </View>
                  <View style={entitlements.entitlements[row.key] ? styles.planBadgeActive : styles.planBadge}>
                    <Text style={entitlements.entitlements[row.key] ? styles.planBadgeActiveText : styles.planBadgeText}>
                      {entitlements.entitlements[row.key] ? 'Active' : 'Free'}
                    </Text>
                  </View>
                </View>
              ))}
              <Text style={styles.helpText}>
                Subscriptions are managed through the App Store from the upgrade screen.
              </Text>
            </View>

            {isOwner ? (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Invite a teammate</Text>
                <Text style={styles.helpText}>
                  Create a single-use code and share it. When your teammate joins, their existing
                  partners, referrals, and cases move into this workspace.
                </Text>
                {workspace.openInvites.map((invite) => (
                  <View key={invite.id} style={styles.inviteRow}>
                    <Text style={styles.inviteCode}>{invite.code}</Text>
                    <Text style={styles.inviteExpiry}>{inviteExpiryLabel(invite.expiresAt)}</Text>
                  </View>
                ))}
                <TouchableOpacity disabled={busy} onPress={makeInvite} style={styles.primaryButton}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Create invite code</Text>}
                </TouchableOpacity>
              </View>
            ) : null}

            {soloOwner || !isOwner ? (
              <View style={styles.card}>
                <Text style={styles.cardLabel}>Join a practice</Text>
                <Text style={styles.helpText}>
                  Have an invite code from another practice? Joining moves your data into their
                  shared workspace.
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
                  <TouchableOpacity disabled={busy || !joinCode.trim()} onPress={joinWorkspace} style={styles.smallButton}>
                    <Text style={styles.smallButtonText}>Join</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </ScrollView>
        ) : (
          <View style={styles.centered}>
            <Text style={styles.errorText}>No workspace found for this account yet. Sign out and back in, then try again.</Text>
          </View>
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
  helpText: { fontSize: 14, color: COLORS.gray, lineHeight: 20 },
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
