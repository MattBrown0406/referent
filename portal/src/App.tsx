import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { PublicHandoff, PublicIntake, getPublicRoute } from './PublicRoutes';
import { supabase } from './supabase';

type Listing = {
  id: string;
  name: string;
  organization: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  website: string;
  monthly_cost: number;
  insurance: string[];
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
  therapies: string;
  populations: string;
  levels: string;
  description: string;
};

type AcceptingState = 'accepting' | 'limited' | 'not_accepting';
type Availability = {
  accepting_state: AcceptingState;
  levels: string[];
  response_time: string;
  public_note: string;
  confirmed_at: string;
  expires_at: string;
  version: number;
};
type AvailabilityForm = {
  acceptingState: AcceptingState;
  levels: string;
  responseTime: string;
  publicNote: string;
};

const DEFAULT_AVAILABILITY: AvailabilityForm = {
  acceptingState: 'accepting',
  levels: '',
  responseTime: 'same_day',
  publicNote: '',
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
    therapies: listing.therapies.join(', '),
    populations: listing.populations.join(', '),
    levels: listing.levels.join(', '),
    description: listing.description,
  };
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function availabilityLabel(state: AcceptingState): string {
  if (state === 'accepting') return 'Accepting referrals';
  if (state === 'limited') return 'Limited availability';
  return 'Not accepting referrals';
}

function responseLabel(value: string): string {
  const labels: Record<string, string> = {
    same_day: 'Same business day',
    within_24_hours: 'Within 24 hours',
    within_48_hours: 'Within 2 business days',
  };
  return labels[value] ?? value;
}

export default function App() {
  const route = getPublicRoute(window.location.pathname);
  if (route?.kind === 'intake') return <PublicIntake sourceId={route.value} />;
  if (route?.kind === 'handoff') return <PublicHandoff token={route.value} />;
  return <CenterPortal />;
}

