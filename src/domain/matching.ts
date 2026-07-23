import type {
  InsuranceNetworkPreference,
  Partner,
  Referral,
} from './types';

export type CashBudget =
  | { kind: 'unbounded' }
  | { kind: 'limited'; amount: number }
  | { kind: 'invalid'; reason: string };

export function parseCashBudget(input: string): CashBudget {
  const value = input.trim();
  if (!value) return { kind: 'unbounded' };

  const amount = Number(value);
  if (!Number.isFinite(amount)) return { kind: 'invalid', reason: 'Budget must be a number.' };
  if (amount <= 0) return { kind: 'invalid', reason: 'Budget must be greater than zero.' };
  return { kind: 'limited', amount };
}

export function matchesServiceRegion(partner: Partner, selectedState: string): boolean {
  if (selectedState === 'ANY') return true;
  return partner.state === selectedState
    || partner.regions.includes(selectedState)
    || partner.regions.includes('Nationwide');
}

interface PaymentRequest {
  insurance: string;
  budget?: CashBudget;
  networkPreferences?: InsuranceNetworkPreference[];
}

export function isPaymentEligible(partner: Partner, request: PaymentRequest): boolean {
  if (request.insurance === 'Cash pay') {
    const budget = request.budget;
    if (!budget || budget.kind === 'invalid' || partner.cashMin === null) return false;
    return budget.kind === 'unbounded' || partner.cashMin <= budget.amount;
  }

  const preferences = request.networkPreferences ?? [];
  const inNetwork = partner.insurance.includes(request.insurance);
  const outOfNetwork = partner.outOfNetworkInsurance.includes(request.insurance)
    || partner.outOfNetworkInsurance.includes('Any');

  return (preferences.includes('In-network') && inNetwork)
    || (preferences.includes('Out-of-network') && outOfNetwork);
}

export interface ReferralCounts {
  inbound: number;
  outbound: number;
}

export function referralCountsByPartner(
  partners: readonly Partner[],
  referrals: readonly Referral[],
): Record<string, ReferralCounts> {
  const counts: Record<string, ReferralCounts> = Object.fromEntries(
    partners.map((partner) => [partner.id, { inbound: 0, outbound: 0 }]),
  );

  for (const referral of referrals) {
    const count = counts[referral.partnerId];
    if (!count) continue;
    if (referral.direction === 'Inbound') count.inbound += 1;
    else count.outbound += 1;
  }

  return counts;
}
