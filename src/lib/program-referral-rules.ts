// Program referrals, the receiving practice's side: pure rules for
// program-referrals.ts, ProgramReferralCard and ProgramReferralSettingsCard
// (no imports, so scripts/program-referral-test.mjs runs them in plain node).
// See docs/PROGRAM_REFERRALS.md.

export type CaseProgramReferral = {
  id: string;
  fromDisplay: string;
  shareProgress: boolean;
  createdAt: string;
  /** The program is a partner in this workspace (migration 20261108180000; false on an older server). */
  inNetwork: boolean;
  /** An inbound referral from the program is in the referral history on this case. */
  logged: boolean;
  /** "Add to network and log" can work (the program is a partner, or its listing is live). */
  canLog: boolean;
};

export type ProgramReferralSettings = {
  accepts: boolean;
  canChange: boolean;
  hasProfile: boolean;
};

export const SHARED_MILESTONES = ['family reached', 'consult', 'intervention', 'entered treatment', 'not proceeding'] as const;

export function isMissingProgramReferralSchema(error: unknown): boolean {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' ? raw : undefined;
  return code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42703' || code === '42883';
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

export function caseProgramReferralFromRow(data: unknown): CaseProgramReferral | null {
  const row = firstRow(data);
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  return {
    id: row.id,
    fromDisplay: typeof row.from_display === 'string' && row.from_display.trim() ? row.from_display.trim() : 'A treatment program',
    shareProgress: row.share_progress !== false,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    inNetwork: row.in_network === true,
    logged: row.logged === true,
    canLog: row.can_log === true,
  };
}

/**
 * What the case file offers for the referral history: nothing (an older
 * server, or already logged), "Log in referral history" (the program is a
 * partner), or "Add <program> to your network and log" (it is not yet).
 */
export function ledgerAction(referral: CaseProgramReferral): 'none' | 'log' | 'add_and_log' {
  if (referral.logged || !referral.canLog) return 'none';
  return referral.inNetwork ? 'log' : 'add_and_log';
}

/** The local date (YYYY-MM-DD) of an ISO time, for the referral's date in the history. */
export function localDateOf(iso: string, fallback = new Date()): string {
  const at = iso ? new Date(iso) : fallback;
  const day = Number.isNaN(at.getTime()) ? fallback : at;
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export function programReferralSettingsFromRow(data: unknown): ProgramReferralSettings | null {
  const row = firstRow(data);
  if (!row) return null;
  return { accepts: row.accepts !== false, canChange: row.can_change === true, hasProfile: row.has_profile === true };
}

// What the switch on the case file means, in the program's own name.
export function sharingExplanation(program: string, on: boolean): string {
  return on
    ? `${program} sees this family's milestones (family reached, consult, intervention, entered treatment, not proceeding) and, if the client enters treatment, the program they entered. Never names, notes, contacts, insurance, or cost.`
    : `${program} sees only that it referred this family. Turn sharing on to let them follow milestones and where the client is placed.`;
}

export function acceptsExplanation(settings: ProgramReferralSettings): string {
  if (!settings.hasProfile) {
    return 'Treatment programs on ReferralFit find you through your directory profile. Once it is live, they can refer families who ask for help; each arrives as a new lead.';
  }
  return settings.accepts
    ? 'Treatment programs on ReferralFit can refer families who ask for help. Each arrives as a new lead with the program as its source. Referrals never affect how anyone is ranked.'
    : 'Programs see that you are not taking referrals through ReferralFit right now and are asked to contact you directly.';
}
