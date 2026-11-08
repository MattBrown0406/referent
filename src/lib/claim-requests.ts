import { StoreError } from './errors';
import { supabase } from './supabase';

// How a program comes to manage its directory listing, from ReferralFit's
// side (platform admins only; every RPC re-checks that on the server):
//   * claim requests (migration 20261108150000): a program signs up in the
//     portal, finds its listing and asks; the admin approves or declines in
//     Workspace > Program claim requests;
//   * a claim code (create_center_claim_code): the admin issues one from the
//     listing's Directory card and sends the program a link that opens the
//     portal with the code filled in.

export const PROGRAM_PORTAL_URL = 'https://portal.referralfit.com';

export type ProgramClaimRequest = {
  id: string;
  globalPartnerId: string;
  listingName: string;
  place: string;
  website: string;
  listingPhone: string;
  listingClaimed: boolean;
  requesterEmail: string;
  emailMatchesWebsite: boolean;
  contactName: string;
  contactRole: string;
  contactPhone: string;
  note: string;
  createdAt: string;
};

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function mapClaimRequest(row: Row): ProgramClaimRequest {
  return {
    id: text(row.id),
    globalPartnerId: text(row.global_partner_id),
    listingName: text(row.listing_name) || 'A program',
    place: [text(row.city), text(row.state)].filter(Boolean).join(', '),
    website: text(row.website),
    listingPhone: text(row.listing_phone),
    listingClaimed: row.listing_claimed === true,
    requesterEmail: text(row.requester_email),
    emailMatchesWebsite: row.email_matches_website === true,
    contactName: text(row.contact_name),
    contactRole: text(row.contact_role),
    contactPhone: text(row.contact_phone),
    note: text(row.note),
    createdAt: text(row.created_at),
  };
}

/** The server does not have the claim-request migration yet. */
export function isMissingClaimRequests(error: { code?: string } | null | undefined): boolean {
  const code = error?.code;
  return code === 'PGRST202' || code === '42883' || code === '42P01';
}

/** Waiting requests, oldest first; null on a server without the feature. */
export async function fetchProgramClaimRequests(): Promise<ProgramClaimRequest[] | null> {
  const { data, error } = await supabase.rpc('list_program_claim_requests');
  if (isMissingClaimRequests(error)) return null;
  if (error) throw new StoreError(error.message || 'Could not load claim requests.', false);
  return (Array.isArray(data) ? data : []).map((row) => mapClaimRequest(row as Row));
}

export async function decideProgramClaimRequest(id: string, approve: boolean, note: string): Promise<'approved' | 'declined'> {
  const { data, error } = await supabase.rpc('decide_program_claim_request', { p_id: id, p_approve: approve, p_note: note.trim() });
  if (error) throw new StoreError(error.message || 'Could not save the decision.', false);
  return data === 'approved' ? 'approved' : 'declined';
}

export type ClaimCode = { code: string; expiresAt: string };

export async function issueClaimCode(globalPartnerId: string): Promise<ClaimCode> {
  const { data, error } = await supabase.rpc('create_center_claim_code', { p_global_partner_id: globalPartnerId });
  if (error) throw new StoreError(error.message || 'Could not issue a claim code.', false);
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  const code = text(row?.code);
  if (!/^[0-9a-z]{8,32}$/.test(code)) throw new StoreError('The server did not return a claim code.', false);
  return { code, expiresAt: text(row?.expires_at) };
}

/** The portal link that opens with the code filled in (code in the fragment). */
export function claimLink(code: string): string {
  return `${PROGRAM_PORTAL_URL}/claim#${code}`;
}

/** "December 7, 2026" from an ISO time, or '' for anything else. */
export function claimExpiryDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** The message ReferralFit sends a program with its code. */
export function claimInviteMessage(programName: string, code: ClaimCode): string {
  const expires = claimExpiryDate(code.expiresAt);
  return [
    `Here is how to manage ${programName.trim() || 'your program'}'s listing on ReferralFit (free):`,
    '',
    `1. Open ${claimLink(code.code)}`,
    '2. Create your program account (or sign in).',
    '3. Your claim code is already filled in. Tap "Claim listing".',
    '',
    `Claim code: ${code.code}${expires ? ` (works until ${expires})` : ''}`,
    '',
    'You can then keep your open beds, levels of care, insurance and admissions contacts current, and answer placement requests from interventionists.',
  ].join('\n');
}

/** "3 hours ago", "2 days ago" for the queue. */
export function requestedAgo(iso: string, now = new Date()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - time) / 60000));
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
