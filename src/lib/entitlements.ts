import { supabase } from './supabase';

// Entitlement state for the active workspace (Phase 2). Billing runs through
// RevenueCat IAP in the app; the backend webhook mirrors subscription state
// into org_entitlements, and this module is the single client-side read path.
//
// Gates in the product:
//   pro        — team workspace features beyond the personal org
//   directory  — the shared verified placement directory
//   benchmarks — cross-practice benchmarking analytics

export type Entitlement = 'pro' | 'directory' | 'benchmarks';

export type EntitlementState = {
  entitlements: Record<Entitlement, boolean>;
  loadedAt: string;
};

export const NO_ENTITLEMENTS: EntitlementState = {
  entitlements: { pro: false, directory: false, benchmarks: false },
  loadedAt: '',
};

export async function fetchEntitlements(): Promise<EntitlementState> {
  const { data, error } = await supabase.rpc('fetch_org_entitlements');
  if (error) throw new Error(error.message || 'Could not load subscription state.');
  const now = Date.now();
  const entitlements = { ...NO_ENTITLEMENTS.entitlements };
  for (const row of data || []) {
    const key = row.entitlement as Entitlement;
    if (!(key in entitlements)) continue;
    const expired = row.expires_at ? Date.parse(row.expires_at) <= now : false;
    if (row.active && !expired) entitlements[key] = true;
  }
  return { entitlements, loadedAt: new Date().toISOString() };
}

export function hasEntitlement(state: EntitlementState, entitlement: Entitlement): boolean {
  return state.entitlements[entitlement] === true;
}
