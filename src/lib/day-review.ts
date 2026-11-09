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

// ─── Names ─────────────────────────────────────────────────────────────────

/** Letters and digits only, lower case, accents dropped. */
export function comparable(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
  const duplicate = row.partnerId && workspace.referrals.some((item) => item.partnerId === row.partnerId
    && directions.includes(item.direction) && item.date === today && (!row.caseId || !item.caseId || item.caseId === row.caseId));
  if (duplicate) {
    row.include = false;
    addHint(row, 'Already in the referral history today.');
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
  const at = Number.isNaN(Date.parse(source.at)) ? '' : new Date(source.at).toISOString();
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
 * text or its quote.
 */
export function rowSignatures(row: ReviewRow): string[] {
  const target = row.kind === 'new_lead' ? phoneKey(row.phone) || cleanEmail(row.email) || comparable(row.callerName)
    : row.kind === 'new_partner' ? orgKey(row.candidate?.organization || row.found.organization) || comparable(row.found.personName)
      : `${row.caseId || ''}|${row.partnerId || ''}`;
  const base = `${row.found.kind}|${target}`;
  const out = [`${base}|t:${comparable(row.text)}`, `${base}|s:${comparable(row.found.summary)}`];
  if (row.found.evidence) out.push(`${base}|q:${comparable(row.found.evidence)}`);
  // Whatever it is matched to now: a lead saved earlier is a case today, so
  // the same words from the notes read again become a note on it. Its
  // quote, word for word from the notes, still says it was saved.
  // Only for a lead: two other items often quote one sentence ("call Ana
  // and Sarah back tomorrow") and are still two things to save.
  const quote = comparable(row.found.evidence);
  // Two leads quoting one sentence are two callers: the caller is part of it.
  if (row.found.kind === 'new_lead' && row.found.verified && quote.split(' ').length >= 4) {
    out.push(`new_lead|any|q:${quote}|${phoneKey(row.found.phone) || cleanEmail(row.found.email) || nameWords(row.found.personName)[0] || ''}`);
  }
  return out;
}

/** Rows that were saved earlier in this review start switched off. */
export function markSavedBefore(rows: ReviewRow[], saved: Set<string>): ReviewRow[] {
  if (!saved.size) return rows;
  return rows.map((row) => {
    if (!rowSignatures(row).some((signature) => saved.has(signature))) return row;
    return { ...row, include: false, hint: row.hint ? `Saved earlier in this review. ${row.hint}` : 'Saved earlier in this review.' };
  });
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
export function referralWrite(row: ReviewRow, today: string, licenseNote = '') {
  const note = row.text.trim();
  return {
    id: row.ids.write,
    partnerId: row.partnerId!,
    direction: row.direction === 'received' ? 'Inbound' as const : 'Outbound' as const,
    date: today,
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

/** A case's title for the review; a new lead above reads as one. */
export function caseLabel(workspace: Workspace, caseId: string): string {
  const record = workspace.cases.find((item) => item.id === caseId);
  if (!record) return 'A case';
  return record.status === PENDING_STATUS ? `${record.title} (new lead above)` : record.title;
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
