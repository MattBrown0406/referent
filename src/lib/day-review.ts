// Day review: the rules on the phone. The day-review Edge Function reads the
// practitioner's notes and returns what it found (FoundItem); this file
// matches each item to the practice's own cases and partners, catches what
// is already in ReferralFit, and turns approved rows into the ordinary
// writes the app already makes. Pure: no network, no React, so
// scripts/day-review-test.mjs covers all of it. See docs/DAY_REVIEW.md.
//
// The model never sees the workspace: it returns names, phones and
// organizations, and the matching happens here. Nothing is saved until the
// practitioner approves a row.

import {
  addCandidates,
  cleanContact,
  cleanEmail,
  IMPORT_TYPES,
  isReady as importReady,
  importRows,
  orgKey,
  phoneKey,
  type DirectoryIndex,
  type ImportCandidate,
  type ImportRow,
  type ImportType,
  type NetworkPartnerLike,
} from './partner-import';

// ─── What the function returns (supabase/functions/day-review/review.ts) ────

export const REVIEW_KINDS = ['new_lead', 'case_note', 'partner_note', 'follow_up', 'referral', 'new_partner'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type FoundItem = {
  kind: ReviewKind;
  summary: string;
  channel: 'call' | 'meeting' | 'text' | 'email' | 'unknown';
  personName: string;
  aboutFirstName: string;
  aboutRelationship: string;
  organization: string;
  phone: string;
  email: string;
  dueDate: string;
  direction: 'sent' | 'received' | '';
  partnerType: ImportType | '';
  regarding: 'family' | 'professional' | 'none';
  urgent: boolean;
  missed: boolean;
  evidence: string;
  verified: boolean;
};

const CHANNELS = ['call', 'meeting', 'text', 'email', 'unknown'] as const;

const text = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The function's answer, read defensively: anything malformed is dropped, never trusted. */
export function readFoundItems(value: unknown): FoundItem[] {
  if (!Array.isArray(value)) return [];
  const out: FoundItem[] = [];
  for (const raw of value.slice(0, 30)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (!(REVIEW_KINDS as readonly unknown[]).includes(item.kind)) continue;
    const summary = text(item.summary, 240);
    if (!summary) continue;
    const partnerType = (IMPORT_TYPES as readonly unknown[]).includes(item.partnerType) ? item.partnerType as ImportType : '';
    out.push({
      kind: item.kind as ReviewKind,
      summary,
      channel: (CHANNELS as readonly unknown[]).includes(item.channel) ? item.channel as FoundItem['channel'] : 'unknown',
      personName: text(item.personName, 80),
      aboutFirstName: text(item.aboutFirstName, 80),
      aboutRelationship: text(item.aboutRelationship, 40),
      organization: text(item.organization, 120),
      phone: text(item.phone, 40),
      email: cleanEmail(item.email),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.dueDate || '')) ? String(item.dueDate) : '',
      direction: item.direction === 'received' ? 'received' : item.direction === 'sent' ? 'sent' : '',
      partnerType,
      regarding: item.regarding === 'family' || item.regarding === 'professional' ? item.regarding : 'none',
      urgent: item.urgent === true,
      missed: item.missed === true,
      evidence: text(item.evidence, 300),
      verified: item.verified === true,
    });
  }
  return out;
}

// ─── The workspace, as much of it as matching needs ────────────────────────

export type CaseLike = { id: string; title: string; status: string; updatedAt: string };
export type ContactLike = { caseId: string; name: string; phone: string; email: string };
export type FollowUpLike = { caseId?: string; partnerId?: string; title: string; dueOn: string; status: string };
export type ReferralLike = { partnerId: string; direction: 'Inbound' | 'Outbound'; date: string; caseId?: string };

export type Workspace = {
  cases: CaseLike[];
  contacts: ContactLike[];
  partners: NetworkPartnerLike[];
  followUps: FollowUpLike[];
  referrals: ReferralLike[];
  directory: DirectoryIndex | null;
};

const CLOSED = new Set(['closed', 'lost']);

// ─── Names ─────────────────────────────────────────────────────────────────

