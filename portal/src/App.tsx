import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabase';

// ReferralFit for Programs — the treatment-center side of the platform.
// A center account claims its directory listing with an admin-issued code,
// then keeps the listing accurate itself. Verification status stays with
// ReferralFit; claiming buys accuracy control, never ranking.

// Mirrors public.is_valid_insurance_networks: each carrier maps to one or
// both of these labels. The app's partner form and referral matching use the
// same two values.
type NetworkStatus = 'In-network' | 'Out-of-network';
type InsuranceNetworks = Record<string, NetworkStatus[]>;

const NETWORK_STATUSES: NetworkStatus[] = ['In-network', 'Out-of-network'];

type Listing = {
  id: string;
  name: string;
  organization: string;
  types: string[];
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  monthly_cost: number;
  insurance: string[];
  insurance_networks: InsuranceNetworks;
  therapies: string[];
  populations: string[];
  levels: string[];
  description: string;
  status: 'active' | 'pending' | 'archived';
  verified_at: string | null;
};

type ListingForm = {
  name: string;
  organization: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  monthlyCost: string;
  insurance: string;
  insuranceNetworks: InsuranceNetworks;
  therapies: string;
  populations: string;
  levels: string;
  description: string;
};

function toForm(listing: Listing): ListingForm {
  return {
    name: listing.name,
    organization: listing.organization,
    city: listing.city,
    state: listing.state,
    phone: listing.phone,
    email: listing.email,
    website: listing.website || '',
    monthlyCost: listing.monthly_cost ? String(listing.monthly_cost) : '',
    insurance: listing.insurance.join(', '),
    insuranceNetworks: listing.insurance_networks,
    therapies: listing.therapies.join(', '),
    populations: listing.populations.join(', '),
    levels: listing.levels.join(', '),
    description: listing.description,
  };
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

// ─── Beds available today ────────────────────────────────────────────────────
// Mirrors public.fetch_listing_beds / public.set_listing_beds
// (20261001150000_bed_availability.sql). Only treatment programs carry beds;
// the server decides staleness (beds_stale) so the portal never computes it.

const BED_PROGRAM_TYPES = ['Inpatient', 'IOP / PHP', 'Sober Living', 'Detox'];
const MAX_BEDS = 999;

type BedsStatus = {
  beds_male: number | null;
  beds_female: number | null;
  beds_updated_at: string | null;
  beds_stale: boolean;
  beds_cadence_days: number | null;
  admissions_contact_name: string;
  admissions_contact_phone: string;
};

type BedsForm = {
  bedsMale: number | null;
  bedsFemale: number | null;
  contactName: string;
  contactPhone: string;
};

type BedHistoryRow = {
  id: string;
  updated_at: string;
  beds_male: number | null;
  beds_female: number | null;
};

function carriesBeds(types: string[]): boolean {
  return types.some((type) => BED_PROGRAM_TYPES.includes(type));
}

function toBedsForm(status: BedsStatus | null): BedsForm {
  return {
    bedsMale: status?.beds_male ?? null,
    bedsFemale: status?.beds_female ?? null,
    contactName: status?.admissions_contact_name || '',
    contactPhone: status?.admissions_contact_phone || '',
  };
}

// "just now", "35m ago", "2h ago", "3d ago"
function relativeTime(iso: string, now = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function countWord(count: number | null, gender: 'men' | 'women'): string {
  if (count === null) return gender === 'men' ? 'men: not set' : 'women: not set';
  if (gender === 'men') return count === 1 ? '1 man' : `${count} men`;
  return count === 1 ? '1 woman' : `${count} women`;
}

function bedsSummary(status: BedsStatus): string {
  if (!status.beds_updated_at) return 'Not set yet. Interventionists see nothing about beds until you confirm a count.';
  if (status.beds_stale) return 'Unconfirmed. Your last count is more than seven days old, so the directory shows Unconfirmed instead of a number.';
  if (status.beds_male === 0 && status.beds_female === 0) return `Full, confirmed ${relativeTime(status.beds_updated_at)}.`;
  return `${[countWord(status.beds_male, 'men'), countWord(status.beds_female, 'women')].join(', ')}, confirmed ${relativeTime(status.beds_updated_at)}.`;
}

// Carriers as typed, trimmed and deduplicated, so each gets exactly one
// network-status row and exactly one key in the saved payload.
function carriersOf(value: string): string[] {
  return Array.from(new Set(csv(value)));
}

// A carrier the program has not classified yet defaults to In-network,
// matching the app's Add/Edit Partner form and the partners-table trigger.
function statusesFor(networks: InsuranceNetworks, carrier: string): NetworkStatus[] {
  const explicit = networks[carrier];
  return explicit === undefined ? ['In-network'] : explicit;
}

// The payload the database accepts: only carriers still listed, each with the
// statuses chosen for it. Choices for carriers that were removed are dropped.
function buildInsuranceNetworks(form: ListingForm): InsuranceNetworks {
  return Object.fromEntries(
    carriersOf(form.insurance).map((carrier) => [carrier, statusesFor(form.insuranceNetworks, carrier)]),
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [claimCode, setClaimCode] = useState('');
  const [listing, setListing] = useState<Listing | null | 'none'>(null);
  const [form, setForm] = useState<ListingForm | null>(null);
  const [importCount, setImportCount] = useState<number | null>(null);
  const [beds, setBeds] = useState<BedsStatus | null>(null);
  const [bedsForm, setBedsForm] = useState<BedsForm>(toBedsForm(null));
  const [bedHistory, setBedHistory] = useState<BedHistoryRow[]>([]);
  const [bedsBusy, setBedsBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setAuthReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadListing = useCallback(async () => {
    setError('');
    const { data: membership, error: memberError } = await supabase
      .from('center_members')
      .select('global_partner_id')
      .maybeSingle();
    if (memberError) { setError(memberError.message); return; }
    if (!membership) { setListing('none'); return; }
    const { data, error: listingError } = await supabase
      .from('global_partners')
      .select('id, name, organization, types, city, state, phone, email, website, monthly_cost, insurance, insurance_networks, therapies, populations, levels, description, status, verified_at')
      .eq('id', membership.global_partner_id)
      .maybeSingle();
    if (listingError) { setError(listingError.message); return; }
    if (!data) { setListing('none'); return; }
    const next: Listing = {
      ...data,
      organization: data.organization || '',
      types: data.types || [],
      website: data.website || '',
      insurance: data.insurance || [],
      insurance_networks: (data.insurance_networks as InsuranceNetworks | null) || {},
      therapies: data.therapies || [],
      populations: data.populations || [],
      levels: data.levels || [],
      description: data.description || '',
    };
    setListing(next);
    setForm(toForm(next));
    const { data: count } = await supabase.rpc('center_listing_import_count');
    setImportCount(typeof count === 'number' ? count : null);
    await loadBeds(next);
  }, []);

  // Bed status and the last five confirmations. Both degrade to "not
  // available yet" when the server does not have the migration.
  async function loadBeds(current: Listing) {
    if (!carriesBeds(current.types)) { setBeds(null); setBedHistory([]); return; }
    const { data: status } = await supabase.rpc('fetch_listing_beds', { p_ids: [current.id] });
    const row = Array.isArray(status) ? (status[0] as BedsStatus | undefined) : undefined;
    const nextStatus: BedsStatus | null = row
      ? {
        beds_male: typeof row.beds_male === 'number' ? row.beds_male : null,
        beds_female: typeof row.beds_female === 'number' ? row.beds_female : null,
        beds_updated_at: row.beds_updated_at || null,
        beds_stale: Boolean(row.beds_stale),
        beds_cadence_days: typeof row.beds_cadence_days === 'number' ? row.beds_cadence_days : null,
        admissions_contact_name: row.admissions_contact_name || '',
        admissions_contact_phone: row.admissions_contact_phone || '',
      }
      : null;
    setBeds(nextStatus);
    setBedsForm(toBedsForm(nextStatus));
    const { data: history } = await supabase
      .from('listing_bed_updates')
      .select('id, updated_at, beds_male, beds_female')
      .eq('global_partner_id', current.id)
      .order('updated_at', { ascending: false })
      .limit(5);
    setBedHistory((history as BedHistoryRow[] | null) || []);
  }

  useEffect(() => {
    if (session) void loadListing();
    else { setListing(null); setForm(null); setImportCount(null); setBeds(null); setBedHistory([]); }
  }, [session, loadListing]);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (authMode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        setNotice('Account created. If email confirmation is enabled, confirm before signing in.');
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitClaim(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { error: claimError } = await supabase.rpc('claim_center_listing', { p_code: claimCode.trim().toLowerCase() });
      if (claimError) throw claimError;
      setClaimCode('');
      setNotice('Listing claimed. Keep it accurate — that is what families and interventionists see.');
      await loadListing();
    } catch (claimException) {
      setError((claimException as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveListing(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !listing || listing === 'none') return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const monthly = form.monthlyCost.trim() === '' ? 0 : Number(form.monthlyCost);
      if (!Number.isInteger(monthly) || monthly < 0) throw new Error('Monthly cost must be a whole dollar amount.');
      const insuranceNetworks = buildInsuranceNetworks(form);
      const unclassified = Object.keys(insuranceNetworks).find((carrier) => insuranceNetworks[carrier].length === 0);
      if (unclassified) {
        throw new Error(`Choose In-network, Out-of-network, or both for ${unclassified} before saving.`);
      }
      const { data: updated, error: updateError } = await supabase
        .from('global_partners')
        .update({
          name: form.name.trim(),
          organization: form.organization.trim(),
          city: form.city.trim(),
          state: form.state.trim().toUpperCase(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          website: form.website.trim() || null,
          monthly_cost: monthly,
          insurance: carriersOf(form.insurance),
          insurance_networks: insuranceNetworks,
          therapies: csv(form.therapies),
          populations: csv(form.populations),
          levels: csv(form.levels),
          description: form.description.trim(),
        })
        .eq('id', listing.id)
        .select('id')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new Error('The listing was not updated. Sign in again and retry.');
      setNotice('Listing saved. Your listing is the authoritative record for your program, so edits publish immediately and it stays verified.');
      await loadListing();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Confirming beds re-stamps the count even when the numbers did not change;
  // that is the point: a confirmed count stays current for seven days.
  async function saveBeds(event: React.FormEvent) {
    event.preventDefault();
    if (!listing || listing === 'none') return;
    setBedsBusy(true);
    setError('');
    setNotice('');
    try {
      const { error: bedsError } = await supabase.rpc('set_listing_beds', {
        p_global_id: listing.id,
        p_beds_male: bedsForm.bedsMale,
        p_beds_female: bedsForm.bedsFemale,
        p_contact_name: bedsForm.contactName.trim(),
        p_contact_phone: bedsForm.contactPhone.trim(),
      });
      if (bedsError) throw bedsError;
      setNotice('Beds confirmed. Interventionists see this count for the next seven days.');
      await loadBeds(listing);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBedsBusy(false);
    }
  }

  function stepBeds(key: 'bedsMale' | 'bedsFemale', delta: number) {
    setBedsForm((current) => {
      const next = Math.min(MAX_BEDS, Math.max(0, (current[key] ?? 0) + delta));
      return { ...current, [key]: next };
    });
  }

  function toggleNetworkStatus(carrier: string, status: NetworkStatus) {
    if (!form) return;
    const current = statusesFor(form.insuranceNetworks, carrier);
    const next = current.includes(status)
      ? current.filter((item) => item !== status)
      : NETWORK_STATUSES.filter((item) => item === status || current.includes(item));
    setForm({ ...form, insuranceNetworks: { ...form.insuranceNetworks, [carrier]: next } });
  }

  // "We bill out-of-network for all carriers listed": checking adds
  // Out-of-network to every carrier and leaves In-network as it is. Unchecking
  // removes Out-of-network again; a carrier that would be left with nothing
  // falls back to In-network so the listing never saves an empty status.
  function setOutOfNetworkForAll(enabled: boolean) {
    if (!form) return;
    const next: InsuranceNetworks = { ...form.insuranceNetworks };
    for (const carrier of carriersOf(form.insurance)) {
      const current = statusesFor(form.insuranceNetworks, carrier);
      if (enabled) {
        next[carrier] = NETWORK_STATUSES.filter((item) => item === 'Out-of-network' || current.includes(item));
      } else {
        const without = current.filter((item) => item !== 'Out-of-network');
        next[carrier] = without.length ? without : ['In-network'];
      }
    }
    setForm({ ...form, insuranceNetworks: next });
  }

  const carriers = form ? carriersOf(form.insurance) : [];
  const allOutOfNetwork = carriers.length > 0
    && carriers.every((carrier) => statusesFor(form!.insuranceNetworks, carrier).includes('Out-of-network'));

  if (!authReady) return null;

  return (
    <div className="shell">
      <div className="brand">
        <h1>ReferralFit</h1>
        <span>for Programs</span>
        {session ? (
          <button className="ghost" onClick={() => void supabase.auth.signOut()}>Sign out</button>
        ) : null}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="success">{notice}</div> : null}

      {!session ? (
        <form className="card" onSubmit={submitAuth}>
          <h2>{authMode === 'signin' ? 'Sign in' : 'Create your program account'}</h2>
          <p className="help">
            Manage your program's listing in the ReferralFit directory — the placement
            directory interventionists use to match clients to clinically appropriate care.
          </p>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} />
          <div className="actions">
            <button type="submit" disabled={busy}>{authMode === 'signin' ? 'Sign in' : 'Create account'}</button>
            <button type="button" className="ghost" onClick={() => setAuthMode(authMode === 'signin' ? 'signup' : 'signin')}>
              {authMode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
      ) : listing === 'none' ? (
        <form className="card" onSubmit={submitClaim}>
          <h2>Claim your listing</h2>
          <p className="help">
            Enter the claim code from your ReferralFit contact. Claiming lets you keep
            your program's levels of care, insurance panels, and admissions contacts
            accurate. Verification and placement in the directory remain independent —
            listings are never ranked by payment.
          </p>
          <label>Claim code</label>
          <input value={claimCode} onChange={(e) => setClaimCode(e.target.value)} required autoComplete="off" />
          <div className="actions">
            <button type="submit" disabled={busy || !claimCode.trim()}>Claim listing</button>
          </div>
        </form>
      ) : listing && form ? (
        <>
          <div className="card">
            <h2>{listing.organization || listing.name}</h2>
            <div className="status-row">
              <span className={`badge ${listing.status}`}>
                {listing.status === 'active' ? 'Live in directory' : listing.status === 'pending' ? 'Pending review' : 'Archived'}
              </span>
              {listing.verified_at ? <span className="stat">Verified <b>{listing.verified_at.slice(0, 10)}</b></span> : <span className="stat">Not yet verified</span>}
              {importCount !== null ? <span className="stat"><b>{importCount}</b> {importCount === 1 ? 'practice has' : 'practices have'} added you to their network</span> : null}
            </div>
            <p className="footnote">
              You claimed this listing, so it is the authoritative record for your program.
              Edits to the fields below go live immediately, flow to every practice that added
              you to their network, and keep the listing verified. Listing status remains
              controlled by ReferralFit.
            </p>
          </div>
          {carriesBeds(listing.types) ? (
            <form className="card beds" onSubmit={saveBeds}>
              <h2>Beds available today</h2>
              <p className="help">
                Tell interventionists what is open right now, for men and for women. A count
                shows in the directory and in match results for seven days, then reads as
                Unconfirmed until you confirm it again. Confirming the same numbers is enough.
              </p>
              <div className={`beds-status${beds?.beds_stale && beds.beds_updated_at ? ' stale' : ''}`}>
                {beds ? bedsSummary(beds) : 'Bed availability is not available on the server yet.'}
                {beds?.beds_cadence_days ? <span className="stat"> Usually updates beds within <b>{beds.beds_cadence_days === 1 ? '1 day' : `${beds.beds_cadence_days} days`}</b>.</span> : null}
              </div>
              {(['bedsMale', 'bedsFemale'] as const).map((key) => {
                const value = bedsForm[key];
                const label = key === 'bedsMale' ? 'Beds for men' : 'Beds for women';
                return (
                  <div key={key} className="stepper">
                    <div className="stepper-label">
                      <span>{label}</span>
                      <small>{value === null ? 'Not set' : value === 0 ? 'Full' : `${value} open`}</small>
                    </div>
                    <div className="stepper-controls">
                      <button type="button" className="step" aria-label={`Fewer ${label.toLowerCase()}`} disabled={bedsBusy || value === null || value <= 0} onClick={() => stepBeds(key, -1)}>−</button>
                      <output aria-label={label}>{value === null ? '–' : value}</output>
                      <button type="button" className="step" aria-label={`More ${label.toLowerCase()}`} disabled={bedsBusy || (value ?? 0) >= MAX_BEDS} onClick={() => stepBeds(key, 1)}>+</button>
                      <button type="button" className="ghost small" disabled={bedsBusy || value === null} onClick={() => setBedsForm({ ...bedsForm, [key]: null })}>Not set</button>
                    </div>
                  </div>
                );
              })}
              <div className="actions">
                <button type="button" className="ghost" disabled={bedsBusy} onClick={() => setBedsForm({ ...bedsForm, bedsMale: 0, bedsFemale: 0 })}>We are full today</button>
              </div>
              <label>On-call admissions contact (optional)</label>
              <input value={bedsForm.contactName} placeholder="Name" maxLength={120} onChange={(e) => setBedsForm({ ...bedsForm, contactName: e.target.value })} />
              <input value={bedsForm.contactPhone} placeholder="Phone" maxLength={40} inputMode="tel" onChange={(e) => setBedsForm({ ...bedsForm, contactPhone: e.target.value })} />
              <div className="actions">
                <button type="submit" disabled={bedsBusy || !beds}>{bedsBusy ? 'Saving' : 'Confirm beds'}</button>
                {beds?.beds_updated_at ? <span className="stat">Last updated <b>{relativeTime(beds.beds_updated_at)}</b></span> : null}
              </div>
              {bedHistory.length ? (
                <div className="history">
                  <label>Recent confirmations</label>
                  <ul>
                    {bedHistory.map((row) => (
                      <li key={row.id}>
                        <span>{row.updated_at.slice(0, 16).replace('T', ' ')}</span>
                        <span>{row.beds_male === 0 && row.beds_female === 0 ? 'Full' : `${countWord(row.beds_male, 'men')}, ${countWord(row.beds_female, 'women')}`}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </form>
          ) : null}
          <form className="card" onSubmit={saveListing}>
            <h2>Listing details</h2>
            <label>Organization</label>
            <input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} />
            <label>Admissions contact name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <label>City</label>
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            <label>State (2-letter)</label>
            <input value={form.state} maxLength={2} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            <label>Phone</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <label>Admissions email</label>
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <label>Website</label>
            <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            <label>Estimated monthly cost (USD)</label>
            <input inputMode="numeric" value={form.monthlyCost} onChange={(e) => setForm({ ...form, monthlyCost: e.target.value })} />
            <label>Insurance carriers (comma-separated)</label>
            <input value={form.insurance} onChange={(e) => setForm({ ...form, insurance: e.target.value })} />
            {carriers.length ? (
              <div className="networks">
                <label>Network status for each carrier</label>
                <p className="help">
                  Families and referring practices filter placements by network status, so if
                  your program bills a carrier out-of-network, say so here. Choose one or both
                  for every carrier.
                </p>
                <label className="check all">
                  <input type="checkbox" checked={allOutOfNetwork} onChange={(e) => setOutOfNetworkForAll(e.target.checked)} />
                  We bill out-of-network for all carriers listed
                </label>
                {carriers.map((carrier) => {
                  const statuses = statusesFor(form.insuranceNetworks, carrier);
                  return (
                    <div key={carrier} className={`network-row${statuses.length ? '' : ' missing'}`}>
                      <span className="carrier">{carrier}</span>
                      {NETWORK_STATUSES.map((status) => (
                        <label key={status} className="check">
                          <input type="checkbox" checked={statuses.includes(status)} onChange={() => toggleNetworkStatus(carrier, status)} />
                          {status}
                        </label>
                      ))}
                      {statuses.length ? null : <span className="warn">Choose at least one</span>}
                    </div>
                  );
                })}
              </div>
            ) : null}
            <label>Levels of care (comma-separated)</label>
            <input value={form.levels} onChange={(e) => setForm({ ...form, levels: e.target.value })} />
            <label>Populations served (comma-separated)</label>
            <input value={form.populations} onChange={(e) => setForm({ ...form, populations: e.target.value })} />
            <label>Therapies (comma-separated)</label>
            <input value={form.therapies} onChange={(e) => setForm({ ...form, therapies: e.target.value })} />
            <label>Program description</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <div className="actions">
              <button type="submit" disabled={busy}>Save listing</button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
