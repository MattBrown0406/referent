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
  /** False when the review gave a name or organization the notes never mention. */
  namesFound: boolean;
};

const CHANNELS = ['call', 'meeting', 'text', 'email', 'unknown'] as const;

/** A real calendar date written YYYY-MM-DD (not 2026-02-30). */
export function validDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

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
      dueDate: validDay(String(item.dueDate || '')) ? String(item.dueDate) : '',
      direction: item.direction === 'received' ? 'received' : item.direction === 'sent' ? 'sent' : '',
      partnerType,
      regarding: item.regarding === 'family' || item.regarding === 'professional' ? item.regarding : 'none',
      urgent: item.urgent === true,
      missed: item.missed === true,
      evidence: text(item.evidence, 300),
      verified: item.verified === true,
      namesFound: item.namesFound !== false,
    });
  }
  return out;
}

// ─── The workspace, as much of it as matching needs ────────────────────────

export type CaseLike = { id: string; title: string; status: string; updatedAt: string };
export type ContactLike = { caseId: string; name: string; phone: string; email: string };
export type FollowUpLike = { caseId?: string; partnerId?: string; title: string; dueOn: string; status: string; kind?: string };
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

// A new lead in this review that is not saved yet: rows below it can be
// about it. Its case exists only in the review until the lead is saved.
export const PENDING_STATUS = 'pending';
/** A case the practitioner made in this review for a note about a family not in ReferralFit yet; created at Approve. */
export const NEW_CASE_STATUS = 'new_case';
export type PendingCase = { id: string; title: string; contact?: { name: string; phone: string; email: string; about: string } };

// ─── Names ─────────────────────────────────────────────────────────────────

// Letters the accent split leaves whole ("Łukasz" is "lukasz", "Strauß" is "strauss").
const FOLD: Record<string, string> = { 'ł': 'l', 'ø': 'o', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'þ': 'th', 'ı': 'i' };

/** Letters (any alphabet) and digits only, lower case, accents dropped (as the day-review function does). */
export function comparable(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[łøßæœđþı]/g, (letter) => FOLD[letter] ?? letter)
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Words that say nothing about who a person is: titles, and how someone is
// related to the person a case is about.
const FILLER = new Set([
  'the', 'family', 'mr', 'mrs', 'ms', 'dr', 'and', 'of', 'her', 'his', 'their', 'self',
  'mom', 'dad', 'mother', 'father', 'parent', 'son', 'daughter', 'wife', 'husband', 'partner', 'spouse',
  'brother', 'sister', 'sibling', 'grandson', 'granddaughter', 'grandmother', 'grandfather', 'grandma', 'grandpa',
  'aunt', 'uncle', 'niece', 'nephew', 'cousin', 'friend', 'boyfriend', 'girlfriend', 'fiance', 'fiancee',
  'stepson', 'stepdaughter', 'stepmom', 'stepdad', 'member',
]);

function nameWords(value: string): string[] {
  return comparable(value).split(' ').filter((word) => word.length >= 2 && !FILLER.has(word));
}

/**
 * Initials for the referral history, which stays de-identified (README,
 * "Privacy note"): "Ana Rivera — son Luis" becomes "AR / L". The
 * practitioner can change it.
 */
export function labelInitials(title: string): string {
  return title
    .split(/\s[—–-]\s|\s*[—–]\s*/)
    .map((part) => nameWords(part).map((word) => word[0].toUpperCase()).join(''))
    .filter(Boolean)
    .join(' / ')
    .slice(0, 20);
}

// ─── Matching cases ────────────────────────────────────────────────────────

export type Matches = { ids: string[]; sure: boolean };

function rankCases(ids: Iterable<string>, workspace: Workspace): string[] {
  const known = new Map(workspace.cases.map((record) => [record.id, record]));
  return [...new Set(ids)].filter((id) => known.has(id)).sort((a, b) => {
    const left = known.get(a)!;
    const right = known.get(b)!;
    const open = Number(CLOSED.has(left.status)) - Number(CLOSED.has(right.status));
    return open || right.updatedAt.localeCompare(left.updatedAt);
  });
}

function isOpenCase(workspace: Workspace, id: string): boolean {
  const record = workspace.cases.find((item) => item.id === id);
  return Boolean(record && !CLOSED.has(record.status));
}

/** The cases with a contact who has this phone number or email address. */
export function casesByContact(item: Pick<FoundItem, 'phone' | 'email'>, workspace: Workspace): string[] {
  const phone = phoneKey(item.phone);
  const email = cleanEmail(item.email);
  if (!phone && !email) return [];
  const ids = workspace.contacts
    .filter((contact) => (phone && phoneKey(contact.phone) === phone) || (email && cleanEmail(contact.email) === email))
    .map((contact) => contact.caseId);
  return rankCases(ids, workspace);
}

/**
 * The cases an item is about. Sure: the same phone or email as a contact on
 * the case, or the same first and last name. Otherwise a likely match: the
 * same first name as a contact, or a name word in the case title.
 */
export function matchCases(item: Pick<FoundItem, 'personName' | 'aboutFirstName' | 'phone' | 'email'>, workspace: Workspace): Matches {
  const strong = new Set<string>(casesByContact(item, workspace));
  const likely = new Set<string>();
  const person = nameWords(item.personName);
  const about = nameWords(item.aboutFirstName);
  for (const contact of workspace.contacts) {
    const words = nameWords(contact.name);
    if (!person.length || !words.length) continue;
    // A full name alone is likely, not sure: two people can share one, so
    // the practitioner confirms the case ("Yes, this case").
    if (person.length >= 2 && words[0] === person[0] && words[words.length - 1] === person[person.length - 1]) likely.add(contact.caseId);
    else if (person.length === 1 && words.includes(person[0])) likely.add(contact.caseId);
    else if (person.length >= 2 && words.length >= 2 && words[words.length - 1] === person[person.length - 1]) likely.add(contact.caseId);
  }
  for (const record of workspace.cases) {
    const title = new Set(nameWords(record.title));
    if (about.some((word) => title.has(word)) || (person.length && person.every((word) => title.has(word)))) likely.add(record.id);
  }
  const sure = rankCases(strong, workspace);
  if (sure.length) return { ids: sure.slice(0, 6), sure: sure.length === 1 };
  return { ids: rankCases(likely, workspace).slice(0, 6), sure: false };
}

// ─── Matching partners ─────────────────────────────────────────────────────

// Words in many program names that say nothing about which program it is.
const GENERIC_ORG = new Set([
  'and', 'of', 'at', 'for', 'new', 'recovery', 'center', 'centers', 'centre', 'treatment', 'house', 'home', 'homes',
  'health', 'healthcare', 'behavioral', 'mental', 'services', 'service', 'wellness', 'sober', 'living', 'detox',
  'inpatient', 'outpatient', 'residential', 'program', 'programs', 'institute', 'clinic', 'family', 'families',
  'intervention', 'interventions', 'counseling', 'therapy', 'therapist', 'care', 'addiction', 'rehab',
  'rehabilitation', 'foundation', 'associates', 'partners', 'network', 'solutions', 'academy', 'campus', 'iop', 'php',
]);

function distinctiveWords(value: string): Set<string> {
  return new Set(orgKey(value).split(' ').filter((word) => word.length >= 3 && !GENERIC_ORG.has(word)));
}

/**
 * Two organization names that may be the same program: they share two
 * distinctive words, or every distinctive word of one is in the other
 * ("Juniper Ridge" and "Juniper Ridge Recovery"), never just "Recovery".
 */