/** Letters and digits only, lower case, accents dropped. */
export function comparable(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Words that say nothing about who a person is.
const FILLER = new Set(['the', 'family', 'mr', 'mrs', 'ms', 'dr', 'and', 'of', 'her', 'his', 'their', 'mom', 'dad', 'son', 'daughter', 'wife', 'husband']);

function nameWords(value: string): string[] {
  return comparable(value).split(' ').filter((word) => word.length >= 2 && !FILLER.has(word));
}

// ─── Matching cases ────────────────────────────────────────────────────────

export type Matches = { ids: string[]; sure: boolean };

/**
 * The cases an item is about. Sure: the same phone or email as a contact on
 * the case, or the same first and last name. Otherwise a likely match: the
 * same first name as a contact, or a name word in the case title.
 */
export function matchCases(item: Pick<FoundItem, 'personName' | 'aboutFirstName' | 'phone' | 'email'>, workspace: Workspace): Matches {
  const strong = new Set<string>();
  const likely = new Set<string>();
  const phone = phoneKey(item.phone);
  const email = cleanEmail(item.email);
  const person = nameWords(item.personName);
  const about = nameWords(item.aboutFirstName);
  for (const contact of workspace.contacts) {
    if (phone && phoneKey(contact.phone) === phone) strong.add(contact.caseId);
    if (email && cleanEmail(contact.email) === email) strong.add(contact.caseId);
    const words = nameWords(contact.name);
    if (!person.length || !words.length) continue;
    if (person.length >= 2 && words[0] === person[0] && words[words.length - 1] === person[person.length - 1]) strong.add(contact.caseId);
    else if (person.length === 1 && words.includes(person[0])) likely.add(contact.caseId);
    else if (person.length >= 2 && words.length >= 2 && words[words.length - 1] === person[person.length - 1]) likely.add(contact.caseId);
  }
  for (const record of workspace.cases) {
    const title = new Set(nameWords(record.title));
    if (about.some((word) => title.has(word)) || (person.length && person.every((word) => title.has(word)))) likely.add(record.id);
  }
  const known = new Map(workspace.cases.map((record) => [record.id, record]));
  const rank = (ids: Set<string>) => [...ids].filter((id) => known.has(id)).sort((a, b) => {
    const left = known.get(a)!;
    const right = known.get(b)!;
    const open = Number(CLOSED.has(left.status)) - Number(CLOSED.has(right.status));
    return open || right.updatedAt.localeCompare(left.updatedAt);
  });
  const sure = rank(strong);
  if (sure.length) return { ids: sure.slice(0, 6), sure: sure.length === 1 };
  // A likely match on both the person and who it's about narrows it down.
  const ids = rank(likely);
  return { ids: ids.slice(0, 6), sure: false };
}

// ─── Matching partners ─────────────────────────────────────────────────────

/**
 * The partners an item is about. Sure: the same phone, email, organization
 * or person's full name. Likely: one organization name inside the other
 * ("Juniper Ridge" and "Juniper Ridge Recovery").
 */
export function matchPartners(item: Pick<FoundItem, 'personName' | 'organization' | 'phone' | 'email'>, workspace: Workspace): Matches {
  const strong = new Set<string>();
  const likely = new Set<string>();
  const phone = phoneKey(item.phone);
  const email = cleanEmail(item.email);
  const org = orgKey(item.organization);
  const person = comparable(item.personName);
  for (const partner of workspace.partners) {
    if (phone && phoneKey(partner.phone) === phone) strong.add(partner.id);
    if (email && cleanEmail(partner.email) === email) strong.add(partner.id);
    const partnerOrg = orgKey(partner.organization);
    if (org.length >= 4 && partnerOrg === org) strong.add(partner.id);
    else if (org.length >= 5 && partnerOrg.length >= 5 && (partnerOrg.includes(org) || org.includes(partnerOrg))) likely.add(partner.id);
    if (person.includes(' ') && comparable(partner.name) === person) strong.add(partner.id);
  }
  const sure = [...strong];
  if (sure.length) return { ids: sure.slice(0, 6), sure: sure.length === 1 };
  const ids = [...likely];
  return { ids: ids.slice(0, 6), sure: false };
}

// ─── Review rows ───────────────────────────────────────────────────────────

export type ReviewRow = {
  key: string;
  kind: ReviewKind;
  found: FoundItem;
  /** The note, the task, or the lead's summary; editable. */
  text: string;
  // A new lead (editable).
  callerName: string;
  phone: string;
  email: string;
  aboutRelationship: string;
  aboutFirstName: string;
  // Where it goes. A row with choices and no pick waits for one.
  caseId: string | null;
  partnerId: string | null;
  caseChoices: string[];
  partnerChoices: string[];
  /** The match was likely, not certain: shown so the practitioner checks it. */
  unsure: boolean;
  dueOn: string;
  clientLabel: string;
  /** A new partner, ready for import_partners. */
  candidate: ImportCandidate | null;
  include: boolean;
  /** Why the row looks the way it does ("Already a case: ..."). */
  hint: string;
};

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'of', 'at', 'on', 'with', 'about', 'call', 'back']);

