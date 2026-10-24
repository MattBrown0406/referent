import { forceLocalSignOut } from './auth-session';
import { RejectedWritesError, StoreError, describeError, errorCode, isServerUnreachable } from './errors';
import { fetchCurrentOrgId } from './org';
import { fetchAllPages } from './paging';
import { forgetWorkspaceBinding, isNetworkError, prepareForWorkspaceChange, rejectedWriteCount, waitingWriteCount } from './store';
import { supabase } from './supabase';

// Self-serve account deletion (App Store guideline 5.1.1(v)).
//
// Order matters:
//   1. public.prepare_account_deletion() — raises exactly the refusals
//      delete_own_account would (an owner whose workspace still has other
//      members, …) and closes the workspace's open invites, so nobody can
//      join a workspace that is about to go. It runs first, so a refusal
//      leaves everything as it was (files, this device's caches and queued
//      changes); its message is shown as the server wrote it.
//   2. Sync this device's queued changes and wipe its caches (refuses while
//      offline, so nothing unsynced is lost).
//   3. If this account is the sole owner of its workspace, remove the
//      workspace's case-document files from storage while the session can
//      still pass storage RLS. The RPC deletes the rows; it cannot reach the
//      bucket contents. Files are only removed once step 1 has said yes, so
//      a refused deletion never leaves cases without their documents.
//   4. public.delete_own_account() — deletes the workspace (sole owner) or
//      just the membership (member) and then the auth user. See the migration
//      header in supabase/migrations/20260929174333_self_serve_accounts.sql.
//   5. Local sign-out. The server-side user is already gone, so a server
//      logout would fail; scope 'local' just clears the persisted session.

const CASE_DOCUMENTS_BUCKET = 'case-documents';

export type DeleteOwnAccountOptions = {
  userId: string;
  // True only when the caller has confirmed this user is the sole owner. A
  // member of a shared workspace must never remove the practice's files.
  removeWorkspaceFiles: boolean;
};

// Every document path in the workspace, paged: PostgREST stops at max_rows
// (1,000) without an error, and a truncated list would leave case documents
// (PHI) behind in storage after the account is gone.
async function listWorkspaceDocumentPaths(orgId: string): Promise<string[]> {
  let rows: { id: string; storage_path: unknown }[];
  try {
    rows = await fetchAllPages<{ id: string; storage_path: unknown }>((from, to) => supabase.from('case_documents').select('id, storage_path').eq('org_id', orgId).order('id').range(from, to));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(`Could not list workspace documents: ${describeError(error)}`, false);
  }
  return Array.from(new Set(rows
    .map((row) => (typeof row.storage_path === 'string' ? row.storage_path : ''))
    .filter(Boolean)));
}

async function removeWorkspaceCaseFiles(): Promise<void> {
  const orgId = await fetchCurrentOrgId();
  const paths = await listWorkspaceDocumentPaths(orgId);
  for (let index = 0; index < paths.length; index += 100) {
    const { error: removeError } = await supabase.storage.from(CASE_DOCUMENTS_BUCKET).remove(paths.slice(index, index + 100));
    if (removeError) throw new StoreError(`Could not remove workspace documents: ${describeError(removeError)}`, false);
  }
}

// The server's own wording for a refusal ("Remove the other members of your
// workspace first", …), without the PostgREST code suffix describeError adds.
function serverMessage(error: unknown, fallback: string): string {
  // A gateway or network failure is not a refusal worth quoting (its text may
  // be an HTML page); describeError gives safe text for those.
  if (isServerUnreachable(error)) return describeError(error, fallback);
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : describeError(error, fallback);
}

// A server that predates prepare_account_deletion (its migration not applied
// yet) answers "function not found". Deletion then goes ahead as before:
// delete_own_account still refuses on its own, only after the files.
function isMissingFunction(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'PGRST202' || code === '42883') return true;
  return /could not find the function/i.test(describeError(error, ''));
}

export async function deleteOwnAccount({ userId, removeWorkspaceFiles }: DeleteOwnAccountOptions): Promise<void> {
  // Refusals come before anything is touched: files, caches, queued changes.
  const { error: prepareError } = await supabase.rpc('prepare_account_deletion');
  if (prepareError && !isMissingFunction(prepareError)) {
    if (isNetworkError(prepareError)) throw new StoreError('Connect to the internet, then try again. Nothing was deleted.', false);
    throw new StoreError(serverMessage(prepareError, 'Your account could not be deleted.'), false);
  }
  // Flush anything still queued on this device and wipe the account's local
  // caches first, so a member's last edits reach the practice and nothing
  // stale survives the deletion. Refuses while offline.
  try {
    try {
      await prepareForWorkspaceChange(userId);
    } catch (error) {
      // Changes the server already refused, and changes waiting on a record
      // that never reached the server, are moot once the account is gone;
      // changes that can still sync (offline, server trouble) block deletion.
      const unsaved = (await rejectedWriteCount(userId).catch(() => 0)) + (await waitingWriteCount(userId).catch(() => 0));
      if (!(error instanceof RejectedWritesError) && unsaved === 0) throw error;
      await prepareForWorkspaceChange(userId, { discardRejected: true });
    }
  } catch (error) {
    throw new StoreError(
      `Could not sync this device's pending changes. Connect to the internet, wait for sync to finish, then try again. (${describeError(error)})`,
      true,
    );
  }
  if (removeWorkspaceFiles) {
    await removeWorkspaceCaseFiles();
  }
  const { error } = await supabase.rpc('delete_own_account');
  if (error) throw new StoreError(serverMessage(error, 'Could not delete the account.'), false);
  // The server-side account is gone; nothing local should outlive it.
  await forgetWorkspaceBinding(userId).catch(() => undefined);
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
  // signOut() first refreshes the session; with an expired token and no
  // connection it fails and leaves the session on the device. Remove it here.
  if (signOutError) await forceLocalSignOut();
}
