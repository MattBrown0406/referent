import { friendlyStoreError } from './errors';
import { supabase } from './supabase';

// Hourly coaching on an interventionist's or therapist's directory profile
// (migration 20261108160000): whether they offer it, the hourly rate and a
// short note. The workspace owner sets it under Workspace > Your directory
// profile; it shows on their Directory card and to programs referring a
// family. Never part of matching or ranking.

export type ListingCoaching = {
  offered: boolean;
  hourlyRate: number | null;
  note: string;
};

export const NO_COACHING: ListingCoaching = { offered: false, hourlyRate: null, note: '' };
export const MAX_COACHING_RATE = 5000;
export const MAX_COACHING_NOTE = 200;

type Row = { global_partner_id?: unknown; coaching_offered?: unknown; coaching_hourly_rate?: unknown; coaching_note?: unknown };

export function mapCoaching(row: Row | null | undefined): ListingCoaching {
  if (!row) return NO_COACHING;
  const rate = typeof row.coaching_hourly_rate === 'number' && Number.isInteger(row.coaching_hourly_rate) && row.coaching_hourly_rate > 0
    ? row.coaching_hourly_rate
    : null;
  return {
    offered: row.coaching_offered === true && rate !== null,
    hourlyRate: rate,
    note: typeof row.coaching_note === 'string' ? row.coaching_note : '',
  };
}

/** "$150" or "$1,250". */
export function formatRate(rate: number): string {
  return `$${rate.toLocaleString('en-US')}`;
}

/** "Hourly coaching: $150/hour · By Zoom or phone", or '' when not offered. */
export function coachingLine(coaching: ListingCoaching | null | undefined): string {
  if (!coaching?.offered || coaching.hourlyRate === null) return '';
  const note = coaching.note.trim();
  return `Hourly coaching: ${formatRate(coaching.hourlyRate)}/hour${note ? ` · ${note}` : ''}`;
}

/** A typed rate ("150", "$150", "1,250") as whole dollars, or null when it is not one. */
export function parseCoachingRate(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d{1,4}$/.test(cleaned)) return null;
  const rate = Number(cleaned);
  return rate >= 1 && rate <= MAX_COACHING_RATE ? rate : null;
}

/** The server does not have the coaching migration yet. */
export function isMissingCoaching(error: { code?: string } | null | undefined): boolean {
  const code = error?.code;
  return code === 'PGRST202' || code === '42883' || code === '42703';
}

/** Coaching by listing id; listings that offer none are left out. Empty on an older server. */
export async function fetchListingCoaching(ids: string[]): Promise<Record<string, ListingCoaching>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return {};
  const out: Record<string, ListingCoaching> = {};
  for (let start = 0; start < unique.length; start += 200) {
    const { data, error, status } = await supabase.rpc('fetch_listing_coaching', { p_ids: unique.slice(start, start + 200) });
    if (isMissingCoaching(error)) return {};
    if (error) throw friendlyStoreError(error, status, 'Could not load coaching.');
    for (const row of (Array.isArray(data) ? data : []) as Row[]) {
      const coaching = mapCoaching(row);
      if (coaching.offered && typeof row.global_partner_id === 'string') out[row.global_partner_id] = coaching;
    }
  }
  return out;
}

/** The owner's own profile coaching (including a rate kept while turned off); null on an older server. */
export async function fetchOwnCoaching(listingId: string): Promise<ListingCoaching | null> {
  const { data, error, status } = await supabase.from('global_partners')
    .select('coaching_offered, coaching_hourly_rate, coaching_note')
    .eq('id', listingId)
    .maybeSingle();
  if (isMissingCoaching(error)) return null;
  if (error) throw friendlyStoreError(error, status, 'Could not load coaching.');
  const row = data as Row | null;
  return {
    offered: row?.coaching_offered === true,
    hourlyRate: typeof row?.coaching_hourly_rate === 'number' ? row.coaching_hourly_rate : null,
    note: typeof row?.coaching_note === 'string' ? row.coaching_note : '',
  };
}

export async function saveListingCoaching(listingId: string, offered: boolean, hourlyRate: number | null, note: string): Promise<ListingCoaching> {
  const { data, error, status } = await supabase.rpc('set_listing_coaching', {
    p_global_id: listingId,
    p_offered: offered,
    p_hourly_rate: hourlyRate,
    p_note: note.trim().slice(0, MAX_COACHING_NOTE),
  });
  if (error) throw friendlyStoreError(error, status, 'Could not save coaching.');
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  return {
    offered: row?.coaching_offered === true,
    hourlyRate: typeof row?.coaching_hourly_rate === 'number' ? row.coaching_hourly_rate : null,
    note: typeof row?.coaching_note === 'string' ? row.coaching_note : '',
  };
}
