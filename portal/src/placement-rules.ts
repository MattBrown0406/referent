// Placement requests in the center portal: what a program reads and how its
// answer is checked. Mirrors the app (src/lib/placement-requests.ts) and the
// server (supabase/migrations/20261104140000_placement_requests.sql);
// scripts/placement-request-test.mjs checks that all three agree.
//
// A practice asks a few programs at once, with one de-identified summary.
// Nothing here identifies the client, and a program never learns where it
// ranked or who else was asked. Answers never change any ranking.

export type AdmitWindow = 'asap' | 'this_week' | 'two_weeks' | 'flexible';
export type BedAnswer = 'yes' | 'no' | 'waitlist';
export type AcceptAnswer = 'yes' | 'maybe' | 'no';
export type CenterStatus = 'sent' | 'viewed' | 'responded' | 'declined' | 'expired';

export type Payload = {
  level_of_care: string;
  population: 'Any' | 'Men' | 'Women' | 'Adolescent';
  must_haves: string[];
  needs: string[];
  payment: 'insurance' | 'self_pay';
  insurance_carrier: string | null;
  home_state: string | null;
  location_preference: 'No preference' | 'Close to family' | 'Away from home';
  admit_window: AdmitWindow;
  note: string | null;
};

// One row of public.list_center_placement_requests.
export type CenterRequestRow = {
  recipient_id: string;
  request_id: string;
  practice_name: string;
  payload: unknown;
  sent_at: string;
  respond_by: string;
  request_status: 'open' | 'closed' | 'cancelled';
  status: CenterStatus;
  can_respond: boolean;
  viewed_at: string | null;
  responded_at: string | null;
  bed_available: BedAnswer | null;
  likely_accept: AcceptAnswer | null;
  earliest_admit_on: string | null;
  daily_rate: number | null;
  cost_note: string | null;
  note: string | null;
};

export const PROGRAM_INTRO = 'A practice is looking for placement for a client and is asking a few programs at once. Here is what they shared. No names or contact details are shared until the family chooses a program.';

export const ADMIT_WINDOWS: { value: AdmitWindow; label: string }[] = [
  { value: 'asap', label: 'As soon as possible' },
  { value: 'this_week', label: 'Within a week' },
  { value: 'two_weeks', label: 'Within two weeks' },
  { value: 'flexible', label: 'Flexible' },
];

export const BED_CHOICES: { value: BedAnswer; label: string }[] = [
  { value: 'yes', label: 'Yes, a bed is available' },
  { value: 'no', label: 'No bed right now' },
  { value: 'waitlist', label: 'Waitlist' },
];

export const ACCEPT_CHOICES: { value: AcceptAnswer; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'no', label: 'No, not a fit' },
];

export const STATUS_LABELS: Record<CenterStatus, string> = {
  sent: 'New',
  viewed: 'Opened',
  responded: 'Answered',
  declined: 'You said not a fit',
  expired: 'Closed',
};

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii',
  ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const ADMIT_VALUES = ADMIT_WINDOWS.map((option) => option.value) as string[];

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function payloadFromJson(value: unknown): Payload {
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
    admit_window: typeof admit === 'string' && ADMIT_VALUES.includes(admit) ? (admit as AdmitWindow) : 'flexible',
    note: typeof raw.note === 'string' && raw.note ? raw.note : null,
  };
}

function populationLabel(population: Payload['population']): string {
  if (population === 'Men') return 'Adult man';
  if (population === 'Women') return 'Adult woman';
  if (population === 'Adolescent') return 'Adolescent';
  return 'Not specified';
}

function locationLine(payload: Payload): string {
  const state = payload.home_state ? STATE_NAMES[payload.home_state] || payload.home_state : '';
  if (payload.location_preference === 'Close to family') return state ? `Close to family, in ${state}` : 'Close to family';
  if (payload.location_preference === 'Away from home') return state ? `Away from home (the family lives in ${state})` : 'Away from home';
  return state ? `Looking in ${state}` : 'Anywhere';
}

