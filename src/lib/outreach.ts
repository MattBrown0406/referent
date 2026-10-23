import type { Partner } from '../data';
import type { CaseContact, CaseEvent, CaseRecord, CaseStatus } from './cases';
import type { FollowUp, FollowUpKind, Touch } from './store';

// ─── Follow-up outreach — pure engine ───────────────────────────────────────
// The follow-up timeline for a new case or referral partner, the 48-hour
// rhythm after every send, what goes to the AI drafter, and the fallbacks
// when the native composers are not available. Dependency-free (type imports
// only) so scripts/outreach-test.mjs runs it in plain node.
//
// The timeline is rolling: one open step at a time. A new partner gets its
// first follow-up 24 hours after it is added; a new inquiry case keeps its
// first call (due today); any other new open case gets a follow-up in 48
// hours. Every text or email sent — and every call logged — from the outreach
// sheet closes the step it came from and sets the next one 48 hours out.
// Nothing here ever sends a message: the practitioner sends from their own
// Messages, Mail, or dialer.

export type OutreachChannel = 'text' | 'email' | 'call';

export const OUTREACH_INTERVAL_HOURS = 48;
export const NEW_PARTNER_FIRST_FOLLOW_UP_HOURS = 24;

// Follow-up kinds an outreach can close out. A consult, a waiting-on item, or
// an outcome check-in is a different job and is left alone.
const OUTREACH_KINDS: FollowUpKind[] = ['first_call', 'follow_up', 'promised_call', 'touch'];

export type OutreachTarget =
  | { kind: 'case'; caseId: string; title: string; status: CaseStatus; assignedTo?: string }
  | { kind: 'partner'; partnerId: string; organization: string; name: string; types: string[] };

export type OutreachRecipient = {
  key: string; // contact id for a case contact, partner id for a partner
  name: string;
  relationship: string;
  phone: string;
  email: string;
  contactId?: string; // case contacts only
};

export type OutreachHistory = {
  count: number; // calls, texts, and emails already logged for the target
  lastChannel: OutreachChannel | '';
  lastAt: string; // ISO; '' when there has been none
};

export type TextDraft = { channel: 'text'; body: string };
export type EmailDraft = { channel: 'email'; subject: string; body: string };
export type CallDraft = { channel: 'call'; opener: string; talkingPoints: string[]; voicemail: string };
export type OutreachDraft = TextDraft | EmailDraft | CallDraft;

// ─── Targets and recipients ─────────────────────────────────────────────────

export function caseTarget(record: Pick<CaseRecord, 'id' | 'title' | 'status' | 'assignedTo'>): OutreachTarget {
  return { kind: 'case', caseId: record.id, title: record.title, status: record.status, assignedTo: record.assignedTo };
}

export function partnerTarget(partner: Pick<Partner, 'id' | 'organization' | 'name' | 'type' | 'types'>): OutreachTarget {
  return {
    kind: 'partner',
    partnerId: partner.id,
    organization: partner.organization,
    name: partner.name,
    types: partner.types?.length ? partner.types : [partner.type],
  };
}

export function targetAnchor(target: OutreachTarget): string {
  if (target.kind === 'case') return target.title.trim() || 'this case';
  const org = target.organization.trim();
  return org && org !== '—' ? org : target.name.trim() || 'this partner';
}

export function targetMatches(item: { caseId?: string; partnerId?: string }, target: OutreachTarget): boolean {
  return target.kind === 'case'
    ? item.caseId === target.caseId
    : item.partnerId === target.partnerId && !item.caseId;
}

export function caseRecipients(contacts: CaseContact[]): OutreachRecipient[] {
  return contacts
    .filter((contact) => contact.phone.trim() || contact.email.trim())
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
    .map((contact) => ({
      key: contact.id,
      name: contact.name.trim(),
      relationship: contact.relationship.trim(),
      phone: contact.phone.trim(),
      email: contact.email.trim(),
      contactId: contact.id,
    }));
}

export function partnerRecipient(partner: Pick<Partner, 'id' | 'name' | 'phone' | 'email'>): OutreachRecipient | null {
  if (!partner.phone.trim() && !partner.email.trim()) return null;
  return { key: partner.id, name: partner.name.trim(), relationship: '', phone: partner.phone.trim(), email: partner.email.trim() };
}

