import { formatMoney, stateOptions } from '../data';
import type { InsuranceNetworkPreference, Partner, ReferralMatch } from '../data';

// ─── Match Packet generator ─────────────────────────────────────────────────
// Pure text builder — no React, no Supabase, no side effects — so it can be
// unit-tested in plain node (see scripts/packet-test.mjs) and reused anywhere.
// The packet is deliberately plain text (no PDF in v1) so it pastes cleanly
// into iMessage or an email body.

export type PacketAudience = 'family' | 'partner';

// Concrete fit signals, computed by the caller from the SAME inputs the
// matcher's useMemo already derives in App.tsx (network status, matched
// therapies, eligibility dimensions). Keeping this as a plain input type
// means the packet always reflects the actual match logic — no generic fluff.
export type PacketFitInput = {
  networkStatus: InsuranceNetworkPreference | null; // null when cash pay
  matchedTherapies: string[]; // needs the partner actually serves
  regionFit: boolean;
  paymentFit: boolean;
};

// De-identification heuristic (per brief): two or more capitalized words
// looks like a full name. Used to show a gentle inline reminder in the
// compose preview — advisory only, never blocks.
export function labelLooksLikeFullName(label: string): boolean {
  const capitalized = label
    .trim()
    .split(/\s+/)
    .filter((word) => /^[A-Z][a-z]/.test(word));
  return capitalized.length >= 2;
}

function stateName(code: string): string {
  if (!code || code === 'ANY') return 'Any state';
  return stateOptions.find((state) => state.code === code)?.name || code;
}

// 3-5 concrete "why this fits" bullets from the actual match dimensions.
export function buildFitReasons(matchProfile: ReferralMatch, partner: Partner, fit: PacketFitInput): string[] {
  const reasons: string[] = [];
  if (matchProfile.levelOfCare !== 'Any type') {
    reasons.push(`Provides ${matchProfile.levelOfCare} level of care`);
  }
  if (matchProfile.insurance === 'Cash pay') {
    const monthlyCost = partner.monthlyCost ?? partner.cashMax ?? partner.cashMin;
    const withinBudget = matchProfile.maxBudget != null && monthlyCost <= matchProfile.maxBudget;
    reasons.push(
      withinBudget
        ? `Monthly cash cost is ${formatMoney(monthlyCost)} — within the ${formatMoney(matchProfile.maxBudget as number)} budget`
        : `Monthly cash cost: ${formatMoney(monthlyCost)}`,
    );
  } else if (fit.networkStatus === 'In-network') {
    reasons.push(`In-network with ${matchProfile.insurance}`);
  } else if (fit.networkStatus === 'Out-of-network') {
    reasons.push(`Accepts ${matchProfile.insurance} out-of-network — verify benefits`);
  }
  if (fit.regionFit && matchProfile.state !== 'ANY') {
    reasons.push(`Serves ${stateName(matchProfile.state)}`);
  }
  for (const therapy of fit.matchedTherapies.slice(0, 2)) {
    reasons.push(`Offers ${therapy}`);
  }
  return reasons.slice(0, 5);
}

// Order the packet's two body sections by audience: the family version leads
// with the program and why it fits; the partner version leads with the client
// criteria ("Looking for placement for...").
export function buildPacket(matchProfile: ReferralMatch, partner: Partner, fitReasons: string[], audience: PacketAudience): string {
  const header = `Placement recommendation — ${matchProfile.clientLabel}`;

  const criteriaLines = [
    'CLIENT CRITERIA',
    `- Level of care: ${matchProfile.levelOfCare === 'Any type' ? 'Any level of care' : matchProfile.levelOfCare}`,
    `- Location: ${stateName(matchProfile.state)}`,
    `- Payment: ${matchProfile.insurance}`,
    matchProfile.insurance === 'Cash pay' && matchProfile.maxBudget != null
      ? `- Budget: up to ${formatMoney(matchProfile.maxBudget)}`
      : '',
    matchProfile.therapies.length ? `- Needs: ${matchProfile.therapies.join(', ')}` : '',
  ].filter(Boolean);

  const programLines = [
    'PROGRAM',
    partner.organization,
    `Contact: ${partner.name}`,
    partner.phone ? `Phone: ${partner.phone}` : '',
    partner.email ? `Email: ${partner.email}` : '',
    partner.website ? `Website: ${partner.website}` : '',
    `Location: ${partner.city}, ${partner.state}`,
  ].filter(Boolean);

  const whyLines = ['WHY THIS FITS', ...fitReasons.map((reason) => `- ${reason}`)];

  const partnerLead = [
    `Looking for placement for ${matchProfile.clientLabel}. Details below — does this look like a fit for your program?`,
    '',
  ];

  const body = audience === 'partner'
    ? [header, '', ...partnerLead, ...criteriaLines, '', ...whyLines, '', ...programLines]
    : [header, '', ...programLines, '', ...whyLines, '', ...criteriaLines];

  return [...body, '', 'Sent via ReferralFit'].join('\n');
}