export function similarOrganization(a: string, b: string): boolean {
  const left = distinctiveWords(a);
  const right = distinctiveWords(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared >= 2 || (shared >= 1 && shared === Math.min(left.size, right.size));
}

/**
 * The partners an item is about. Sure: the same phone, email, organization
 * or person's full name. Likely: a similar organization name.
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
    else if (org && partnerOrg && similarOrganization(item.organization, partner.organization)) likely.add(partner.id);
    if (person.includes(' ') && comparable(partner.name) === person) strong.add(partner.id);
  }
  const sure = [...strong];
  if (sure.length) return { ids: sure.slice(0, 6), sure: sure.length === 1 };
  return { ids: [...likely].slice(0, 6), sure: false };
}

// ─── Review rows ───────────────────────────────────────────────────────────

/**
 * Ids chosen when the row is built and kept for its whole life, so saving
 * it again after a failure (or a half-finished save) writes the same
 * records instead of second copies.
 */
export type RowIds = { caseId: string; contactId: string; followUpId: string; write: string };

export type ReviewRow = {
  key: string;
  kind: ReviewKind;
  found: FoundItem;
  /** Where it came from, when the notes were read from a recorder ("From Fieldy, Nov 9, 2:15 PM · Call with Sarah"). */
  source: string;
  /** When that recording was made: a note is dated then, not when it is reviewed. '' for pasted notes. */
  occurredAt: string;
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
  /** Matched by name only: the practitioner confirms before it can be saved. */
  caseUnsure: boolean;
  partnerUnsure: boolean;
  /** A new lead that may already be one of these open cases (by name, or several). */
  possibleCases: string[];
  /** A follow-up the practitioner chose to keep off any case or partner. */
  noLink: boolean;
  dueOn: string;
  clientLabel: string;
  /** The client label as last filled in automatically, so a case change can replace it. */
  autoLabel: string;
  /** A referral: which way it went ('' until the practitioner says, when the notes did not). */
  direction: 'sent' | 'received' | '';
  /** The partner whose license concern the practitioner looked at and went ahead with. */
  licenseConfirmed: string | null;
  /** A new partner, ready for import_partners. */
  candidate: ImportCandidate | null;
  include: boolean;
  /** Why the row looks the way it does ("Already a case: ..."). */
  hint: string;
  /** Found saved before as the review was built (markSavedBefore): switched off for that reason, so decided. */
  savedEarlier: boolean;
  ids: RowIds;
};

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'of', 'at', 'on', 'with', 'about', 'call', 'back', 'her', 'his', 'him', 'them', 'their', 'from', 'by']);

/**
 * Two task titles that say the same thing: at least two words in common,
 * leaving out names ("Send the Rivera packet to Dana" / "Send Dana the
 * placement packet"), and most of the shorter one.
 */
export function sameTask(a: string, b: string, names: string[] = []): boolean {
  const skip = new Set(names.flatMap((value) => comparable(value).split(' ')));
  const words = (value: string) => new Set(comparable(value).split(' ').filter((word) => word.length >= 3 && !STOP.has(word) && !skip.has(word)));
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared >= 2 && shared / Math.min(left.size, right.size) >= 0.6;
}

/** A task that is a phone call: "Call Tom back", "Return Sarah's call". */
export function callTask(title: string): boolean {
  const words = comparable(title);
  return /^(call|phone|ring|return)\b/.test(words) || /\bcall (\w+ )?back\b/.test(words);
}

const CALL_KINDS = new Set(['first_call', 'promised_call']);

function caseTitle(workspace: Workspace, caseId: string | null): string {
  return (caseId && workspace.cases.find((record) => record.id === caseId)?.title) || '';
}

function partnerName(workspace: Workspace, partnerId: string | null): string {
  const partner = partnerId ? workspace.partners.find((item) => item.id === partnerId) : null;
  return partner ? partner.organization || partner.name : '';
}

function newPartnerCandidate(item: FoundItem, workspace: Workspace): ImportCandidate | null {
  // The summary is not kept on the partner record: what was said goes on
  // the partner's first touch when the row is saved.
  const contact = cleanContact({
    name: item.personName,
    organization: item.organization,
    phone: item.phone,
    email: item.email,
    note: '',
    hint: item.partnerType,
  });
  if (!contact.name && !contact.organization) return null;
  const [candidate] = addCandidates([], [contact], workspace.directory, workspace.partners).candidates;
  if (!candidate) return null;
  return item.partnerType ? { ...candidate, types: candidate.match ? candidate.types : [item.partnerType] } : candidate;
}

// Mirrors leadCaseTitle in cases.ts (not imported: that file talks to the server).
function pendingLeadTitle(row: Pick<ReviewRow, 'callerName' | 'aboutRelationship' | 'aboutFirstName'>): string {
  const caller = row.callerName.trim() || 'New lead';
  const about = `${row.aboutRelationship.trim()} ${row.aboutFirstName.trim()}`.trim();
  return about ? `${caller} — ${about}` : caller;
}

/**
 * The workspace with the review's new leads added as cases, so a follow-up
 * or note about a caller who is new today can go on the case the lead will
 * create. A lead already saved is in the workspace itself.
 */
export function withPendingLeads(workspace: Workspace, rows: ReviewRow[], firstCalls: { today: string; leads: ReviewRow[] } | null = null): Workspace {
  const known = new Set(workspace.cases.map((record) => record.id));
  const leads = rows.filter((row) => row.kind === 'new_lead' && row.include && !known.has(row.ids.caseId));
  if (!leads.length) return workspace;
  return {
    ...workspace,
    cases: [...leads.map((row) => ({ id: row.ids.caseId, title: pendingLeadTitle(row), status: PENDING_STATUS, updatedAt: '' })), ...workspace.cases],
    contacts: [...leads.map((row) => ({ caseId: row.ids.caseId, name: row.callerName, phone: row.phone, email: row.email })), ...workspace.contacts],
    // With firstCalls: the first call create_lead makes (due today) with
    // each lead that is on, so a "call her back" below is recognized as that
    // call, not a second one. A lead that is off makes no call, so nothing
    // is folded into it.
    followUps: firstCalls ? [...firstCalls.leads.filter((row) => row.include && leads.includes(row)).map((row) => ({
      caseId: row.ids.caseId, title: `First call with ${row.callerName || 'the new caller'}`, dueOn: firstCalls.today, status: 'open', kind: 'first_call',
    })), ...workspace.followUps] : workspace.followUps,
  };
}

/**
 * The review's new cases (made with "New case" on a row), shown like the
 * workspace's own until they exist: once created and loaded, the real case
 * is shown instead.
 */
export function withPendingCases(workspace: Workspace, pending: PendingCase[]): Workspace {
  const known = new Set(workspace.cases.map((record) => record.id));
  const add = pending.filter((item) => !known.has(item.id));
  if (!add.length) return workspace;
  return { ...workspace, cases: [...add.map((item) => ({ id: item.id, title: item.title, status: NEW_CASE_STATUS, updatedAt: '' })), ...workspace.cases] };
}

/** A name for a new case from what the notes say: "Ana Rivera — son Luis" (as a new lead's case is named). */
export function suggestedCaseTitle(row: Pick<ReviewRow, 'found'>): string {
  const person = row.found.personName.trim();
  const about = `${row.found.aboutRelationship.trim()} ${row.found.aboutFirstName.trim()}`.trim();
  return (person && about ? `${person} — ${about}` : person || about).slice(0, 120);
}

function newRowIds(makeId: () => string): RowIds {
  return { caseId: makeId(), contactId: makeId(), followUpId: makeId(), write: makeId() };
}

