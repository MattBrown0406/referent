import { newUuid } from './cases';
import { currentAuthSessionIdentity } from './auth-session';
import { StoreError } from './errors';
import { supabase } from './supabase';
import type { InsuranceNetworkPreference, Partner, PartnerType } from '../data';

// The shared, verified placement directory (Phase 3). Listings are curated at
// the platform level; workspaces on the 'directory' plan browse active
// listings and import them into their own partner network. RLS enforces the
// entitlement server-side — without it the listing query simply returns
// nothing, so the UI should gate on the entitlement first for a clear message.

export type GlobalPartner = {
  id: string;
  name: string;
  organization: string;
  types: PartnerType[];
  city: string;
  state: string;
  regions: string[];
  phone: string;
  email: string;
  website?: string;
  monthlyCost: number;
  insurance: string[];
  insuranceNetworks: Partial<Record<string, InsuranceNetworkPreference[]>>;
  therapies: string[];
  populations: string[];
  levels: string[];
  description: string;
  verifiedAt?: string;
  // Verification decays after 12 months; only current verifications earn the badge.
  verifiedCurrent?: boolean;
  // Claimed by the program (center portal) or owned by a workspace as its
  // own profile. Claimed listings are authoritative: the claimant's edits
  // keep them verified. Only the search RPC reports this.
  claimed?: boolean;
};

// Network-wide, aggregate-only usage for a listing. Fields are null when
// fewer than five workspaces contributed (k-anonymity floor).
export type GlobalPartnerStats = {
  globalPartnerId: string;
  importingOrgs: number | null;
  referrals12m: number | null;
  admitRate: number | null;
  familyExperience: number | null;
  lastReferralOn: string | null;
  disclosed: boolean;
};

export type DirectorySearchParams = {
  query?: string;
  state?: string;
  levels?: string[];
  insurance?: string[];
  populations?: string[];
  // PartnerType values; a listing matches when any of its types overlap.
  types?: string[];
  limit?: number;
  offset?: number;
};

type GlobalPartnerRow = {
  id: string;
  name: string;
  organization: string | null;
  types: string[] | null;
  city: string | null;
  state: string | null;
  regions: string[] | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  monthly_cost: number | null;
  insurance: string[] | null;
  insurance_networks: Record<string, InsuranceNetworkPreference[]> | null;
  therapies: string[] | null;
  populations: string[] | null;
  levels: string[] | null;
  description: string | null;
  verified_at: string | null;
  verified_current?: boolean | null;
  claimed?: boolean | null;
};

function mapListing(row: GlobalPartnerRow): GlobalPartner {
  return {
    id: row.id,
    name: row.name,
    organization: row.organization || '',
    types: (row.types || []) as PartnerType[],
    city: row.city || '',
    state: row.state || '',
    regions: row.regions || [],
    phone: row.phone || '',
    email: row.email || '',
    website: row.website || undefined,
    monthlyCost: row.monthly_cost || 0,
    insurance: row.insurance || [],
    insuranceNetworks: row.insurance_networks || {},
    therapies: row.therapies || [],
    populations: row.populations || [],
    levels: row.levels || [],
    description: row.description || '',
    verifiedAt: row.verified_at || undefined,
    verifiedCurrent: typeof row.verified_current === 'boolean'
      ? row.verified_current
      : (row.verified_at ? Date.now() - Date.parse(row.verified_at) < 365 * 24 * 60 * 60 * 1000 : false),
    claimed: typeof row.claimed === 'boolean' ? row.claimed : undefined,
  };
}

// Server-side, paged directory search (trigram + full-text + array filters).
// RLS still governs visibility, so an unentitled workspace gets an empty page.
export async function searchGlobalDirectory(params: DirectorySearchParams = {}): Promise<GlobalPartner[]> {
  const { data, error } = await supabase.rpc('search_global_partners', {
    p_query: params.query?.trim() || null,
    p_state: params.state || null,
    p_levels: params.levels && params.levels.length ? params.levels : null,
    p_insurance: params.insurance && params.insurance.length ? params.insurance : null,
    p_populations: params.populations && params.populations.length ? params.populations : null,
    p_types: params.types && params.types.length ? params.types : null,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
  });
  if (error) throw new StoreError(error.message || 'Could not search the directory.', false);
  return ((data || []) as GlobalPartnerRow[]).map(mapListing);
}

