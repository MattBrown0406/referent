import { StoreError } from './errors';
import { fetchCurrentOrgId } from './org';
import { prepareForWorkspaceChange } from './store';
import { supabase } from './supabase';

// Self-serve account deletion (App Store guideline 5.1.1(v)).
//
// Order matters:
//   1. If this account is the sole owner of its workspace, remove the
//      workspace's case-document files from storage while the session can
//      still pass storage RLS. The RPC deletes the rows; it cannot reach the
//      bucket contents.
//   2. public.delete_own_account() — refuses owners whose workspace still has
//      other members, otherwise deletes the workspace (sole owner) or just the
//      membership (member) and then the auth user. See the migration header in
//      supabase/migrations/20260929174333_self_serve_accounts.sql.
//   3. Wipe this account's on-device caches while the local session still
//      identifies it.
//   4. Local sign-out. The server-side user is already gone, so a server
//      logout would fail; scope 'local' just clears the persisted session.

const CASE_DOCUMENTS_BUCKET = 'case-documents';

export type DeleteOwnAccountOptions = {
  userId: string;
  // True only when the caller has confirmed this user is the sole owner. A
  // member of a shared workspace must never remove the practice's files.
  removeWorkspaceFiles: boolean;
};

async function removeWorkspaceCaseFiles(): Promise<void> {
  const orgId = await fetchCurrentOrgId();
  const { data, error } = await supabase
    .from('case_documents')
    .select('storage_path')
    .eq('org_id', orgId);
  if (error) throw new StoreError(error.message || 'Could not list workspace documents.', false);
  const paths = (data || [])
    .map((row) => (typeof row.storage_path === 'string' ? row.storage_path : ''))
    .filter(Boolean);
  for (let index = 0; index < paths.length; index += 100) {
    const { error: removeError } = await supabase.storage.from(CASE_DOCUMENTS_BUCKET).remove(paths.slice(index, index + 100));
    if (removeError) throw new StoreError(removeError.message || 'Could not remove workspace documents.', false);
  }
}

export async function deleteOwnAccount({ userId, removeWorkspaceFiles }: DeleteOwnAccountOptions): Promise<void> {
  // Flush anything still queued on this device and wipe the account's local
  // caches first, so a member's last edits reach the practice and nothing
  // stale survives the deletion. Refuses while offline.
  try {
    await prepareForWorkspaceChange(userId);
  } catch (error) {
    throw new StoreError(
      `Could not sync this device's pending changes. Connect to the internet, wait for sync to finish, then try again. (${(error as Error).message})`,
      true,
    );
  }
  if (removeWorkspaceFiles) {
    await removeWorkspaceCaseFiles();
  }
  const { error } = await supabase.rpc('delete_own_account');
  if (error) throw new StoreError(error.message || 'Could not delete the account.', false);
  await supabase.auth.signOut({ scope: 'local' });
}