function blankRow(found: FoundItem, index: number, today: string, makeId: () => string): ReviewRow {
  return {
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
    caseUnsure: false,
    partnerUnsure: false,
    possibleCases: [],
    noLink: false,
    dueOn: found.dueDate || (found.missed ? today : addDays(today, 1)),
    clientLabel: '',
    autoLabel: '',
    direction: found.kind === 'referral' ? found.direction : '',
    licenseConfirmed: null,
    candidate: null,
    source: '',
    occurredAt: '',
    include: found.verified,
    hint: found.verified ? ''
      : found.namesFound === false ? 'A name or organization here is not in your notes. Check it before saving.'
        : 'Not found word for word in your notes. Check it before saving.',
    savedEarlier: false,
    ids: newRowIds(makeId),
  };
}

function addHint(row: ReviewRow, hint: string) {
  row.hint = row.hint ? `${row.hint} ${hint}` : hint;
}

/** The same caller as an earlier lead: by phone or email (sure), or by full name alone (to confirm). */
function sameCaller(a: ReviewRow, b: ReviewRow): 'contact' | 'name' | null {
  const phone = phoneKey(a.phone);
  const email = cleanEmail(a.email);
  if (phone && phone === phoneKey(b.phone)) return 'contact';
  if (email && email === cleanEmail(b.email)) return 'contact';
  const left = nameWords(a.callerName);
  const right = nameWords(b.callerName);
  return left.length >= 2 && right.length >= 2 && left[0] === right[0] && left[left.length - 1] === right[right.length - 1] ? 'name' : null;
}

// A new lead: a note on a case instead only when the caller's phone or
// email is already on exactly one open case. A name alone, or several
// cases, keeps the lead and says which cases it may be; a closed or lost
// case never takes the note (a family coming back is a new inquiry).
function placeLead(row: ReviewRow, workspace: Workspace, earlierLeads: ReviewRow[]) {
  const sameAsEarlier = earlierLeads.find((lead) => sameCaller(row, lead));
  if (sameAsEarlier) {
    const how = sameCaller(row, sameAsEarlier);
    row.kind = 'case_note';
    row.caseId = sameAsEarlier.ids.caseId;
    row.caseChoices = [sameAsEarlier.ids.caseId];
    if (how === 'name') {
      row.caseUnsure = true;
      addHint(row, 'The same name as a new lead above: check it is the same person before it goes on that case.');
    } else {
      addHint(row, 'The same caller as a new lead above: this goes on that case.');
    }
    return;
  }
  const byContact = casesByContact(row.found, workspace);
  const open = byContact.filter((id) => isOpenCase(workspace, id));
  if (open.length === 1) {
    row.kind = 'case_note';
    row.caseId = open[0];
    row.caseChoices = open;
    row.possibleCases = open;
    addHint(row, `Already a case with this phone or email: ${caseTitle(workspace, open[0])}.`);
    return;
  }
  const byName = matchCases({ ...row.found, phone: '', email: '', aboutFirstName: '' }, workspace).ids.filter((id) => isOpenCase(workspace, id));
  row.possibleCases = [...new Set([...open, ...byName])].slice(0, 6);
  if (row.possibleCases.length) {
    addHint(row, `Possibly already a case: ${row.possibleCases.map((id) => caseTitle(workspace, id)).join('; ')}.`);
  } else {
    const closed = byContact.find((id) => !isOpenCase(workspace, id));
    if (closed) addHint(row, `A closed case has the same contact: ${caseTitle(workspace, closed)}. This starts a new one.`);
  }
}

function pickCase(row: ReviewRow, workspace: Workspace) {
  const matches = matchCases(row.found, workspace);
  row.caseChoices = matches.ids;
  if (matches.ids.length === 1) { row.caseId = matches.ids[0]; row.caseUnsure = !matches.sure; }
}

function pickPartner(row: ReviewRow, workspace: Workspace) {
  const matches = matchPartners(row.found, workspace);
  row.partnerChoices = matches.ids;
  if (matches.ids.length === 1) { row.partnerId = matches.ids[0]; row.partnerUnsure = !matches.sure; }
}

// The words in a row that are names, left out when comparing task titles.
function rowNames(row: ReviewRow, workspace: Workspace): string[] {
  return [row.found.personName, row.found.aboutFirstName, row.found.organization, caseTitle(workspace, row.caseId), partnerName(workspace, row.partnerId)];
}

