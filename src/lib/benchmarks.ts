import { StoreError } from './errors';
import { supabase } from './supabase';

// Cross-practice benchmarks (Phase 5). fetch_benchmarks() is entitlement-gated
// server-side and returns only aggregate medians with a 3-workspace
// k-anonymity floor; per-metric network values are null until enough
// practices contribute.

export type BenchmarkReport = {
  network: {
    admitRate: number | null;
    familyExperience: number | null;
    placementRate: number | null;
    medianQuote: number | null;
    contributorFloor: number;
  };
  workspace: {
    outboundReferrals: number;
    admitRate: number | null;
    familyExperience: number | null;
    casesTotal: number;
    placementRate: number | null;
    medianQuote: number | null;
  };
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function fetchBenchmarks(): Promise<BenchmarkReport> {
  const { data, error } = await supabase.rpc('fetch_benchmarks');
  if (error) throw new StoreError(error.message || 'Could not load benchmarks.', false);
  const root = (data || {}) as Record<string, Record<string, unknown>>;
  const network = root.network || {};
  const workspace = root.workspace || {};
  return {
    network: {
      admitRate: num(network.admit_rate),
      familyExperience: num(network.family_experience),
      placementRate: num(network.placement_rate),
      medianQuote: num(network.median_quote),
      contributorFloor: num(network.contributor_floor) ?? 3,
    },
    workspace: {
      outboundReferrals: num(workspace.outbound_referrals) ?? 0,
      admitRate: num(workspace.admit_rate),
      familyExperience: num(workspace.family_experience),
      casesTotal: num(workspace.cases_total) ?? 0,
      placementRate: num(workspace.placement_rate),
      medianQuote: num(workspace.median_quote),
    },
  };
}
