import { partnerTypes, stateOptions, therapyOptions } from '../data';
import type { ReferralMatch } from '../data';
import { addDaysToStamp, formatStamp, isDateStamp } from './integrity';

// ─── Placement Request: the rules ───────────────────────────────────────────
// Pure: no React, no Supabase, no side effects, so it runs in plain node
// (scripts/placement-request-test.mjs). The server side is migration
// 20261104140000_placement_requests.sql; the API calls are in
// placement-api.ts; the screens are PlacementRequestSheet.tsx and
// PlacementCompare.tsx; the center portal's inbox is
// portal/src/PlacementRequests.tsx.
//
// One de-identified request goes to up to 8 of the practice's own ranked
// programs; their answers (bed, likely to accept, earliest admit, cost)
// come back side by side.
//
// ETHICS (non-negotiable):
//   * Answers NEVER change ranking or scores. This file never imports the
//     ranker, the comparison lists programs in the practice's own ranked
//     order (rank, fixed when the request went out), and the other sorts
//     (earliest admit, lowest cost) are display only. Nothing writes back
//     to matching.
//   * Programs cannot pay to be asked or to be shown. Who is asked is the
//     practitioner's choice from their own ranked list.
//   * Nothing identifies the client until the family chooses a program and
//     the practitioner sends the packet through the existing flow. The
//     payload below never reads the client label or the budget (its input
//     type does not even carry them), and the server builds its own copy
//     from the same allow-list.

export const MAX_RECIPIENTS = 8;
export const MAX_REQUESTS_PER_DAY = 20;
export const NOTE_MAX = 300;
export const ANSWER_NOTE_MAX = 300;
export const COST_NOTE_MAX = 200;
export const MAX_DAILY_RATE = 100000;
export const CARRIER_MAX = 80;
export const DEFAULT_STAY_DAYS = 30;

export const RESPONSE_WINDOW_HOURS = [4, 24, 48] as const;
export type ResponseWindowHours = (typeof RESPONSE_WINDOW_HOURS)[number];
export const DEFAULT_RESPONSE_HOURS: ResponseWindowHours = 24;

export type AdmitWindow = 'asap' | 'this_week' | 'two_weeks' | 'flexible';
export const ADMIT_WINDOWS: { value: AdmitWindow; label: string }[] = [
  { value: 'asap', label: 'As soon as possible' },
  { value: 'this_week', label: 'Within a week' },
  { value: 'two_weeks', label: 'Within two weeks' },
  { value: 'flexible', label: 'Flexible' },
];

// The only keys a request's payload ever has (the migration's CHECK).
export const PAYLOAD_KEYS = [
  'level_of_care', 'population', 'must_haves', 'needs', 'payment', 'insurance_carrier',
  'home_state', 'location_preference', 'admit_window', 'note',
] as const;

export type PayloadPopulation = 'Any' | 'Men' | 'Women' | 'Adolescent';
export type PayloadLocation = 'No preference' | 'Close to family' | 'Away from home';

export type PlacementPayload = {
  level_of_care: string;
  population: PayloadPopulation;
  must_haves: string[];
  needs: string[];
  payment: 'insurance' | 'self_pay';
  insurance_carrier: string | null;
  home_state: string | null;
  location_preference: PayloadLocation;
  admit_window: AdmitWindow;
  note: string | null;
};

// What the payload is built from: the saved match's criteria and nothing
// else. No clientLabel, no maxBudget, no case: they cannot reach a program.
export type PayloadCriteria = Pick<ReferralMatch,
  'levelOfCare' | 'population' | 'therapies' | 'mustHaveTherapies' | 'insurance' | 'state' | 'locationPreference'
>;

const LEVELS: string[] = [...partnerTypes];
const POPULATION_NEEDS = ['Men only', 'Women only', 'Adolescent'];
const ADMIT_VALUES = ADMIT_WINDOWS.map((option) => option.value);

// Postgres btrim(): spaces only (the server trims this way).
function btrim(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^ +| +$/g, '') : '';
}

function charLength(value: string): number {
  return Array.from(value).length;
}

// ─── The note ───────────────────────────────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/;
const NUMBER_RUN = /[0-9]([ ().-]*[0-9]){6,}/;
const LINK = /(https?:|www[.])/i;

