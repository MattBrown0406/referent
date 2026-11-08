import { type FormEvent, useCallback, useEffect, useState } from 'react';

import {
  type ClaimableListing,
  type MyClaimRequest,
  requestReady,
  searchable,
  toClaimableListing,
  toMyClaimRequest,
} from './claim-rules';
import { supabase } from './supabase';

// "Find your program": a signed-in account with no listing asks ReferralFit
// to let it manage one (migration 20261108150000). ReferralFit approves or
// declines in its app and the account is emailed either way; approval makes
// the portal open the listing.

type Props = {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

const EMPTY_FORM = { name: '', role: '', phone: '', note: '' };

export default function ClaimRequest({ onError, onNotice }: Props) {
  const [mine, setMine] = useState<MyClaimRequest | null | undefined>(undefined);
  const [available, setAvailable] = useState(true);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const [results, setResults] = useState<ClaimableListing[] | null>(null);
  const [chosen, setChosen] = useState<ClaimableListing | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const loadMine = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_program_claim_request');
    if (error) {
      // A server without the feature: only the claim code works.
      if (error.code === 'PGRST202' || error.code === '42883') { setAvailable(false); setMine(null); return; }
      setMine(null);
      return;
    }
    setMine(toMyClaimRequest((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null));
  }, []);

  useEffect(() => { void loadMine(); }, [loadMine]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!searchable(query)) return;
    setBusy(true);
    onError('');
    const { data, error } = await supabase.rpc('claimable_program_listings', { p_query: query.trim(), p_state: state.trim() || null });
    setBusy(false);
    if (error) { onError(error.message); return; }
    setResults((Array.isArray(data) ? data : []).map((row) => toClaimableListing(row as Record<string, unknown>)).filter((row): row is ClaimableListing => row !== null));
    setChosen(null);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!chosen || !requestReady(form)) return;
    setBusy(true);
    onError('');
    const { error } = await supabase.rpc('request_program_claim', {
      p_global_id: chosen.id, p_contact_name: form.name.trim(), p_contact_role: form.role.trim(),
      p_contact_phone: form.phone.trim(), p_note: form.note.trim(),
    });
    setBusy(false);
    if (error) { onError(error.message); return; }
    setForm(EMPTY_FORM);
    setChosen(null);
    setResults(null);
    onNotice(`Request sent. ReferralFit will email you when it is approved, usually within one business day.`);
    await loadMine();
  }

  async function cancel() {
    setBusy(true);
    const { error } = await supabase.rpc('cancel_program_claim_request');
    setBusy(false);
    if (error) { onError(error.message); return; }
    onNotice('Request cancelled.');
    await loadMine();
  }

  if (!available || mine === undefined) return null;

  if (mine?.status === 'pending') {
    return (
      <section className="card">
        <h2>Request sent</h2>
        <p className="help">
          You asked to manage <b>{mine.listingName}</b>. ReferralFit checks that you work at the program and will email you,
          usually within one business day. Once approved, this page opens your listing.
        </p>
        <div className="actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => void cancel()}>Cancel the request</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Find your program</h2>
      {mine?.status === 'declined' ? (
        <div className="error">
          Your request for {mine.listingName} was not approved.{mine.decisionNote ? ` ${mine.decisionNote}` : ''} You can ask again below,
          or reply to ReferralFit's email.
        </div>
      ) : null}
      <p className="help">
        Search for your program, ask to manage its listing, and ReferralFit approves it, usually within one business day.
        It's free. Use your email at the program's own domain to be approved fastest.
      </p>
      <form onSubmit={search} className="claim-search">
        <label>Program name or website</label>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="For example: Juniper Ridge" autoComplete="off" />
        <label>State (optional)</label>
        <input value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))} placeholder="OR" maxLength={2} autoComplete="off" />
        <div className="actions">
          <button type="submit" disabled={busy || !searchable(query)}>Search</button>
        </div>
      </form>
      {results ? (
        results.length ? (
          <ul className="claim-results">
            {results.map((listing) => (
              <li key={listing.id} className={chosen?.id === listing.id ? 'chosen' : ''}>
                <div>
                  <strong>{listing.name}</strong>
                  <small>{[listing.place, listing.website].filter(Boolean).join(' · ')}</small>
                </div>
                {listing.claimed
                  ? <span className="claim-taken">Managed by its program</span>
                  : <button type="button" className={chosen?.id === listing.id ? '' : 'ghost'} onClick={() => setChosen(listing)}>This is my program</button>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="help">
            No program found. If your program is not in the directory yet, email{' '}
            <a href="mailto:matt@freedominterventions.com?subject=Add%20our%20program%20to%20ReferralFit">matt@freedominterventions.com</a>{' '}
            with its name, city and state, website and main phone.
          </p>
        )
      ) : null}
      {chosen ? (
        <form onSubmit={send} className="claim-request-form">
          <h3>Ask to manage {chosen.name}</h3>
          <label>Your name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required autoComplete="name" />
          <label>Your role (optional)</label>
          <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} maxLength={120} placeholder="Admissions director" />
          <label>Your phone (optional)</label>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={40} inputMode="tel" autoComplete="tel" />
          <label>Anything ReferralFit should know (optional)</label>
          <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} rows={3} />
          <div className="actions">
            <button type="submit" disabled={busy || !requestReady(form)}>{busy ? 'Sending…' : 'Send request'}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setChosen(null)}>Back</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
