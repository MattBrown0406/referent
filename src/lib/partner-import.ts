// Partners from contacts, a spreadsheet or a contacts file: pure rules for
// PartnerImportSheet and partner-import-api.ts (no imports, so
// scripts/partner-import-test.mjs runs them in plain node). See
// docs/PARTNER_IMPORT.md.
//
// Privacy: on the iPhone, iOS's own contact picker hands the app only the
// contact the practitioner picks (no address book permission). On the web,
// the file is read in the browser. Matching to the ReferralFit Directory
// happens here, on the device, against the listings the app already loads;
// only the rows the practitioner confirms are sent (import_partners).

export const IMPORT_TYPES = ['Inpatient', 'IOP / PHP', 'Interventionist', 'Therapist', 'Sober Living', 'Detox'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/** The most rows one import sends (the server's limit too). */
export const MAX_IMPORT_ROWS = 500;
/** The largest file read on the web. */
export const MAX_IMPORT_FILE_BYTES = 5_000_000;

/** A contact as read from the picker or a file, before any choices. */
export type RawContact = {
  name: string;
  organization: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  website: string;
  note: string;
  /** A job title or a "type" column, used only to suggest a type. */
  hint: string;
};

/** A Directory listing, as much of it as matching needs. */
export type ListingLike = {
  id: string;
  name: string;
  organization: string;
  types: string[];
  city: string;
  state: string;
  phone: string;
  email: string;
  website?: string;
};

/** A partner already in the network, as much of it as duplicate checks need. */
export type NetworkPartnerLike = {
  id: string;
  name: string;
  organization: string;
  email: string;
  phone: string;
  globalPartnerId?: string;
};

export type ImportCandidate = RawContact & {
  key: string;
  types: ImportType[];
  match: ListingLike | null;
  /** Add the Directory listing instead of the contact's own details. */
  useListing: boolean;
  /** Already in the network: shown, never sent. */
  existingPartnerId: string | null;
  include: boolean;
};

/** One row for import_partners: a Directory listing, or the practice's own contact. */
export type ImportRow =
  | { global_id: string }
  | { name: string; organization: string; types: ImportType[]; email: string; phone: string; city: string; state: string; website: string; note: string };

// ─── Cleaning ──────────────────────────────────────────────────────────────

const clip = (value: unknown, max: number): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};
const STATE_CODES = new Set(Object.values(STATES));

/** "Oregon", "or", "OR." to "OR"; anything else to ''. */
export function stateCode(value: unknown): string {
  const text = clip(value, 40).replace(/\./g, '').toLowerCase();
  if (!text) return '';
  const upper = text.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;
  return STATES[text] || '';
}

/** The last ten digits of a phone number, or '' when it has fewer. */
export function phoneKey(value: unknown): string {
  const digits = clip(value, 60).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'cox.net', 'charter.net', 'bellsouth.net', 'earthlink.net',
]);

/** A website's or a work email's domain ("www.oaks.org/x" to "oaks.org"); '' for free mail and junk. */
export function domainKey(value: unknown): string {
  const text = clip(value, 300).toLowerCase();
  if (!text) return '';
  const host = text.includes('@')
    ? text.split('@').pop() || ''
    : text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:]/)[0];
  const domain = host.replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) || FREE_MAIL.has(domain)) return '';
  return domain;
}

const ORG_NOISE = /\b(the|inc|llc|pllc|pc|corp|corporation|co|ltd|lp|group)\b/g;

/** An organization name compared loosely: case, punctuation and "Inc."/"LLC" ignored. */
export function orgKey(value: unknown): string {
  return clip(value, 200).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(ORG_NOISE, ' ').replace(/\s+/g, ' ').trim();
}

