// Phone normalization + matching for the case-file "14 months ago" lookup.
// Pure functions, no React/Supabase imports — unit-testable in plain node.

// Strip everything except digits and a leading +. Mirrors the database's
// generated column: phone_e164 = regexp_replace(phone, '[^0-9+]', '', 'g').
export function normalizePhone(input: string): string {
  return (input || '').replace(/[^0-9+]/g, '');
}

// Digits only (drops the +) — the shape free-typed search input takes once
// normalized, since nobody types the + into a search box.
export function phoneDigits(input: string): string {
  return (input || '').replace(/\D/g, '');
}

// Does a stored contact match this phone query? Last-N-digits semantics so
// +1 / country-code prefixes on the stored number don't break a query typed
// without them: '5415550142' matches '+15415550142', and a last-4 query like
// '0142' matches any number ending in it. Returns false for queries shorter
// than 4 digits — below that, every contact in the book "matches".
export function phoneMatchesQuery(query: string, storedPhoneE164: string): boolean {
  const q = phoneDigits(query);
  if (q.length < 4) return false;
  return phoneDigits(storedPhoneE164).endsWith(q);
}

// Server-side filter clause for a phone search. PostgREST has no endsWith,
// but a trailing `%pattern` (suffix match) is exactly endsWith semantics and
// can use the case_contacts_phone_idx. Returns null when the query isn't
// phone-like at all (caller then skips the phone branch of the search).
export function phoneSearchSuffix(query: string): string | null {
  const q = phoneDigits(query);
  return q.length >= 4 ? `%${q}` : null;
}
