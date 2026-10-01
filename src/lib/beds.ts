// Bed availability: the client half of 20261001150000_bed_availability.sql.
//
// Pure helpers (no React, no Supabase) so scripts/bed-availability-test.mjs
// runs them in plain node. The server decides who may set beds and whether
// a count is stale (beds_stale on every read RPC); the mirror below exists
// only for rows read without that flag, and the test keeps the two numbers
// equal. Copy is deliberately plain: a program that has not updated in a
// while is "Unconfirmed", never "stale" or "out of date".

/** Mirrors public.bed_stale_days(). A count older than this shows as Unconfirmed, never as a number. */
export const BED_STALE_DAYS = 7;

/** Listing types that carry beds. Individual professionals never do. Mirrors public.listing_carries_beds(). */
export const BED_PROGRAM_TYPES = ['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox'];

export type BedGender = 'men' | 'women';
/** The match filter: which bed must be open. 'any' = a bed for anyone. */
export type BedFor = BedGender | 'any';

export type ListingBeds = {
  /** Open beds for men today. null = unknown; 0 = full. */
  bedsMale: number | null;
  /** Open beds for women today. null = unknown; 0 = full. */
  bedsFemale: number | null;
  /** When the counts were last confirmed (ISO). null = never. */
  bedsUpdatedAt: string | null;
  /** Server-computed. Missing only on rows read without the RPC; then the mirror decides. */
  bedsStale?: boolean | null;
  /** "Usually updates beds within N days". null with fewer than three updates. */
  bedsCadenceDays?: number | null;
  admissionsContactName?: string;
  admissionsContactPhone?: string;
};

export type ListingBedsRow = {
  beds_male?: number | null;
  beds_female?: number | null;
  beds_updated_at?: string | null;
  beds_stale?: boolean | null;
  beds_cadence_days?: number | null;
  admissions_contact_name?: string | null;
  admissions_contact_phone?: string | null;
};

export function mapListingBeds(row: ListingBedsRow): ListingBeds {
  return {
    bedsMale: typeof row.beds_male === 'number' ? row.beds_male : null,
    bedsFemale: typeof row.beds_female === 'number' ? row.beds_female : null,
    bedsUpdatedAt: row.beds_updated_at || null,
    bedsStale: typeof row.beds_stale === 'boolean' ? row.beds_stale : null,
    bedsCadenceDays: typeof row.beds_cadence_days === 'number' ? row.beds_cadence_days : null,
    admissionsContactName: row.admissions_contact_name || '',
    admissionsContactPhone: row.admissions_contact_phone || '',
  };
}

export function listingCarriesBeds(types: readonly string[] | undefined): boolean {
  return Boolean(types?.some((type) => BED_PROGRAM_TYPES.includes(type)));
}

/**
 * Mirror of public.listing_beds_stale(): never confirmed, or confirmed more
 * than BED_STALE_DAYS ago. Prefers the server's answer when the row has one.
 */
export function bedsAreStale(beds: Pick<ListingBeds, 'bedsUpdatedAt' | 'bedsStale'>, now: Date = new Date()): boolean {
  if (typeof beds.bedsStale === 'boolean') return beds.bedsStale;
  if (!beds.bedsUpdatedAt) return true;
  const updated = Date.parse(beds.bedsUpdatedAt);
  if (Number.isNaN(updated)) return true;
  return now.getTime() - updated > BED_STALE_DAYS * 24 * 60 * 60 * 1000;
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * What a reader may conclude from a listing's counts:
 *   unknown      never confirmed (or no linked listing): show nothing
 *   unconfirmed  confirmed, but too long ago: show "Unconfirmed", never the number
 *   full         confirmed 0 for every known gender
 *   open         at least one known gender has a bed
 */
export type BedStatusKind = 'unknown' | 'unconfirmed' | 'full' | 'open';

export function bedStatus(beds: ListingBeds | null | undefined, now: Date = new Date()): BedStatusKind {
  if (!beds || !beds.bedsUpdatedAt) return 'unknown';
  if (bedsAreStale(beds, now)) return 'unconfirmed';
  const known = [beds.bedsMale, beds.bedsFemale].filter((count): count is number => typeof count === 'number');
  if (known.length === 0) return 'unknown';
  return known.some((count) => count > 0) ? 'open' : 'full';
}

/**
 * The hard-filter answer for one requirement:
 *   true   a confirmed bed is open for that requirement
 *   false  confirmed none (hide)
 *   null   unknown or unconfirmed (keep, sort below confirmed)
 */
export function bedAvailable(beds: ListingBeds | null | undefined, bedFor: BedFor, now: Date = new Date()): boolean | null {
  if (!beds || bedStatus(beds, now) === 'unknown' || bedStatus(beds, now) === 'unconfirmed') return null;
  if (bedFor === 'any') {
    if ((beds.bedsMale ?? 0) > 0 || (beds.bedsFemale ?? 0) > 0) return true;
    // Both known and zero: full. One zero and one unknown: unknown.
    return beds.bedsMale === 0 && beds.bedsFemale === 0 ? false : null;
  }
  const count = bedFor === 'men' ? beds.bedsMale : beds.bedsFemale;
  if (count === null || count === undefined) return null;
  return count > 0;
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** "just now", "35m ago", "2h ago", "3d ago". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function countLabel(count: number, gender: BedGender): string {
  if (gender === 'men') return count === 1 ? '1 man' : `${count} men`;
  return count === 1 ? '1 woman' : `${count} women`;
}

/**
 * The one-line status for cards and detail:
 *   "Beds today: 3 men, 1 woman, updated 2h ago"
 *   "Beds today: Full, updated 2h ago"
 *   "Beds today: Unconfirmed"
 *   ""  (never confirmed: say nothing rather than shame a program)
 */
export function bedsLine(beds: ListingBeds | null | undefined, now: Date = new Date()): string {
  const status = bedStatus(beds, now);
  if (status === 'unknown' || !beds || !beds.bedsUpdatedAt) return '';
  if (status === 'unconfirmed') return 'Beds today: Unconfirmed';
  const updated = relativeTime(beds.bedsUpdatedAt, now);
  const suffix = updated ? `, updated ${updated}` : '';
  if (status === 'full') return `Beds today: Full${suffix}`;
  const parts: string[] = [];
  if (typeof beds.bedsMale === 'number') parts.push(countLabel(beds.bedsMale, 'men'));
  if (typeof beds.bedsFemale === 'number') parts.push(countLabel(beds.bedsFemale, 'women'));
  return `Beds today: ${parts.join(', ')}${suffix}`;
}

/** "Usually updates beds within 2 days" or "" when the badge is not earned yet. */
export function bedsCadenceLine(beds: Pick<ListingBeds, 'bedsCadenceDays'> | null | undefined): string {
  const days = beds?.bedsCadenceDays;
  if (typeof days !== 'number' || days < 1) return '';
  return `Usually updates beds within ${days === 1 ? '1 day' : `${days} days`}`;
}

/** The filter label shown on a pill or a packet: "a bed for men". */
export function bedForLabel(bedFor: BedFor): string {
  return bedFor === 'men' ? 'a bed for men' : bedFor === 'women' ? 'a bed for women' : 'a bed for anyone';
}

/** When the clinician turns the filter on, the client's population picks the default. */
export function bedForFromPopulation(population: string | undefined): BedFor {
  if (population === 'Men') return 'men';
  if (population === 'Women') return 'women';
  return 'any';
}