// "Dr. Jane Smith" → "Jane"; "ana" → "ana". Only the first name ever leaves
// the device for drafting.
export function firstName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const honorific = /^(dr|mr|mrs|ms|mx|rev|fr|sr|prof)\.?$/i;
  return (words.length > 1 && honorific.test(words[0]) ? words[1] : words[0]).replace(/[,;:]+$/, '');
}

export function digitsForPhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function channelAvailable(recipient: OutreachRecipient | null, channel: OutreachChannel): boolean {
  if (!recipient) return false;
  return channel === 'email' ? looksLikeEmail(recipient.email) : digitsForPhone(recipient.phone).replace(/\D/g, '').length >= 7;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Wall-clock hours: a send at 3:15 PM comes due at 3:15 PM two days later,
// even across a daylight-saving change.
export function addHoursLocal(date: Date, hours: number): Date {
  const next = new Date(date);
  if (hours % 24 === 0) next.setDate(next.getDate() + hours / 24);
  else next.setHours(next.getHours() + hours);
  return next;
}

export function dueAfter(from: Date, hours: number): { dueOn: string; dueTime: string } {
  const at = addHoursLocal(from, hours);
  return { dueOn: localStamp(at), dueTime: localTime(at) };
}

function twelveHour(time: string): string {
  const [hourRaw, minuteRaw] = time.split(':');
  const hour = Number(hourRaw);
  if (!Number.isFinite(hour)) return time;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minuteRaw || '00').padStart(2, '0')} ${suffix}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Today 3:15 PM", "Tomorrow", "Sat, Oct 25 · 3:15 PM".
export function describeDue(dueOn: string, dueTime: string | undefined, now: Date): string {
  const [year, month, day] = dueOn.split('-').map(Number);
  const due = new Date(year, (month || 1) - 1, day || 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  const time = dueTime ? twelveHour(dueTime) : '';
  let label: string;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else label = `${WEEKDAYS[due.getDay()]}, ${MONTHS[due.getMonth()]} ${due.getDate()}`;
  if (!time) return label;
  return diff === 0 || diff === 1 || diff === -1 ? `${label} ${time}` : `${label} · ${time}`;
}

// ─── History ────────────────────────────────────────────────────────────────

function isChannel(kind: string): kind is OutreachChannel {
  return kind === 'call' || kind === 'text' || kind === 'email';
}

export function outreachHistory(
  target: OutreachTarget,
  caseEvents: Pick<CaseEvent, 'caseId' | 'kind' | 'occurredAt'>[],
  touches: Pick<Touch, 'partnerId' | 'kind' | 'occurredAt'>[],
): OutreachHistory {
  const entries = target.kind === 'case'
    ? caseEvents.filter((event) => event.caseId === target.caseId && isChannel(event.kind))
    : touches.filter((touch) => touch.partnerId === target.partnerId && isChannel(touch.kind));
  let lastAt = '';
  let lastChannel: OutreachChannel | '' = '';
  for (const entry of entries) {
    if (entry.occurredAt > lastAt) {
      lastAt = entry.occurredAt;
      lastChannel = entry.kind as OutreachChannel;
    }
  }
  return { count: entries.length, lastChannel, lastAt };
}

export function daysSince(iso: string, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const start = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today.getTime() - start.getTime()) / 86400000));
}

// ─── The timeline steps ─────────────────────────────────────────────────────

// A step an outreach may close: a call, follow-up, or touch. A referral's
// admit check ("did they admit?") is never closed this way — it needs its
// outcome answered — and neither is a consult, a waiting-on item, or a
// post-placement check-in.
export function isOutreachStep(followUp: FollowUp): boolean {
  return followUp.status === 'open' && !followUp.referralId && OUTREACH_KINDS.includes(followUp.kind || 'follow_up');
}

// The open step a send closes: the one it was started from when that is an
// outreach step, or else the earliest open outreach step for the same case or
// partner that is due no later than the new follow-up (a later promised call
// stays on the list).
export function followUpToComplete(
  followUps: FollowUp[],
  target: OutreachTarget,
  nextDueOn: string,
  startedFromId?: string,
): FollowUp | null {
  if (startedFromId) {
    const started = followUps.find((item) => item.id === startedFromId);
    if (started && isOutreachStep(started)) return started;
  }
  const candidates = followUps
    .filter((item) => isOutreachStep(item)
      && targetMatches(item, target)
      && item.dueOn <= nextDueOn)
    .sort((a, b) => `${a.dueOn} ${a.dueTime || ''}`.localeCompare(`${b.dueOn} ${b.dueTime || ''}`));
  return candidates[0] || null;
}

