// Program referrals, the program's side (migration
// 20261108140000_program_referrals.sql, docs/PROGRAM_REFERRALS.md). Pure
// rules for ProgramReferrals.tsx; scripts/program-referral-test.mjs runs
// them in plain node.
//
// A program refers a family that asked for help to an interventionist on
// ReferralFit. While the practice shares progress, the program sees
// milestones and, per referral, the program the client entered. The track
// record never counts where clients went: no "returned to us" measure.

export type ReceiveStatus = 'ready' | 'not_on_referralfit' | 'not_taking';

export type TargetRow = {
  global_partner_id: string;
  display_name: string;
  city: string | null;
  state: string | null;
  types: string[] | null;
  website: string | null;
  receive_status: ReceiveStatus;
};

export type Milestone =
  | 'received' | 'family_reached' | 'consult' | 'intervention' | 'entered_treatment'
  | 'not_proceeding' | 'closed' | 'not_shared';

export type ReferralRow = {
  id: string;
  to_global_partner_id: string | null;
  to_display: string;
  family_label: string;
  created_at: string;
  shared: boolean;
  milestone: Milestone;
  reached_at: string | null;
  minutes_to_reach: number | null;
  consult: boolean | null;
  intervention: boolean | null;
  entered_treatment: boolean | null;
  placed_with: string | null;
};

export type StatsRow = {
  to_global_partner_id: string | null;
  to_display: string;
  sent: number;
  shared: number;
  reached_within_24h: number;
  median_minutes_to_reach: number | null;
  consult_or_intervention: number;
  entered_treatment: number;
  last_referred_at: string;
};

export type ReferralForm = {
  callerName: string;
  phone: string;
  email: string;
  relationship: string;
  aboutFirstName: string;
  danger: boolean;
  note: string;
  consent: boolean;
};

export type ReferralPayload = {
  p_caller_first_name: string;
  p_phone: string;
  p_email: string;
  p_relationship: string;
  p_about_first_name: string;
  p_urgency: 'none' | 'immediate_danger';
  p_note: string;
  p_consent: true;
};

export const CONSENT_TEXT =
  'The family asked us to share these details with this interventionist, and agreed we may be kept informed of their progress and placement.';

export const SAFETY_TEXT =
  'If someone is in danger right now, call 911. For a mental health or substance use crisis, call or text 988.';

export const RECEIVE_STATUS_TEXT: Record<ReceiveStatus, string> = {
  ready: 'On ReferralFit',
  not_on_referralfit: 'Not on ReferralFit yet',
  not_taking: 'Not taking referrals through ReferralFit',
};

export const MILESTONE_LABELS: Record<Milestone, string> = {
  received: 'Received',
  family_reached: 'Family reached',
  consult: 'Consult',
  intervention: 'Intervention',
  entered_treatment: 'Entered treatment',
  not_proceeding: 'Not proceeding',
  closed: 'Closed',
  not_shared: 'Progress not shared',
};

export const FIELD_LIMITS = {
  callerName: 120,
  email: 254,
  relationship: 60,
  aboutFirstName: 60,
  note: 1000,
} as const;

const EMAIL = /^[^@ ]+@[^@ ]+[.][^@ ]+$/;

export function emptyReferralForm(): ReferralForm {
  return { callerName: '', phone: '', email: '', relationship: '', aboutFirstName: '', danger: false, note: '', consent: false };
}

// The server's own rules (lead_payload_normalize and program_refer_family),
// checked first so the program reads a plain sentence instead of an error.
export function validateReferral(form: ReferralForm): { problem: string } | { payload: ReferralPayload } {
  const callerName = form.callerName.trim();
  const phone = form.phone.trim();
  const digits = phone.replace(/[^0-9]/g, '');
  const email = form.email.trim();
  const relationship = form.relationship.trim();
  const aboutFirstName = form.aboutFirstName.trim();
  const note = form.note.trim();
  if (!callerName) return { problem: 'Add the name of the family member the interventionist should call.' };
  if (callerName.length > FIELD_LIMITS.callerName) return { problem: 'Keep the name to 120 characters.' };
  if (digits.length < 10 || digits.length > 15 || phone.length > 40) return { problem: 'Add a phone number with at least 10 digits.' };
  if (email && (email.length > FIELD_LIMITS.email || !EMAIL.test(email))) return { problem: 'The email address does not look right.' };
  if (relationship.length > FIELD_LIMITS.relationship || aboutFirstName.length > FIELD_LIMITS.aboutFirstName) {
    return { problem: 'Keep the relationship and first name to 60 characters each.' };
  }
  if (note.length > FIELD_LIMITS.note) return { problem: 'Keep the note to 1,000 characters.' };
  if (!form.consent) return { problem: 'Confirm that the family asked you to share their details.' };
  return {
    payload: {
      p_caller_first_name: callerName,
      p_phone: phone,
      p_email: email,
      p_relationship: relationship,
      p_about_first_name: aboutFirstName,
      p_urgency: form.danger ? 'immediate_danger' : 'none',
      p_note: note,
      p_consent: true,
    },
  };
}

// "Entered treatment at Harbor Ridge Treatment"; every other milestone is its label.
export function milestoneText(row: Pick<ReferralRow, 'milestone' | 'placed_with'>): string {
  if (row.milestone === 'entered_treatment' && row.placed_with) return `Entered treatment at ${row.placed_with}`;
  return MILESTONE_LABELS[row.milestone] || 'Received';
}

// 45 -> "45 min"; 190 -> "3 h 10 min"; 3000 -> "2 d 2 h".
export function durationText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return '';
  const whole = Math.round(minutes);
  if (whole < 1) return 'under a minute';
  if (whole < 60) return `${whole} min`;
  if (whole < 24 * 60) {
    const hours = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(whole / (24 * 60));
  const hours = Math.floor((whole % (24 * 60)) / 60);
  return hours ? `${days} d ${hours} h` : `${days} d`;
}

// "50% (1 of 2)"; nothing shared yet reads as a dash.
export function rateText(count: number, of: number): string {
  if (!of) return '-';
  return `${Math.round((count / of) * 100)}% (${count} of ${of})`;
}

// One interventionist's track record, as the table shows it.
export function statsLine(row: StatsRow): {
  name: string; sent: string; reached: string; median: string; consult: string; treatment: string; note: string;
} {
  return {
    name: row.to_display,
    sent: String(row.sent),
    reached: rateText(row.reached_within_24h, row.shared),
    median: row.median_minutes_to_reach === null ? '-' : durationText(row.median_minutes_to_reach),
    consult: rateText(row.consult_or_intervention, row.shared),
    treatment: rateText(row.entered_treatment, row.shared),
    note: row.shared < row.sent ? `${row.sent - row.shared} not shared or closed` : '',
  };
}

export function placeText(row: Pick<TargetRow, 'city' | 'state'>): string {
  return [row.city, row.state].filter((part) => part && part.trim()).join(', ');
}

export function isMissingSchema(code: string | undefined): boolean {
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}

/**
 * A listing's website as a safe link: http(s) only, a bare host gets
 * https://, anything else (javascript:, data:, mailto:, junk) is no link.
 */
export function safeWebsiteHref(value: string | null | undefined): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  let candidate = raw;
  if (!/^https?:\/\//i.test(raw)) {
    // A scheme other than http(s) (no dot before the colon): refuse it.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:]*\./.test(raw)) return null;
    candidate = `https://${raw}`;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
