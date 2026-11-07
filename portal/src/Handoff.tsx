import { useCallback, useEffect, useState } from 'react';

import { signedOutSupabase as supabase } from './supabase';

// /h#<token>: a referral handoff's page for the program that received the
// family (migration 20261106130000; the app's src/lib/handoffs.ts). Signed
// out, even in a browser signed in to the center portal (its own client
// sends no session). The token is in the fragment, so it never reaches a
// server log or a Referer header; the two calls below take it in their body,
// and it stays in memory after leaving the address bar. The page shows
// the alias the practice chose, the two names and the status, and records
// the next step. Nothing about the family is here to read.

type HandoffStatus = 'sent' | 'received' | 'contact_attempted' | 'family_reached' | 'consult_scheduled' | 'closed';

type HandoffView = {
  clientAlias: string;
  senderPractice: string;
  recipient: string;
  status: HandoffStatus;
  version: number;
  next: HandoffStatus | null;
};

export const HANDOFF_STEPS: { status: HandoffStatus; label: string; detail: string }[] = [
  { status: 'sent', label: 'Sent', detail: 'The practice referred the family to you.' },
  { status: 'received', label: 'Received', detail: 'You have the referral.' },
  { status: 'contact_attempted', label: 'Contact attempted', detail: 'You tried to reach the family.' },
  { status: 'family_reached', label: 'Family reached', detail: 'You spoke with the family.' },
  { status: 'consult_scheduled', label: 'Consult scheduled', detail: 'A consult or assessment is booked.' },
  { status: 'closed', label: 'Closed', detail: 'Nothing more to report.' },
];

const STATUSES = new Set<string>(HANDOFF_STEPS.map((step) => step.status));

