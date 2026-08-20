import { newUuid } from './cases';
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
export async function importGlobalPartner(listing: GlobalPartner): Promise<Partner> {
  const { data, error } = await supabase.rpc('import_global_partner', {
    p_global_id: listing.id,
    p_partner_id: newUuid(),
  });
  if (error) throw new StoreError(error.message || 'Could not add the program to your network.', false);
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