export function followUpTitle(target: OutreachTarget): string {
  return `Follow up — ${targetAnchor(target)}`;
}

// The next step, 48 hours after the send. It keeps whoever owned the step it
// replaces; otherwise it is unassigned (a case step then belongs to the case
// owner, as everywhere else).
export function nextOutreachFollowUp(params: {
  id: string;
  target: OutreachTarget;
  sentAt: Date;
  assignedTo?: string;
}): FollowUp {
  const { dueOn, dueTime } = dueAfter(params.sentAt, OUTREACH_INTERVAL_HOURS);
  const base: FollowUp = {
    id: params.id,
    title: followUpTitle(params.target),
    dueOn,
    dueTime,
    status: 'open',
    note: '',
    kind: params.target.kind === 'case' ? 'follow_up' : 'touch',
  };
  if (params.assignedTo) base.assignedTo = params.assignedTo;
  return params.target.kind === 'case'
    ? { ...base, caseId: params.target.caseId }
    : { ...base, partnerId: params.target.partnerId };
}

// First step for a partner added by hand or from the directory.
export function initialPartnerFollowUp(id: string, partner: Pick<Partner, 'id' | 'organization' | 'name' | 'type' | 'types'>, now: Date): FollowUp {
  const { dueOn, dueTime } = dueAfter(now, NEW_PARTNER_FIRST_FOLLOW_UP_HOURS);
  return {
    id,
    partnerId: partner.id,
    title: followUpTitle(partnerTarget(partner)),
    dueOn,
    dueTime,
    status: 'open',
    note: '',
    kind: 'touch',
  };
}

// First step for a new case that is not an inquiry (an inquiry already gets
// its first call today). Closed and lost cases get none.
export function initialCaseFollowUp(id: string, record: Pick<CaseRecord, 'id' | 'title' | 'status'>, now: Date): FollowUp | null {
  if (record.status === 'inquiry' || record.status === 'closed' || record.status === 'lost') return null;
  const { dueOn, dueTime } = dueAfter(now, OUTREACH_INTERVAL_HOURS);
  return {
    id,
    caseId: record.id,
    title: followUpTitle(caseTarget({ ...record, assignedTo: undefined })),
    dueOn,
    dueTime,
    status: 'open',
    note: '',
    kind: 'follow_up',
  };
}

// What to try next: a first call is a call; after that, vary the channel so a
// family is not getting the same kind of message every time, and never offer
// a channel the recipient cannot receive.
export function suggestedChannel(
  recipient: OutreachRecipient | null,
  history: OutreachHistory,
  purposeKind?: FollowUpKind,
): OutreachChannel {
  const order: OutreachChannel[] = (() => {
    if (purposeKind === 'first_call' || purposeKind === 'promised_call' || history.count === 0) return ['call', 'text', 'email'];
    if (history.lastChannel === 'call') return ['text', 'email', 'call'];
    if (history.lastChannel === 'text') return ['email', 'call', 'text'];
    return ['call', 'text', 'email'];
  })();
  return order.find((channel) => channelAvailable(recipient, channel)) || order[0];
}

// ─── Draft request (what leaves the device) ─────────────────────────────────

const CASE_STAGES: CaseStatus[] = ['inquiry', 'consult', 'deciding', 'engaged', 'intervention', 'placed', 'aftercare', 'closed', 'lost'];

export type DraftRequestBody = {
  channel: OutreachChannel;
  target: { kind: 'case'; caseId: string } | { kind: 'partner'; partnerId: string };
  recipient: { firstName: string; relationship: string; organization: string };
  sender: { firstName: string; practiceName: string };
  situation: {
    stage: string;
    partnerTypes: string[];
    attempt: number;
    lastChannel: OutreachChannel | '';
    daysSinceLastContact: number | null;
    purpose: 'first_call' | 'follow_up' | 'promised_call' | 'touch' | 'none';
  };
  instructions: string;
};