function daysApart(a: string, b: string): number {
  if (!validDay(a) || !validDay(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * An open follow-up that already says what this row says, on the same case
 * or partner: the same task at any due date, or else a call when a call is
 * already open there for about the same day ("Call Ana back" and the case's
 * first call). A call the notes set for another day ("call her Wednesday")
 * is a new step, not a repeat.
 */
export function existingFollowUp(row: ReviewRow, workspace: Workspace): FollowUpLike | null {
  const names = rowNames(row, workspace);
  const open = workspace.followUps.filter((item) => item.status === 'open' && (row.caseId ? item.caseId === row.caseId
    : row.partnerId ? item.partnerId === row.partnerId
      : !item.caseId && !item.partnerId));
  const same = open.find((item) => sameTask(item.title, row.text, names));
  if (same) return same;
  if (!(row.caseId || row.partnerId) || !callTask(row.text)) return null;
  const dated = Boolean(row.found.dueDate) && !row.found.missed;
  return open.find((item) => (CALL_KINDS.has(item.kind || '') || callTask(item.title))
    && (!dated || daysApart(item.dueOn, row.dueOn) <= 1)) ?? null;
}

function placeFollowUp(row: ReviewRow, workspace: Workspace) {
  const found = row.found;
  const professional = found.regarding === 'professional' || (found.regarding === 'none' && Boolean(found.organization));
  if (professional) pickPartner(row, workspace); else if (found.personName || found.aboutFirstName) pickCase(row, workspace);
  if (!row.caseId && !row.partnerId && !professional && found.organization) pickPartner(row, workspace);
  // One place only: a follow-up is saved on its case, or else its partner.
  if (row.caseId && row.partnerId) { row.partnerId = null; row.partnerUnsure = false; }
  const duplicate = row.caseId || row.partnerId || (!row.caseChoices.length && !row.partnerChoices.length) ? existingFollowUp(row, workspace) : null;
  if (duplicate) {
    row.include = false;
    addHint(row, `Already a follow-up: ${duplicate.title.replace(/[.!?\s]+$/, '')} (due ${duplicate.dueOn}).`);
  } else if (found.missed) {
    addHint(row, 'Possibly missed: nothing in your notes says it was done.');
  }
}

function setReferralCase(row: ReviewRow, workspace: Workspace, caseId: string | null) {
  const label = caseId ? labelInitials(caseTitle(workspace, caseId)) : '';
  // A label the practitioner typed stays; one filled in automatically follows the case.
  if (!row.clientLabel.trim() || row.clientLabel === row.autoLabel) row.clientLabel = label;
  row.autoLabel = label;
  row.caseId = caseId;
}

function placeReferral(row: ReviewRow, workspace: Workspace, today: string) {
  pickPartner(row, workspace);
  if (row.found.personName || row.found.aboutFirstName) pickCase(row, workspace);
  setReferralCase(row, workspace, row.caseId);
  const directions = row.direction === 'received' ? ['Inbound'] : row.direction === 'sent' ? ['Outbound'] : ['Inbound', 'Outbound'];
  // A referral from a recording is saved on the recording's day (referralWrite).
  const happened = localDayOf(row.occurredAt);
  const duplicate = row.partnerId && workspace.referrals.some((item) => item.partnerId === row.partnerId
    && directions.includes(item.direction) && (item.date === today || item.date === happened)
    && (!row.caseId || !item.caseId || item.caseId === row.caseId));
  if (duplicate) {
    row.include = false;
    addHint(row, happened && happened !== today ? 'Already in the referral history on the day of the recording.' : 'Already in the referral history today.');
  }
}

function placePartner(row: ReviewRow, workspace: Workspace) {
  const found = row.found;
  if (row.kind === 'partner_note') {
    pickPartner(row, workspace);
    // A program nobody has added yet: offer it as a new partner instead.
    if (!row.partnerChoices.length && found.organization) {
      const candidate = newPartnerCandidate(found, workspace);
      if (candidate && !candidate.existingPartnerId) {
        row.kind = 'new_partner';
        row.candidate = candidate;
        addHint(row, `${found.organization} is not in your network yet.`);
      }
    }
    return;
  }
  const candidate = newPartnerCandidate(found, workspace);
  if (candidate?.existingPartnerId) {
    // Already a partner: what was said about them is a note.
    row.kind = 'partner_note';
    row.partnerId = candidate.existingPartnerId;
    row.partnerChoices = [candidate.existingPartnerId];
    addHint(row, `Already a partner: ${partnerName(workspace, row.partnerId)}.`);
    return;
  }
  row.candidate = candidate;
  // A name written a little differently ("Juniper Ridge" for "Juniper Ridge
  // Recovery"): offered, never assumed.
  const similar = matchPartners(found, workspace).ids;
  if (similar.length) {
    row.partnerChoices = similar;
    addHint(row, `Possibly already in your network: ${similar.map((id) => partnerName(workspace, id)).join('; ')}. Tap one to add this as a note on it instead.`);
  }
}

/**
 * The rows the review shows, in the function's order (anything urgent
 * first). New leads are placed first so that a follow-up or note about a
 * caller who is new today goes on the case the lead will create.
 */
export function buildRows(items: FoundItem[], workspace: Workspace, today: string, makeId: () => string,
  sourceOf: (found: FoundItem) => { label: string; at: string } | null = () => null): ReviewRow[] {
  const rows = items.map((found, index) => withSource(blankRow(found, index, today, makeId), sourceOf(found)));
  const leads: ReviewRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'new_lead') continue;
    placeLead(row, withPendingLeads(workspace, leads), leads);
    if (row.kind === 'new_lead') leads.push(row);
  }
  for (const row of rows) {
    if (row.found.kind === 'new_lead') continue;
    // Rows can be about a new lead above whether or not its switch is on:
    // rowProblem stops them from saving until the lead is.
    const on = leads.map((lead) => ({ ...lead, include: true }));
    const view = withPendingLeads(workspace, on, { today, leads: on.filter((_, index) => leads[index].include) });
    switch (row.kind) {
      case 'case_note': pickCase(row, view); break;
      case 'partner_note':
      case 'new_partner': placePartner(row, view); break;
      case 'follow_up': placeFollowUp(row, view); break;
      case 'referral': placeReferral(row, view, today); break;
      default: break;
    }
  }
  return rows;
}

/**
 * A row read from a recorder says which conversation it came from, and a
 * note keeps that on the timeline ("… (From Fieldy, Nov 9, 2:15 PM)").
 */
function withSource(row: ReviewRow, source: { label: string; at: string } | null): ReviewRow {
  if (!source?.label) return row;
  const when = source.label.split(' · ')[0];
  const note = row.kind === 'case_note' || row.kind === 'partner_note' || row.kind === 'new_lead';
  // A recording time with its zone, not in the future (a clock off, or a bad
  // date): anything else and the note is dated when it is saved.
  const time = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(source.at.trim()) ? Date.parse(source.at) : NaN;
  const at = Number.isNaN(time) || time > Date.now() + 5 * 60_000 ? '' : new Date(time).toISOString();
  return { ...row, source: source.label, occurredAt: at, text: note && row.text && !row.text.includes(when) ? `${row.text} (${when})` : row.text };
}

/**
 * Turns a row into another kind it can be: a new lead into a note on one of
 * the cases it may be (and back), a new partner into a note on a partner it
 * may be (and back).
 */
export function switchKind(row: ReviewRow, kind: ReviewKind): ReviewRow {
  if (kind === row.kind) return row;
  if (row.found.kind === 'new_lead' && kind === 'case_note') {
    const choices = row.possibleCases.length ? row.possibleCases : row.caseChoices;
    return { ...row, kind, caseChoices: choices, caseId: choices.length === 1 ? choices[0] : null, caseUnsure: choices.length === 1 };
  }
  if (row.found.kind === 'new_lead' && kind === 'new_lead') {
    return { ...row, kind, caseId: null, caseUnsure: false, possibleCases: row.possibleCases.length ? row.possibleCases : row.caseChoices };
  }
  if (row.candidate && kind === 'partner_note') return { ...row, kind, partnerId: null, partnerUnsure: false };
  if (row.candidate && kind === 'new_partner') return { ...row, kind, partnerId: null, partnerUnsure: false };
  return row;
}

/** The kinds a row can be switched to (always including its own), or [] when it has no choice. */
export function kindChoices(row: ReviewRow): ReviewKind[] {
  if (row.found.kind === 'new_lead') return ['new_lead', 'case_note'];
  if (row.candidate) return ['new_partner', 'partner_note'];
  return [];
}

/** A case picked (or unpicked) on a row: the referral label follows when it was filled in automatically. */
export function chooseCase(row: ReviewRow, caseId: string | null, workspace: Workspace): ReviewRow {
  const next: ReviewRow = { ...row, caseUnsure: false, noLink: false };
  if (row.kind === 'referral') setReferralCase(next, workspace, caseId);
  else next.caseId = caseId;
  // A follow-up goes on one place: its case, or its partner.
  if (row.kind === 'follow_up' && caseId) next.partnerId = null;
  return next;
}

export function choosePartner(row: ReviewRow, partnerId: string | null): ReviewRow {
  const next: ReviewRow = { ...row, partnerId, partnerUnsure: false, noLink: false };
  if (row.kind === 'follow_up' && partnerId) { next.caseId = null; next.caseUnsure = false; }
  // Picking a partner on a new partner row: it is a note on that partner.
  if (row.kind === 'new_partner' && partnerId) next.kind = 'partner_note';
  return next;
}

// ─── Ready to save ─────────────────────────────────────────────────────────

export type RowContext = {
  /** The whole review: a row about a new lead in it waits for that lead. */
  rows?: ReviewRow[];
  /** True when sending a client to this partner raises a license concern (integrity.ts). */
  licenseConcern?: (partnerId: string) => boolean;
};

// A row on the case a new lead in this review will create.
function pendingLeadProblem(row: ReviewRow, rows: ReviewRow[]): string {
  if (!row.caseId) return '';
  const owner = rows.find((other) => other.key !== row.key && other.ids.caseId === row.caseId);
  if (!owner) return '';
  if (owner.kind !== 'new_lead') return 'Choose the case: the new lead it was on is now a note.';
  if (!owner.include) return 'Turn on the new lead above, or choose another case.';
  if (rowProblem(owner)) return 'Finish the new lead above first.';
  return '';
}

function phoneProblem(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15 || phone.trim().length > 40) return 'Add a phone number (10 to 15 digits).';
  return '';
}

