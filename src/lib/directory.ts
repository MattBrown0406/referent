import { newUuid } from './cases';
import { currentAuthSessionIdentity } from './auth-session';
import { StoreError } from './errors';
import { supabase } from './supabase';
import { fetchDirectoryPartner, pendingWriteCount } from './store';
import { programPayload, type PublicProgramDraft } from './program-sharing';
import type { InsuranceNetworkPreference, Partner, PartnerType } from '../data';

// Active public programs are discoverable by every signed-in practice.
// Community contributions remain unverified until reviewed by a curator.
// Private workspace records are fetched separately after importing.

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
  };
}

export async function fetchGlobalDirectory(): Promise<GlobalPartner[]> {
  const listings: GlobalPartner[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('global_partners')
      .select('id, name, organization, types, city, state, regions, phone, email, website, monthly_cost, insurance, insurance_networks, therapies, populations, levels, description, verified_at')
      .eq('status', 'active').order('id').range(offset, offset + pageSize - 1);
    if (error) throw new StoreError(error.message || 'Could not load the directory.', false);
    const rows = (data || []) as GlobalPartnerRow[];
    listings.push(...rows.map(mapListing));
    if (rows.length < pageSize) return listings;
  }
}

async function directorySession(expectedUserId: string, expectedOrgId: string) {
  const identity = await currentAuthSessionIdentity();
  if (!identity || identity.userId !== expectedUserId.toLowerCase()) throw new StoreError('The signed-in account changed.', false);
  const { data: org, error } = await supabase.rpc('current_org_id');
  if (error || !expectedOrgId || org !== expectedOrgId) throw new StoreError('The active workspace changed. Reload your directory.', false);
  if (await pendingWriteCount(expectedUserId)) throw new StoreError('Sync your pending changes before sharing or importing a program.', true);
  return identity;
}

async function verifyDirectorySession(identity: NonNullable<Awaited<ReturnType<typeof currentAuthSessionIdentity>>>, orgId: string) {
  const current = await currentAuthSessionIdentity();
  const { data: org, error } = await supabase.rpc('current_org_id');
  if (!current || current.userId !== identity.userId || current.sessionId !== identity.sessionId || error || org !== orgId) {
    throw new StoreError('The account or workspace changed. Reload your directory.', false);
  }
}

export async function importGlobalPartner(listing: GlobalPartner, expectedUserId: string, expectedOrgId: string): Promise<Partner> {
  const identity = await directorySession(expectedUserId, expectedOrgId);
  const { data, error } = await supabase.rpc('import_global_partner', {
    p_global_id: listing.id, p_partner_id: newUuid(), p_expected_org_id: expectedOrgId,
  });
  if (error) throw new StoreError(error.message || 'Could not add the program to your directory.', false);
  await verifyDirectorySession(identity, expectedOrgId);
  // Read the actual local row. A deduplicated import must preserve private
  // contacts, notes, rates, and referral balances instead of replacing them.
  const partner = await fetchDirectoryPartner(String(data), expectedUserId);
  await verifyDirectorySession(identity, expectedOrgId);
  return partner;
}

export async function publishPartnerProgram(partnerId: string, draft: PublicProgramDraft, userId: string, orgId: string, existingGlobalId?: string): Promise<{ partner: Partner; globalId: string; created: boolean }> {
  const identity = await directorySession(userId, orgId);
  const { data, error } = await supabase.rpc('publish_partner_program', {
    p_partner_id: partnerId, p_program: programPayload(draft), p_expected_org_id: orgId,
    p_existing_global_id: existingGlobalId || null,
  });
  if (error) throw new StoreError(error.message || 'Could not publish the program.', false);
  await verifyDirectorySession(identity, orgId);
  const partner = await fetchDirectoryPartner(data.partner_id, userId);
  await verifyDirectorySession(identity, orgId);
  return { partner, globalId: data.global_id, created: data.created };
}

// Read-only candidates for on-device placement matching. Public directory
// data has no access to another practice's balances, notes, scores, or cases.
export function globalProgramPartner(listing: GlobalPartner): Partner {
  return {
    id: listing.id, globalPartnerId: listing.id, name: listing.name,
    organization: listing.organization, type: listing.types[0] || 'Inpatient', types: listing.types,
    city: listing.city, state: listing.state, regions: listing.regions,
    phone: listing.phone, email: listing.email, website: listing.website,
    monthlyCost: listing.monthlyCost, cashMin: 0, cashMax: listing.monthlyCost,
    insurance: listing.insurance, insuranceNetworks: listing.insuranceNetworks,
    therapies: listing.therapies, populations: listing.populations, levels: listing.levels,
    note: '', inbound: 0, outbound: 0, lastContact: '',
  };
}