// Exactly the fields the draft-follow-up function accepts. Names are cut to
// first names; the case title, contact details, notes, and timeline never go.
export function buildDraftRequest(params: {
  channel: OutreachChannel;
  target: OutreachTarget;
  recipient: OutreachRecipient;
  senderName: string;
  practiceName: string;
  history: OutreachHistory;
  purposeKind?: FollowUpKind;
  instructions: string;
  now: Date;
}): DraftRequestBody {
  const { channel, target, recipient, history } = params;
  const purposeKind = params.purposeKind;
  const purpose = purposeKind === 'first_call' || purposeKind === 'follow_up' || purposeKind === 'promised_call' || purposeKind === 'touch'
    ? purposeKind
    : 'none';
  return {
    channel,
    target: target.kind === 'case' ? { kind: 'case', caseId: target.caseId } : { kind: 'partner', partnerId: target.partnerId },
    recipient: {
      firstName: firstName(recipient.name),
      relationship: target.kind === 'case' ? recipient.relationship.slice(0, 40) : '',
      organization: target.kind === 'partner' ? targetAnchor(target).slice(0, 80) : '',
    },
    sender: { firstName: firstName(params.senderName), practiceName: params.practiceName.trim().slice(0, 80) },
    situation: {
      stage: target.kind === 'case' && CASE_STAGES.includes(target.status) ? target.status : '',
      partnerTypes: target.kind === 'partner' ? target.types.slice(0, 6) : [],
      attempt: Math.min(20, history.count + 1),
      lastChannel: history.lastChannel,
      daysSinceLastContact: daysSince(history.lastAt, params.now),
      purpose,
    },
    instructions: params.instructions.trim().slice(0, 500),
  };
}

// ─── Without AI: a plain, discreet starting point ───────────────────────────

export function templateDraft(params: {
  channel: OutreachChannel;
  target: OutreachTarget;
  recipient: OutreachRecipient;
  senderName: string;
  practiceName: string;
  history: OutreachHistory;
}): OutreachDraft {
  const to = firstName(params.recipient.name);
  const hi = to ? `Hi ${to}` : 'Hi';
  const me = firstName(params.senderName) || 'me';
  const practice = params.practiceName.trim();
  const later = params.history.count > 0;
  if (params.target.kind === 'partner') {
    const org = targetAnchor(params.target);
    if (params.channel === 'text') {
      return { channel: 'text', body: `${hi}, this is ${me}${practice ? ` with ${practice}` : ''}. ${later ? 'Checking back in' : 'Good to connect'} — I'd like to stay in touch and learn more about ${org}. Talk soon.` };
    }
    if (params.channel === 'email') {
      return {
        channel: 'email',
        subject: later ? 'Checking back in' : 'Good to connect',
        body: `${hi},\n\n${later ? 'Following up on my last note.' : 'Thanks for connecting.'} I'd like to learn more about ${org} and stay in touch, and I'm glad to be a resource for you as well.\n\nWould a short call in the next week or two work?\n\n${me}${practice ? `\n${practice}` : ''}`,
      };
    }
    return {
      channel: 'call',
      opener: `${hi}, this is ${me}${practice ? ` with ${practice}` : ''}. Do you have a couple of minutes?`,
      talkingPoints: [`Ask what is new at ${org}`, 'Ask who is best to reach for admissions questions', 'Offer to be a resource for their team'],
      voicemail: `${hi}, it's ${me}${practice ? ` with ${practice}` : ''}. Just checking in and would love to connect. Give me a call back when you have a minute.`,
    };
  }
  if (params.channel === 'text') {
    return {
      channel: 'text',
      body: later
        ? `${hi}, it's ${me} again. Just checking in, no pressure at all. I'm here whenever you're ready to talk.`
        : `${hi}, it's ${me}, following up on our conversation. I'm here whenever you'd like to talk. — ${me}`,
    };
  }
  if (params.channel === 'email') {
    return {
      channel: 'email',
      subject: later ? 'Checking in' : 'Following up',
      body: `${hi},\n\n${later ? 'I wanted to check in again.' : 'Thank you for reaching out.'} I know this can be a lot to carry, and there is no pressure to decide anything right now. When you're ready, I'm glad to talk through what you're seeing and what options look like.\n\nYou can reply here or call me any time.\n\n${me}${practice ? `\n${practice}` : ''}`,
    };
  }
  return {
    channel: 'call',
    opener: `${hi}, it's ${me}. Is now an okay time to talk for a few minutes?`,
    talkingPoints: ['Ask how things have been since you last spoke', 'Listen first; ask what feels most urgent to them', 'Offer a clear next step and a time to talk again'],
    voicemail: `${hi}, it's ${me}. Just checking in. Call me back whenever it works for you.`,
  };
}