/** Two task titles that say the same thing ("Call Tom back" / "Call back Tom about the bed"). */
export function sameTask(a: string, b: string): boolean {
  const words = (value: string) => new Set(comparable(value).split(' ').filter((word) => word.length >= 3 && !STOP.has(word)));
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.6;
}

function caseTitle(workspace: Workspace, caseId: string | null): string {
  return (caseId && workspace.cases.find((record) => record.id === caseId)?.title) || '';
}

function partnerName(workspace: Workspace, partnerId: string | null): string {
  const partner = partnerId ? workspace.partners.find((item) => item.id === partnerId) : null;
  return partner ? partner.organization || partner.name : '';
}

function newPartnerCandidate(item: FoundItem, workspace: Workspace): ImportCandidate | null {
  const contact = cleanContact({
    name: item.personName,
    organization: item.organization,
    phone: item.phone,
    email: item.email,
    note: item.summary,
    hint: item.partnerType,
  });
  if (!contact.name && !contact.organization) return null;
  const [candidate] = addCandidates([], [contact], workspace.directory, workspace.partners).candidates;
  if (!candidate) return null;
  return item.partnerType ? { ...candidate, types: candidate.match ? candidate.types : [item.partnerType] } : candidate;
}

/** The rows the review shows, in the function's order (anything urgent first). */
export function buildRows(items: FoundItem[], workspace: Workspace, today: string): ReviewRow[] {
  return items.map((found, index) => {
    const row: ReviewRow = {
      key: `r${index}`,
      kind: found.kind,
      found,
      text: found.summary,
      callerName: found.personName,
      phone: found.phone,
      email: found.email,
      aboutRelationship: found.aboutRelationship,
      aboutFirstName: found.aboutFirstName,
      caseId: null,
      partnerId: null,
      caseChoices: [],
      partnerChoices: [],
      unsure: false,
      dueOn: found.dueDate || (found.missed ? today : addDays(today, 1)),
      clientLabel: '',
      candidate: null,
      include: found.verified,
      hint: found.verified ? '' : 'Not found word for word in your notes. Check it before saving.',
    };
    const pickCase = () => {
      const matches = matchCases(found, workspace);
      row.caseChoices = matches.ids;
      if (matches.ids.length === 1) { row.caseId = matches.ids[0]; row.unsure = !matches.sure; }
    };
    const pickPartner = () => {
      const matches = matchPartners(found, workspace);
      row.partnerChoices = matches.ids;
      if (matches.ids.length === 1) { row.partnerId = matches.ids[0]; row.unsure = row.unsure || !matches.sure; }
    };

    switch (found.kind) {
      case 'new_lead': {
        // Someone already on a case is a note on that case, not a new lead.
        const matches = matchCases({ ...found, aboutFirstName: '' }, workspace);
        if (matches.sure) {
          row.kind = 'case_note';
          row.caseId = matches.ids[0];
          row.caseChoices = matches.ids;
          row.hint = row.hint || `Already a case: ${caseTitle(workspace, row.caseId)}.`;
        }
        break;
      }
      case 'case_note':
        pickCase();
        break;
      case 'partner_note': {
        pickPartner();
        // A program nobody has added yet: offer it as a new partner instead.
        if (!row.partnerChoices.length && found.organization) {
          const candidate = newPartnerCandidate(found, workspace);
          if (candidate && !candidate.existingPartnerId) {
            row.kind = 'new_partner';
            row.candidate = candidate;
            row.hint = row.hint || `${found.organization} is not in your network yet.`;
          }
        }
        break;
      }
      case 'follow_up': {
        const professional = found.regarding === 'professional' || (found.regarding === 'none' && Boolean(found.organization));
        if (professional) pickPartner(); else if (found.personName || found.aboutFirstName) pickCase();
        if (!row.caseId && !row.partnerId && !professional && found.organization) pickPartner();
        const duplicate = workspace.followUps.find((item) => item.status === 'open'
          && item.dueOn === row.dueOn
          && (row.caseId ? item.caseId === row.caseId : row.partnerId ? item.partnerId === row.partnerId : !item.caseId && !item.partnerId)
          && sameTask(item.title, row.text));
        if (duplicate) {
          row.include = false;
          row.hint = 'Already on Today.';
        } else if (found.missed) {
          row.hint = row.hint || 'Possibly missed: nothing in your notes says it was done.';
        }
        break;
      }
      case 'referral': {
        pickPartner();
        if (found.personName || found.aboutFirstName) pickCase();
        row.clientLabel = caseTitle(workspace, row.caseId);
        const direction = found.direction === 'received' ? 'Inbound' : 'Outbound';
        const duplicate = row.partnerId && workspace.referrals.some((item) => item.partnerId === row.partnerId
          && item.direction === direction && item.date === today && (!row.caseId || !item.caseId || item.caseId === row.caseId));
        if (duplicate) {
          row.include = false;
          row.hint = 'Already in the referral history today.';
        }
        break;
      }
      case 'new_partner': {
        const candidate = newPartnerCandidate(found, workspace);
        if (candidate?.existingPartnerId) {
          // Already a partner: what was said about them is a note.
          row.kind = 'partner_note';
          row.partnerId = candidate.existingPartnerId;
          row.partnerChoices = [candidate.existingPartnerId];
          row.hint = row.hint || `Already a partner: ${partnerName(workspace, row.partnerId)}.`;
        } else {
          row.candidate = candidate;
        }
        break;
      }
    }
    return row;
  });
}

