// Hourly coaching on an interventionist's profile (migration
// 20261108160000), as programs see it when they refer a family. Mirrors
// coachingLine in the app's src/lib/coaching.ts.

export type Coaching = { hourlyRate: number; note: string };

type Row = { global_partner_id?: unknown; coaching_offered?: unknown; coaching_hourly_rate?: unknown; coaching_note?: unknown };

/** Coaching by listing id, for the rows that offer it. */
export function coachingById(rows: unknown): Record<string, Coaching> {
  const out: Record<string, Coaching> = {};
  for (const row of (Array.isArray(rows) ? rows : []) as Row[]) {
    const rate = row.coaching_hourly_rate;
    if (row.coaching_offered === true && typeof rate === 'number' && Number.isInteger(rate) && rate > 0 && typeof row.global_partner_id === 'string') {
      out[row.global_partner_id] = { hourlyRate: rate, note: typeof row.coaching_note === 'string' ? row.coaching_note.trim() : '' };
    }
  }
  return out;
}

/** "Hourly coaching: $150/hour · By Zoom or phone". */
export function coachingLine(coaching: Coaching | undefined): string {
  if (!coaching) return '';
  return `Hourly coaching: $${coaching.hourlyRate.toLocaleString('en-US')}/hour${coaching.note ? ` · ${coaching.note}` : ''}`;
}