// ─── Sending: native composer fallbacks ─────────────────────────────────────

// iOS separates the body with '&', Android with '?'.
export function smsUrl(phone: string, body: string, platform: 'ios' | 'android' | string): string {
  const separator = platform === 'ios' ? '&' : '?';
  return `sms:${digitsForPhone(phone)}${body ? `${separator}body=${encodeURIComponent(body)}` : ''}`;
}

export function mailtoUrl(email: string, subject: string, body: string): string {
  const params = [
    subject ? `subject=${encodeURIComponent(subject)}` : '',
    body ? `body=${encodeURIComponent(body)}` : '',
  ].filter(Boolean).join('&');
  return `mailto:${email.trim()}${params ? `?${params}` : ''}`;
}

export function callScriptText(draft: CallDraft): string {
  const points = draft.talkingPoints.map((point) => `• ${point}`).join('\n');
  return `${draft.opener}\n\n${points}\n\nVoicemail:\n${draft.voicemail}`.trim();
}

// ─── Logging the outreach ───────────────────────────────────────────────────

export type CallResult = 'talked' | 'voicemail' | 'no_answer';

const CALL_RESULT_LABEL: Record<CallResult, string> = {
  talked: 'talked',
  voicemail: 'left a voicemail',
  no_answer: 'no answer',
};

export function outreachEventBody(channel: OutreachChannel, recipient: OutreachRecipient, callResult?: CallResult): string {
  const who = `${recipient.name}${recipient.relationship ? ` (${recipient.relationship})` : ''}`;
  if (channel === 'call') return `Called ${who}${callResult ? ` — ${CALL_RESULT_LABEL[callResult]}` : ''}`;
  return `${channel === 'text' ? 'Texted' : 'Emailed'} ${who} (follow-up)`;
}

// ─── Timeline view ──────────────────────────────────────────────────────────

export type TimelineEntry =
  | { kind: 'past'; id: string; channel: OutreachChannel; at: string; label: string }
  | { kind: 'next'; id: string; followUp: FollowUp; label: string };

// The last few outreach entries (oldest first) followed by the open steps in
// due order — what the case file and partner profile show.
export function outreachTimeline(
  target: OutreachTarget,
  followUps: FollowUp[],
  caseEvents: Pick<CaseEvent, 'id' | 'caseId' | 'kind' | 'body' | 'occurredAt'>[],
  touches: Pick<Touch, 'id' | 'partnerId' | 'kind' | 'note' | 'occurredAt'>[],
  pastLimit = 4,
): TimelineEntry[] {
  type PastEntry = Extract<TimelineEntry, { kind: 'past' }>;
  const past: PastEntry[] = (target.kind === 'case'
    ? caseEvents
      .filter((event) => event.caseId === target.caseId && isChannel(event.kind))
      .map((event) => ({ kind: 'past' as const, id: event.id, channel: event.kind as OutreachChannel, at: event.occurredAt, label: event.body }))
    : touches
      .filter((touch) => touch.partnerId === target.partnerId && isChannel(touch.kind))
      .map((touch) => ({
        kind: 'past' as const,
        id: touch.id,
        channel: touch.kind as OutreachChannel,
        at: touch.occurredAt,
        label: `${touch.kind === 'call' ? 'Called' : touch.kind === 'text' ? 'Texted' : 'Emailed'}${touch.note ? ` — ${touch.note}` : ''}`,
      })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-pastLimit);
  const next: TimelineEntry[] = followUps
    .filter((item) => item.status === 'open' && targetMatches(item, target))
    .sort((a, b) => `${a.dueOn} ${a.dueTime || ''}`.localeCompare(`${b.dueOn} ${b.dueTime || ''}`))
    .map((item) => ({ kind: 'next' as const, id: item.id, followUp: item, label: item.title }));
  return [...past, ...next];
}
