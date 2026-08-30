import type { Partner, PartnerType, Referral } from '../data';
import type { CaseRecord } from './cases';
import type { FollowUp, PartnerScorecard, Touch } from './store';

export type RelationshipEvidenceCode =
  | 'RELATIONSHIP_CADENCE_OVERDUE'
  | 'PRIOR_INBOUND_REFERRER_COLD'
  | 'UNRECIPROCATED_INBOUND_VALUE'
  | 'OPEN_WAITING_ON'
  | 'OPEN_REFERRAL_HANDOFF'
  | 'FORMER_HIGH_VALUE_RELATIONSHIP'
  | 'NETWORK_SPECIALTY_GAP'
  | 'NETWORK_REGION_GAP';

export type RelationshipUrgency = 'high' | 'medium' | 'low';

export type RelationshipRecommendation = {
  partnerId?: string;
  title: string;
  reason: string;
  action: string;
  urgency: RelationshipUrgency;
  /** A deterministic priority score from 0–100; it is not a paid ranking. */
  score: number;
  evidenceCodes: RelationshipEvidenceCode[];
};

export type RelationshipIntelligenceInput = {
  /** YYYY-MM-DD or an ISO timestamp. Required so results never depend on wall-clock time. */
  asOf: string;
  partners: Partner[];
  referrals: Referral[];
  touches: Touch[];
  followUps: FollowUp[];
  scorecards: Record<string, PartnerScorecard>;
  cases: CaseRecord[];
};

type Signal = {
  code: RelationshipEvidenceCode;
  score: number;
  reason: string;
};

