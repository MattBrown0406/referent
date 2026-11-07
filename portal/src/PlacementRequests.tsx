import { useCallback, useEffect, useState } from 'react';

import {
  ACCEPT_CHOICES,
  BED_CHOICES,
  PROGRAM_INTRO,
  STATUS_LABELS,
  closedReason,
  deadlineText,
  formFromRow,
  isMissingSchema,
  payloadFromJson,
  sentOnStamp,
  summaryLines,
  timeLeft,
  validateAnswer,
  type AnswerForm,
  type CenterRequestRow,
} from './placement-rules';
import { supabase } from './supabase';

// "Placement requests": practices using ReferralFit ask a few programs at
// once whether they have a bed, would likely accept, the earliest admit date
// and the cost. This is the program's inbox: the requests addressed to its
// own listing, newest first, the de-identified summary, the asking
// practice's name, and an answer form that stays editable until the
// deadline. Opening a request marks it viewed. Expired ones read closed.
//
// Nothing here identifies the client, and a program never sees where it
// ranked or who else was asked. Answers never change any ranking, and
// programs cannot pay to be asked. Hidden on a server without the feature.

type Props = {
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

const REFRESH_MS = 60_000;

function sentText(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortLine(row: CenterRequestRow): string {
  const payload = payloadFromJson(row.payload);
  const lines = summaryLines(payload);
  const level = lines.find((line) => line.label === 'Level of care')?.value || '';
  const client = lines.find((line) => line.label === 'Client')?.value || '';
  const payment = lines.find((line) => line.label === 'Payment')?.value || '';
  return [level, client, payment].filter(Boolean).join(' · ');
}

export default function PlacementRequests({ onNotice, onError }: Props) {
  const [rows, setRows] = useState<CenterRequestRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<AnswerForm>(formFromRow(null));
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_center_placement_requests');
    if (error) {
      if (isMissingSchema(error.code)) { setAvailable(false); return; }
      onError(error.message);
      return;
    }
    setAvailable(true);
    setRows((Array.isArray(data) ? data : []) as CenterRequestRow[]);
    setNow(new Date());
  }, [onError]);

  useEffect(() => { void load(); }, [load]);
  // New requests arrive while the page is open; the time left keeps moving.
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!available || rows === null) return null;

  const open = openId ? rows.find((row) => row.recipient_id === openId) || null : null;

  async function openRequest(row: CenterRequestRow) {
    setOpenId(row.recipient_id);
    setForm(formFromRow(row));
    setProblem('');
    if (!row.viewed_at) {
      const { error } = await supabase.rpc('mark_placement_request_viewed', { p_recipient_id: row.recipient_id });
      if (!error) {
        setRows((current) => (current || []).map((item) => (item.recipient_id === row.recipient_id
          ? { ...item, viewed_at: new Date().toISOString(), status: item.status === 'sent' ? 'viewed' : item.status }
          : item)));
      }
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!open || busy) return;
    const checked = validateAnswer(form, sentOnStamp(open.sent_at));
    if ('problem' in checked) { setProblem(checked.problem); return; }
    setBusy(true);
    setProblem('');
    try {
      const { data, error } = await supabase.rpc('respond_to_placement_request', { p_recipient_id: open.recipient_id, ...checked.payload });
      if (error) throw error;
      const updated = (Array.isArray(data) ? data[0] : data) as CenterRequestRow | null;
      if (updated) setRows((current) => (current || []).map((item) => (item.recipient_id === updated.recipient_id ? updated : item)));
      onNotice(`Thank you. ${open.practice_name} sees your answer now. You can change it until ${deadlineText(open.respond_by)}.`);
    } catch (submitError) {
      setProblem((submitError as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    const payload = payloadFromJson(open.payload);
    const reason = closedReason(open);
    const answered = open.status === 'responded' || open.status === 'declined' || Boolean(open.responded_at);
    return (
      <div className="card placement">
        <button type="button" className="ghost small" onClick={() => { setOpenId(null); void load(); }}>Back to placement requests</button>
        <h2>A practice is looking for placement</h2>
        <p className="help">{PROGRAM_INTRO}</p>
        <div className="status-row">
          <span className="stat">From <b>{open.practice_name}</b></span>
          <span className="stat">Sent <b>{sentText(open.sent_at, now)}</b></span>
          {reason ? <span className="badge archived">Closed</span> : <span className="badge pending">{timeLeft(open.respond_by, now) || 'Closing'}</span>}
        </div>
        <dl className="summary">
          {summaryLines(payload).map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
        {reason ? (
          <>
            <p className="footnote">{reason}</p>
            {answered ? (
              <p className="footnote">
                Your answer: {BED_CHOICES.find((choice) => choice.value === open.bed_available)?.label || 'not given'};
                {' '}likely to accept: {ACCEPT_CHOICES.find((choice) => choice.value === open.likely_accept)?.label || 'not given'}
                {open.earliest_admit_on ? `; earliest admit ${open.earliest_admit_on.slice(0, 10)}` : ''}
                {open.daily_rate ? `; $${open.daily_rate.toLocaleString('en-US')} a day` : ''}.
              </p>
            ) : null}
          </>
        ) : (
          <form onSubmit={submit}>
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
            {problem ? <div className="error">{problem}</div> : null}
            <div className="actions">
              <button type="submit" disabled={busy}>{busy ? 'Sending' : answered ? 'Update answer' : 'Submit answer'}</button>
              <span className="stat">You can change it until <b>{deadlineText(open.respond_by)}</b></span>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="card placement">
      <h2>Placement requests</h2>
      <p className="help">
        Practices using ReferralFit ask a few programs at once whether they have a bed, would
        likely accept, and what it costs. Answer here and the practice sees your answer next to
        the others. Nothing identifies the client until the family chooses a program, and
        programs are never ranked by their answers or by payment.
      </p>
      {rows.length ? (
        <ul className="requests">
          {rows.map((row) => {
            const left = row.can_respond ? timeLeft(row.respond_by, now) : '';
            return (
              <li key={row.recipient_id}>
                <button type="button" className="request" onClick={() => { void openRequest(row); }}>
                  <span className="request-main">
                    <b>{row.practice_name}</b>
                    <span>{shortLine(row)}</span>
                    <small>Sent {sentText(row.sent_at, now)}</small>
                  </span>
                  <span className="request-side">
                    <span className={`badge ${row.can_respond ? (row.status === 'sent' ? 'pending' : 'active') : 'archived'}`}>
                      {row.can_respond ? STATUS_LABELS[row.status] : 'Closed'}
                    </span>
                    {left ? <small>{left}</small> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="footnote">No placement requests yet. When a practice asks your program, it shows up here.</p>
      )}
    </div>
  );
}