/** The summary line by line: the same words the app's review screen showed the practice. */
export function summaryLines(payload: Payload): { label: string; value: string }[] {
  const lines = [
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
  lines.push({ label: 'Admission', value: ADMIT_WINDOWS.find((option) => option.value === payload.admit_window)?.label || 'Flexible' });
  if (payload.note) lines.push({ label: 'Note from the practice', value: payload.note });
  return lines;
}

/** "18 h left", "45 min left", or "" once the deadline passed. */
export function timeLeft(respondBy: string, now: Date = new Date()): string {
  const left = Date.parse(respondBy) - now.getTime();
  if (!(left > 0)) return '';
  const minutes = Math.max(1, Math.round(left / 60000));
  return minutes < 60 ? `${minutes} min left` : `${Math.round(minutes / 60)} h left`;
}

/** Why a request can no longer be answered, in plain words; '' while it can. */
export function closedReason(row: Pick<CenterRequestRow, 'can_respond' | 'request_status'>): string {
  if (row.can_respond) return '';
  if (row.request_status === 'cancelled') return 'Closed: the practice no longer needs this placement.';
  if (row.request_status === 'closed') return 'Closed: the practice found a placement.';
  return 'Closed: the time to answer has passed.';
}

export function deadlineText(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ─── The answer form ─────────────────────────────────────────────────────────

export type AnswerForm = {
  bed: BedAnswer | '';
  likely: AcceptAnswer | '';
  admitOn: string;
  dailyRate: string;
  costNote: string;
  note: string;
};

export type AnswerPayload = {
  p_bed_available: BedAnswer;
  p_likely_accept: AcceptAnswer;
  p_earliest_admit_on: string | null;
  p_daily_rate: number | null;
  p_cost_note: string;
  p_note: string;
};

/** The answer fields of a row (or of an answer link's own answer). */
export type AnswerFields = Pick<CenterRequestRow, 'bed_available' | 'likely_accept' | 'earliest_admit_on' | 'daily_rate' | 'cost_note' | 'note'>;

export function formFromRow(row: AnswerFields | null): AnswerForm {
  return {
    bed: row?.bed_available || '',
    likely: row?.likely_accept || '',
    admitOn: row?.earliest_admit_on ? row.earliest_admit_on.slice(0, 10) : '',
    dailyRate: row?.daily_rate ? String(row.daily_rate) : '',
    costNote: row?.cost_note || '',
    note: row?.note || '',
  };
}

const STAMP = /^\d{4}-\d{2}-\d{2}$/;

function isDateStamp(value: string): boolean {
  if (!STAMP.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(stamp: string, days: number): string {
  const date = new Date(`${stamp}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The day the request went out as the server dates it (UTC). */
export function sentOnStamp(sentAt: string): string {
  const time = Date.parse(sentAt);
  return Number.isNaN(time) ? '' : new Date(time).toISOString().slice(0, 10);
}

/** The same checks and words as public.placement_answer_problem. */
export function validateAnswer(form: AnswerForm, sentOn: string): { payload: AnswerPayload } | { problem: string } {
  if (!form.bed) return { problem: 'Choose yes, no or waitlist for a bed' };
  if (!form.likely) return { problem: 'Choose yes, maybe or no for likely to accept' };
  let admitOn: string | null = null;
  const typed = form.admitOn.trim();
  if (typed) {
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(typed);
    const stamp = us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : typed;
    if (!isDateStamp(stamp)) return { problem: 'Check the earliest admit date' };
    if (isDateStamp(sentOn) && (stamp < addDays(sentOn, -1) || stamp > addDays(sentOn, 366))) return { problem: 'Check the earliest admit date' };
    admitOn = stamp;
  }
  const rateText = form.dailyRate.replace(/[$,\s]/g, '');
  let dailyRate: number | null = null;
  if (rateText) {
    if (!/^\d+$/.test(rateText)) return { problem: 'The daily rate is whole dollars, from 1 to 100,000' };
    dailyRate = Number(rateText);
    if (dailyRate < 1 || dailyRate > 100000) return { problem: 'The daily rate is whole dollars, from 1 to 100,000' };
  }
  const costNote = form.costNote.trim();
  if (Array.from(costNote).length > 200) return { problem: 'Keep the cost note to 200 characters' };
  const note = form.note.trim();
  if (Array.from(note).length > 300) return { problem: 'Keep the note to 300 characters' };
  return { payload: { p_bed_available: form.bed, p_likely_accept: form.likely, p_earliest_admit_on: admitOn, p_daily_rate: dailyRate, p_cost_note: costNote, p_note: note } };
}

// ─── Answer links (/a#<token>, signed out) ───────────────────────────────────
// Migration 20261108130000: a program the practice asked by hand opens the
// request from a link in the text or email and answers it itself.

/** The token in the page's fragment: 64 lowercase hex characters, else null. */
export function answerLinkTokenFrom(hash: string): string | null {
  const token = hash.replace(/^#/, '').trim();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

/** public.public_placement_answer_open / _respond, as the page reads it. */
export type AnswerLinkView = {
  programName: string;
  practiceName: string;
  /** Null once the request is closed or a week past due: the page shows only its status. */
  payload: Payload | null;
  sentAt: string;
  respondBy: string;
  requestStatus: CenterRequestRow['request_status'];
  status: CenterStatus;
  canRespond: boolean;
  /** The program's own answer, or null (an answer the practice logged reads as none). */
  answer: (AnswerFields & { responded_at: string }) | null;
};

const CENTER_STATUSES: CenterStatus[] = ['sent', 'viewed', 'responded', 'declined', 'expired'];

function stringOr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The server's JSON, or null when it is not a view (a link that does not work). */
export function answerLinkViewFromJson(value: unknown): AnswerLinkView | null {
  const row = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') return null;
  const sentAt = stringOr(row.sent_at);
  const respondBy = stringOr(row.respond_by);
  if (!sentAt || !respondBy) return null;
  const requestStatus = row.request_status === 'closed' || row.request_status === 'cancelled' ? row.request_status : 'open';
  const status = CENTER_STATUSES.includes(row.status as CenterStatus) ? (row.status as CenterStatus) : 'sent';
  const raw = (row.answer && typeof row.answer === 'object' ? row.answer : null) as Record<string, unknown> | null;
  const bed = BED_CHOICES.find((choice) => choice.value === raw?.bed_available)?.value ?? null;
  const likely = ACCEPT_CHOICES.find((choice) => choice.value === raw?.likely_accept)?.value ?? null;
  const answer = raw && typeof raw.responded_at === 'string' && bed && likely
    ? {
        responded_at: raw.responded_at,
        bed_available: bed,
        likely_accept: likely,
        earliest_admit_on: typeof raw.earliest_admit_on === 'string' ? raw.earliest_admit_on : null,
        daily_rate: typeof raw.daily_rate === 'number' ? raw.daily_rate : null,
        cost_note: stringOr(raw.cost_note) || null,
        note: stringOr(raw.note) || null,
      }
    : null;
  return {
    programName: stringOr(row.program_name).trim() || 'your program',
    practiceName: stringOr(row.practice_name).trim() || 'A ReferralFit practice',
    payload: row.payload && typeof row.payload === 'object' && Object.keys(row.payload).length ? payloadFromJson(row.payload) : null,
    sentAt,
    respondBy,
    requestStatus,
    status,
    canRespond: row.can_respond === true,
    answer,
  };
}

/** An answer already given, in one line: "Bed: Waitlist; likely to accept: Maybe; earliest admit 2026-11-12; $950 a day". */
export function answerSummary(answer: AnswerFields | null): string {
  if (!answer) return '';
  const parts = [
    `Bed: ${BED_CHOICES.find((choice) => choice.value === answer.bed_available)?.label || 'not given'}`,
    `likely to accept: ${ACCEPT_CHOICES.find((choice) => choice.value === answer.likely_accept)?.label || 'not given'}`,
  ];
  if (answer.earliest_admit_on) parts.push(`earliest admit ${answer.earliest_admit_on.slice(0, 10)}`);
  if (answer.daily_rate) parts.push(`$${answer.daily_rate.toLocaleString('en-US')} a day`);
  return parts.join('; ');
}

/** PGRST202 / PGRST205 / 42P01 / 42703 / 42883: the server does not have placement requests yet. */
export function isMissingSchema(code: string | undefined): boolean {
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}