type Candidate = RelationshipRecommendation & { sortKey: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const PARTNER_TYPES: PartnerType[] = [
  'Inpatient', 'IOP / PHP', 'Interventionist', 'Therapist', 'Sober Living', 'Detox',
];
const EVIDENCE_ORDER: RelationshipEvidenceCode[] = [
  'OPEN_REFERRAL_HANDOFF',
  'OPEN_WAITING_ON',
  'PRIOR_INBOUND_REFERRER_COLD',
  'RELATIONSHIP_CADENCE_OVERDUE',
  'UNRECIPROCATED_INBOUND_VALUE',
  'FORMER_HIGH_VALUE_RELATIONSHIP',
  'NETWORK_SPECIALTY_GAP',
  'NETWORK_REGION_GAP',
];

const STATE_NAMES: Record<string, string> = Object.fromEntries([
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
] as [string, string][]);

function utcDay(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text;
  const timestamp = Date.parse(dateOnly);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS;
}

function daysBetween(earlier: string, asOfDay: number): number | null {
  const day = utcDay(earlier);
  return day == null ? null : Math.max(0, Math.floor(asOfDay - day));
}

function newestDate(values: Array<string | null | undefined>): string | null {
  let newest: { value: string; day: number } | null = null;
  for (const value of values) {
    if (!value) continue;
    const day = utcDay(value);
    if (day != null && (!newest || day > newest.day)) newest = { value, day };
  }
  return newest?.value ?? null;
}

function urgencyFor(score: number): RelationshipUrgency {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

function partnerLabel(partner: Partner): string {
  return partner.organization.trim() || partner.name.trim() || 'this partner';
}

function signalTitle(signal: RelationshipEvidenceCode, partner: Partner): string {
  const label = partnerLabel(partner);
  switch (signal) {
    case 'OPEN_REFERRAL_HANDOFF': return `Close the referral handoff with ${label}`;
    case 'OPEN_WAITING_ON': return `Resolve what is pending with ${label}`;
    case 'PRIOR_INBOUND_REFERRER_COLD': return `Reconnect with prior referrer ${label}`;
    case 'FORMER_HIGH_VALUE_RELATIONSHIP': return `Re-engage former high-value relationship ${label}`;
    case 'RELATIONSHIP_CADENCE_OVERDUE': return `Check in with ${label}`;
    case 'UNRECIPROCATED_INBOUND_VALUE': return `Show appreciation to ${label}`;
    default: return `Strengthen the relationship with ${label}`;
  }
}

function actionFor(codes: RelationshipEvidenceCode[], followUp?: FollowUp): string {
  if (codes.includes('OPEN_REFERRAL_HANDOFF')) {
    return 'Confirm the handoff status, answer any open questions, and record the next step.';
  }
  if (codes.includes('OPEN_WAITING_ON')) {
    const detail = followUp?.waitingOn?.trim();
    return detail
      ? `Check on ${detail}, then document the response and next step.`
      : 'Check on the pending item, then document the response and next step.';
  }
  if (codes.includes('UNRECIPROCATED_INBOUND_VALUE')) {
    return 'Send a genuine thank-you and offer a useful resource or introduction with no expectation of referrals in return.';
  }
  if (codes.includes('FORMER_HIGH_VALUE_RELATIONSHIP')) {
    return 'Reach out personally, acknowledge the past relationship, and ask what would be useful to them now.';
  }
  return 'Send a personal check-in focused on how they are doing and where you can be helpful.';
}

function recommendationForPartner(
  partner: Partner,
  signals: Signal[],
  followUp: FollowUp | undefined,
): Candidate | null {
  if (!signals.length) return null;
  const deduped = new Map<RelationshipEvidenceCode, Signal>();
  for (const signal of signals) {
    const current = deduped.get(signal.code);
    if (!current || signal.score > current.score) deduped.set(signal.code, signal);
  }
  const ordered = [...deduped.values()].sort((a, b) => {
    const scoreDifference = b.score - a.score;
    return scoreDifference || EVIDENCE_ORDER.indexOf(a.code) - EVIDENCE_ORDER.indexOf(b.code);
  });
  const primary = ordered[0];
  const score = Math.min(100, primary.score + Math.min(10, (ordered.length - 1) * 5));
  const evidenceCodes = [...deduped.keys()].sort(
    (a, b) => EVIDENCE_ORDER.indexOf(a) - EVIDENCE_ORDER.indexOf(b),
  );
  return {
    partnerId: partner.id,
    title: signalTitle(primary.code, partner),
    reason: ordered.map((signal) => signal.reason).join(' '),
    action: actionFor(evidenceCodes, followUp),
    urgency: urgencyFor(score),
    score,
    evidenceCodes,
    sortKey: `partner:${partner.id}`,
  };
}

function latestPartnerActivity(
  partner: Partner,
  touches: Touch[],
  referrals: Referral[],
  scorecard: PartnerScorecard | undefined,
): string | null {
  return newestDate([
    partner.lastContact,
    ...touches.map((touch) => touch.occurredAt),
    ...referrals.map((referral) => referral.date),
    scorecard?.lastReferralOn,
  ]);
}

function relationshipSignals(
  partner: Partner,
  partnerReferrals: Referral[],
  partnerTouches: Touch[],
  openFollowUps: FollowUp[],
  scorecard: PartnerScorecard | undefined,
  asOfDay: number,
): { signals: Signal[]; primaryFollowUp?: FollowUp } {
  const signals: Signal[] = [];
  const referralHandoff = openFollowUps.find((item) => item.kind === 'referral_handshake');
  const waitingOn = openFollowUps.find((item) => item.kind === 'waiting_on');
  const primaryFollowUp = referralHandoff || waitingOn || openFollowUps[0];

  if (referralHandoff) {
    const daysOverdue = daysBetween(referralHandoff.dueOn, asOfDay) ?? 0;
    signals.push({
      code: 'OPEN_REFERRAL_HANDOFF',
      score: Math.min(100, 95 + Math.min(5, daysOverdue)),
      reason: daysOverdue > 0
        ? `A referral handoff follow-up is open and ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue.`
        : 'A referral handoff follow-up is still open.',
    });
  }
  if (waitingOn) {
    const detail = waitingOn.waitingOn?.trim();
    signals.push({
      code: 'OPEN_WAITING_ON',
      score: 90,
      reason: detail ? `The relationship is waiting on ${detail}.` : 'A waiting-on follow-up remains open.',
    });
  }

  const contactDate = newestDate([partner.lastContact, ...partnerTouches.map((touch) => touch.occurredAt)]);
  const daysSinceContact = contactDate ? daysBetween(contactDate, asOfDay) : null;
  const cadence = partner.touchCadenceDays;
  if (cadence && cadence > 0 && daysSinceContact != null && daysSinceContact >= cadence) {
    const overdue = daysSinceContact - cadence;
    signals.push({
      code: 'RELATIONSHIP_CADENCE_OVERDUE',
      score: Math.min(70, 55 + Math.ceil(overdue / 7)),
      reason: `The latest recorded contact was ${daysSinceContact} days ago, ${overdue} day${overdue === 1 ? '' : 's'} beyond the ${cadence}-day cadence.`,
    });
  }

  const inboundReferrals = partnerReferrals.filter((referral) => referral.direction === 'Inbound');
  const latestInbound = newestDate(inboundReferrals.map((referral) => referral.date));
  const coldThreshold = Math.max(90, (cadence || 45) * 2);
  if (inboundReferrals.length > 0 && latestInbound && daysSinceContact != null
      && daysSinceContact >= coldThreshold && (daysBetween(latestInbound, asOfDay) ?? 0) >= 60) {
    signals.push({
      code: 'PRIOR_INBOUND_REFERRER_COLD',
      score: 78,
      reason: `They previously sent ${inboundReferrals.length} inbound referral${inboundReferrals.length === 1 ? '' : 's'}, but the relationship has had no recorded contact for ${daysSinceContact} days.`,
    });
  }

  const hasReferralRows = partnerReferrals.length > 0;
  const inbound = hasReferralRows ? inboundReferrals.length : Math.max(0, partner.inbound || 0);
  const outbound = hasReferralRows
    ? partnerReferrals.filter((referral) => referral.direction === 'Outbound').length
    : Math.max(0, partner.outbound || 0);
  if (inbound >= 2 && inbound - outbound >= 2) {
    signals.push({
      code: 'UNRECIPROCATED_INBOUND_VALUE',
      score: 50,
      reason: `They have contributed ${inbound} inbound referrals versus ${outbound} outbound connections; this is a prompt for gratitude and useful value, not an obligation or exchange.`,
    });
  }

  if (scorecard) {
    const strongHistory = scorecard.referralsSent >= 5
      || scorecard.admits >= 3
      || (scorecard.referralsSent >= 3 && (scorecard.avgFamilyExperience ?? 0) >= 4.5);
    const activityDate = latestPartnerActivity(partner, partnerTouches, partnerReferrals, scorecard);
    const inactiveDays = activityDate ? daysBetween(activityDate, asOfDay) : null;
    if (strongHistory && inactiveDays != null && inactiveDays >= 120) {
      signals.push({
        code: 'FORMER_HIGH_VALUE_RELATIONSHIP',
        score: 72,
        reason: `Past results show ${scorecard.referralsSent} referrals sent and ${scorecard.admits} admits, while the latest recorded activity was ${inactiveDays} days ago.`,
      });
    }
  }

  return { signals, primaryFollowUp };
}

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i').test(text);
}

function caseDemand(record: CaseRecord): { specialty: PartnerType; state: string } | null {
  if (record.status === 'closed' || record.status === 'lost') return null;
  const text = `${record.title} ${record.summary} ${record.leadSourceDetail}`;
  const specialty = PARTNER_TYPES.find((type) => containsPhrase(text, type));
  if (!specialty) return null;
  const state = Object.entries(STATE_NAMES).find(([code, name]) =>
    containsPhrase(text, name) || new RegExp(`(?:^|[^A-Za-z])${code}(?:$|[^A-Za-z])`).test(text),
  )?.[0];
  return state ? { specialty, state } : null;
}

function networkGapCandidates(partners: Partner[], cases: CaseRecord[]): Candidate[] {
  const demandCounts = new Map<string, { specialty: PartnerType; state: string; count: number }>();
  for (const record of cases) {
    const demand = caseDemand(record);
    if (!demand) continue;
    const key = `${demand.specialty}|${demand.state}`;
    const existing = demandCounts.get(key);
    demandCounts.set(key, { ...demand, count: (existing?.count ?? 0) + 1 });
  }

  const gaps: Candidate[] = [];
  for (const demand of demandCounts.values()) {
    if (demand.count < 2) continue;
    const specialtyCovered = partners.some((partner) =>
      (partner.types?.length ? partner.types : [partner.type]).includes(demand.specialty));
    const regionCovered = partners.some((partner) =>
      partner.state.toUpperCase() === demand.state
      || partner.regions.some((region) => region.toLowerCase() === STATE_NAMES[demand.state].toLowerCase()));
    if (specialtyCovered && regionCovered) continue;

    const evidenceCodes: RelationshipEvidenceCode[] = [];
    if (!specialtyCovered) evidenceCodes.push('NETWORK_SPECIALTY_GAP');
    if (!regionCovered) evidenceCodes.push('NETWORK_REGION_GAP');
    const location = STATE_NAMES[demand.state];
    const score = Math.min(65, 56 + demand.count);
    gaps.push({
      title: `Build a ${demand.specialty} connection in ${location}`,
      reason: `${demand.count} open cases mention ${demand.specialty} needs in ${location}, and the current network does not cover ${evidenceCodes.length === 2 ? 'that specialty or region' : evidenceCodes[0] === 'NETWORK_SPECIALTY_GAP' ? 'that specialty' : 'that region'}.`,
      action: 'Research and introduce yourself to a qualified provider that fits the documented need; evaluate fit on service quality and client needs only.',
      urgency: urgencyFor(score),
      score,
      evidenceCodes,
      sortKey: `gap:${demand.specialty}:${demand.state}`,
    });
  }
  return gaps;
}

/**
 * Produces at most five explainable relationship actions. Recommendations are
 * ordered only by documented relationship/case signals, never payment, fees,
 * sponsorship, or an expectation that referrals be reciprocated.
 */
export function recommendRelationshipActions(
  input: RelationshipIntelligenceInput,
): RelationshipRecommendation[] {
  const asOfDay = utcDay(input.asOf);
  if (asOfDay == null) throw new Error('Relationship intelligence requires a valid asOf date.');

  const candidates: Candidate[] = [];
  for (const partner of input.partners) {
    const referrals = input.referrals.filter((item) => item.partnerId === partner.id);
    const touches = input.touches.filter((item) => item.partnerId === partner.id);
    const followUps = input.followUps
      .filter((item) => item.partnerId === partner.id && item.status === 'open')
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id));
    const { signals, primaryFollowUp } = relationshipSignals(
      partner, referrals, touches, followUps, input.scorecards[partner.id], asOfDay,
    );
    const candidate = recommendationForPartner(partner, signals, primaryFollowUp);
    if (candidate) candidates.push(candidate);
  }
  candidates.push(...networkGapCandidates(input.partners, input.cases));

  return candidates
    .sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey))
    .slice(0, 5)
    .map(({ sortKey: _sortKey, ...recommendation }) => recommendation);
}