/** A website worth keeping: http(s) or a bare host name, as typed; otherwise ''. */
export function cleanWebsite(value: unknown): string {
  const text = clip(value, 300);
  if (/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}([:/?#].*)?$/i.test(text)) return text;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/.*)?$/i.test(text)) return text;
  return '';
}

export function cleanEmail(value: unknown): string {
  const text = clip(value, 254).toLowerCase().replace(/^mailto:/, '');
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? text : '';
}

export function cleanContact(raw: Partial<RawContact>): RawContact {
  return {
    name: clip(raw.name, 200),
    organization: clip(raw.organization, 200),
    email: cleanEmail(raw.email),
    phone: clip(raw.phone, 40),
    city: clip(raw.city, 100),
    state: stateCode(raw.state),
    website: cleanWebsite(raw.website),
    note: clip(raw.note, 1000),
    hint: clip(raw.hint, 200),
  };
}

// ─── Suggesting a type ─────────────────────────────────────────────────────

const TYPE_HINTS: [RegExp, ImportType][] = [
  [/\binterven/i, 'Interventionist'],
  [/\bdetox|withdrawal management/i, 'Detox'],
  [/\bsober (living|home|house)|recovery residence|transitional living/i, 'Sober Living'],
  [/\biop\b|\bphp\b|intensive outpatient|partial hospital|\boutpatient/i, 'IOP / PHP'],
  [/\b(therapist|therapy|counsel|psycholog|psychiatr|lmft|lcsw|lpc|lmhc|lcadc|ladc|cadc|marriage and family)/i, 'Therapist'],
  [/\b(treatment|rehab|residential|inpatient|recovery cent|behavioral health|wellness cent|ranch|lodge)/i, 'Inpatient'],
];

/** A type suggested by the words on the contact; [] when nothing says. A "type" column naming one wins. */
export function suggestTypes(contact: Pick<RawContact, 'name' | 'organization' | 'hint'>): ImportType[] {
  const hint = contact.hint.trim().toLowerCase();
  const named = IMPORT_TYPES.find((type) => type.toLowerCase() === hint);
  if (named) return [named];
  const words = `${contact.organization} ${contact.hint} ${contact.name}`;
  for (const [pattern, type] of TYPE_HINTS) if (pattern.test(words)) return [type];
  return [];
}

// ─── Reading a spreadsheet (CSV) ───────────────────────────────────────────

/** RFC 4180: quoted fields, "" inside quotes, CRLF or LF, a leading BOM. Blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(input);
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

type Field = keyof RawContact | 'first' | 'middle' | 'last';

const norm = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Google Contacts, Outlook, and hand-made sheets.
function headerField(header: string): Field | null {
  const h = norm(header);
  if (!h || /\b(label|type)\b/.test(h) && /\b\d+\b/.test(h)) return null; // "E-mail 1 - Label"
  if (/^(first name|given name|first)$/.test(h)) return 'first';
  if (/^(middle name|additional name|middle)$/.test(h)) return 'middle';
  if (/^(last name|family name|surname|last)$/.test(h)) return 'last';
  if (/^(name|full name|contact|contact name|display name|person|contact person)$/.test(h)) return 'name';
  if (/^(organization|organisation|organization name|organization 1 name|company|company name|program|program name|facility|agency|business|business name|practice|center|centre)$/.test(h)) return 'organization';
  if (/(^| )e ?mail( |$)/.test(h)) return 'email';
  if (/(^| )(phone|mobile|cell|telephone|tel)( |$)/.test(h) && !/fax/.test(h)) return 'phone';
  if (/(^| )city( |$)/.test(h)) return 'city';
  if (/^(state|st|region|province)$|(^| )(state|region)( |$)/.test(h)) return 'state';
  if (/^(website|web site|web page|webpage|url|site)$|website \d+ value|web page/.test(h)) return 'website';
  if (/^(type|category|partner type|level of care|kind|job title|title|organization 1 title|organization title)$/.test(h)) return 'hint';
  if (/^(note|notes|comments)$/.test(h)) return 'note';
  return null;
}

/** Contacts from a CSV with a header row; rows without a name or organization are dropped. */
export function contactsFromCsv(text: string): RawContact[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const fields = rows[0].map(headerField);
  const out: RawContact[] = [];
  for (const cells of rows.slice(1)) {
    const value: Partial<Record<Field, string>> = {};
    fields.forEach((field, index) => {
      const cell = (cells[index] || '').trim();
      if (field && cell && !value[field]) value[field] = cell;
    });
    const name = value.name || [value.first, value.middle, value.last].filter(Boolean).join(' ');
    const contact = cleanContact({ ...value, name });
    if (contact.name || contact.organization) out.push(contact);
  }
  return out;
}

// ─── Reading a contacts file (vCard) ───────────────────────────────────────

function vcardValue(raw: string): string {
  return raw.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

/** Contacts from a .vcf (Apple Contacts, Google, Outlook; vCard 2.1 to 4.0). */
export function contactsFromVcard(text: string): RawContact[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: RawContact[] = [];
  let card: Partial<Record<Field, string>> | null = null;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [prop, ...params] = head.split(';');
    const name = prop.replace(/^[^.]*\./, '').toUpperCase();
    if (name === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') { card = {}; continue; }
    if (!card) continue;
    if (name === 'END') {
      const fullName = card.name || [card.first, card.last].filter(Boolean).join(' ');
      const contact = cleanContact({ ...card, name: fullName });
      if (contact.name || contact.organization) out.push(contact);
      card = null;
      continue;
    }
    const paramText = params.join(';').toLowerCase();
    if (/encoding=quoted-printable/.test(paramText)) continue; // vCard 2.1 encodings: skipped, not misread
    const set = (field: Field, v: string, prefer = false) => {
      const cleaned = vcardValue(v).trim();
      if (cleaned && (prefer || !card![field])) card![field] = cleaned;
    };
    const preferred = /\bpref\b|type=pref|pref=1/.test(paramText);
    const work = /\bwork\b/.test(paramText);
    switch (name) {
      case 'FN': set('name', value); break;
      case 'N': {
        const [last = '', first = ''] = value.split(';');
        set('last', last); set('first', first);
        break;
      }
      case 'ORG': set('organization', value.split(';')[0]); break;
      case 'TITLE': set('hint', value); break;
      case 'EMAIL': set('email', value, preferred || work); break;
      case 'TEL': set('phone', value, preferred || work); break;
      case 'URL': set('website', value); break;
      case 'NOTE': set('note', value); break;
      case 'ADR': {
        const parts = value.split(';');
        set('city', parts[3] || '', work); set('state', parts[4] || '', work);
        break;
      }
      default: break;
    }
  }
  return out;
}

/** A file's contacts by its name or content: vCard or CSV. */
export function contactsFromFile(fileName: string, text: string): RawContact[] {
  return /\.vcf$/i.test(fileName) || /^﻿?\s*BEGIN:VCARD/i.test(text) ? contactsFromVcard(text) : contactsFromCsv(text);
}

// ─── iOS's contact picker (expo-contacts, legacy picker shape) ─────────────

type PickedContact = {
  name?: string; firstName?: string; lastName?: string; company?: string; jobTitle?: string; department?: string; note?: string;
  emails?: { email?: string; isPrimary?: boolean; label?: string }[];
  phoneNumbers?: { number?: string; isPrimary?: boolean; label?: string }[];
  addresses?: { city?: string; region?: string; label?: string }[];
  urlAddresses?: { url?: string }[];
};

function preferredOf<T extends { isPrimary?: boolean; label?: string }>(items: T[] | undefined): T | undefined {
  const list = items || [];
  return list.find((item) => item.isPrimary) || list.find((item) => /work/i.test(item.label || '')) || list[0];
}

export function contactFromPicker(picked: PickedContact | null | undefined): RawContact | null {
  if (!picked) return null;
  const address = (picked.addresses || []).find((item) => /work/i.test(item.label || '')) || (picked.addresses || [])[0];
  const contact = cleanContact({
    name: picked.name || [picked.firstName, picked.lastName].filter(Boolean).join(' '),
    organization: picked.company,
    email: preferredOf(picked.emails)?.email,
    phone: preferredOf(picked.phoneNumbers)?.number,
    city: address?.city,
    state: address?.region,
    website: (picked.urlAddresses || [])[0]?.url,
    note: '',
    hint: [picked.jobTitle, picked.department].filter(Boolean).join(' '),
  });
  return contact.name || contact.organization ? contact : null;
}

// ─── Matching ──────────────────────────────────────────────────────────────

export type DirectoryIndex = {
  byDomain: Map<string, ListingLike>;
  byPhone: Map<string, ListingLike>;
  byOrg: Map<string, ListingLike>;
};

export function directoryIndex(listings: ListingLike[]): DirectoryIndex {
  const index: DirectoryIndex = { byDomain: new Map(), byPhone: new Map(), byOrg: new Map() };
  for (const listing of listings) {
    const domain = domainKey(listing.website) || domainKey(listing.email);
    const phone = phoneKey(listing.phone);
    const org = orgKey(listing.organization);
    if (domain && !index.byDomain.has(domain)) index.byDomain.set(domain, listing);
    if (phone && !index.byPhone.has(phone)) index.byPhone.set(phone, listing);
    if (org && org.length >= 4 && !index.byOrg.has(org)) index.byOrg.set(org, listing);
  }
  return index;
}

/** The Directory listing a contact most likely is: same website or work-email domain, same phone, or same organization name. */
export function matchListing(contact: RawContact, index: DirectoryIndex): ListingLike | null {
  const domain = domainKey(contact.website) || domainKey(contact.email);
  if (domain && index.byDomain.has(domain)) return index.byDomain.get(domain)!;
  const phone = phoneKey(contact.phone);
  if (phone && index.byPhone.has(phone)) return index.byPhone.get(phone)!;
  const org = orgKey(contact.organization);
  if (org && index.byOrg.has(org)) return index.byOrg.get(org)!;
  return null;
}

/** The network partner a candidate already is, by Directory link, email, phone, or name and organization. */
export function existingPartner(contact: RawContact, match: ListingLike | null, network: NetworkPartnerLike[]): string | null {
  const email = contact.email;
  const phone = phoneKey(contact.phone);
  const org = (contact.organization || contact.name).toLowerCase();
  const name = (contact.name || contact.organization).toLowerCase();
  for (const partner of network) {
    if (match && partner.globalPartnerId && partner.globalPartnerId.toLowerCase() === match.id.toLowerCase()) return partner.id;
    if (email && partner.email && partner.email.trim().toLowerCase() === email) return partner.id;
    if (phone && phoneKey(partner.phone) === phone) return partner.id;
    if (org && partner.organization.trim().toLowerCase() === org && partner.name.trim().toLowerCase() === name) return partner.id;
  }
  return null;
}

function contactKey(contact: RawContact): string {
  return contact.email || phoneKey(contact.phone) || `${orgKey(contact.organization)}|${contact.name.toLowerCase()}`;
}

function listingTypes(listing: ListingLike): ImportType[] {
  return listing.types.filter((type): type is ImportType => (IMPORT_TYPES as readonly string[]).includes(type));
}

/**
 * Review rows for the sheet: each contact once (the same email, phone, or
 * name twice is one row), matched to the Directory, checked against the
 * network, with a suggested type. New rows come after `existing`, which keep
 * the choices already made.
 */
export function addCandidates(
  existing: ImportCandidate[],
  contacts: RawContact[],
  index: DirectoryIndex | null,
  network: NetworkPartnerLike[],
): { candidates: ImportCandidate[]; added: number; truncated: boolean } {
  const out = existing.slice();
  const seen = new Set(out.map((candidate) => candidate.key));
  let added = 0;
  let truncated = false;
  for (const contact of contacts) {
    const key = contactKey(contact);
    if (seen.has(key)) continue;
    if (out.length >= MAX_IMPORT_ROWS) { truncated = true; break; }
    seen.add(key);
    const match = index ? matchListing(contact, index) : null;
    const existingPartnerId = existingPartner(contact, match, network);
    const types = match && listingTypes(match).length ? listingTypes(match) : suggestTypes(contact);
    out.push({ ...contact, key, types, match, useListing: Boolean(match), existingPartnerId, include: !existingPartnerId });
    added += 1;
  }
  return { candidates: out, added, truncated };
}

/** A row that would be sent: included, not already a partner, and with a type (or the Directory listing). */
export function isReady(candidate: ImportCandidate): boolean {
  if (!candidate.include || candidate.existingPartnerId) return false;
  if (candidate.useListing && candidate.match) return true;
  return candidate.types.length > 0 && Boolean(candidate.name || candidate.organization);
}

export function importRows(candidates: ImportCandidate[]): ImportRow[] {
  return candidates.filter(isReady).map((candidate) => (candidate.useListing && candidate.match
    ? { global_id: candidate.match.id }
    : {
        name: candidate.name || candidate.organization,
        organization: candidate.organization || candidate.name,
        types: candidate.types,
        email: candidate.email,
        phone: candidate.phone,
        city: candidate.city,
        state: candidate.state,
        website: candidate.website,
        note: candidate.note,
      }));
}

/** The import's outcome in one line: "Added 3 partners and 2 from the Directory. 1 was already in your network." */
export function importSummary(result: { added: number; linked: number; skipped: number }): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (result.added) parts.push(plural(result.added, 'partner', 'partners'));
  if (result.linked) parts.push(`${result.linked} from the Directory`);
  const head = parts.length ? `Added ${parts.join(' and ')}.` : 'Nothing new was added.';
  return result.skipped ? `${head} ${plural(result.skipped, 'was', 'were')} already in your network or could not be added.` : head;
}