/** What a row still needs before it can be saved; '' when it is ready. */
export function rowProblem(row: ReviewRow, context: RowContext = {}): string {
  if (!row.text.trim()) return 'Add a note.';
  const rows = context.rows ?? [];
  const onLead = pendingLeadProblem(row, rows);
  switch (row.kind) {
    case 'new_lead': {
      if (!row.callerName.trim()) return 'Add the caller’s name.';
      const phone = phoneProblem(row.phone);
      if (phone) return phone;
      if (row.email.trim() && !cleanEmail(row.email)) return 'Check the email address.';
      return '';
    }
    case 'case_note':
      if (!row.caseId) return row.caseChoices.length ? 'Choose the case.' : 'Choose a case.';
      if (onLead) return onLead;
      return row.caseUnsure ? 'Confirm the case.' : '';
    case 'partner_note':
      if (!row.partnerId) return row.partnerChoices.length ? 'Choose the partner.' : 'Choose a partner.';
      return row.partnerUnsure ? 'Confirm the partner.' : '';
    case 'follow_up':
      if (!validDay(row.dueOn)) return 'Set a due date (YYYY-MM-DD).';
      if (!row.caseId && !row.partnerId && !row.noLink && (row.caseChoices.length || row.partnerChoices.length)) {
        return 'Choose where it goes, or tap Not linked.';
      }
      if (onLead) return onLead;
      if (row.caseId && row.caseUnsure) return 'Confirm the case.';
      if (row.partnerId && row.partnerUnsure) return 'Confirm the partner.';
      return '';
    case 'referral':
      if (!row.direction) return 'Choose which way the referral went.';
      if (!row.partnerId) return row.partnerChoices.length ? 'Choose the partner.' : 'Choose a partner.';
      if (row.partnerUnsure) return 'Confirm the partner.';
      if (onLead) return onLead;
      if (row.caseId && row.caseUnsure) return 'Confirm the case.';
      if (!row.clientLabel.trim()) return 'Add a client label (initials or a private label).';
      if (row.direction === 'sent' && context.licenseConcern?.(row.partnerId) && row.licenseConfirmed !== row.partnerId) {
        return 'Check the license first.';
      }
      return '';
    case 'new_partner': return row.candidate && importReady({ ...row.candidate, include: true }) ? '' : 'Choose a type.';
  }
}

export function rowReady(row: ReviewRow, context: RowContext = {}): boolean {
  return row.include && !rowProblem(row, context);
}

/**
 * The order rows are saved in: new leads first (a note or follow-up below
 * may go on the case a lead creates), then the review's order.
 */
export function saveOrder<T extends Pick<ReviewRow, 'kind'>>(rows: T[]): T[] {
  return rows.filter((row) => row.kind === 'new_lead').concat(rows.filter((row) => row.kind !== 'new_lead'));
}

/** The new lead a row depends on, when it is on that lead's case. */
export function leadFor(row: ReviewRow, rows: ReviewRow[]): ReviewRow | null {
  if (!row.caseId) return null;
  return rows.find((other) => other.key !== row.key && other.kind === 'new_lead' && other.ids.caseId === row.caseId) ?? null;
}

// ─── Already saved in this review ──────────────────────────────────────────

/**
 * What a saved row was, to recognize it when the same notes are read again
 * ("Back to the notes", then Find): by its kind and target with either its
 * text or its quote. `saved` is true for a row being saved (it is known by
 * everything about its caller), false for a row read again (it matches by
 * what it has: a phone, an email, a full name, or a first name alone).
 */
export function rowSignatures(row: ReviewRow, saved = false): string[] {
  const target = row.kind === 'new_lead' ? phoneKey(row.phone) || cleanEmail(row.email) || comparable(row.callerName)
    : row.kind === 'new_partner' ? orgKey(row.candidate?.organization || row.found.organization) || comparable(row.found.personName)
      : `${row.caseId || ''}|${row.partnerId || ''}`;
  // A follow-up is also the date the notes gave it ("Call Ana back" on the
  // 10th and on the 13th are two), never one typed in or defaulted to
  // tomorrow, which would not match when the notes are read again.
  // A promise already late ("possibly missed") is due on whatever day it is
  // read, so its day never tells it apart: it is known as missed.
  const base = `${row.found.kind}|${target}${row.kind === 'follow_up' ? `|d:${row.found.missed ? 'missed' : row.found.dueDate}` : ''}`;
  const out = [`${base}|t:${comparable(row.text)}`, `${base}|s:${comparable(row.found.summary)}`];
  // A follow-up saved with its date, read again once that date has passed,
  // comes back as a late promise ("missed"): it is still this one.
  if (saved && row.kind === 'follow_up' && !row.found.missed) {
    const late = `${row.found.kind}|${target}|d:missed`;
    out.push(`${late}|t:${comparable(row.text)}`, `${late}|s:${comparable(row.found.summary)}`);
  }
  if (row.found.evidence) out.push(`${base}|q:${comparable(row.found.evidence)}`);
  // Whatever it is matched to now: a lead saved earlier is a case today, so
  // the same words from the notes read again become a note on it. Its
  // quote, word for word from the notes, still says it was saved.
  // Only for a lead: two other items often quote one sentence ("call Ana
  // and Sarah back tomorrow") and are still two things to save.
  const quote = comparable(row.found.evidence);
  // Two leads quoting one sentence are two callers: the caller is part of it
  // ("Mike Smith" saved never hides "Mike Jones"; one with no phone, name or
  // email to tell it by is known by its own text and quote only).
  if (row.found.kind === 'new_lead' && row.found.verified && quote.split(' ').length >= 4) {
    const names = nameWords(row.found.personName);
    // A name matches only with the same phone or email, or when the row read
    // again has neither: "Kevin" at one number is not "Kevin Walsh" at another.
    // A saved row is also known by the phone and email it was saved with
    // (typed in by hand, say), a row read again by what the notes gave.
    const contact = phoneKey(row.found.phone) || cleanEmail(row.found.email);
    const savedContact = saved ? phoneKey(row.phone) || cleanEmail(row.email) : '';
    const withContact = (key: string) => (saved
      ? [...new Set([`${key}|${contact || '-'}`, `${key}|${savedContact || '-'}`, `${key}|-`])]
      : [`${key}|${contact || '-'}`]);
    const keys = [
      phoneKey(row.found.phone) ? `p:${phoneKey(row.found.phone)}` : '',
      cleanEmail(row.found.email) ? `e:${cleanEmail(row.found.email)}` : '',
      saved && phoneKey(row.phone) ? `p:${phoneKey(row.phone)}` : '',
      saved && cleanEmail(row.email) ? `e:${cleanEmail(row.email)}` : '',
      ...(names.length >= 2 ? withContact(`n:${names.join(' ')}`) : []),
      ...(names.length && (saved || names.length === 1) ? withContact(`f:${names[0]}`) : []),
      // Saved with a first name only ("Kevin"): read again with a full name ("Kevin Walsh"), still that caller.
      ...((names.length === 1 && saved) || (names.length >= 2 && !saved) ? withContact(`f1:${names[0]}`) : []),
    ].filter(Boolean);
    for (const key of keys) out.push(`new_lead|any|q:${quote}|${key}`);
  }
  return out;
}

/**
 * What a saved row is known by when the same notes or recording are read
 * again: its text or its summary with its target (and a follow-up's due
 * date), and a lead's quote with its caller; never a quote alone (two
 * items often quote one sentence; the one not saved must come back) nor a
 * phone alone (a caller calling again about something new is shown).
 */
export function laterSignatures(row: ReviewRow): string[] {
  // A note or a referral is also known by its quote with its kind and its
  // case or partner (never a quote alone): read again, the model words the
  // same note a little differently, and it must not be saved twice. Not a
  // follow-up: one sentence often holds two ("call Ana and Sarah back
  // tomorrow", both on one case); those are known by their wording and date.
  const quoted = new Set<string>(['case_note', 'partner_note', 'referral']);
  // As for a lead: a quote of four words or more, never a fragment two items could share.
  const targeted = Boolean(row.caseId || row.partnerId) && comparable(row.found.evidence).split(' ').length >= 4;
  return rowSignatures(row, true).filter((signature) => !signature.includes('|q:')
    || signature.startsWith('new_lead|any|')
    || (targeted && quoted.has(row.found.kind) && signature.startsWith(`${row.found.kind}|`)));
}

