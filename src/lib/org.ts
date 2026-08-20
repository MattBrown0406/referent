import { StoreError } from './errors';
import { supabase } from './supabase';

// Workspace (org) client API — Phase 1 of the platform buildout. Every user
// belongs to exactly one org (a personal one by default). Members of the same
// org share the whole workspace: partners, referrals, cases, follow-ups.

export type OrgRole = 'owner' | 'member';

export type OrgMember = {
  userId: string;
  role: OrgRole;
  displayName: string;
  joinedAt: string;
};

export type OrgInvite = {
  id: string;
  code: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

export type Workspace = {
  orgId: string;
  name: string;
  myRole: OrgRole;
  members: OrgMember[];
  openInvites: OrgInvite[];
};

function fail(error: { message?: string } | null, fallback: string): never {
  throw new StoreError(error?.message || fallback, false);
}

export async function fetchCurrentOrgId(): Promise<string> {
  const { data, error } = await supabase.rpc('current_org_id');
  if (error) fail(error, 'Could not resolve the active workspace.');
  if (typeof data !== 'string' || !data) throw new StoreError('No active workspace is available.', false);
  return data.toLowerCase();
}

export async function fetchWorkspace(userId: string): Promise<Workspace | null> {
  const [orgResult, membersResult, invitesResult] = await Promise.all([
    supabase.from('orgs').select('id, name').maybeSingle(),
    supabase.from('org_members').select('user_id, role, display_name, created_at').order('created_at'),
    supabase.from('org_invites').select('id, code, expires_at, accepted_at, created_at').order('created_at', { ascending: false }),
  ]);
  if (orgResult.error) fail(orgResult.error, 'Could not load the workspace.');
  if (!orgResult.data) return null;
  if (membersResult.error) fail(membersResult.error, 'Could not load workspace members.');
  if (invitesResult.error) fail(invitesResult.error, 'Could not load workspace invites.');

  const members: OrgMember[] = (membersResult.data || []).map((row) => ({
    userId: String(row.user_id).toLowerCase(),
    role: row.role === 'owner' ? 'owner' : 'member',
    displayName: row.display_name || 'Member',
    joinedAt: row.created_at,
  }));
  const me = members.find((member) => member.userId === userId.toLowerCase());
  const now = Date.now();
  const openInvites: OrgInvite[] = (invitesResult.data || [])
    .filter((row) => !row.accepted_at && Date.parse(row.expires_at) > now)
    .map((row) => ({
      id: row.id,
      code: row.code,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
    }));

  return {
    orgId: orgResult.data.id,
    name: orgResult.data.name,
    myRole: me?.role ?? 'member',
    members,
    openInvites,
  };
}

export async function renameWorkspace(orgId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new StoreError('Workspace name is required.', false);
  const { error } = await supabase.from('orgs').update({ name: trimmed }).eq('id', orgId);
  if (error) fail(error, 'Could not rename the workspace.');
}

export async function createWorkspaceInvite(): Promise<{ code: string; expiresAt: string }> {
  const { data, error } = await supabase.rpc('create_org_invite');
  if (error) fail(error, 'Could not create an invite code.');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.code) throw new StoreError('The invite code was not returned.', false);
  return { code: row.code, expiresAt: row.expires_at };
}

export async function acceptWorkspaceInvite(code: string): Promise<void> {
  const { error } = await supabase.rpc('accept_org_invite', { p_code: code.trim().toLowerCase() });
  if (error) fail(error, 'Could not join the workspace with that code.');
}

export async function removeWorkspaceMember(userId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_org_member', { p_user_id: userId });
  if (error) fail(error, 'Could not remove that member.');
}
