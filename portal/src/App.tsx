import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabase';

// ReferralFit for Programs — the treatment-center side of the platform.
// A center account claims its directory listing with an admin-issued code,
// then keeps the listing accurate itself. Verification status stays with
// ReferralFit; claiming buys accuracy control, never ranking.

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
    const { data: count } = await supabase.rpc('center_listing_import_count');
    setImportCount(typeof count === 'number' ? count : null);
  }, []);

  useEffect(() => {
    if (session) void loadListing();
    else { setListing(null); setForm(null); setImportCount(null); }
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
      const { error: updateError } = await supabase
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
          insurance: csv(form.insurance),
          therapies: csv(form.therapies),
          populations: csv(form.populations),
          levels: csv(form.levels),
          description: form.description.trim(),
        })
        .eq('id', listing.id);
      if (updateError) throw updateError;
      setNotice('Listing saved.');
      await loadListing();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
              Edits go live immediately for the fields below. Verification status is
              reviewed by ReferralFit and cannot be changed here.
            </p>
          </div>
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
