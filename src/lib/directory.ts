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