/**
 * A short fingerprint of a signature (cyrb53), kept on the phone with the
 * recording it was saved from, so the same item is known when that
 * recording is read again in a later review, without keeping its words.
 */
export function signatureHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `h:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

type Target = { kind: ReviewKind; caseId: string | null; partnerId: string | null };

const sameTarget = (a: Target, b: Target) => a.kind === b.kind && a.caseId === b.caseId && a.partnerId === b.partnerId;

// The places a row read again may have been saved on. Its own pick when it
// is sure; with no pick, or one made by name only, also each case or
// partner it could be: a note saved on a case picked by hand comes back
// with no case picked, and is still that note. A new partner may have been
// saved as a note on a partner it may be ("Possibly already in your
// network"), and a new lead as a note on a case it may be.
function possibleTargets(row: ReviewRow): Target[] {
  const out: Target[] = [{ kind: row.kind, caseId: row.caseId, partnerId: row.partnerId }];
  const add = (target: Target) => { if (!out.some((known) => sameTarget(known, target))) out.push(target); };
  if (row.kind === 'new_partner') {
    for (const partnerId of row.partnerChoices) add({ kind: 'partner_note', caseId: row.caseId, partnerId });
    return out;
  }
  if (row.kind === 'new_lead') {
    for (const caseId of row.possibleCases) add({ kind: 'case_note', caseId, partnerId: row.partnerId });
    return out;
  }
  if (row.kind !== 'case_note' && row.kind !== 'partner_note' && row.kind !== 'follow_up' && row.kind !== 'referral') return out;
  const options = (picked: string | null, unsure: boolean, choices: string[]) =>
    (picked && !unsure ? [picked] : [...new Set([picked, null, ...choices])]);
  const cases = row.kind === 'partner_note' ? [row.caseId] : options(row.caseId, row.caseUnsure, row.caseChoices);
  const partners = row.kind === 'case_note' ? [row.partnerId] : options(row.partnerId, row.partnerUnsure, row.partnerChoices);
  for (const caseId of cases) {
    for (const partnerId of partners) {
      // A follow-up is saved on one place only.
      if (row.kind === 'follow_up' && caseId && partnerId) continue;
      add({ kind: row.kind, caseId, partnerId });
    }
  }
  return out;
}

const knownBy = (saved: Set<string>, signature: string) => saved.has(signature) || saved.has(signatureHash(signature));

// A signature by the row's text or summary (not its quote, nor a lead's quote with its caller).
const byWording = (signature: string) => /\|[ts]:/.test(signature);

/** A saved signature this row matches, on one of its possible places, and how well (higher is closer). */
type Claim = { target: Target; signature: string; score: number };

function claims(row: ReviewRow, saved: Set<string>): Claim[] {
  if (!saved.size) return [];
  const out: Claim[] = [];
  possibleTargets(row).forEach((target, index) => {
    const own = index === 0;
    for (const signature of rowSignatures({ ...row, ...target })) {
      // Another place is known by the row's own wording only, never by its
      // quote: two items often quote one sentence ("both Sarahs want the
      // Saturday family session"), and the one saved on one Sarah's case
      // must not hide the other's.
      if (!own && !byWording(signature)) continue;
      if (!knownBy(saved, signature)) continue;
      out.push({ target, signature, score: (own ? 10 : 0) + (signature.includes('|t:') ? 3 : signature.includes('|s:') ? 2 : 1) });
    }
  });
  return out;
}

const uniqueTargets = (list: Claim[]) => list.reduce<Target[]>((out, claim) => (out.some((target) => sameTarget(target, claim.target)) ? out : [...out, claim.target]), []);

/**
 * Where this row was saved before (none when it was not): in this review
 * (its signature), or from the same recording in an earlier one (its
 * fingerprint). The row's own place first, then each case or partner it
 * could be (possibleTargets), known there by its wording only.
 */
export function savedTargets(row: ReviewRow, saved: Set<string>): Target[] {
  return uniqueTargets(claims(row, saved));
}

/** This row was saved before: in this review (its signature), or from the same recording in an earlier one (its fingerprint). */
export function savedBefore(row: ReviewRow, saved: Set<string>): boolean {
  return claims(row, saved).length > 0;
}

const NO_WORKSPACE: Workspace = { cases: [], contacts: [], partners: [], followUps: [], referrals: [], directory: null };

/** How well a row matches one place: its closest signature there. */
const closest = (list: Claim[]) => Math.max(0, ...list.map((claim) => claim.score));

/**
 * Which saved place each row is (one-to-one): the closest claims first; a
 * row that takes a place lets go of its other claims, and the signatures it
 * took there are no one else's. Between equals: the row with fewer places
 * left, then the place fewer rows want, then the first row (rows that are
 * alike end up the same whichever comes first). Each row's place and the
 * signatures it took; a row with none is not there.
 */
function assignSaved(all: Claim[][]): Map<number, Claim[]> {
  const taken = new Set<string>();
  const placed = new Map<number, Claim[]>();
  for (;;) {
    // Each unplaced row's places, by the signatures still free there.
    const open: { index: number; list: Claim[] }[] = [];
    all.forEach((rowClaims, index) => {
      if (placed.has(index)) return;
      for (const target of uniqueTargets(rowClaims)) {
        const list = rowClaims.filter((claim) => sameTarget(claim.target, target) && !taken.has(claim.signature));
        if (list.length) open.push({ index, list });
      }
    });
    if (!open.length) return placed;
    const left = (index: number) => open.filter((option) => option.index === index).length;
    const wanted = (list: Claim[]) => open.filter((option) => option.list.some((claim) => list.some((mine) => mine.signature === claim.signature))).length;
    let best = open[0];
    for (const option of open.slice(1)) {
      const order = closest(option.list) - closest(best.list) || left(best.index) - left(option.index) || wanted(best.list) - wanted(option.list);
      if (order > 0) best = option;
    }
    placed.set(best.index, best.list);
    for (const claim of best.list) taken.add(claim.signature);
  }
}

/**
 * Rows that were saved before start switched off. One saved on a case or
 * partner it could be (picked by hand then) shows that place again, set the
 * way the row's own pickers set it (a referral's client label follows its
 * case). Saved places and rows are matched one to one (assignSaved): two
 * notes worded alike, one saved on each Sarah's case, each go back to their
 * own case; with only one saved, one row is the saved one and the other
 * stays as it was. A row that alone matches two saved places is saved, with
 * no place guessed for it.
 */
export function markSavedBefore(rows: ReviewRow[], saved: Set<string>, workspace: Workspace = NO_WORKSPACE): ReviewRow[] {
  if (!saved.size) return rows;
  const all = rows.map((row) => claims(row, saved));
  const placed = assignSaved(all);
  const taken = new Set([...placed.values()].flat().map((claim) => claim.signature));
  return rows.map((row, index) => {
    const kept = placed.get(index);
    if (!kept) return row;
    const ownTarget: Target = { kind: row.kind, caseId: row.caseId, partnerId: row.partnerId };
    const target = kept[0].target;
    const own = sameTarget(target, ownTarget);
    // Another place this row matches that no other row took: it was saved
    // on two, and neither is guessed (its own pick stays).
    const alsoElsewhere = all[index].some((claim) => !sameTarget(claim.target, target) && !taken.has(claim.signature));
    const place = own ? target : alsoElsewhere ? null : target;
    let next = row;
    if (place && !own) {
      // As the practitioner would have: a new lead made a note on its case,
      // a new partner a note on the partner it is.
      if (place.kind === 'case_note' && next.kind === 'new_lead') next = switchKind(next, 'case_note');
      if (place.caseId !== next.caseId) next = chooseCase(next, place.caseId, workspace);
      if (place.partnerId !== next.partnerId || place.kind !== next.kind) next = choosePartner(next, place.partnerId);
      next = { ...next, caseUnsure: false, partnerUnsure: false, noLink: false };
    }
    const when = kept.some((claim) => saved.has(claim.signature)) ? 'Saved earlier in this review.' : 'Saved in an earlier review.';
    return { ...next, include: false, savedEarlier: true, hint: row.hint ? `${when} ${row.hint}` : when };
  });
}

/**
 * Fingerprints kept with a recording: those it had and those just saved,
 * each once, the newest `max` kept (the oldest drop first).
 */
export function mergeFingerprints(before: string[], added: string[], max = 200): string[] {
  const fresh = new Set(added);
  return [...new Set([...before.filter((hash) => !fresh.has(hash)), ...added])].filter(Boolean).slice(-max);
}

// ─── Recordings in the box ─────────────────────────────────────────────────

type BlockLike = { id: string; text: string };
const spaced = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * The recordings (each under its header) still written in the notes box,
 * word for word apart from spacing: the review stays linked to them when
 * text is typed, shared or spoken beside them, and lets go of one edited or
 * deleted.
 */
export function blocksInNotes<T extends BlockLike>(notes: string, blocks: T[]): T[] {
  const box = spaced(notes);
  return blocks.filter((block) => spaced(block.text) && box.includes(spaced(block.text)));
}

/** What the box holds besides those recordings: notes typed, shared or spoken there ('' for none). */
export function notesBesides(notes: string, blocks: BlockLike[]): string {
  let rest = spaced(notes);
  for (const block of blocks) {
    const text = spaced(block.text);
    if (text) rest = rest.split(text).join(' ');
  }
  return spaced(rest);
}

/**
 * At most `max` recordings in one review, the oldest first (as read), so
 * one review rarely finds more than it can list (20 items); the rest wait
 * for the next read and are counted with those already waiting.
 */
export const RECORDINGS_PER_REVIEW = 3;

export function firstRecordings<T extends { text: string; blocks: BlockLike[]; later: number }>(plan: T, max = RECORDINGS_PER_REVIEW): T {
  if (plan.blocks.length <= max) return plan;
  const blocks = plan.blocks.slice(0, max);
  return { ...plan, blocks, text: blocks.map((block) => block.text).join('\n\n'), later: plan.later + plan.blocks.length - blocks.length };
}

/**
 * The recordings of a read that are done as soon as the review comes back:
 * those nothing was found in. None while an item's quote is in no one of
 * them (it could be from any), and none when the review stopped at its cap
 * (what it left out may be in any of them).
 */
export function recordingsDoneOnRead(blockIds: string[], rowIds: Iterable<string[]>, truncated: boolean): string[] {
  const lists = [...rowIds];
  if (truncated || lists.some((ids) => !ids.length)) return [];
  const withRows = new Set(lists.flat());
  return blockIds.filter((id) => !withRows.has(id));
}

/**
 * Recordings read again next time whatever happens to this review's rows,
 * when it stopped at its cap: every one, when it read several (what it left
 * out may be in any of them, even one with items listed; the next read
 * takes fewer at a time, so they are not held forever); of a single one,
 * only when nothing was listed from it (one with items listed is done once
 * they are decided).
 */
export function recordingsHeld(blockIds: string[], rowIds: Iterable<string[]>, truncated: boolean): string[] {
  if (!truncated) return [];
  if (blockIds.length > 1) return [...blockIds];
  const withRows = new Set([...rowIds].flat());
  return blockIds.filter((id) => !withRows.has(id));
}

/** At most this many extra reviews, with fewer recordings each, when a review of several stopped at its cap. */
export const NARROWED_READS = 2;

/**
 * A review of several recordings stopped at its cap: the older half (at
 * least one) is read again on its own, the rest wait for the next read.
 * null when there is only one (nothing to narrow).
 */
export function olderHalf<T>(blocks: T[]): T[] | null {
  if (blocks.length <= 1) return null;
  return blocks.slice(0, Math.max(1, Math.floor(blocks.length / 2)));
}

/** "2 more Fieldy conversations wait for the next review." ('' for none). */
export function waitingLine(count: number, recorder: { name: string; noun: string }): string {
  if (count <= 0) return '';
  return `${count} more ${recorder.name} ${count === 1 ? `${recorder.noun} waits` : `${recorder.noun}s wait`} for the next review.`;
}

/** "2 Fieldy conversations are read again next time." ('' for none): closing says what will happen. */
export function readAgainLine(count: number, recorder: { name: string; noun: string }): string {
  if (count <= 0) return '';
  return `${count} ${recorder.name} ${count === 1 ? `${recorder.noun} is` : `${recorder.noun}s are`} read again next time.`;
}

/**
 * Said when a review of `from` recordings was read again with the oldest
 * `read`: it stopped at its cap ('cap'), or it failed for its length (came
 * back incomplete, was turned down, took too long: 'failed').
 */
export function narrowedMessage(from: number, read: number, recorder: { name: string; noun: string }, why: 'cap' | 'failed' = 'cap'): string {
  const oldest = read === 1 ? `the oldest ${recorder.noun}` : `the oldest ${read}`;
  return why === 'failed'
    ? `Your ${from} ${recorder.name} ${recorder.noun}s could not be reviewed together, so this review reads ${oldest} on its own.`
    : `Your ${from} ${recorder.name} ${recorder.noun}s held more than one review can show (20 items), so this review reads ${oldest} on its own.`;
}

/** "1 urgent item already found in the Fieldy conversations that wait is shown here too." ('' for none). */
export function carriedLine(count: number, recorder: { name: string; noun: string }): string {
  if (count <= 0) return '';
  return `${count === 1 ? '1 urgent item' : `${count} urgent items`} already found in the ${recorder.name} ${recorder.noun}s that wait ${count === 1 ? 'is' : 'are'} shown here too.`;
}

/**
 * Said when a recording's review failed even read on its own: it can be
 * tried again, or let go ("Done with this"); it no longer holds newer ones back.
 */
export function failedAloneLine(recorder: { name: string; noun: string }): string {
  return `This ${recorder.name} ${recorder.noun} could not be reviewed even on its own. Try again later, or tap Done with this ${recorder.noun} so it is not offered again; until then it is read only when nothing newer waits.`;
}

/** The same item found by two reads: same kind, and the same quote or the same summary. */
export function sameFinding(a: FoundItem, b: FoundItem): boolean {
  if (a.kind !== b.kind) return false;
  const quote = comparable(a.evidence);
  return Boolean(quote && quote === comparable(b.evidence)) || Boolean(comparable(a.summary) && comparable(a.summary) === comparable(b.summary));
}

/**
 * A review stopped at its cap and was read again with fewer recordings:
 * the urgent items it had already found in those set aside are not dropped
 * ("she's not safe tonight, call her back by 6"). Each is shown with the
 * narrowed review (unless that review found it too), tied to the set-aside
 * recordings it is from (every one of them when its quote is in none), so
 * a save is remembered there and not offered again when they are read.
 * `sourceOf`: the recordings of the first read an item's quote is in.
 */
export function carriedUrgent(items: FoundItem[], setAsideIds: string[], sourceOf: (item: FoundItem) => string[], shown: FoundItem[] = []): { found: FoundItem; ids: string[] }[] {
  const aside = new Set(setAsideIds);
  const out: { found: FoundItem; ids: string[] }[] = [];
  for (const item of items) {
    if (!item.urgent) continue;
    const from = sourceOf(item);
    const ids = from.length ? from.filter((id) => aside.has(id)) : [...setAsideIds];
    if (!ids.length) continue;
    if (shown.some((other) => sameFinding(item, other)) || out.some((other) => sameFinding(item, other.found))) continue;
    out.push({ found: item, ids });
  }
  return out;
}

/**
 * When a recording whose review failed on its own was last tried: its mark
 * is "<since> <last tried>" (an older mark has the first time only). NaN when
 * the mark cannot be read.
 */
export function lastTried(mark: string | undefined): number {
  const [since, tried] = (mark || '').split(' ');
  const at = Date.parse(tried || since || '');
  return Number.isNaN(at) ? Number.NaN : at;
}

/**
 * The mark for a recording whose review failed on its own, tried again `now`:
 * since when (kept from the first failure), and when it was last tried.
 */
export function failedMark(previous: string | undefined, now: string): string {
  const since = (previous || '').split(' ')[0];
  return `${since && !Number.isNaN(Date.parse(since)) ? since : now} ${now}`;
}

/**
 * A recording whose review failed on its own (came back incomplete, was
 * turned down, took too long) waits apart, before the review is planned: it
 * takes no room in it, so it never holds newer recordings back. `apart`
 * comes least recently tried first, so with several, each gets its turn.
 */
export function apartFromFailed<T extends { id: string }>(items: T[], marks: Record<string, string>): { others: T[]; apart: T[] } {
  const others = items.filter((item) => !marks[item.id]);
  const tried = (item: T) => {
    const at = lastTried(marks[item.id]);
    return Number.isNaN(at) ? 0 : at;
  };
  const apart = items.filter((item) => marks[item.id])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => tried(a.item) - tried(b.item) || a.index - b.index)
    .map((entry) => entry.item);
  return { others, apart };
}

/**
 * The review of the others, when it reads anything; else the recording
 * tried least recently, alone. Those still apart are counted as waiting.
 */
export function planAroundFailed<T extends { text: string; blocks: BlockLike[]; later: number; skipped: string[] }>(
  others: T, apart: unknown[], alone: (index: number) => T,
): T {
  if (others.blocks.length || !apart.length) return { ...others, later: others.later + apart.length };
  const one = alone(0);
  return { ...one, skipped: [...others.skipped, ...one.skipped], later: others.later + one.later + apart.length - 1 };
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
    phone: row.phone.trim().slice(0, 40),
    email: cleanEmail(row.email),
    aboutRelationship: row.aboutRelationship.trim().slice(0, 60),
    aboutFirstName: row.aboutFirstName.trim().slice(0, 60),
    leadSource: row.found.channel === 'call' ? 'Inbound call' : 'Unspecified',
    urgency: row.found.urgent ? 'immediate_danger' : 'none',
    note: row.text.trim().slice(0, 2000),
  };
}

export function caseEventWrite(row: ReviewRow, occurredAt: string) {
  return { id: row.ids.write, caseId: row.caseId!, kind: EVENT_KIND[row.found.channel], body: row.text.trim(), occurredAt };
}

export function partnerTouchWrite(row: ReviewRow, occurredAt: string, partnerId = row.partnerId!) {
  return { id: row.ids.write, partnerId, kind: TOUCH_KIND[row.found.channel], note: row.text.trim(), occurredAt };
}

export function followUpWrite(row: ReviewRow) {
  return {
    id: row.ids.write,
    ...(row.caseId ? { caseId: row.caseId } : {}),
    ...(row.partnerId && !row.caseId ? { partnerId: row.partnerId } : {}),
    title: row.text.trim().slice(0, 200),
    dueOn: row.dueOn,
    status: 'open' as const,
    note: row.found.missed ? 'From day review: possibly missed.' : 'From day review.',
    kind: 'follow_up' as const,
  };
}

/** `licenseNote`: the line kept when the practitioner went ahead despite a license concern. */
// The local day of a recording's time ('' when there is none).
function localDayOf(iso: string): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

export function referralWrite(row: ReviewRow, today: string, licenseNote = '') {
  const note = row.text.trim();
  // Dated the day it happened (the recording's day), as notes are; pasted notes, today.
  const happened = localDayOf(row.occurredAt);
  return {
    id: row.ids.write,
    partnerId: row.partnerId!,
    direction: row.direction === 'received' ? 'Inbound' as const : 'Outbound' as const,
    date: happened && happened <= today ? happened : today,
    clientLabel: row.clientLabel.trim().slice(0, 120),
    outcome: 'Pending' as const,
    note: licenseNote ? `${note}\n\n${licenseNote}` : note,
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

/** "Saved: 2 new leads." after Approve; '' when nothing was saved (never "Saved: Nothing to add."). */
export function savedLine(kinds: ReviewKind[]): string {
  return kinds.length ? `Saved: ${countLine(kinds)}` : '';
}

/**
 * What the review says when it stopped at its cap (20 items, the most
 * important first). `held`: the recordings nothing was listed from, read
 * again next time.
 */
export function stoppedAtCapMessage(held: number, recorder: { name: string; noun: string } | null, recordings = 0): string {
  const first = 'There was more than one review can show (20 items). These are the most important.';
  if (!recorder) return `${first} For the rest, review a shorter part of the notes.`;
  // Several recordings, all held: read again next time, fewer at a time.
  if (recordings > 1 && held >= recordings) {
    return `${first} These ${recordings} ${recorder.name} ${recorder.noun}s are read again next time, a few at a time, for the rest; what you save now is not offered again.`;
  }
  if (!held) return `${first} A few smaller items in ${recordings === 1 ? `this ${recorder.noun}` : `these ${recorder.noun}s`} may not be listed.`;
  const what = held === 1 ? `The ${recorder.name} ${recorder.noun} with nothing listed here is` : `The ${held} ${recorder.name} ${recorder.noun}s with nothing listed here are`;
  return `${first} ${what} read again next time.`;
}

/** A case's title for the review; a new lead above reads as one. */
export function caseLabel(workspace: Workspace, caseId: string): string {
  const record = workspace.cases.find((item) => item.id === caseId);
  if (!record) return 'A case';
  if (record.status === PENDING_STATUS) return `${record.title} (new lead above)`;
  return record.status === NEW_CASE_STATUS ? `${record.title} (new case)` : record.title;
}

/**
 * Where a row goes, in words: "Case: Ana Rivera — son Luis". Pass the
 * workspace with the review's new leads (withPendingLeads). A follow-up
 * names only the place it is saved: its case, or else its partner.
 */
export function destination(row: ReviewRow, workspace: Workspace): string {
  if (row.kind === 'new_lead') return 'A new case, with a first call on Today.';
  if (row.kind === 'new_partner') {
    const match = row.candidate?.useListing ? row.candidate.match : null;
    const what = match ? `Adds ${match.organization || match.name} from the Directory` : 'Adds a partner to your network';
    return `${what}, with this note on it.`;
  }
  if (row.kind === 'follow_up') {
    if (row.caseId) return `Case: ${caseLabel(workspace, row.caseId)}`;
    if (row.partnerId) return `Partner: ${partnerName(workspace, row.partnerId)}`;
    return row.noLink || (!row.caseChoices.length && !row.partnerChoices.length) ? 'Today, not linked to a case or partner.' : '';
  }
  const parts: string[] = [];
  if (row.caseId) parts.push(`Case: ${caseLabel(workspace, row.caseId)}`);
  if (row.partnerId) parts.push(`Partner: ${partnerName(workspace, row.partnerId)}`);
  return parts.join(' · ');
}
