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
  leadSettings: LeadSettings;
};

// Lead capture settings on the workspace row. The intake token is generated
// and rotated server-side only; the target is the owner's to edit.
export type LeadSettings = {
  intakeToken: string;
  leadResponseTargetMinutes: number;
};

export const DEFAULT_LEAD_RESPONSE_TARGET_MINUTES = 15;

export const DEFAULT_LEAD_SETTINGS: LeadSettings = {
  intakeToken: '',
  leadResponseTargetMinutes: DEFAULT_LEAD_RESPONSE_TARGET_MINUTES,
};

function mapLeadSettings(row: { intake_token?: unknown; lead_response_target_minutes?: unknown } | null): LeadSettings {
  const target = Number(row?.lead_response_target_minutes);
  return {
    intakeToken: typeof row?.intake_token === 'string' ? row.intake_token : '',
    leadResponseTargetMinutes: Number.isInteger(target) && target >= 1 && target <= 1440 ? target : DEFAULT_LEAD_RESPONSE_TARGET_MINUTES,
  };
}

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
  let [orgResult, membersResult, invitesResult] = await Promise.all([
    supabase.from('orgs').select('id, name, intake_token, lead_response_target_minutes').maybeSingle(),
    supabase.from('org_members').select('user_id, role, display_name, created_at').order('created_at'),
    supabase.from('org_invites').select('id, code, expires_at, accepted_at, created_at').order('created_at', { ascending: false }),
  ]);
  // Until the lead-capture migration is applied the two columns do not exist
  // (42703); the workspace screen still works, just without the intake card.
  if (orgResult.error?.code === '42703') {
    orgResult = await supabase.from('orgs').select('id, name').maybeSingle();
  }
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
    leadSettings: mapLeadSettings(orgResult.data),
  };
}

// Lightweight read for the app shell (Today clock, quick-add, dashboard
// target). Any failure falls back to the defaults; nothing else depends on it.
export async function fetchLeadSettings(): Promise<LeadSettings> {
  const { data, error } = await supabase.from('orgs').select('intake_token, lead_response_target_minutes').maybeSingle();
  if (error) fail(error, 'Could not load lead settings.');
  return mapLeadSettings(data);
}

export async function updateLeadResponseTarget(orgId: string, minutes: number): Promise<void> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new StoreError('Enter a target between 1 and 1440 minutes.', false);
  }
  const { error } = await supabase.from('orgs').update({ lead_response_target_minutes: minutes }).eq('id', orgId);
  if (error) fail(error, 'Could not save the first-call target.');
}

// "Make a new link": the old token stops working the moment this returns.
export async function rotateIntakeToken(): Promise<string> {
  const { data, error } = await supabase.rpc('rotate_intake_token');
  if (error) fail(error, 'Could not make a new intake link.');
  if (typeof data !== 'string' || !data) throw new StoreError('The new intake link was not returned.', false);
  return data;
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