// ─── Ready to save ─────────────────────────────────────────────────────────

/** What a row still needs before it can be saved; '' when it is ready. */
export function rowProblem(row: ReviewRow): string {
  if (!row.text.trim()) return 'Add a note.';
  switch (row.kind) {
    case 'new_lead': {
      if (!row.callerName.trim()) return 'Add the caller’s name.';
      const digits = row.phone.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return 'Add a phone number.';
      if (row.email.trim() && !cleanEmail(row.email)) return 'Check the email address.';
      return '';
    }
    case 'case_note': return row.caseId ? '' : row.caseChoices.length ? 'Choose the case.' : 'Choose a case.';
    case 'partner_note': return row.partnerId ? '' : row.partnerChoices.length ? 'Choose the partner.' : 'Choose a partner.';
    case 'follow_up': return /^\d{4}-\d{2}-\d{2}$/.test(row.dueOn) ? '' : 'Set a due date.';
    case 'referral':
      if (!row.partnerId) return row.partnerChoices.length ? 'Choose the partner.' : 'Choose a partner.';
      return row.clientLabel.trim() ? '' : 'Add a client label (initials or a private label).';
    case 'new_partner': return row.candidate && importReady({ ...row.candidate, include: true }) ? '' : 'Choose a type.';
  }
}

export function rowReady(row: ReviewRow): boolean {
  return row.include && !rowProblem(row);
}

// ─── The writes ────────────────────────────────────────────────────────────

const EVENT_KIND: Record<FoundItem['channel'], 'call' | 'meeting' | 'text' | 'email' | 'note'> = {
  call: 'call', meeting: 'meeting', text: 'text', email: 'email', unknown: 'note',
};
const TOUCH_KIND: Record<FoundItem['channel'], 'call' | 'meeting' | 'text' | 'email' | 'other'> = {
  call: 'call', meeting: 'meeting', text: 'text', email: 'email', unknown: 'other',
};

export type LeadWrite = {
  callerName: string;
  phone: string;
  email: string;
  aboutRelationship: string;
  aboutFirstName: string;
  leadSource: string;
  urgency: 'none' | 'immediate_danger';
  note: string;
};

