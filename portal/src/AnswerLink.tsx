import { useCallback, useEffect, useState } from 'react';

import {
  ACCEPT_CHOICES,
  BED_CHOICES,
  PROGRAM_INTRO,
  answerLinkTokenFrom,
  answerLinkViewFromJson,
  answerSummary,
  closedReason,
  deadlineText,
  formFromRow,
  sentOnStamp,
  summaryLines,
  timeLeft,
  validateAnswer,
  type AnswerForm,
  type AnswerLinkView,
} from './placement-rules';
import { signedOutSupabase as supabase } from './supabase';

// /a#<token>: a placement request opened from the link in the text or email
// a practice sent to a program that does not answer in the portal
// (migration 20261108130000; the app's placementAnswerLink). Signed out,
// even in a browser signed in to the center portal (its client sends no
// session). The token is in the fragment, so it never reaches a server log
// or a Referer header. It is kept for this tab only (sessionStorage), so a
// reload still works, and taken out of the address bar.
//
// The page shows what the center inbox shows for a request: the practice's
// name, the de-identified summary, the time left, and the program's own
// answer. Nothing identifies the client; the program never sees where it
// ranked or who else was asked; answers never change any ranking.

const TOKEN_KEY = 'referralfit.answerLink.v1';
const CLAIM_PAGE = 'https://referralfit.com/programs';

function readToken(): string | null {
  const fromHash = answerLinkTokenFrom(window.location.hash);
  try {
    if (fromHash) {
      window.sessionStorage.setItem(TOKEN_KEY, fromHash);
      return fromHash;
    }
    return answerLinkTokenFrom(window.sessionStorage.getItem(TOKEN_KEY) || '');
  } catch {
    return fromHash;
  }
}

type State = 'loading' | 'ready' | 'saving' | 'unavailable' | 'unreachable';

export default function AnswerLink() {
  const [token] = useState(readToken);
  const [view, setView] = useState<AnswerLinkView | null>(null);
  const [state, setState] = useState<State>('loading');
  const [form, setForm] = useState<AnswerForm>(formFromRow(null));
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async (): Promise<AnswerLinkView | null> => {
    if (!token) { setState('unavailable'); return null; }
    try {
      const { data, error } = await supabase.rpc('public_placement_answer_open', { p_token: token });
      if (error) {
        setState((current) => (current === 'loading' ? 'unreachable' : 'ready'));
        return null;
      }
      const next = answerLinkViewFromJson(data);
      if (!next) { setState('unavailable'); return null; }
      setView(next);
      setNow(new Date());
      setState('ready');
      return next;
    } catch {
      setState((current) => (current === 'loading' ? 'unreachable' : 'ready'));
      return null;
    }
  }, [token]);

  useEffect(() => {
    // Keep the token out of history entries and screenshots of the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void load().then((first) => { if (first) setForm(formFromRow(first.answer)); });
  }, [load]);

  // The time left keeps moving while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!view || !token || state === 'saving') return;
    const checked = validateAnswer(form, sentOnStamp(view.sentAt));
    if ('problem' in checked) { setProblem(checked.problem); return; }
    setState('saving');
    setProblem('');
    setNotice('');
    try {
      const { data, error } = await supabase.rpc('public_placement_answer_respond', { p_token: token, ...checked.payload });
      if (error) {
        setProblem(error.message || 'The answer was not saved. Check the connection and try again.');
        await load();
        setState('ready');
        return;
      }
      const saved = answerLinkViewFromJson(data);
      if (saved) {
        setView(saved);
        setForm(formFromRow(saved.answer));
      }
      setState('ready');
      setNotice(`Thank you. ${(saved || view).practiceName} sees your answer now. You can change it until ${deadlineText(view.respondBy)}.`);
    } catch {
      setState('ready');
      setProblem('The answer was not saved. Check the connection and try again.');
    }
  }

  if (state === 'loading' && !view) {
    return <main className="shell"><p className="handoff-muted">Loading the request…</p></main>;
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
          <h2>This link is not active</h2>
          <p className="help">
            The link may have been copied incompletely, or the practice sent a newer one. Open the newest message from the
            practice, or reply to them directly.
          </p>
        </section>
      </main>
    );
  }

  const reason = closedReason({ can_respond: view.canRespond, request_status: view.requestStatus });
  const left = view.canRespond ? timeLeft(view.respondBy, now) : '';
  const given = answerSummary(view.answer);
  return (
    <main className="shell">
      <div className="brand"><h1>ReferralFit</h1><span>Placement request</span></div>
      <section className="card placement answer-link">
        <p className="handoff-eyebrow">FROM {view.practiceName.toUpperCase()}</p>
        <h2 className="handoff-title">Can {view.programName} take this client?</h2>
        <p className="help">{PROGRAM_INTRO}</p>
        <div className="status-row">
          {reason ? <span className="badge archived">Closed</span> : <span className="badge pending">{left || 'Closing'}</span>}
          {view.answer ? <span className="badge active">Answered</span> : null}
        </div>
        <dl className="summary">
          {summaryLines(view.payload).map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
        {notice ? <div className="success" role="status">{notice}</div> : null}
        {reason ? (
          <>
            <p className="footnote">{reason}</p>
            {given ? <p className="footnote">Your answer: {given}.</p> : null}
          </>
        ) : (
          <form onSubmit={submit}>
            {given && !notice ? <p className="footnote">Your answer so far: {given}. Change anything below and update it.</p> : null}
            <label>Do you have a bed?</label>
            <div className="choices">
              {BED_CHOICES.map((choice) => (
                <label key={choice.value} className="check">
                  <input type="radio" name="bed" checked={form.bed === choice.value} onChange={() => setForm({ ...form, bed: choice.value })} />
                  {choice.label}
                </label>
              ))}
            </div>
            <label>Would you likely accept this client?</label>
            <div className="choices">
              {ACCEPT_CHOICES.map((choice) => (
                <label key={choice.value} className="check">
                  <input type="radio" name="likely" checked={form.likely === choice.value} onChange={() => setForm({ ...form, likely: choice.value })} />
                  {choice.label}
                </label>
              ))}
            </div>
            <label>Earliest admit date (optional)</label>
            <input type="date" value={form.admitOn} onChange={(e) => setForm({ ...form, admitOn: e.target.value })} />
            <label>Daily rate in dollars (optional)</label>
            <input inputMode="numeric" value={form.dailyRate} placeholder="For example 950" onChange={(e) => setForm({ ...form, dailyRate: e.target.value })} />
            <label>Cost note (optional)</label>
            <input value={form.costNote} maxLength={200} placeholder="For example: in-network with most plans" onChange={(e) => setForm({ ...form, costNote: e.target.value })} />
            <label>Note to the practice (optional)</label>
            <textarea value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            {problem ? <div className="error" role="alert">{problem}</div> : null}
            <button type="submit" className="handoff-action answer-submit" disabled={state === 'saving'}>
              {state === 'saving' ? 'Sending…' : view.answer ? 'Update answer' : 'Send answer'}
            </button>
            <p className="footnote">You can change your answer until <b>{deadlineText(view.respondBy)}</b>. No account needed.</p>
          </form>
        )}
      </section>
      <p className="footnote answer-claim">
        Answer every request in one place: <a href={CLAIM_PAGE}>claim your program&apos;s free listing on ReferralFit</a>.
      </p>
    </main>
  );
}
