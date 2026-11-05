import { useCallback, useEffect, useState } from 'react';

import {
  ACCREDITORS,
  KEPT_ON_RECORD_FALLBACK,
  KINDS,
  STATUS_LABELS,
  credentialStatus,
  credentialTitle,
  emptyForm,
  formFromRow,
  isMissingSchema,
  keptCredentialMessage,
  newId,
  notesFromRows,
  savedNotice,
  todayStamp,
  validateForm,
  withListingNotes,
  type CredentialForm,
  type CredentialRow,
  type ListingNotes,
} from './credential-rules';
import { supabase } from './supabase';

// "Credentials" on the program's own listing (Program Integrity Watch).
// Interventionists see whether a program's credentials are on file, current
// and verified before they refer a family. The program adds them here;
// ReferralFit checks each one by hand on the issuer's public page. Any change
// goes back to "Pending ReferralFit review" (the server enforces it).
// Hidden on a server without the credentials migration.

type Props = {
  listingId: string;
  listingState: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

type Editing = { id?: string; form: CredentialForm; rejected?: boolean };

export default function Credentials({ listingId, listingState, onNotice, onError }: Props) {
  const [rows, setRows] = useState<CredentialRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState('');
  // The server's way forward for an edit it will not take (a credential
  // ReferralFit could not confirm is only corrected), said calmly in the form.
  const [formInfo, setFormInfo] = useState('');
  const [busy, setBusy] = useState(false);
  // Information, said calmly in the card (not as an error): for example a
  // credential ReferralFit could not confirm stays on record.
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('fetch_listing_credentials', { p_ids: [listingId] });
    if (error) {
      if (isMissingSchema(error.code)) { setAvailable(false); return; }
      onError(error.message);
      return;
    }
    // The notes (the program's note to ReferralFit, and ReferralFit's note
    // on one it could not confirm) are the claimant's and ReferralFit's
    // only: they come from their own call, never with the rows.
    let notes: ListingNotes | null = null;
    const noteRead = await supabase.rpc('fetch_listing_credential_notes', { p_global_partner_id: listingId });
    if (!noteRead.error) notes = notesFromRows(noteRead.data);
    else if (!isMissingSchema(noteRead.error.code)) { onError(noteRead.error.message); return; }
    setAvailable(true);
    setRows(withListingNotes((Array.isArray(data) ? data : []) as CredentialRow[], notes));
  }, [listingId, onError]);

  useEffect(() => { void load(); }, [load]);

  if (!available) return null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const checked = validateForm(editing.form);
    if ('problem' in checked) { setProblem(checked.problem); return; }
    setBusy(true);
    setProblem('');
    setFormInfo('');
    setInfo('');
    try {
      const { data, error } = await supabase.rpc('save_program_credential', {
        p_id: editing.id || newId(),
        p_global_partner_id: listingId,
        p_partner_id: null,
        ...checked.payload,
      });
      if (error) {
        const kept = keptCredentialMessage(error);
        if (kept) { setFormInfo(kept); return; }
        throw error;
      }
      const saved = (Array.isArray(data) ? data[0] : data) as { status?: unknown } | null;
      setEditing(null);
      onNotice(savedNotice(saved?.status));
      await load();
    } catch (saveError) {
      setProblem((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: CredentialRow) {
    if (busy || !window.confirm(`Remove the ${credentialTitle(row).toLowerCase()}? Practitioners will no longer see it.`)) return;
    setBusy(true);
    setInfo('');
    try {
      const { error } = await supabase.rpc('delete_program_credential', { p_id: row.id });
      if (error) {
        // Kept on purpose (42501): the server's own calm words, shown as
        // information beside the credential, not as an error.
        if (error.code === '42501') { setInfo(error.message || KEPT_ON_RECORD_FALLBACK); return; }
        throw error;
      }
      onNotice('Credential removed.');
      await load();
    } catch (removeError) {
      onError((removeError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const today = todayStamp();
  const form = editing?.form;
  const setForm = (patch: Partial<CredentialForm>) => {
    setProblem('');
    setFormInfo('');
    setEditing((current) => (current ? { ...current, form: { ...current.form, ...patch } } : current));
  };

  return (
    <div className="card">
      <h2>Credentials</h2>
      <p className="help">
        Before they refer a family, interventionists see whether your program's credentials
        are on file, current and verified. Add your state license, accreditation (The Joint
        Commission, CARF or another body), LegitScript certification and NPI, with a link to the
        issuer's public record. ReferralFit checks each one by hand. Any change goes back for
        review. Credentials never change where you appear in match results.
      </p>
      {info ? <p className="help" role="status">{info}</p> : null}
      {rows === null ? <p className="footnote">Loading credentials...</p> : rows.length === 0 ? (
        <p className="footnote">No credentials on file yet. Practitioners see "None on file" until you add them.</p>
      ) : (
        <ul className="credentials">
          {rows.map((row) => {
            const status = credentialStatus(row.status, row.expires_on, today);
            return (
              <li key={row.id}>
                <div className="credential-main">
                  <b>{credentialTitle(row)}</b>
                  <span className="stat">
                    {[row.identifier ? (row.kind === 'npi' ? `NPI ${row.identifier}` : `No. ${row.identifier}`) : '', row.expires_on ? `Expires ${row.expires_on}` : row.kind === 'npi' ? '' : 'No expiration date'].filter(Boolean).join(' · ')}
                  </span>
                  {row.status === 'rejected' && row.verification_note ? <span className="warn">Note from ReferralFit: {row.verification_note}</span> : null}
                  {row.proof_url ? <a href={row.proof_url} target="_blank" rel="noreferrer noopener">Public record</a> : null}
                </div>
                <span className={`badge credential-${status}`}>{STATUS_LABELS[status]}</span>
                <div className="credential-actions">
                  <button type="button" className="ghost small" disabled={busy || Boolean(editing)} onClick={() => { setProblem(''); setFormInfo(''); setInfo(''); setEditing({ id: row.id, form: formFromRow(row), rejected: row.status === 'rejected' }); }}>Edit</button>
                  <button type="button" className="ghost small" disabled={busy} onClick={() => { void remove(row); }}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && form ? (
        <form onSubmit={save}>
          <label>Kind</label>
          <select value={form.kind} onChange={(e) => setForm({ kind: e.target.value as CredentialForm['kind'] })}>
            {KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </select>
          {form.kind === 'accreditation' ? (
            <>
              <label>Accredited by</label>
              <select value={form.accreditor} onChange={(e) => setForm({ accreditor: e.target.value as CredentialForm['accreditor'] })}>
                {ACCREDITORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              {form.accreditor === 'other' ? (
                <input value={form.accreditorName} maxLength={120} placeholder="Name of the accrediting body" onChange={(e) => setForm({ accreditorName: e.target.value })} />
              ) : null}
            </>
          ) : null}
          <label>{form.kind === 'npi' ? 'NPI (10 digits)' : form.kind === 'state_license' ? 'License number' : 'Certificate or program number'}</label>
          <input value={form.identifier} maxLength={64} inputMode={form.kind === 'npi' ? 'numeric' : 'text'} onChange={(e) => setForm({ identifier: e.target.value })} />
          {form.kind === 'state_license' ? (
            <>
              <label>Issuing state (2-letter)</label>
              <input value={form.issuingState} maxLength={2} onChange={(e) => setForm({ issuingState: e.target.value.toUpperCase() })} />
            </>
          ) : null}
          {form.kind !== 'npi' ? (
            <>
              <label>Expires on</label>
              <input type="date" value={form.expiresOn} onChange={(e) => setForm({ expiresOn: e.target.value })} />
            </>
          ) : null}
          <label>Link to the issuer's public record (https)</label>
          <input value={form.proofUrl} maxLength={500} inputMode="url" placeholder="https://" onChange={(e) => setForm({ proofUrl: e.target.value })} />
          <label>Note for ReferralFit (only ReferralFit sees this)</label>
          <textarea value={form.note} maxLength={1000} placeholder="Optional" onChange={(e) => setForm({ note: e.target.value })} />
          {problem ? <div className="error">{problem}</div> : null}
          {formInfo ? <p className="help" role="status">{formInfo}</p> : null}
          <div className="actions">
            <button type="submit" disabled={busy}>{busy ? 'Saving' : 'Save credential'}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { setEditing(null); setProblem(''); setFormInfo(''); }}>Cancel</button>
          </div>
          <p className="footnote">{editing.rejected
            ? 'ReferralFit could not confirm this one, so it stays marked that way after a change. You can correct its number, date or link here; for another kind, accreditor or state, or to have it reviewed again, add an updated credential.'
            : 'Saving sends it to ReferralFit for review. It shows as pending ReferralFit review until then.'}</p>
        </form>
      ) : (
        <div className="actions">
          <button type="button" disabled={busy || rows === null || rows.length >= 20} onClick={() => { setProblem(''); setFormInfo(''); setInfo(''); setEditing({ form: emptyForm(listingState) }); }}>Add a credential</button>
        </div>
      )}
    </div>
  );
}