// Distinct states with active listings, for filter pills. Cheap even at
// thousands of listings because only one column crosses the wire.
export async function fetchGlobalDirectoryStates(): Promise<string[]> {
  const { data, error } = await supabase
    .from('global_partners')
    .select('state')
    .eq('status', 'active');
  if (error) throw new StoreError(error.message || 'Could not load directory states.', false);
  const unique = new Set(((data || []) as { state: string | null }[]).map((row) => row.state || '').filter(Boolean));
  return [...unique].sort();
}

type GlobalPartnerStatsRow = {
  global_partner_id: string;
  importing_orgs: number | null;
  referrals_12m: number | null;
  admit_rate: number | string | null;
  family_experience: number | string | null;
  last_referral_on: string | null;
  disclosed: boolean;
};

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchGlobalPartnerStats(ids: string[]): Promise<Map<string, GlobalPartnerStats>> {
  const result = new Map<string, GlobalPartnerStats>();
  if (ids.length === 0) return result;
  const { data, error } = await supabase.rpc('fetch_global_partner_stats', { p_ids: ids });
  if (error) throw new StoreError(error.message || 'Could not load directory stats.', false);
  for (const row of (data || []) as GlobalPartnerStatsRow[]) {
    result.set(row.global_partner_id, {
      globalPartnerId: row.global_partner_id,
      importingOrgs: row.importing_orgs ?? null,
      referrals12m: row.referrals_12m ?? null,
      admitRate: toNumber(row.admit_rate),
      familyExperience: toNumber(row.family_experience),
      lastReferralOn: row.last_referral_on ?? null,
      disclosed: Boolean(row.disclosed),
    });
  }
  return result;
}

// ─── Per-user favorites ──────────────────────────────────────────────────────
// Personal to the signed-in user (unlike partners.favorite, which is the
// workspace-wide team pin). Global listings can be favorited before import;
// the favorite carries over to the tenant partner on import.

export type FavoriteTarget = 'partner' | 'global_partner';

export async function fetchFavoriteIds(target: FavoriteTarget): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('user_favorites')
    .select('target_id')
    .eq('target_type', target)
    .order('position');
  if (error) throw new StoreError(error.message || 'Could not load favorites.', false);
  return new Set(((data || []) as { target_id: string }[]).map((row) => row.target_id));
}

// Returns the new favorite state.
export async function toggleFavorite(target: FavoriteTarget, id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('toggle_user_favorite', { p_target_type: target, p_target_id: id });
  if (error) throw new StoreError(error.message || 'Could not update the favorite.', false);
  return Boolean(data);
}

// Propose one of the workspace's private partners for the shared directory.
// Returns the global listing id (existing, if the program was already listed).
export async function suggestGlobalListing(partnerId: string): Promise<string> {
  const { data, error } = await supabase.rpc('suggest_global_listing', { p_partner_id: partnerId });
  if (error) throw new StoreError(error.message || 'Could not suggest this program.', false);
  return typeof data === 'string' ? data : String(data);
}

// Re-adopt the directory's value for a field the workspace had overridden.
export async function clearPartnerOverride(partnerId: string, field: string): Promise<void> {
  const { error } = await supabase.rpc('clear_partner_override', { p_partner_id: partnerId, p_field: field });
  if (error) throw new StoreError(error.message || 'Could not reset this field.', false);
}

export async function fetchGlobalDirectory(): Promise<GlobalPartner[]> {
  const { data, error } = await supabase
    .from('global_partners')
    .select('id, name, organization, types, city, state, regions, phone, email, website, monthly_cost, insurance, insurance_networks, therapies, populations, levels, description, verified_at')
    .eq('status', 'active')
    .order('state')
    .order('organization');
  if (error) throw new StoreError(error.message || 'Could not load the directory.', false);
  return ((data || []) as GlobalPartnerRow[]).map(mapListing);
}