export const NOTE_PROBLEMS = {
  tooLong: 'Keep the note to 300 characters',
  email: 'Leave email addresses out of the note',
  number: 'Leave phone numbers, ID numbers and dates out of the note',
  link: 'Leave links out of the note',
  money: 'Leave money out of the note. Programs never see the family\'s budget.',
  label: 'The note mentions how this client is labeled in your workspace. Leave names and labels out.',
} as const;

// Shown under the note field, always.
export const NOTE_WARNING = 'Programs read this note. Leave out names, initials, dates of birth, phone numbers and money.';

/**
 * The first thing wrong with a request's note, or null. The same rules and
 * words as public.placement_note_problem: no email, no run of 7+ digits (a
 * phone, an ID, a date), no link, no money, and not the client's label or
 * the case title (`identifiers`, matched when 3+ characters).
 */
export function placementNoteProblem(note: string, identifiers: (string | null | undefined)[] = []): string | null {
  const text = note.trim();
  if (charLength(text) > NOTE_MAX) return NOTE_PROBLEMS.tooLong;
  if (EMAIL.test(text)) return NOTE_PROBLEMS.email;
  if (NUMBER_RUN.test(text)) return NOTE_PROBLEMS.number;
  if (LINK.test(text)) return NOTE_PROBLEMS.link;
  if (text.includes('$')) return NOTE_PROBLEMS.money;
  const lower = text.toLowerCase();
  for (const identifier of identifiers) {
    const value = btrim(identifier).toLowerCase();
    if (charLength(value) >= 3 && lower.includes(value)) return NOTE_PROBLEMS.label;
  }
  return null;
}

// ─── The payload (mirror of public.placement_request_payload) ───────────────

/** Allowed needs, first occurrence only, in the profile's order. */
function allowedNeeds(therapies: readonly unknown[] | undefined): string[] {
  const result: string[] = [];
  for (const need of therapies || []) {
    if (typeof need === 'string' && therapyOptions.includes(need) && !result.includes(need)) result.push(need);
  }
  return result;
}

