// Pure helpers for the signed-out pages linked from ReferralFit emails
// (migration 20261108120000_email_alerts.sql, docs/EMAIL.md):
//   /b#<token>          the weekly bed check-in (BedCheckIn.tsx)
//   /u#<token>:<kind>   email settings and unsubscribe (EmailPreferences.tsx)
// Tokens travel in the fragment, so they never reach a server log or a
// Referer header; the pages send them in the body of the calls.

export type EmailKind = 'placement_response' | 'daily_summary' | 'bed_reminder';

export const EMAIL_KIND_LABELS: Record<EmailKind, { label: string; detail: string }> = {
  placement_response: {
    label: 'A program answers my placement request',
    detail: 'A short email when programs answer. Program names and client details stay in the app.',
  },
  daily_summary: {
    label: 'Morning summary',
    detail: 'Around 7 AM: how many new leads, follow-ups and answers are waiting. Counts only.',
  },
  bed_reminder: {
    label: 'Weekly bed check-in',
    detail: 'When your beds have not been confirmed in six days, at most once a week.',
  },
};

const TOKEN = /^[0-9a-f]{64}$/;

/** The 64-hex token of a /b link, or null. */
export function bedTokenFrom(hash: string): string | null {
  const token = hash.replace(/^#/, '').trim().toLowerCase();
  return TOKEN.test(token) ? token : null;
}

/** The token and, when present and known, the email kind of a /u link. */
export function preferenceLinkFrom(hash: string): { token: string; kind: EmailKind | null } | null {
  const [rawToken, rawKind] = hash.replace(/^#/, '').trim().split(':');
  const token = (rawToken || '').toLowerCase();
  if (!TOKEN.test(token)) return null;
  const kind = rawKind && rawKind in EMAIL_KIND_LABELS ? rawKind as EmailKind : null;
  return { token, kind };
}

/** The kinds a person can receive: practices get two, programs one. */
export function kindsFor(isPractice: boolean, isProgram: boolean): EmailKind[] {
  return [
    ...(isPractice ? ['placement_response', 'daily_summary'] as EmailKind[] : []),
    ...(isProgram ? ['bed_reminder'] as EmailKind[] : []),
  ];
}

export const MAX_BEDS = 999;

/** A stepper move, kept within 0..999; unset stays unset until a + press. */
export function stepCount(value: number | null, delta: number): number | null {
  if (value === null) return delta > 0 ? 1 : null;
  return Math.min(MAX_BEDS, Math.max(0, value + delta));
}

export function countWord(count: number | null, gender: 'men' | 'women'): string {
  if (count === null) return gender === 'men' ? 'men: not set' : 'women: not set';
  if (gender === 'men') return count === 1 ? '1 bed for men' : `${count} beds for men`;
  return count === 1 ? '1 bed for women' : `${count} beds for women`;
}

/** "today", "yesterday", "9 days ago". */
export function daysAgo(iso: string, now = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function bedsLine(male: number | null, female: number | null, updatedAt: string | null, stale: boolean, now = new Date()): string {
  if (!updatedAt) return 'Not set yet. Practices see nothing about your beds until you confirm a count.';
  const counts = male === 0 && female === 0 ? 'Full' : `${countWord(male, 'men')}, ${countWord(female, 'women')}`;
  const when = daysAgo(updatedAt, now);
  return stale
    ? `${counts}, last confirmed ${when}. Practices now see Unconfirmed instead of a number.`
    : `${counts}, confirmed ${when}.`;
}

/**
 * A page's token for this tab: from the link's fragment (kept in this tab's
 * sessionStorage under `key`), else the one kept earlier, so a reload or an
 * evicted Safari tab still works. A fragment that is present but not a valid
 * token clears what was kept and returns null (never an older link).
 */
export function tokenForTab<T>(key: string, hash: string, parse: (fragment: string) => T | null): T | null {
  const fragment = hash.replace(/^#/, '').trim();
  const fromHash = fragment ? parse(`#${fragment}`) : null;
  try {
    if (fromHash) {
      window.sessionStorage.setItem(key, `#${fragment}`);
      return fromHash;
    }
    if (fragment) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    const kept = window.sessionStorage.getItem(key);
    return kept ? parse(kept) : null;
  } catch {
    return fromHash;
  }
}