// Imports a listing into the caller's workspace network and returns the
// resulting Partner shaped for local state. The server dedupes per workspace,
// so the returned id may belong to a previously imported copy.
export async function importGlobalPartner(listing: GlobalPartner, expectedUserId: string): Promise<Partner> {
  const identity = await currentAuthSessionIdentity();
  if (!identity || identity.userId !== expectedUserId.toLowerCase()) {
    throw new StoreError('The signed-in account changed before the directory import.', false);
  }
  const { data: initiatingOrg, error: orgError } = await supabase.rpc('current_org_id');
  if (orgError || typeof initiatingOrg !== 'string') {
    throw new StoreError(orgError?.message || 'The active workspace could not be verified.', false);
  }
  const { data, error } = await supabase.rpc('import_global_partner', {
    p_global_id: listing.id,
    p_partner_id: newUuid(),
  });
  if (error) throw new StoreError(error.message || 'Could not add the program to your network.', false);
  const [currentIdentity, currentOrgResult] = await Promise.all([
    currentAuthSessionIdentity(),
    supabase.rpc('current_org_id'),
  ]);
  if (!currentIdentity || currentIdentity.userId !== identity.userId
      || currentIdentity.sessionId !== identity.sessionId
      || currentOrgResult.error || currentOrgResult.data !== initiatingOrg) {
    throw new StoreError('The account or workspace changed while importing the program. Reload the directory.', false);
  }
  const partnerId = typeof data === 'string' ? data : String(data);
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    id: partnerId,
    name: listing.name,
    organization: listing.organization,
    type: listing.types[0] || 'Inpatient',
    types: listing.types.length ? listing.types : undefined,
    city: listing.city,
    state: listing.state,
    regions: listing.regions,
    phone: listing.phone,
    email: listing.email,
    website: listing.website,
    monthlyCost: listing.monthlyCost,
    insuranceNetworks: listing.insuranceNetworks,
    cashMin: 0,
    cashMax: listing.monthlyCost,
    insurance: listing.insurance,
    therapies: listing.therapies,
    populations: listing.populations,
    levels: listing.levels,
    note: listing.description,
    inbound: 0,
    outbound: 0,
    lastContact: stamp,
  };
}

// ─── Workspace directory profile ────────────────────────────────────────────
//
// Every workspace can publish one listing about itself (owner_org_id). The
// owner builds it in the app; it goes live verified, and the owner's edits
// keep it verified. If the profile collides with an existing listing the
// server either takes it over (email domain / creator / suggesting workspace
// match) or files a claim request for ReferralFit to confirm.

// Keys the RPC accepts. Must match public.org_directory_profile_fields();
// scripts/store-account-test.mjs asserts the two lists agree.
export const ORG_DIRECTORY_PROFILE_FIELDS = [
  'name', 'organization', 'types', 'city', 'state', 'regions', 'phone', 'email', 'website',
  'monthly_cost', 'insurance', 'insurance_networks', 'therapies', 'populations', 'levels', 'description',
] as const;

export type OrgDirectoryProfileInput = {
  name: string;
  organization: string;
  types: PartnerType[];
  city: string;
  state: string;
  regions: string[];
  phone: string;
  email: string;
  website?: string;
  monthlyCost: number;
  insurance: string[];
  insuranceNetworks: Partial<Record<string, InsuranceNetworkPreference[]>>;
  therapies: string[];
  populations: string[];
  levels: string[];
  description: string;
};

export type OrgDirectoryProfile = GlobalPartner & {
  status: 'active' | 'pending' | 'archived';
  ownerOrgId: string;
};

export type OrgDirectoryClaimRequest = {
  id: string;
  listingId: string;
  note: string;
  createdAt: string;
};