export function handoffTokenFrom(hash: string): string | null {
  const token = hash.replace(/^#/, '').trim();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function label(status: HandoffStatus): string {
  return HANDOFF_STEPS.find((step) => step.status === status)?.label ?? status;
}

function stepAfter(status: HandoffStatus): HandoffStatus | null {
  const index = HANDOFF_STEPS.findIndex((step) => step.status === status);
  return index >= 0 && index < HANDOFF_STEPS.length - 1 ? HANDOFF_STEPS[index + 1].status : null;
}

type Row = {
  client_alias?: unknown; sender_practice_display?: unknown; recipient_display?: unknown;
  status?: unknown; version?: unknown; allowed_next_status?: unknown;
};

function toView(row: Row | undefined): HandoffView | null {
  if (!row || typeof row.status !== 'string' || !STATUSES.has(row.status) || typeof row.version !== 'number') return null;
  const next = typeof row.allowed_next_status === 'string' && STATUSES.has(row.allowed_next_status) ? row.allowed_next_status as HandoffStatus : null;
  return {
    clientAlias: String(row.client_alias ?? ''),
    senderPractice: String(row.sender_practice_display ?? ''),
    recipient: String(row.recipient_display ?? ''),
    status: row.status as HandoffStatus,
    version: row.version,
    next,
  };
}

export default function Handoff() {
  const [token] = useState(() => handoffTokenFrom(window.location.hash));
  const [view, setView] = useState<HandoffView | null>(null);
  // 'unreachable': the server did not answer (offline, an outage); the
  // page offers to try again. 'unavailable': it answered that no open
  // handoff has this token (revoked, or a link copied incompletely).
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'unavailable' | 'unreachable'>('loading');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // A failed read keeps a status already on screen; with nothing shown yet
  // it says whether the link is gone or the server could not be reached.
  const load = useCallback(async (): Promise<'ok' | 'gone' | 'unreachable'> => {
    if (!token) { setState('unavailable'); return 'gone'; }
    let result: 'ok' | 'gone' | 'unreachable';
    let next: HandoffView | null = null;
    try {
      const { data, error } = await supabase.rpc('public_referral_handoff_resolve', { p_token: token });
      next = error ? null : toView((Array.isArray(data) ? data[0] : data) as Row | undefined);
      result = error ? 'unreachable' : next ? 'ok' : 'gone';
    } catch {
      result = 'unreachable';
    }
    if (next) setView(next);
    setState((current) => (result === 'ok' ? 'ready' : result === 'gone' ? 'unavailable' : current === 'loading' ? 'unreachable' : 'ready'));
    return result;
  }, [token]);

  useEffect(() => {
    // Keep the token out of history entries and screenshots of the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void load();
  }, [load]);

  async function advance() {
    if (!view?.next || !token) return;
    const recorded = view.next;
    setState('saving');
    setMessage(null);
    let failure: { code?: string } | null = null;
    let saved: { status?: unknown; version?: unknown } | null = null;
    try {
      const { data, error } = await supabase.rpc('public_referral_handoff_transition', {
        p_token: token, p_expected_version: view.version, p_next_status: recorded,
      });
      failure = error;
      saved = (Array.isArray(data) ? data[0] : data) as { status?: unknown; version?: unknown } | null;
    } catch {
      failure = {};
    }
    if (failure) {
      const stale = failure.code === '40001';
      const read = await load();
      if (read !== 'gone') {
        setState('ready');
        setMessage({ kind: 'error', text: stale ? 'Someone updated this meanwhile. The latest status is shown below.' : 'The step was not saved. Check the connection and try again.' });
      }
      return;
    }
    // Saved: show it from the answer, then read again (a failed read keeps it).
    if (saved && typeof saved.version === 'number' && saved.status === recorded) {
      const version = saved.version;
      setView((current) => (current ? { ...current, status: recorded, version, next: stepAfter(recorded) } : current));
    }
    setState('ready');
    setMessage({ kind: 'success', text: `Recorded: ${label(recorded)}.` });
    await load();
  }

  if (state === 'loading' && !view) {
    return <main className="shell"><p className="handoff-muted">Loading the handoff…</p></main>;
  }
  if (state === 'unreachable' && !view) {
    return (
      <main className="shell">
        <div className="brand"><h1>ReferralFit</h1></div>
        <section className="card">
          <h2>ReferralFit could not be reached</h2>
          <p className="help">Check the connection and try again. The link still works; there is no need to ask for a new one.</p>
          <button type="button" className="handoff-action" onClick={() => { setState('loading'); void load(); }}>Try again</button>
        </section>
      </main>
    );
  }
  if (state === 'unavailable' || !view) {
    return (
      <main className="shell">
        <div className="brand"><h1>ReferralFit</h1></div>
        <section className="card">
          <h2>This handoff link is not available</h2>
          <p className="help">It may have been revoked, or the link was copied incompletely. Ask the practice that sent it for a new one.</p>
        </section>
      </main>
    );
  }

  const current = HANDOFF_STEPS.findIndex((step) => step.status === view.status);
  return (
    <main className="shell">
      <div className="brand"><h1>ReferralFit</h1><span>Referral handoff</span></div>
      <section className="card">
        <p className="handoff-eyebrow">FROM {view.senderPractice.toUpperCase()}</p>
        <h2 className="handoff-title">{view.clientAlias}</h2>
        <p className="help">
          {view.senderPractice} referred a family to {view.recipient}. Please mark each step as it happens, so they know where things stand.
          This page shows no names, contact details or clinical information, and records only the steps.
        </p>
        {message ? <div className={message.kind} role="status">{message.text}</div> : null}
        <ol className="handoff-steps" aria-label="Handoff progress">
          {HANDOFF_STEPS.map((step, index) => (
            <li key={step.status} className={index < current ? 'done' : index === current ? 'current' : ''} aria-current={index === current ? 'step' : undefined}>
              <span className="handoff-marker" aria-hidden="true">{index < current ? '✓' : index + 1}</span>
              <span><strong>{step.label}</strong><small>{step.detail}</small></span>
            </li>
          ))}
        </ol>
        {view.next ? (
          <button type="button" className="handoff-action" onClick={() => void advance()} disabled={state === 'saving'}>
            {state === 'saving' ? 'Saving…' : `Mark: ${label(view.next)}`}
          </button>
        ) : <div className="success">This handoff is closed. Thank you.</div>}
      </section>
    </main>
  );
}
