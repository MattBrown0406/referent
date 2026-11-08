import { useCallback, useEffect, useState } from 'react';

import { EMAIL_KIND_LABELS, type EmailKind, kindsFor, preferenceLinkFrom } from './email-rules';
import { signedOutSupabase as supabase } from './supabase';

// /u#<token>:<kind>: the "Turn off these emails" page every ReferralFit email
// links to (migration 20261108120000_email_alerts.sql). Signed out. Nothing
// changes on opening the page (mail scanners open links): turning an email
// off or on takes a press.

type Prefs = Record<EmailKind, boolean>;

export default function EmailPreferences() {
  const [link] = useState(() => preferenceLinkFrom(window.location.hash));
  const [kinds, setKinds] = useState<EmailKind[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'unavailable' | 'unreachable'>('loading');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!link) { setState('unavailable'); return; }
    try {
      const { data, error } = await supabase.rpc('public_email_preferences', { p_token: link.token });
      if (error) { setState('unreachable'); return; }
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) { setState('unavailable'); return; }
      setKinds(kindsFor(row.is_practice === true, row.is_program === true));
      setPrefs({
        placement_response: row.placement_response === true,
        daily_summary: row.daily_summary === true,
        bed_reminder: row.bed_reminder === true,
      });
      setState('ready');
    } catch {
      setState('unreachable');
    }
  }, [link]);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void load();
  }, [load]);

  async function set(kind: EmailKind, value: boolean) {
    if (!link || !prefs) return;
    setState('saving');
    setMessage(null);
    try {
      const { error } = await supabase.rpc('public_email_set_preference', { p_token: link.token, p_kind: kind, p_value: value });
      if (error) {
        if (error.code === 'P0002') { setState('unavailable'); return; }
        throw error;
      }
      setPrefs({ ...prefs, [kind]: value });
      setMessage({ kind: 'success', text: value ? `Turned on: ${EMAIL_KIND_LABELS[kind].label}.` : `Turned off: ${EMAIL_KIND_LABELS[kind].label}. You will not get these emails any more.` });
    } catch {
      setMessage({ kind: 'error', text: 'Not saved. Check the connection and try again.' });
    }
    setState('ready');
  }

  if (state === 'loading') return <main className="shell"><p className="handoff-muted">Loading your email settings…</p></main>;
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
  if (state === 'unavailable' || !prefs) {
    return (
      <main className="shell">
        <div className="brand"><h1>ReferralFit</h1></div>
        <section className="card">
          <h2>This link is not active</h2>
          <p className="help">It may have been copied incompletely. Practices can change email settings in the app (Workspace and settings); programs can reply to any ReferralFit email.</p>
        </section>
      </main>
    );
  }

  const asked = link?.kind && kinds.includes(link.kind) ? link.kind : null;
  const busy = state === 'saving';
  return (
    <main className="shell">
      <div className="brand"><h1>ReferralFit</h1><span>Email settings</span></div>
      <section className="card">
        <h2>Email from ReferralFit</h2>
        {message ? <div className={message.kind} role="status">{message.text}</div> : null}
        {asked && prefs[asked] ? (
          <div className="pref-ask">
            <p className="help">Stop getting <b>{EMAIL_KIND_LABELS[asked].label.toLowerCase()}</b> emails?</p>
            <button type="button" className="handoff-action" disabled={busy} onClick={() => void set(asked, false)}>
              Turn off these emails
            </button>
          </div>
        ) : null}
        {kinds.length ? (
          <div className="pref-list" role="group" aria-label="Emails you get">
            {kinds.map((kind) => (
              <label key={kind} className="check pref-row">
                <input type="checkbox" checked={prefs[kind]} disabled={busy} onChange={(e) => void set(kind, e.target.checked)} />
                <span><strong>{EMAIL_KIND_LABELS[kind].label}</strong><small>{EMAIL_KIND_LABELS[kind].detail}</small></span>
              </label>
            ))}
          </div>
        ) : <p className="help">There are no emails to manage for this account.</p>}
        <p className="help pref-foot">Account emails (sign-in links and password resets) always go out; these settings do not affect them.</p>
      </section>
    </main>
  );
}