export type OrgDirectoryProfileState = {
  // Whether the signed-in user may build or edit the profile (workspace owner).
  canEdit: boolean;
  profile: OrgDirectoryProfile | null;
  // An open request to take over an existing listing, awaiting ReferralFit.
  pendingClaim: OrgDirectoryClaimRequest | null;
};

export type UpsertOrgDirectoryProfileResult = {
  status: 'created' | 'updated' | 'claimed' | 'claim_requested';
  listingId: string;
  requestId?: string;
};

export async function fetchOrgDirectoryProfile(): Promise<OrgDirectoryProfileState> {
  const [orgResult, roleResult] = await Promise.all([
    supabase.rpc('current_org_id'),
    supabase.rpc('current_org_role'),
  ]);
  if (orgResult.error || typeof orgResult.data !== 'string' || !orgResult.data) {
    throw new StoreError(orgResult.error?.message || 'The active workspace could not be verified.', false);
  }
  const orgId = orgResult.data;
  const canEdit = roleResult.data === 'owner';

  const [listingResult, claimResult] = await Promise.all([
    supabase
      .from('global_partners')
      .select('id, name, organization, types, city, state, regions, phone, email, website, monthly_cost, insurance, insurance_networks, therapies, populations, levels, description, verified_at, status, owner_org_id')
      .eq('owner_org_id', orgId)
      .maybeSingle(),
    supabase
      .from('center_claim_requests')
      .select('id, global_partner_id, note, created_at')
      .eq('org_id', orgId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (listingResult.error) throw new StoreError(listingResult.error.message || 'Could not load your directory profile.', false);
  if (claimResult.error) throw new StoreError(claimResult.error.message || 'Could not load your directory profile.', false);

  const row = listingResult.data as (GlobalPartnerRow & { status: string; owner_org_id: string }) | null;
  const claim = claimResult.data as { id: string; global_partner_id: string; note: string | null; created_at: string } | null;
  return {
    canEdit,
    profile: row
      ? {
        ...mapListing(row),
        claimed: true,
        status: row.status === 'archived' ? 'archived' : row.status === 'pending' ? 'pending' : 'active',
        ownerOrgId: row.owner_org_id,
      }
      : null,
    pendingClaim: claim
      ? { id: claim.id, listingId: claim.global_partner_id, note: claim.note || '', createdAt: claim.created_at }
      : null,
  };
}

export function orgDirectoryProfilePayload(input: OrgDirectoryProfileInput): Record<(typeof ORG_DIRECTORY_PROFILE_FIELDS)[number], unknown> {
  return {
    name: input.name.trim(),
    organization: input.organization.trim(),
    types: input.types,
    city: input.city.trim(),
    state: input.state.trim().toUpperCase(),
    regions: input.regions,
    phone: input.phone.trim(),
    email: input.email.trim(),
    website: input.website?.trim() || '',
    monthly_cost: Math.max(0, Math.round(input.monthlyCost || 0)),
    insurance: input.insurance,
    insurance_networks: input.insuranceNetworks,
    therapies: input.therapies,
    populations: input.populations,
    levels: input.levels,
    description: input.description.trim(),
  };
}

export async function upsertOrgDirectoryProfile(input: OrgDirectoryProfileInput): Promise<UpsertOrgDirectoryProfileResult> {
  const { data, error } = await supabase.rpc('upsert_org_directory_profile', { p_payload: orgDirectoryProfilePayload(input) });
  if (error) throw new StoreError(error.message || 'Could not publish your directory profile.', false);
  const result = (data || {}) as { status?: string; listing_id?: string; request_id?: string };
  const status = result.status;
  if (status !== 'created' && status !== 'updated' && status !== 'claimed' && status !== 'claim_requested') {
    throw new StoreError('The directory returned an unexpected response. Try again.', false);
  }
  if (typeof result.listing_id !== 'string' || !result.listing_id) {
    throw new StoreError('The directory returned an unexpected response. Try again.', false);
  }
  return { status, listingId: result.listing_id, requestId: typeof result.request_id === 'string' ? result.request_id : undefined };
}
