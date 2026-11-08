import { useCallback, useEffect, useState } from 'react';

import {
  CONSENT_TEXT,
  FIELD_LIMITS,
  RECEIVE_STATUS_TEXT,
  SAFETY_TEXT,
  durationText,
  emptyReferralForm,
  isMissingSchema,
  milestoneText,
  placeText,
  statsLine,
  validateReferral,
  type ReferralForm,
  type ReferralRow,
  type StatsRow,
  type TargetRow,
} from './program-referral-rules';
import { supabase } from './supabase';

// "Refer a family": a program refers a family that asked for help to an
// interventionist on ReferralFit (migration 20261108140000). The referral is
// a new lead in that practice. While the practice shares progress, the
// program follows its milestones and, if the client enters treatment, which
// program; the track record never counts where clients went. Hidden on a
// server without the migration.

type Props = {
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

function dateText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProgramReferrals({ onNotice, onError }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [stats, setStats] = useState<StatsRow[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const [results, setResults] = useState<TargetRow[] | null>(null);
  const [target, setTarget] = useState<TargetRow | null>(null);
  const [form, setForm] = useState<ReferralForm>(emptyReferralForm());
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, record] = await Promise.all([
      supabase.rpc('list_program_referrals'),
      supabase.rpc('program_referral_stats'),
    ]);
    const failure = list.error || record.error;
    if (failure) {
      if (isMissingSchema(failure.code)) { setAvailable(false); return; }
      // 42501: this account has no live listing yet; nothing to show.
      if (failure.code === '42501') { setAvailable(false); return; }
      onError(failure.message);
      return;
    }
    setAvailable(true);
    setReferrals((Array.isArray(list.data) ? list.data : []) as ReferralRow[]);
    setStats((Array.isArray(record.data) ? record.data : []) as StatsRow[]);
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  if (!available) return null;

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (query.trim().length < 2 && state.trim().length !== 2) {
      setProblem('Type at least two letters of a name, or a two-letter state.');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      const { data, error } = await supabase.rpc('program_referral_targets', { p_query: query.trim(), p_state: state.trim() || null });
      if (error) throw error;
      setResults((Array.isArray(data) ? data : []) as TargetRow[]);
    } catch (searchError) {
      setProblem((searchError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function choose(row: TargetRow) {
    setTarget(row);
    setForm(emptyReferralForm());
    setProblem('');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!target || busy) return;
    const checked = validateReferral(form);
    if ('problem' in checked) { setProblem(checked.problem); return; }
    setBusy(true);
    setProblem('');
    try {
      const { error } = await supabase.rpc('program_refer_family', { p_to_global_id: target.global_partner_id, ...checked.payload });
      if (error) throw error;
      onNotice(`Sent to ${target.display_name}. It arrives as a new lead, and they will call the family.`);
      setTarget(null);
      setResults(null);
      setQuery('');
      setForm(emptyReferralForm());
      await load();
    } catch (submitError) {
      setProblem((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card referrals">
        <h2>Refer a family to an interventionist</h2>
        <p className="help">
          When a family needs help before they are ready for treatment, refer them to an interventionist
          on ReferralFit. It arrives in the practice as a new lead with your program as the source, and
          they call the family. Referrals never change how anyone is ranked.
        </p>
        {target ? (
          <form onSubmit={submit}>
            <div className="status-row">
              <span className="stat">To <b>{target.display_name}</b></span>
              {placeText(target) ? <span className="stat">{placeText(target)}</span> : null}
              <button type="button" className="ghost small" onClick={() => setTarget(null)}>Choose someone else</button>
            </div>
            <label>Family member to call</label>
            <input value={form.callerName} maxLength={FIELD_LIMITS.callerName} autoComplete="off"
              onChange={(e) => setForm({ ...form, callerName: e.target.value })} />
            <label>Their phone</label>
            <input type="tel" inputMode="tel" value={form.phone} maxLength={40} autoComplete="off"
              onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <label>Their email (optional)</label>
            <input type="email" value={form.email} maxLength={FIELD_LIMITS.email} autoComplete="off"
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <label>Their relationship to the person who needs help (optional)</label>
            <input value={form.relationship} maxLength={FIELD_LIMITS.relationship} placeholder="For example: mother"
              onChange={(e) => setForm({ ...form, relationship: e.target.value })} />
            <label>First name of the person who needs help (optional)</label>
            <input value={form.aboutFirstName} maxLength={FIELD_LIMITS.aboutFirstName}
              onChange={(e) => setForm({ ...form, aboutFirstName: e.target.value })} />
            <label>Note for the interventionist (optional)</label>
            <textarea value={form.note} maxLength={FIELD_LIMITS.note}
              placeholder="What the family told you and what they need"
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={form.danger} onChange={(e) => setForm({ ...form, danger: e.target.checked })} />
              Someone may be in danger right now
            </label>
            {form.danger ? <p className="safety">{SAFETY_TEXT}</p> : null}
            <label className="check consent">
              <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
              {CONSENT_TEXT}
            </label>
            {problem ? <div className="error">{problem}</div> : null}
            <div className="actions">
              <button type="submit" disabled={busy || !form.consent}>{busy ? 'Sending' : 'Send referral'}</button>
            </div>
          </form>
        ) : (
          <>
            <form className="search-row" onSubmit={search}>
              <input value={query} placeholder="Interventionist or practice name" onChange={(e) => setQuery(e.target.value)} />
              <input className="state" value={state} maxLength={2} placeholder="State"
                onChange={(e) => setState(e.target.value.toUpperCase())} />
              <button type="submit" disabled={busy}>Search</button>
            </form>
            {problem ? <div className="error">{problem}</div> : null}
            {results ? (
              results.length ? (
                <ul className="targets">
                  {results.map((row) => (
                    <li key={row.global_partner_id}>
                      <span className="target-main">
                        <b>{row.display_name}</b>
                        <small>{[placeText(row), (row.types || []).join(', ')].filter(Boolean).join(' · ')}</small>
                        {row.website ? <a href={row.website} target="_blank" rel="noreferrer noopener">{row.website.replace(/^https?:\/\//, '')}</a> : null}
                      </span>
                      {row.receive_status === 'ready' ? (
                        <button type="button" onClick={() => choose(row)}>Refer</button>
                      ) : (
                        <span className="badge archived">{RECEIVE_STATUS_TEXT[row.receive_status]}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="footnote">No interventionists match. Try a shorter name or a state.</p>
              )
            ) : null}
          </>
        )}
      </div>

      <div className="card referrals">
        <h2>Your referrals</h2>
        <p className="help">
          You see milestones while the practice shares progress, and if the client enters treatment,
          the program they entered, so you can help coordinate care. ReferralFit never shares anything
          else from the practice's file.
        </p>
        {referrals.length ? (
          <ul className="requests">
            {referrals.map((row) => (
              <li key={row.id} className="referral-row">
                <span className="request-main">
                  <b>{row.family_label || 'A family'}</b>
                  <span>To {row.to_display}</span>
                  <small>
                    Sent {dateText(row.created_at)}
                    {row.minutes_to_reach !== null ? ` · reached in ${durationText(row.minutes_to_reach)}` : ''}
                  </small>
                </span>
                <span className="request-side">
                  <span className={`badge ${row.milestone === 'not_shared' || row.milestone === 'closed' || row.milestone === 'not_proceeding' ? 'archived' : row.milestone === 'received' ? 'pending' : 'active'}`}>
                    {milestoneText(row)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="footnote">No referrals yet.</p>
        )}
      </div>

      {stats.length ? (
        <div className="card referrals">
          <h2>Interventionists you've referred to</h2>
          <p className="help">
            How your referrals went with each interventionist. Rates count the referrals whose progress
            the practice shares. ReferralFit does not count where clients were placed, and none of this
            affects how anyone is ranked.
          </p>
          <div className="table-wrap">
            <table className="track">
              <thead>
                <tr>
                  <th scope="col">Interventionist</th>
                  <th scope="col">Referred</th>
                  <th scope="col">Reached within 24 hours</th>
                  <th scope="col">Median time to first contact</th>
                  <th scope="col">Consult or intervention</th>
                  <th scope="col">Entered treatment (anywhere)</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((row) => {
                  const line = statsLine(row);
                  return (
                    <tr key={`${row.to_global_partner_id || row.to_display}`}>
                      <th scope="row">{line.name}{line.note ? <small>{line.note}</small> : null}</th>
                      <td>{line.sent}</td>
                      <td>{line.reached}</td>
                      <td>{line.median}</td>
                      <td>{line.consult}</td>
                      <td>{line.treatment}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
