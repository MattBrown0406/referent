// Pure helpers for claiming a listing in the center portal
// (migration 20261108150000_claim_requests.sql).
//
// Two ways in, both on the signed-in "Claim your listing" screen:
//   * a claim code from ReferralFit; its invite link is /claim#<code>, which
//     fills the code in (kept for this tab while the program signs up);
//   * a claim request: find the program, ask, and ReferralFit approves.

export const CLAIM_CODE_STORAGE_KEY = 'referralfit-claim-code';

/** The claim code in a /claim link, or null. Codes are 8 to 32 lower-case letters and digits. */
export function claimCodeFromLocation(pathname: string, hash: string): string | null {
  if (!/^\/claim\/?$/.test(pathname)) return null;
  const code = hash.replace(/^#/, '').trim().toLowerCase();
  return /^[0-9a-z]{8,32}$/.test(code) ? code : null;
}

export type ClaimRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

export type MyClaimRequest = {
  id: string;
  listingName: string;
  status: ClaimRequestStatus;
  decisionNote: string;
  createdAt: string;
};

const STATUSES: ClaimRequestStatus[] = ['pending', 'approved', 'declined', 'cancelled'];

export function toMyClaimRequest(row: Record<string, unknown> | null | undefined): MyClaimRequest | null {
  if (!row || typeof row.id !== 'string' || !STATUSES.includes(row.status as ClaimRequestStatus)) return null;
  return {
    id: row.id,
    listingName: typeof row.listing_name === 'string' && row.listing_name ? row.listing_name : 'your program',
    status: row.status as ClaimRequestStatus,
    decisionNote: typeof row.decision_note === 'string' ? row.decision_note : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  };
}

export type ClaimableListing = {
  id: string;
  name: string;
  place: string;
  website: string;
  claimed: boolean;
};

export function toClaimableListing(row: Record<string, unknown>): ClaimableListing | null {
  if (typeof row.id !== 'string') return null;
  return {
    id: row.id,
    name: typeof row.listing_name === 'string' && row.listing_name ? row.listing_name : 'Unnamed program',
    place: [row.city, row.state].filter((part) => typeof part === 'string' && part).join(', '),
    website: typeof row.website === 'string' ? row.website : '',
    claimed: row.claimed === true,
  };
}

/** A search worth sending: two characters or more. */
export function searchable(query: string): boolean {
  return query.trim().length >= 2;
}

/** The request form is ready to send: a name is required, the rest is optional. */
export function requestReady(form: { name: string }): boolean {
  return form.name.trim().length > 0;
}
