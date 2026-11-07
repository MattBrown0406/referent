// ─── NPI check against the public NPI Registry (NPPES) ──────────────────────
// The CMS NPPES API is public data with no key:
//   https://npiregistry.cms.hhs.gov/api/?version=2.1&number=<10 digits>
// The app checks the number's check digit on the device first (Luhn with
// the 80840 prefix, integrity.ts isValidNpi), then asks the registry for the
// registered name so the person can see whether it matches the program.
// The name is a HINT, never a verification: the app stores it as
// npi_lookup_name / npi_checked_at and a credential stays pending until a
// person checks it.
//
// The fetch is injected so the tests never call the real API. Supabase's
// request deadline (supabase.ts withRequestTimeout) only wraps the Supabase
// client, so this has its own: a registry that is slow or down settles as a
// calm "try again later", and lookupNpi never throws.

import { isValidNpi, normalizeNpi } from './integrity';

export const NPPES_API = 'https://npiregistry.cms.hhs.gov/api/';
export const NPI_LOOKUP_TIMEOUT_MS = 8_000;

export function nppesLookupUrl(npi: string): string {
  return `${NPPES_API}?version=2.1&number=${encodeURIComponent(npi)}`;
}

export type NpiLookupFailure = 'invalid' | 'not_found' | 'unavailable' | 'timeout';

export type NpiLookupResult =
  | {
      ok: true;
      npi: string;
      // The registered name: the organization, or "First Last, Credential".
      name: string;
      // Other names on the record (doing business as, former names).
      otherNames: string[];
      kind: 'organization' | 'individual';
      // "Bend, OR" from the practice location, when there is one.
      place: string;
      // The primary taxonomy, e.g. "Substance Abuse Rehabilitation Facility".
      specialty: string;
      active: boolean;
      checkedAt: string;
    }
  | { ok: false; reason: NpiLookupFailure; message: string };

export const NPI_LOOKUP_MESSAGES: Record<NpiLookupFailure, string> = {
  invalid: "This NPI's check digit doesn't add up. Check the number.",
  not_found: 'The NPI Registry has no provider with this number. Check the number with the program.',
  unavailable: 'The NPI Registry could not be reached right now. Try again later, or open it in your browser.',
  timeout: 'The NPI Registry did not answer in time. Try again later, or open it in your browser.',
};

function failure(reason: NpiLookupFailure): NpiLookupResult {
  return { ok: false, reason, message: NPI_LOOKUP_MESSAGES[reason] };
}

// Registry text, made safe to show and store: no control characters,
// single spaces, at most 200 characters.
function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

type NppesRecord = {
  number?: unknown;
  enumeration_type?: unknown;
  basic?: Record<string, unknown>;
  other_names?: unknown;
  addresses?: unknown;
  taxonomies?: unknown;
};

export function parseNppesResponse(npi: string, body: unknown, checkedAt: string = new Date().toISOString()): NpiLookupResult {
  if (!body || typeof body !== 'object') return failure('unavailable');
  const value = body as { result_count?: unknown; results?: unknown; Errors?: unknown };
  if (Array.isArray(value.Errors) && value.Errors.length) return failure('not_found');
  const results = Array.isArray(value.results) ? (value.results as NppesRecord[]) : null;
  if (!results) return failure('unavailable');
  const record = results.find((item) => item && String(item.number ?? '') === npi) ?? (results.length === 1 ? results[0] : undefined);
  if (!record || typeof record !== 'object') return failure('not_found');
  const basic = record.basic && typeof record.basic === 'object' ? record.basic : {};
  const organization = record.enumeration_type === 'NPI-2' || Boolean(clean(basic.organization_name));
  let name = '';
  if (organization) {
    name = clean(basic.organization_name);
  } else {
    const person = [clean(basic.name_prefix), clean(basic.first_name), clean(basic.middle_name), clean(basic.last_name)].filter(Boolean).join(' ');
    const credential = clean(basic.credential);
    name = clean([person, credential].filter(Boolean).join(', '));
  }
  if (!name) return failure('not_found');
  const otherNames = Array.isArray(record.other_names)
    ? Array.from(new Set((record.other_names as Record<string, unknown>[])
      .map((item) => clean(item?.organization_name) || clean([item?.first_name, item?.last_name].filter(Boolean).join(' ')))
      .filter((item) => item && item !== name))).slice(0, 5)
    : [];
  const addresses = Array.isArray(record.addresses) ? (record.addresses as Record<string, unknown>[]) : [];
  const location = addresses.find((item) => item?.address_purpose === 'LOCATION') ?? addresses[0];
  const place = location ? [clean(location.city), clean(location.state)].filter(Boolean).join(', ') : '';
  const taxonomies = Array.isArray(record.taxonomies) ? (record.taxonomies as Record<string, unknown>[]) : [];
  const primary = taxonomies.find((item) => item?.primary === true) ?? taxonomies[0];
  const specialty = primary ? clean(primary.desc) : '';
  // NPPES marks an active record "A"; a deactivated one is not returned by
  // the API at all, so a missing status is read as active.
  const status = clean(basic.status);
  return {
    ok: true,
    npi,
    name,
    otherNames,
    kind: organization ? 'organization' : 'individual',
    place,
    specialty,
    active: status === '' || status === 'A',
    checkedAt,
  };
}

// Just what lookupNpi needs from fetch (React Native's and the tests' stub).
export type NpiFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type NpiLookupOptions = { timeoutMs?: number; now?: () => Date };

// Never throws. The deadline covers the whole exchange (headers and body);
// the request is aborted when it passes, and the answer is "timeout" even if
// the underlying fetch ignores the abort.
export async function lookupNpi(input: string, fetchFn: NpiFetch, options: NpiLookupOptions = {}): Promise<NpiLookupResult> {
  const npi = normalizeNpi(input);
  if (!isValidNpi(npi)) return failure('invalid');
  const timeoutMs = options.timeoutMs ?? NPI_LOOKUP_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchFn(nppesLookupUrl(npi), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller?.signal }),
      deadline,
    ]);
    if (response === 'timeout') return failure('timeout');
    if (!response || !response.ok) return failure('unavailable');
    const body = await Promise.race([response.json(), deadline]);
    if (body === 'timeout') return failure('timeout');
    return parseNppesResponse(npi, body, (options.now ? options.now() : new Date()).toISOString());
  } catch {
    return failure(controller?.signal.aborted ? 'timeout' : 'unavailable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