function CenterPortal() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [claimCode, setClaimCode] = useState('');
  const [listing, setListing] = useState<Listing | null | 'none'>(null);
  const [form, setForm] = useState<ListingForm | null>(null);
  const [importCount, setImportCount] = useState<number | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityForm, setAvailabilityForm] = useState<AvailabilityForm>(DEFAULT_AVAILABILITY);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityError, setAvailabilityError] = useState('');
  const [availabilityNotice, setAvailabilityNotice] = useState('');
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

  const loadAvailability = useCallback(async () => {
    setAvailabilityError('');
    const { data, error: loadError } = await supabase
      .from('center_availability')
      .select('accepting_state, levels, response_time, public_note, confirmed_at, expires_at, version')
      .maybeSingle();
    if (loadError) { setAvailabilityError(loadError.message); return; }
    if (!data) {
      setAvailability(null);
      setAvailabilityForm(DEFAULT_AVAILABILITY);
      return;
    }
    const next = data as Availability;
    setAvailability(next);
    setAvailabilityForm({
      acceptingState: next.accepting_state,
      levels: (next.levels || []).join(', '),
      responseTime: next.response_time,
      publicNote: next.public_note || '',
    });
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
      .select('id, name, organization, city, state, phone, email, website, monthly_cost, insurance, therapies, populations, levels, description, status, verified_at')
      .eq('id', membership.global_partner_id)
      .maybeSingle();
    if (listingError) { setError(listingError.message); return; }
    if (!data) { setListing('none'); return; }
    const next: Listing = {
      ...data,
      organization: data.organization || '',
      website: data.website || '',
      insurance: data.insurance || [],
      therapies: data.therapies || [],
      populations: data.populations || [],
      levels: data.levels || [],
      description: data.description || '',
    };
    setListing(next);
    setForm(toForm(next));
    setAvailabilityForm((current) => current.levels ? current : { ...current, levels: next.levels.join(', ') });
    const [{ data: count }] = await Promise.all([
      supabase.rpc('center_listing_import_count'),
      loadAvailability(),
    ]);
    setImportCount(typeof count === 'number' ? count : null);
  }, [loadAvailability]);

  useEffect(() => {
    if (session) void loadListing();
    else {
      setListing(null);
      setForm(null);
      setImportCount(null);
      setAvailability(null);
      setAvailabilityForm(DEFAULT_AVAILABILITY);
    }
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

  async function saveAvailability(event: React.FormEvent) {
    event.preventDefault();
    setAvailabilityBusy(true);
    setAvailabilityError('');
    setAvailabilityNotice('');
    try {
      const levels = csv(availabilityForm.levels);
      if (!levels.length) throw new Error('Add at least one currently available level of care.');
      if (availabilityForm.publicNote.length > 180) throw new Error('Keep the public note to 180 characters or fewer.');
      const { error: saveError } = await supabase.rpc('confirm_center_availability', {
        p_accepting_state: availabilityForm.acceptingState,
        p_levels: levels,
        p_response_time: availabilityForm.responseTime,
        p_public_note: availabilityForm.publicNote.trim(),
      });
      if (saveError) throw saveError;
      await loadAvailability();
      setAvailabilityNotice('Availability saved and confirmed.');
    } catch (saveError) {
      setAvailabilityError((saveError as Error).message);
    } finally {
      setAvailabilityBusy(false);
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
      const { data: updated, error: updateError } = await supabase
        .from('global_partners')
        .update({
          name: form.name.trim(), organization: form.organization.trim(), city: form.city.trim(),
          state: form.state.trim().toUpperCase(), phone: form.phone.trim(), email: form.email.trim(),
          website: form.website.trim() || null, monthly_cost: monthly, insurance: csv(form.insurance),
          therapies: csv(form.therapies), populations: csv(form.populations), levels: csv(form.levels),
          description: form.description.trim(),
        })
        .eq('id', listing.id)
        .select('id')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new Error('The listing was not updated. Sign in again and retry.');
      setNotice('Listing saved. Its verification date was cleared until ReferralFit reviews the updated information.');
      await loadListing();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!authReady) return <div className="portal-loading" aria-label="Loading"><span className="spinner" /></div>;

  const availabilityCurrent = availability && new Date(availability.expires_at).getTime() > Date.now();

  return (
    <div className="shell">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">R</div>
        <div><h1>ReferralFit</h1><span>for Programs</span></div>
        {session ? <button className="ghost" onClick={() => void supabase.auth.signOut()}>Sign out</button> : null}
      </div>

      {error ? <div className="error" role="alert">{error}</div> : null}
      {notice ? <div className="success" role="status">{notice}</div> : null}

      {!session ? (
        <form className="card auth-card" onSubmit={submitAuth}>
          <p className="eyebrow">Program portal</p>
          <h2>{authMode === 'signin' ? 'Welcome back' : 'Create your program account'}</h2>
          <p className="help">Manage your program’s ReferralFit directory listing and current availability.</p>
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} />
          <div className="actions">
            <button type="submit" disabled={busy}>{authMode === 'signin' ? 'Sign in' : 'Create account'}</button>
            <button type="button" className="ghost" onClick={() => setAuthMode(authMode === 'signin' ? 'signup' : 'signin')}>
              {authMode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
      ) : listing === 'none' ? (
        <form className="card" onSubmit={submitClaim}>
          <p className="eyebrow">Connect your program</p>
          <h2>Claim your listing</h2>
          <p className="help">Enter the claim code from your ReferralFit contact. Claiming lets you keep your program’s information accurate. Verification and placement remain independent—listings are never ranked by payment.</p>
          <label htmlFor="claim-code">Claim code</label>
          <input id="claim-code" value={claimCode} onChange={(e) => setClaimCode(e.target.value)} required autoComplete="off" />
          <div className="actions"><button type="submit" disabled={busy || !claimCode.trim()}>Claim listing</button></div>
        </form>
      ) : listing && form ? (
        <>
          <div className="card overview-card">
            <div><p className="eyebrow">Program overview</p><h2>{listing.organization || listing.name}</h2></div>
            <div className="status-row">
              <span className={`badge ${listing.status}`}>{listing.status === 'active' ? 'Live in directory' : listing.status === 'pending' ? 'Pending review' : 'Archived'}</span>
              {listing.verified_at ? <span className="stat">Verified <b>{listing.verified_at.slice(0, 10)}</b></span> : <span className="stat">Not yet verified</span>}
              {importCount !== null ? <span className="stat"><b>{importCount}</b> {importCount === 1 ? 'practice has' : 'practices have'} added you to their network</span> : null}
            </div>
            <p className="footnote">
              Edits go live immediately for the fields below and clear the verification date
              until ReferralFit reviews the updated information. Listing status remains
              controlled by ReferralFit.
            </p>
          </div>

          <form className="card availability-card" onSubmit={saveAvailability}>
            <div className="card-heading-row">
              <div><p className="eyebrow">Admissions signal</p><h2>Availability right now</h2></div>
              <span className={`availability-pill ${availabilityCurrent ? availability.accepting_state : 'unknown'}`}>
                {availabilityCurrent ? availabilityLabel(availability.accepting_state) : 'Unknown'}
              </span>
            </div>
            <p className="help">Give referral partners a current, practical snapshot. Confirmations stay current for seven days; an expired or missing confirmation displays as Unknown.</p>
            {availability ? (
              <p className={`freshness ${availabilityCurrent ? 'fresh' : 'stale'}`}>
                {availabilityCurrent ? `Current through ${new Date(availability.expires_at).toLocaleDateString()}` : `Stale since ${new Date(availability.expires_at).toLocaleDateString()}`}
                {' · '}Last confirmed {new Date(availability.confirmed_at).toLocaleString()}
                {availabilityCurrent ? ` · ${responseLabel(availability.response_time)}` : ''}
              </p>
            ) : <p className="freshness stale">No availability has been confirmed yet.</p>}
            <div className="ranking-note"><strong>Availability never changes ranking.</strong> It is a freshness signal only.</div>
            {availabilityError ? <div className="error" role="alert">{availabilityError}</div> : null}
            {availabilityNotice ? <div className="success" role="status">{availabilityNotice}</div> : null}

            <fieldset>
              <legend>Are you accepting referrals?</legend>
              <div className="segmented-choices">
                {(['accepting', 'limited', 'not_accepting'] as AcceptingState[]).map((value) => (
                  <label className="segment" key={value}>
                    <input type="radio" name="accepting-state" value={value} checked={availabilityForm.acceptingState === value} onChange={() => setAvailabilityForm({ ...availabilityForm, acceptingState: value })} />
                    <span>{availabilityLabel(value)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label htmlFor="availability-levels">Available levels of care (comma-separated)</label>
            <input id="availability-levels" value={availabilityForm.levels} onChange={(e) => setAvailabilityForm({ ...availabilityForm, levels: e.target.value })} placeholder="Residential, PHP, IOP" required />
            <p className="input-help">Use the same level names as your listing; include only levels with space right now.</p>
            <label htmlFor="response-time">Typical admissions response time</label>
            <select id="response-time" value={availabilityForm.responseTime} onChange={(e) => setAvailabilityForm({ ...availabilityForm, responseTime: e.target.value })}>
              <option value="same_day">Same business day</option>
              <option value="within_24_hours">Within 24 hours</option>
              <option value="within_48_hours">Within 2 business days</option>
            </select>
            <label htmlFor="public-note">Short public note</label>
            <textarea id="public-note" className="short-textarea" maxLength={180} value={availabilityForm.publicNote} onChange={(e) => setAvailabilityForm({ ...availabilityForm, publicNote: e.target.value })} placeholder="For example: Call admissions to confirm bed timing." />
            <p className="input-help align-right">{availabilityForm.publicNote.length}/180</p>
            <div className="actions"><button type="submit" disabled={availabilityBusy}>{availabilityBusy ? 'Saving…' : availability ? 'Save and reconfirm' : 'Confirm availability'}</button></div>
          </form>

          <form className="card" onSubmit={saveListing}>
            <p className="eyebrow">Directory profile</p><h2>Listing details</h2>
            <div className="field-grid two-column">
              <div><label htmlFor="organization">Organization</label><input id="organization" value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} /></div>
              <div><label htmlFor="contact-name">Admissions contact name</label><input id="contact-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
              <div><label htmlFor="city">City</label><input id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
              <div><label htmlFor="state">State (2-letter)</label><input id="state" value={form.state} maxLength={2} onChange={(e) => setForm({ ...form, state: e.target.value })} /></div>
              <div><label htmlFor="phone">Phone</label><input id="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              <div><label htmlFor="listing-email">Admissions email</label><input id="listing-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            </div>
            <label htmlFor="website-url">Website</label><input id="website-url" type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            <label htmlFor="monthly-cost">Estimated monthly cost (USD)</label><input id="monthly-cost" inputMode="numeric" value={form.monthlyCost} onChange={(e) => setForm({ ...form, monthlyCost: e.target.value })} />
            <label htmlFor="insurance">Insurance carriers (comma-separated)</label><input id="insurance" value={form.insurance} onChange={(e) => setForm({ ...form, insurance: e.target.value })} />
            <label htmlFor="levels">Levels of care (comma-separated)</label><input id="levels" value={form.levels} onChange={(e) => setForm({ ...form, levels: e.target.value })} />
            <label htmlFor="populations">Populations served (comma-separated)</label><input id="populations" value={form.populations} onChange={(e) => setForm({ ...form, populations: e.target.value })} />
            <label htmlFor="therapies">Therapies (comma-separated)</label><input id="therapies" value={form.therapies} onChange={(e) => setForm({ ...form, therapies: e.target.value })} />
            <label htmlFor="description">Program description</label><textarea id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <div className="actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save listing'}</button></div>
          </form>
        </>
      ) : <div className="portal-loading"><span className="spinner" /></div>}
    </div>
  );
}