export function leadWrite(row: ReviewRow): LeadWrite {
  return {
    callerName: row.callerName.trim().slice(0, 120),
    phone: row.phone.trim(),
    email: cleanEmail(row.email),
    aboutRelationship: row.aboutRelationship.trim().slice(0, 60),
    aboutFirstName: row.aboutFirstName.trim().slice(0, 60),
    leadSource: row.found.channel === 'call' ? 'Inbound call' : 'Unspecified',
    urgency: row.found.urgent ? 'immediate_danger' : 'none',
    note: row.text.trim().slice(0, 2000),
  };
}

export function caseEventWrite(row: ReviewRow, id: string, occurredAt: string) {
  return { id, caseId: row.caseId!, kind: EVENT_KIND[row.found.channel], body: row.text.trim(), occurredAt };
}

export function partnerTouchWrite(row: ReviewRow, id: string, occurredAt: string) {
  return { id, partnerId: row.partnerId!, kind: TOUCH_KIND[row.found.channel], note: row.text.trim(), occurredAt };
}

export function followUpWrite(row: ReviewRow, id: string) {
  return {
    id,
    ...(row.caseId ? { caseId: row.caseId } : {}),
    ...(row.partnerId && !row.caseId ? { partnerId: row.partnerId } : {}),
    title: row.text.trim().slice(0, 200),
    dueOn: row.dueOn,
    status: 'open' as const,
    note: row.found.missed ? 'From day review: possibly missed.' : 'From day review.',
    kind: 'follow_up' as const,
  };
}

export function referralWrite(row: ReviewRow, id: string, today: string) {
  return {
    id,
    partnerId: row.partnerId!,
    direction: row.found.direction === 'received' ? 'Inbound' as const : 'Outbound' as const,
    date: today,
    clientLabel: row.clientLabel.trim().slice(0, 120),
    outcome: 'Pending' as const,
    note: row.text.trim(),
    ...(row.caseId ? { caseId: row.caseId } : {}),
  };
}

export function newPartnerWrite(row: ReviewRow): ImportRow | null {
  if (!row.candidate) return null;
  return importRows([{ ...row.candidate, include: true }])[0] ?? null;
}

// ─── Wording ───────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ReviewKind, string> = {
  new_lead: 'New lead',
  case_note: 'Case note',
  partner_note: 'Partner note',
  follow_up: 'Follow-up',
  referral: 'Referral',
  new_partner: 'New partner',
};

const PLURAL: Record<ReviewKind, [string, string]> = {
  new_lead: ['new lead', 'new leads'],
  case_note: ['case note', 'case notes'],
  partner_note: ['partner note', 'partner notes'],
  follow_up: ['follow-up', 'follow-ups'],
  referral: ['referral', 'referrals'],
  new_partner: ['new partner', 'new partners'],
};

/** "2 new leads, 3 case notes, 1 follow-up." */
export function countLine(kinds: ReviewKind[]): string {
  const counts = new Map<ReviewKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) || 0) + 1);
  const parts = REVIEW_KINDS.filter((kind) => counts.get(kind)).map((kind) => {
    const count = counts.get(kind)!;
    return `${count} ${PLURAL[kind][count === 1 ? 0 : 1]}`;
  });
  return parts.length ? `${parts.join(', ')}.` : 'Nothing to add.';
}

/** Where a row goes, in words: "Case: Ana Rivera — son Luis". */
export function destination(row: ReviewRow, workspace: Workspace): string {
  if (row.kind === 'new_lead') return 'A new case, with a first call on Today.';
  if (row.kind === 'new_partner') {
    const match = row.candidate?.useListing ? row.candidate.match : null;
    const what = match ? `Adds ${match.organization || match.name} from the Directory` : 'Adds a partner to your network';
    return `${what}, with this note on it.`;
  }
  const parts: string[] = [];
  if (row.caseId) parts.push(`Case: ${caseTitle(workspace, row.caseId)}`);
  if (row.partnerId) parts.push(`Partner: ${partnerName(workspace, row.partnerId)}`);
  if (!parts.length) return row.kind === 'follow_up' ? 'Today, not linked to a case or partner.' : '';
  return parts.join(' · ');
}
