import type { Partner } from '../data';

// This DTO is deliberately separate from Partner. No private notes, prices,
// contacts, totals, case links, owner attribution, or referral history.
export type PublicProgramDraft = {
  organization: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  types: Partner['type'][];
  insurance: string[];
  insurance_networks: NonNullable<Partner['insuranceNetworks']>;
  therapies: string[];
  populations: string[];
  levels: string[];
  regions: string[];
};

export function publicProgramDraft(partner: Partner): PublicProgramDraft {
  return {
    organization: partner.organization,
    city: partner.city === '—' ? '' : partner.city,
    state: partner.state === '—' ? '' : partner.state,
    // Private relationship contacts are never prefilled into public fields.
    phone: '', email: '', website: partner.website || '',
    types: [...(partner.types?.length ? partner.types : [partner.type])],
    insurance: [...partner.insurance],
    insurance_networks: Object.fromEntries(Object.entries(partner.insuranceNetworks || {}).map(([key, value]) => [key, [...(value || [])]])),
    therapies: [...partner.therapies], populations: [...partner.populations],
    levels: [...partner.levels], regions: [...partner.regions],
  };
}

// Whitelist again at the network boundary, even if the runtime object has
// additional properties. The database independently rejects unknown fields.
export function programPayload(draft: PublicProgramDraft): PublicProgramDraft {
  return {
    organization: draft.organization.trim(), city: draft.city.trim(), state: draft.state.trim().toUpperCase(),
    phone: draft.phone.trim(), email: draft.email.trim(), website: draft.website.trim(),
    types: [...draft.types], insurance: [...draft.insurance], insurance_networks: draft.insurance_networks,
    therapies: [...draft.therapies], populations: [...draft.populations], levels: [...draft.levels], regions: [...draft.regions],
  };
}

export function programIdentity(organization: string, city: string, state: string): string | null {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  if (!normalize(organization) || !normalize(city) || city === '—' || !state.trim() || state === '—') return null;
  return `${normalize(organization)}|${normalize(city)}|${state.trim().toUpperCase()}`;
}

export function potentialProgramMatch(a: { organization: string; city: string; state: string; website?: string }, b: { organization: string; city: string; state: string; website?: string }): boolean {
  const identity = programIdentity(a.organization, a.city, a.state);
  if (identity && identity === programIdentity(b.organization, b.city, b.state)) return true;
  // Suggest aliases; never silently merge programs just because they share a website.
  const host = (url?: string) => { try { return new URL(url || '').hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
  return Boolean(host(a.website) && host(a.website) === host(b.website)
    && a.city.trim().toLowerCase() === b.city.trim().toLowerCase() && a.state.toUpperCase() === b.state.toUpperCase());
}
