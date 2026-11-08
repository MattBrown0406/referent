import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { bedsLine, bedTokenFrom, stepCount } from './email-rules';
import { signedOutSupabase as supabase } from './supabase';

// /b#<token>: the weekly bed check-in email's page (migration
// 20261108120000_email_alerts.sql). Signed out, like the handoff page: the
// token is in the fragment and goes only in the body of the two calls. It
// shows the program's own listing and beds, and saves through the same
// write as the portal (apply_listing_beds), recorded as the center account
// the email was sent to. Nothing about any practice or family is here.

type Status = {
  listingName: string;
  place: string;
  bedsMale: number | null;
  bedsFemale: number | null;
  updatedAt: string | null;
  stale: boolean;
  contactName: string;
  contactPhone: string;
};

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStatus(row: Row | undefined): Status | null {
  if (!row || typeof row.listing_name !== 'string') return null;
  return {
    listingName: row.listing_name,
    place: [row.city, row.state].filter((part) => typeof part === 'string' && part).join(', '),
    bedsMale: num(row.beds_male),
    bedsFemale: num(row.beds_female),
    updatedAt: typeof row.beds_updated_at === 'string' ? row.beds_updated_at : null,
    stale: row.beds_stale === true,
    contactName: typeof row.admissions_contact_name === 'string' ? row.admissions_contact_name : '',
    contactPhone: typeof row.admissions_contact_phone === 'string' ? row.admissions_contact_phone : '',
  };
}

export default function BedCheckIn() {
  const [token] = useState(() => bedTokenFrom(window.location.hash));
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState({ bedsMale: null as number | null, bedsFemale: null as number | null, contactName: '', contactPhone: '' });
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'unavailable' | 'unreachable'>('loading');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!token) { setState('unavailable'); return; }
    try {
      const { data, error } = await supabase.rpc('public_bed_link_open', { p_token: token });
      if (error) { setState((current) => (current === 'loading' ? 'unreachable' : current)); return; }
      const next = toStatus((Array.isArray(data) ? data[0] : data) as Row | undefined);
      if (!next) { setState('unavailable'); return; }
      setStatus(next);
      setForm({ bedsMale: next.bedsMale, bedsFemale: next.bedsFemale, contactName: next.contactName, contactPhone: next.contactPhone });
      setState('ready');
    } catch {
      setState((current) => (current === 'loading' ? 'unreachable' : current));
    }
  }, [token]);

  useEffect(() => {
    // Keep the token out of history entries and screenshots of the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token || !status) return;
    setState('saving');
    setMessage(null);
    try {
      const { data, error } = await supabase.rpc('public_bed_link_save', {
        p_token: token,
        p_beds_male: form.bedsMale,
        p_beds_female: form.bedsFemale,
        p_contact_name: form.contactName,
        p_contact_phone: form.contactPhone,
      });
      if (error) {
        if (error.code === 'P0002') { setState('unavailable'); return; }
        setState('ready');
        setMessage({ kind: 'error', text: error.code === '22023' ? 'Bed counts must be between 0 and 999.' : 'Not saved. Check the connection and try again.' });
        return;
      }
      const saved = (Array.isArray(data) ? data[0] : data) as Row | undefined;
      setStatus({
        ...status,
        bedsMale: form.bedsMale,
        bedsFemale: form.bedsFemale,
        updatedAt: typeof saved?.beds_updated_at === 'string' ? saved.beds_updated_at : new Date().toISOString(),
        stale: false,
        contactName: form.contactName,
        contactPhone: form.contactPhone,
      });
      setState('ready');
      setMessage({ kind: 'success', text: 'Thank you. Practices see these counts for the next 7 days.' });
    } catch {
      setState('ready');
      setMessage({ kind: 'error', text: 'Not saved. Check the connection and try again.' });
    }
  }

  if (state === 'loading') {
    return <main className="shell"><p className="handoff-muted">Loading your beds…</p></main>;
  }
  if (state === 'unreachable') {
    return (
      <main className="shell">
        <div className="brand"><h1>ReferralFit</h1></div>
        <section className="card">
          <h2>ReferralFit could not be reached</h2>
          <p className="help">Check the connection and try again. The link from your email still works.</p>
          <button type="button" className="handoff-action" onClick={() => { setState('loading'); void load(); }}>Try again</button>
        </section>
      </main>
    );
  }
  if (state === 'unavailable' || !status) {
    return (
      <main className="shell">
        <div className="brand"><h1>ReferralFit</h1></div>
        <section className="card">
          <h2>This link is not active</h2>
          <p className="help">
            Bed check-in links work for 14 days, for the account they were sent to. You can always update your beds in the
            program portal.
          </p>
          <a className="handoff-action" href="/">Sign in to the program portal</a>
        </section>
      </main>
    );
  }

  const busy = state === 'saving';
  return (
    <main className="shell">
      <div className="brand"><h1>ReferralFit</h1><span>Bed check-in</span></div>
      <form className="card" onSubmit={save}>
        <p className="handoff-eyebrow">{status.place ? `${status.listingName.toUpperCase()} · ${status.place.toUpperCase()}` : status.listingName.toUpperCase()}</p>
        <h2 className="handoff-title">Are these beds still right?</h2>
        <p className="help">
          Practices using ReferralFit see your open beds when they look for a placement. Confirming the same numbers is
          enough; change them if anything opened or filled.
        </p>
        <div className={`beds-status${status.stale && status.updatedAt ? ' stale' : ''}`}>
          {bedsLine(status.bedsMale, status.bedsFemale, status.updatedAt, status.stale)}
        </div>
        {message ? <div className={message.kind} role="status">{message.text}</div> : null}
        {(['bedsMale', 'bedsFemale'] as const).map((key) => {
          const value = form[key];
          const label = key === 'bedsMale' ? 'Beds for men' : 'Beds for women';
          return (
            <div key={key} className="stepper">
              <div className="stepper-label">
                <span>{label}</span>
                <small>{value === null ? 'Not set' : value === 0 ? 'Full' : `${value} open`}</small>
              </div>
              <div className="stepper-controls">
                <button type="button" className="step" aria-label={`Fewer ${label.toLowerCase()}`} disabled={busy || value === null || value <= 0} onClick={() => setForm({ ...form, [key]: stepCount(value, -1) })}>−</button>
                <output aria-label={label}>{value === null ? '–' : value}</output>
                <button type="button" className="step" aria-label={`More ${label.toLowerCase()}`} disabled={busy || (value ?? 0) >= 999} onClick={() => setForm({ ...form, [key]: stepCount(value, 1) })}>+</button>
              </div>
            </div>
          );
        })}
        <div className="actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => setForm({ ...form, bedsMale: 0, bedsFemale: 0 })}>We are full today</button>
        </div>
        <label>On-call admissions contact (optional)</label>
        <input value={form.contactName} placeholder="Name" maxLength={120} disabled={busy} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
        <input value={form.contactPhone} placeholder="Phone" maxLength={40} inputMode="tel" disabled={busy} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
        <div className="actions">
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Confirm beds'}</button>
        </div>
        <p className="help bed-link-foot">
          This private page is for {status.listingName} only. To change anything else, <a href="/">sign in to the program portal</a>.
        </p>
      </form>
    </main>
  );
}