/** A carrier's name only: no digits or @ (a member id never fits), no control characters, at most 80 characters. */
export function carrierNameOnly(insurance: string): string | null {
  const value = btrim(insurance);
  if (!value || value === 'Cash pay') return null;
  // eslint-disable-next-line no-control-regex
  if (charLength(value) > CARRIER_MAX || /[0-9@]/.test(value) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  return value;
}

/**
 * The de-identified summary programs see. Every value is checked against
 * the app's own choices; anything unknown is dropped, never passed
 * through. Mirrors the server exactly (the same fixture is asserted in both
 * test suites). `note` must already be trimmed and checked
 * (preparePlacementRequest does both).
 */
export function buildPlacementPayload(criteria: PayloadCriteria, admitWindow: AdmitWindow, note: string): PlacementPayload {
  const level = btrim(criteria.levelOfCare);
  const needs = allowedNeeds(criteria.therapies);
  const explicit = (criteria.mustHaveTherapies ?? ['MAT']).filter((need): need is string => typeof need === 'string');
  const required = needs.filter((need) => explicit.includes(need) || POPULATION_NEEDS.includes(need));
  let population = btrim(criteria.population) as PayloadPopulation;
  if (population !== 'Men' && population !== 'Women' && population !== 'Adolescent') {
    population = needs.includes('Adolescent') ? 'Adolescent' : needs.includes('Women only') ? 'Women' : needs.includes('Men only') ? 'Men' : 'Any';
  }
  const insurance = btrim(criteria.insurance);
  const state = btrim(criteria.state).toUpperCase();
  const location = btrim(criteria.locationPreference);
  const trimmedNote = btrim(note);
  return {
    level_of_care: LEVELS.includes(level) ? level : 'Any type',
    population,
    must_haves: required,
    needs: needs.filter((need) => !required.includes(need)),
    payment: insurance === '' || insurance === 'Cash pay' ? 'self_pay' : 'insurance',
    insurance_carrier: carrierNameOnly(insurance),
    home_state: /^[A-Z]{2}$/.test(state) ? state : null,
    location_preference: location === 'Close to family' || location === 'Away from home' ? location : 'No preference',
    admit_window: admitWindow,
    note: trimmedNote ? trimmedNote : null,
  };
}

export type PreparedRequest = { payload: PlacementPayload; note: string };

/**
 * What the review screen shows and what the app sends: the note trimmed and
 * checked first (the server checks it the same way, against the saved
 * match's label and its case's title), then the payload.
 */
export function preparePlacementRequest(input: {
  criteria: PayloadCriteria;
  admitWindow: AdmitWindow | null | undefined;
  note: string;
  identifiers: (string | null | undefined)[];
}): PreparedRequest | { problem: string } {
  const note = input.note.trim();
  const problem = placementNoteProblem(note, input.identifiers);
  if (problem) return { problem };
  if (!input.admitWindow || !ADMIT_VALUES.includes(input.admitWindow)) return { problem: 'Choose when the client could be admitted' };
  return { payload: buildPlacementPayload(input.criteria, input.admitWindow, note), note };
}

// ─── Reading a stored payload ───────────────────────────────────────────────

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A payload as the server returned it, defensively. Unknown keys never survive. */
export function payloadFromJson(value: unknown): PlacementPayload {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const population = raw.population;
  const location = raw.location_preference;
  const admit = raw.admit_window;
  return {
    level_of_care: typeof raw.level_of_care === 'string' && raw.level_of_care ? raw.level_of_care : 'Any type',
    population: population === 'Men' || population === 'Women' || population === 'Adolescent' ? population : 'Any',
    must_haves: stringList(raw.must_haves),
    needs: stringList(raw.needs),
    payment: raw.payment === 'insurance' ? 'insurance' : 'self_pay',
    insurance_carrier: typeof raw.insurance_carrier === 'string' && raw.insurance_carrier ? raw.insurance_carrier : null,
    home_state: typeof raw.home_state === 'string' && /^[A-Z]{2}$/.test(raw.home_state) ? raw.home_state : null,
    location_preference: location === 'Close to family' || location === 'Away from home' ? location : 'No preference',
    admit_window: typeof admit === 'string' && (ADMIT_VALUES as string[]).includes(admit) ? (admit as AdmitWindow) : 'flexible',
    note: typeof raw.note === 'string' && raw.note ? raw.note : null,
  };
}

// ─── What programs read ─────────────────────────────────────────────────────

export const PROGRAM_INTRO = 'A practice is looking for placement for a client and is asking a few programs at once. Here is what they shared. No names or contact details are shared until the family chooses a program.';

/** What is never shared, said plainly on the review screen. */
export const NOT_SHARED_LINE = 'Never shared with programs: the client\'s label or name, contact details, case notes, documents, or the family\'s budget.';

function stateName(code: string | null): string {
  if (!code) return '';
  return stateOptions.find((state) => state.code === code)?.name || code;
}

export function populationLabel(population: PayloadPopulation): string {
  if (population === 'Men') return 'Adult man';
  if (population === 'Women') return 'Adult woman';
  if (population === 'Adolescent') return 'Adolescent';
  return 'Not specified';
}

export function admitWindowLabel(value: AdmitWindow): string {
  return ADMIT_WINDOWS.find((option) => option.value === value)?.label || 'Flexible';
}

export function locationLine(payload: Pick<PlacementPayload, 'home_state' | 'location_preference'>): string {
  const state = stateName(payload.home_state);
  if (payload.location_preference === 'Close to family') return state ? `Close to family, in ${state}` : 'Close to family';
  if (payload.location_preference === 'Away from home') return state ? `Away from home (the family lives in ${state})` : 'Away from home';
  return state ? `Looking in ${state}` : 'Anywhere';
}

export type SummaryLine = { label: string; value: string };

/** The summary, line by line, exactly as the portal and the text message show it. */
export function placementSummaryLines(payload: PlacementPayload): SummaryLine[] {
  const lines: SummaryLine[] = [
    { label: 'Level of care', value: payload.level_of_care === 'Any type' ? 'Any level of care' : payload.level_of_care },
    { label: 'Client', value: populationLabel(payload.population) },
  ];
  if (payload.must_haves.length) lines.push({ label: 'Must have', value: payload.must_haves.join(', ') });
  if (payload.needs.length) lines.push({ label: 'Would like', value: payload.needs.join(', ') });
  lines.push({
    label: 'Payment',
    value: payload.payment === 'self_pay' ? 'Self-pay' : payload.insurance_carrier ? `${payload.insurance_carrier} insurance` : 'Insurance (carrier not shared)',
  });
  lines.push({ label: 'Location', value: locationLine(payload) });
  lines.push({ label: 'Admission', value: admitWindowLabel(payload.admit_window) });
  if (payload.note) lines.push({ label: 'Note from the practice', value: payload.note });
  return lines;
}

// "Thu, Nov 5, 3:00 PM" in the device's time zone.
export function deadlineLabel(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The practice name as a program should read it: never the unnamed default. */
export function practiceNameForMessage(name: string | null | undefined): string {
  const value = (name || '').trim();
  return value && value !== 'My Practice' ? value : '';
}

/**
 * The request summary a practitioner texts or emails to a program that
 * cannot answer in the portal (channel 'manual'). Built only from the
 * payload: no label, budget or contact details, by construction.
 */
export function placementRequestMessage(input: {
  payload: PlacementPayload;
  programName: string;
  practiceName?: string | null;
  senderName?: string | null;
  respondBy: string;
}): { text: string; subject: string; body: string } {
  const sender = (input.senderName || '').trim().split(/\s+/)[0] || '';
  const practice = practiceNameForMessage(input.practiceName);
  const who = sender && practice ? `this is ${sender} with ${practice}` : sender ? `this is ${sender}` : practice ? `this is ${practice}` : 'this is a ReferralFit practice';
  const greeting = `Hi ${input.programName.trim() || 'there'} admissions, ${who}.`;
  const intro = 'A family I am working with is looking for placement, and I am asking a few programs at once. No names yet; here is the picture:';
  const details = placementSummaryLines(input.payload).map((line) => `- ${line.label}: ${line.value}`).join('\n');
  const deadline = deadlineLabel(input.respondBy);
  const ask = `Could you let me know${deadline ? ` by ${deadline}` : ''}: do you have a bed (yes, no or waitlist), would you likely accept, your earliest admit date, and your daily rate or cost? Thank you.`;
  const body = `${greeting}\n\n${intro}\n${details}\n\n${ask}`;
  return {
    text: body,
    subject: 'Placement request: do you have a bed?',
    body: `${body}${sender ? `\n\n${sender}` : ''}${practice ? `\n${practice}` : ''}`,
  };
}

// ─── Requests and recipients as the app holds them ──────────────────────────

export type RequestStatus = 'open' | 'closed' | 'cancelled';
export type StoredRecipientStatus = 'sent' | 'viewed' | 'responded' | 'declined';
export type RecipientStatus = StoredRecipientStatus | 'expired';
export type PlacementChannel = 'portal' | 'manual';
export type BedAnswer = 'yes' | 'no' | 'waitlist';
export type AcceptAnswer = 'yes' | 'maybe' | 'no';

export type PlacementRequest = {
  id: string;
  orgId: string;
  createdBy: string | null;
  matchProfileId: string | null;
  caseId: string | null;
  payload: PlacementPayload;
  respondBy: string;
  status: RequestStatus;
  closedAt: string | null;
  createdAt: string;
};

export type PlacementRecipient = {
  id: string;
  requestId: string;
  partnerId: string | null;
  globalPartnerId: string | null;
  channel: PlacementChannel;
  /** The program's place in the practice's ranked order when the request went out. Never changed by an answer. */
  rank: number;
  programName: string;
  status: StoredRecipientStatus;
  viewedAt: string | null;
  bedAvailable: BedAnswer | null;
  likelyAccept: AcceptAnswer | null;
  earliestAdmitOn: string | null;
  dailyRate: number | null;
  costNote: string;
  note: string;
  respondedAt: string | null;
  enteredByPractice: boolean;
};

export type PlacementRequestView = { request: PlacementRequest; recipients: PlacementRecipient[] };

export const REQUEST_COLUMNS = ['id', 'org_id', 'created_by', 'match_profile_id', 'case_id', 'payload', 'respond_by', 'status', 'closed_at', 'created_at'] as const;
export const RECIPIENT_COLUMNS = [
  'id', 'request_id', 'partner_id', 'global_partner_id', 'channel', 'rank', 'program_name', 'status', 'viewed_at',
  'bed_available', 'likely_accept', 'earliest_admit_on', 'daily_rate', 'cost_note', 'note', 'responded_at', 'entered_by_practice',
] as const;

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function lowerId(value: unknown): string | null {
  return typeof value === 'string' && value ? value.toLowerCase() : null;
}

export function requestFromRow(row: Row | null | undefined): PlacementRequest | null {
  if (!row || typeof row !== 'object') return null;
  const id = lowerId(row.id);
  const respondBy = text(row.respond_by);
  const createdAt = text(row.created_at);
  if (!id || !respondBy || !createdAt) return null;
  const status = row.status === 'closed' || row.status === 'cancelled' ? row.status : 'open';
  return {
    id,
    orgId: lowerId(row.org_id) || '',
    createdBy: lowerId(row.created_by),
    matchProfileId: lowerId(row.match_profile_id),
    caseId: lowerId(row.case_id),
    payload: payloadFromJson(row.payload),
    respondBy,
    status,
    closedAt: text(row.closed_at),
    createdAt,
  };
}

export function recipientFromRow(row: Row | null | undefined): PlacementRecipient | null {
  if (!row || typeof row !== 'object') return null;
  const id = lowerId(row.id);
  const requestId = lowerId(row.request_id);
  const rank = typeof row.rank === 'number' ? row.rank : Number(row.rank);
  if (!id || !requestId || !Number.isInteger(rank)) return null;
  const status = row.status === 'viewed' || row.status === 'responded' || row.status === 'declined' ? row.status : 'sent';
  const bed = row.bed_available === 'yes' || row.bed_available === 'no' || row.bed_available === 'waitlist' ? row.bed_available : null;
  const likely = row.likely_accept === 'yes' || row.likely_accept === 'maybe' || row.likely_accept === 'no' ? row.likely_accept : null;
  const rate = typeof row.daily_rate === 'number' ? row.daily_rate : row.daily_rate == null ? null : Number(row.daily_rate);
  const admit = text(row.earliest_admit_on);
  return {
    id,
    requestId,
    partnerId: lowerId(row.partner_id),
    globalPartnerId: lowerId(row.global_partner_id),
    channel: row.channel === 'portal' ? 'portal' : 'manual',
    rank,
    programName: text(row.program_name) || 'Program',
    status,
    viewedAt: text(row.viewed_at),
    bedAvailable: bed,
    likelyAccept: likely,
    earliestAdmitOn: admit && isDateStamp(admit.slice(0, 10)) ? admit.slice(0, 10) : null,
    dailyRate: rate != null && Number.isInteger(rate) && rate > 0 ? rate : null,
    costNote: text(row.cost_note) || '',
    note: text(row.note) || '',
    respondedAt: text(row.responded_at),
    enteredByPractice: row.entered_by_practice === true,
  };
}

/** {request, recipients} as create / cancel / close return it. */
export function viewFromJson(value: unknown): PlacementRequestView | null {
  const raw = (value && typeof value === 'object' ? value : null) as { request?: Row; recipients?: Row[] } | null;
  const request = requestFromRow(raw?.request);
  if (!request) return null;
  const recipients = (Array.isArray(raw?.recipients) ? raw.recipients : [])
    .map((row) => recipientFromRow(row))
    .filter((item): item is PlacementRecipient => Boolean(item));
  return { request, recipients: sortRecipients(recipients, 'ranked') };
}

// ─── Status, progress, deadlines ────────────────────────────────────────────

function timeOf(iso: string | null | undefined): number {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? NaN : time;
}

/** The same rule as public.placement_recipient_status: unanswered past the deadline reads expired. */
export function effectiveRecipientStatus(status: StoredRecipientStatus, respondBy: string, now: Date): RecipientStatus {
  if ((status === 'sent' || status === 'viewed') && now.getTime() > timeOf(respondBy)) return 'expired';
  return status;
}

export function isAnswered(recipient: Pick<PlacementRecipient, 'status'>): boolean {
  return recipient.status === 'responded' || recipient.status === 'declined';
}

/** Programs can still answer: the request is open and its deadline has not passed. */
export function acceptingAnswers(request: Pick<PlacementRequest, 'status' | 'respondBy'>, now: Date): boolean {
  return request.status === 'open' && now.getTime() <= timeOf(request.respondBy);
}

export type RequestProgress = { answered: number; total: number; accepting: boolean; label: string };

export function requestProgress(view: PlacementRequestView, now: Date): RequestProgress {
  const total = view.recipients.length;
  const answered = view.recipients.filter(isAnswered).length;
  return {
    answered,
    total,
    accepting: acceptingAnswers(view.request, now),
    label: `${answered} of ${total} ${total === 1 ? 'program' : 'programs'} answered`,
  };
}

/** "18 h left", "45 min left", "Deadline passed". */
export function timeLeftLabel(respondBy: string, now: Date): string {
  const left = timeOf(respondBy) - now.getTime();
  if (!(left > 0)) return 'Deadline passed';
  const minutes = Math.max(1, Math.round(left / 60000));
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.round(minutes / 60)} h left`;
}

export function requestStatusLine(view: PlacementRequestView, now: Date): string {
  if (view.request.status === 'cancelled') return 'Cancelled';
  if (view.request.status === 'closed') return 'Closed: placement found';
  return acceptingAnswers(view.request, now) ? `Answers due ${deadlineLabel(view.request.respondBy)} · ${timeLeftLabel(view.request.respondBy, now)}` : 'Deadline passed';
}

export const STATUS_LABELS: Record<RecipientStatus, string> = {
  sent: 'Waiting',
  viewed: 'Seen, no answer yet',
  responded: 'Answered',
  declined: 'Declined',
  expired: 'No answer',
};

export const BED_LABELS: Record<BedAnswer, string> = { yes: 'Bed available', no: 'No bed', waitlist: 'Waitlist' };
export const ACCEPT_LABELS: Record<AcceptAnswer, string> = { yes: 'Likely to accept', maybe: 'Maybe', no: 'Not a fit' };

/** "$950/day quoted · about $28,500 for 30 days, before insurance". */
export function quotedRateLine(dailyRate: number | null, days = DEFAULT_STAY_DAYS): string {
  if (dailyRate == null || !(dailyRate > 0)) return '';
  const money = (value: number) => `$${value.toLocaleString('en-US')}`;
  return `${money(dailyRate)}/day quoted · about ${money(dailyRate * days)} for ${days} days, before insurance`;
}

/** The answer in one line: "Bed available · Likely to accept · Earliest admit Nov 6, 2026". */
export function answerLine(recipient: Pick<PlacementRecipient, 'bedAvailable' | 'likelyAccept' | 'earliestAdmitOn'>): string {
  return [
    recipient.bedAvailable ? BED_LABELS[recipient.bedAvailable] : '',
    recipient.likelyAccept ? ACCEPT_LABELS[recipient.likelyAccept] : '',
    recipient.earliestAdmitOn ? `Earliest admit ${formatStamp(recipient.earliestAdmitOn)}` : '',
  ].filter(Boolean).join(' · ');
}

// ─── The comparison order (display only) ────────────────────────────────────

export type CompareSort = 'ranked' | 'admit' | 'cost';
export const COMPARE_SORTS: { value: CompareSort; label: string }[] = [
  { value: 'ranked', label: 'Your ranking' },
  { value: 'admit', label: 'Earliest admit' },
  { value: 'cost', label: 'Lowest daily rate' },
];

type Sortable = Pick<PlacementRecipient, 'rank' | 'status' | 'earliestAdmitOn' | 'dailyRate'>;

/**
 * A new array; the input is never reordered. 'ranked' (the default) is the
 * practice's own order. 'admit' and 'cost' put answered programs with a
 * date / a rate first, then answered without, then unanswered, then
 * declined; ties keep the ranked order. Nothing here is written anywhere.
 */
export function sortRecipients<T extends Sortable>(rows: readonly T[], sort: CompareSort): T[] {
  const byRank = (a: T, b: T) => a.rank - b.rank;
  if (sort === 'ranked') return rows.slice().sort(byRank);
  const group = (row: T) => {
    if (row.status === 'declined') return 3;
    if (!isAnswered(row)) return 2;
    return (sort === 'admit' ? row.earliestAdmitOn : row.dailyRate) == null ? 1 : 0;
  };
  return rows.slice().sort((a, b) => {
    const groups = group(a) - group(b);
    if (groups) return groups;
    if (group(a) === 0) {
      if (sort === 'admit' && a.earliestAdmitOn !== b.earliestAdmitOn) return (a.earliestAdmitOn || '').localeCompare(b.earliestAdmitOn || '');
      if (sort === 'cost' && a.dailyRate !== b.dailyRate) return (a.dailyRate || 0) - (b.dailyRate || 0);
    }
    return byRank(a, b);
  });
}

// ─── Logging an answer from a call or a text ────────────────────────────────

export type AnswerDraft = {
  bed: BedAnswer | null;
  likely: AcceptAnswer | null;
  /** YYYY-MM-DD or M/D/YYYY; blank for none. */
  admitOn: string;
  /** Whole dollars; blank for none. */
  dailyRate: string;
  costNote: string;
  note: string;
};

export type AnswerFields = {
  bedAvailable: BedAnswer;
  likelyAccept: AcceptAnswer;
  earliestAdmitOn: string | null;
  dailyRate: number | null;
  costNote: string;
  note: string;
};

export function emptyAnswerDraft(): AnswerDraft {
  return { bed: null, likely: null, admitOn: '', dailyRate: '', costNote: '', note: '' };
}

export function draftFromRecipient(recipient: PlacementRecipient): AnswerDraft {
  return {
    bed: recipient.bedAvailable,
    likely: recipient.likelyAccept,
    admitOn: recipient.earliestAdmitOn || '',
    dailyRate: recipient.dailyRate ? String(recipient.dailyRate) : '',
    costNote: recipient.costNote,
    note: recipient.note,
  };
}

export const ANSWER_PROBLEMS = {
  bed: 'Choose yes, no or waitlist for a bed',
  likely: 'Choose yes, maybe or no for likely to accept',
  admitOn: 'Check the earliest admit date',
  dailyRate: 'The daily rate is whole dollars, from 1 to 100,000',
  costNote: 'Keep the cost note to 200 characters',
  note: 'Keep the note to 300 characters',
} as const;

function parseAdmitDate(input: string): string | null | undefined {
  const value = input.trim();
  if (!value) return null;
  if (isDateStamp(value)) return value;
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (!us) return undefined;
  const stamp = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return isDateStamp(stamp) ? stamp : undefined;
}

/**
 * The same checks, in the same order and words, as
 * public.placement_answer_problem. `sentOn` is the day the request went
 * out (YYYY-MM-DD, UTC as the server reads it).
 */
export function normalizeAnswerDraft(draft: AnswerDraft, sentOn: string): { fields: AnswerFields } | { problem: string } {
  if (!draft.bed) return { problem: ANSWER_PROBLEMS.bed };
  if (!draft.likely) return { problem: ANSWER_PROBLEMS.likely };
  const admitOn = parseAdmitDate(draft.admitOn);
  if (admitOn === undefined) return { problem: ANSWER_PROBLEMS.admitOn };
  if (admitOn && isDateStamp(sentOn) && (admitOn < addDaysToStamp(sentOn, -1) || admitOn > addDaysToStamp(sentOn, 366))) {
    return { problem: ANSWER_PROBLEMS.admitOn };
  }
  const rateText = draft.dailyRate.replace(/[$,\s]/g, '');
  let dailyRate: number | null = null;
  if (rateText) {
    if (!/^\d+$/.test(rateText)) return { problem: ANSWER_PROBLEMS.dailyRate };
    dailyRate = Number(rateText);
    if (dailyRate < 1 || dailyRate > MAX_DAILY_RATE) return { problem: ANSWER_PROBLEMS.dailyRate };
  }
  const costNote = draft.costNote.trim();
  if (charLength(costNote) > COST_NOTE_MAX) return { problem: ANSWER_PROBLEMS.costNote };
  const note = draft.note.trim();
  if (charLength(note) > ANSWER_NOTE_MAX) return { problem: ANSWER_PROBLEMS.note };
  return { fields: { bedAvailable: draft.bed, likelyAccept: draft.likely, earliestAdmitOn: admitOn, dailyRate, costNote, note } };
}

/** The day the request went out as the server dates it (UTC). */
export function sentOnStamp(request: Pick<PlacementRequest, 'createdAt'>): string {
  const time = timeOf(request.createdAt);
  return Number.isNaN(time) ? '' : new Date(time).toISOString().slice(0, 10);
}

/**
 * The practitioner can log an answer by hand (the server's rule): not on a
 * cancelled request, and never over an answer the program gave itself in
 * the portal. Allowed after the deadline: programs call back late.
 */
export function canLogAnswer(request: Pick<PlacementRequest, 'status'>, recipient: Pick<PlacementRecipient, 'respondedAt' | 'enteredByPractice'>): boolean {
  if (request.status === 'cancelled') return false;
  return !recipient.respondedAt || recipient.enteredByPractice;
}

/** A view with one program's row replaced (after a logged answer); the order never moves. */
export function withRecipient(view: PlacementRequestView, recipient: PlacementRecipient): PlacementRequestView {
  return { ...view, recipients: sortRecipients(view.recipients.map((item) => (item.id === recipient.id ? recipient : item)), 'ranked') };
}

// ─── Today ──────────────────────────────────────────────────────────────────

/** requestId -> the newest answer time the practitioner has already seen (ISO). */
export type PlacementSeen = Record<string, string>;

export function newAnswerCount(view: PlacementRequestView, seen: PlacementSeen): number {
  const seenAt = timeOf(seen[view.request.id]);
  return view.recipients.filter((recipient) => {
    if (!isAnswered(recipient)) return false;
    const answeredAt = timeOf(recipient.respondedAt);
    return Number.isNaN(seenAt) || (!Number.isNaN(answeredAt) && answeredAt > seenAt);
  }).length;
}

/** What "seen" should become after the practitioner opens the comparison. */
export function seenMarker(view: PlacementRequestView, now: Date): string {
  let latest = now.getTime();
  for (const recipient of view.recipients) {
    const answeredAt = timeOf(recipient.respondedAt);
    if (!Number.isNaN(answeredAt) && answeredAt > latest) latest = answeredAt;
  }
  return new Date(latest).toISOString();
}

export type PlacementTodayItem = {
  requestId: string;
  title: string;
  detail: string;
  newAnswers: number;
  accepting: boolean;
};

/**
 * Today's one card: each open request while programs can still answer,
 * and any open request with answers that arrived since the last look.
 * 'mine' shows the requests this practitioner sent; 'everyone' the team's.
 */
export function placementTodayItems(input: {
  requests: PlacementRequestView[];
  seen: PlacementSeen;
  now: Date;
  userId: string;
  scope: 'mine' | 'everyone';
  labelFor: (request: PlacementRequest) => string;
}): PlacementTodayItem[] {
  const me = input.userId.toLowerCase();
  const items: (PlacementTodayItem & { due: number })[] = [];
  for (const view of input.requests) {
    if (view.request.status !== 'open') continue;
    if (input.scope === 'mine' && view.request.createdBy && view.request.createdBy !== me) continue;
    const progress = requestProgress(view, input.now);
    const fresh = newAnswerCount(view, input.seen);
    if (!progress.accepting && fresh === 0) continue;
    const label = input.labelFor(view.request);
    items.push({
      requestId: view.request.id,
      title: `Placement request: ${progress.label}`,
      detail: [label, progress.accepting ? timeLeftLabel(view.request.respondBy, input.now) : 'Deadline passed', fresh ? `${fresh} new ${fresh === 1 ? 'answer' : 'answers'}` : '']
        .filter(Boolean).join(' · '),
      newAnswers: fresh,
      accepting: progress.accepting,
      due: timeOf(view.request.respondBy),
    });
  }
  return items
    .sort((a, b) => (b.newAnswers > 0 ? 1 : 0) - (a.newAnswers > 0 ? 1 : 0) || a.due - b.due || a.requestId.localeCompare(b.requestId))
    .map(({ due: _due, ...item }) => item);
}

/** The newest request for a saved match, if any. */
export function latestRequestForMatch(requests: PlacementRequestView[], matchProfileId: string): PlacementRequestView | null {
  const id = matchProfileId.toLowerCase();
  let best: PlacementRequestView | null = null;
  for (const view of requests) {
    if (view.request.matchProfileId !== id) continue;
    if (!best || view.request.createdAt > best.request.createdAt) best = view;
  }
  return best;
}

// ─── The server without the migration ───────────────────────────────────────

/** PGRST202 unknown function, PGRST205 / 42P01 unknown table, 42703 unknown column, 42883 unknown signature. */
export function isMissingPlacementSchema(code: string | null | undefined): boolean {
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}
