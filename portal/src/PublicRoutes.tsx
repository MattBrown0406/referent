import { useEffect, useRef, useState } from 'react';

type PublicRoute =
  | { kind: 'intake'; value: string }
  | { kind: 'handoff'; value: string };

type IntakeLabels = { sourceId: string; practiceDisplay: string; sourceDisplay: string };
type HandoffStatus = 'sent' | 'received' | 'contact_attempted' | 'family_reached' | 'consult_scheduled' | 'closed';
type HandoffRecord = {
  clientAlias: string;
  senderPracticeDisplay: string;
  recipientDisplay: string;
  status: HandoffStatus;
  version: number;
  allowedNextStatus: HandoffStatus | null;
};

type IntakeForm = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  callbackConsent: boolean;
  privacyConsent: boolean;
  website: string;
};

const EMPTY_INTAKE: IntakeForm = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  callbackConsent: false,
  privacyConsent: false,
  website: '',
};

const STATUS_STEPS: Array<{ value: HandoffStatus; label: string; detail: string }> = [
  { value: 'sent', label: 'Sent', detail: 'The referral was shared.' },
  { value: 'received', label: 'Received', detail: 'The recipient confirms receipt.' },
  { value: 'contact_attempted', label: 'Contact attempted', detail: 'An outreach attempt was made.' },
  { value: 'family_reached', label: 'Family reached', detail: 'The family was reached.' },
  { value: 'consult_scheduled', label: 'Consult scheduled', detail: 'A consultation was scheduled.' },
  { value: 'closed', label: 'Closed', detail: 'The handoff loop is complete.' },
];

function endpoint(): string {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) throw new Error('Service configuration is unavailable.');
  return `${base.replace(/\/$/, '')}/functions/v1/public-referrals`;
}

async function publicAction<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error('Request failed.') as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

export function getPublicRoute(pathname: string): PublicRoute | null {
  const intake = pathname.match(/^\/r\/([0-9a-fA-F-]{36})\/?$/);
  if (intake) return { kind: 'intake', value: intake[1] };
  const handoff = pathname.match(/^\/h\/([^/]+)\/?$/);
  if (handoff) {
    try { return { kind: 'handoff', value: decodeURIComponent(handoff[1]) }; }
    catch { return { kind: 'handoff', value: '' }; }
  }
  return null;
}

function PublicBrand() {
  return (
    <header className="public-brand" aria-label="ReferralFit">
      <span className="brand-mark" aria-hidden="true">R</span>
      <span>ReferralFit</span>
    </header>
  );
}

function PublicFooter({ emergency = false }: { emergency?: boolean }) {
  return (
    <footer className="public-footer">
      <p>Your information is handled with care and used only to respond to this request.</p>
      {emergency ? <p>This form is not monitored for emergencies. If there is immediate danger, call 911 or 988.</p> : null}
    </footer>
  );
}

export function PublicIntake({ sourceId }: { sourceId: string }) {
  const [labels, setLabels] = useState<IntakeLabels | null>(null);
  const [form, setForm] = useState<IntakeForm>(EMPTY_INTAKE);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<'loading' | 'ready' | 'submitting' | 'success' | 'unavailable'>('loading');
  const [errors, setErrors] = useState<string[]>([]);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    publicAction<IntakeLabels>({ action: 'intake.resolve', sourceId })
      .then((result) => { if (active) { setLabels(result); setState('ready'); } })
      .catch(() => { if (active) setState('unavailable'); });
    return () => { active = false; };
  }, [sourceId]);

  useEffect(() => {
    if (errors.length) errorRef.current?.focus();
  }, [errors]);

  function update<K extends keyof IntakeForm>(key: K, value: IntakeForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: string[] = [];
    if (!form.firstName.trim()) nextErrors.push('Enter your first name.');
    if (!form.lastName.trim()) nextErrors.push('Enter your last name.');
    if (!form.phone.trim() && !form.email.trim()) nextErrors.push('Enter a phone number or email address.');
    if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) nextErrors.push('Enter a valid email address.');
    if (!form.callbackConsent) nextErrors.push('Confirm that you agree to be contacted about this request.');
    if (!form.privacyConsent) nextErrors.push('Confirm that you understand how this request will be used.');
    if (nextErrors.length) { setErrors(nextErrors); return; }

    setErrors([]);
    setState('submitting');
    try {
      await publicAction<{ accepted: true; message: string }>({
        action: 'intake.submit',
        sourceId,
        idempotencyKey,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        callbackConsent: form.callbackConsent,
        privacyConsent: form.privacyConsent,
        website: form.website,
      });
      setIdempotencyKey(crypto.randomUUID());
      setState('success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 404 || status === 410) setState('unavailable');
      else {
        setState('ready');
        setErrors(['We could not send your request right now. Your entries are still here—please try again.']);
      }
    }
  }

  if (state === 'loading') return <PublicState title="Opening your request form…" loading />;
  if (state === 'unavailable') return <PublicState title="This request link is unavailable" body="It may have expired or been replaced. Please contact the person who shared it with you." />;
  if (state === 'success') {
    return (
      <main className="public-shell">
        <PublicBrand />
        <section className="public-card centered-state" aria-labelledby="intake-success-title">
          <span className="success-icon" aria-hidden="true">✓</span>
          <p className="eyebrow">Request received</p>
          <h1 id="intake-success-title">Thank you for reaching out.</h1>
          <p>{labels?.practiceDisplay} has your callback request. You can close this page now.</p>
        </section>
        <PublicFooter emergency />
      </main>
    );
  }

  return (
    <main className="public-shell">
      <PublicBrand />
      <section className="public-card" aria-labelledby="intake-title">
        <p className="eyebrow">A private callback request</p>
        <h1 id="intake-title">Let’s make the first step simple.</h1>
        <p className="lede">
          Share the best way for <strong>{labels?.practiceDisplay}</strong> to reach you. This link was provided by {labels?.sourceDisplay}.
        </p>
        <div className="privacy-note">You do not need to share diagnosis, treatment, or medical details here.</div>

        {errors.length ? (
          <div className="error error-summary" role="alert" tabIndex={-1} ref={errorRef}>
            <strong>Please check the form:</strong>
            <ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        ) : null}

        <form onSubmit={submit} noValidate>
          <div className="field-grid two-column">
            <div className="field">
              <label htmlFor="intake-first-name">First name <span aria-hidden="true">*</span></label>
              <input id="intake-first-name" value={form.firstName} onChange={(e) => update('firstName', e.target.value)} autoComplete="given-name" required />
            </div>
            <div className="field">
              <label htmlFor="intake-last-name">Last name <span aria-hidden="true">*</span></label>
              <input id="intake-last-name" value={form.lastName} onChange={(e) => update('lastName', e.target.value)} autoComplete="family-name" required />
            </div>
          </div>

          <fieldset>
            <legend>How may we contact you? <span aria-hidden="true">*</span></legend>
            <div className="field-grid two-column">
              <div className="field">
                <label htmlFor="intake-phone">Phone number</label>
                <input id="intake-phone" type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} autoComplete="tel" inputMode="tel" />
              </div>
              <div className="field">
                <label htmlFor="intake-email">Email address</label>
                <input id="intake-email" type="email" value={form.email} onChange={(e) => update('email', e.target.value)} autoComplete="email" inputMode="email" />
              </div>
            </div>
          </fieldset>

          <div className="hp-field" aria-hidden="true">
            <label htmlFor="website">Website</label>
            <input id="website" name="website" value={form.website} onChange={(e) => update('website', e.target.value)} tabIndex={-1} autoComplete="off" />
          </div>

          <label className="consent-row">
            <input type="checkbox" checked={form.callbackConsent} onChange={(e) => update('callbackConsent', e.target.checked)} />
            <span>I agree that {labels?.practiceDisplay} may contact me about this request. <span aria-hidden="true">*</span></span>
          </label>
          <label className="consent-row">
            <input type="checkbox" checked={form.privacyConsent} onChange={(e) => update('privacyConsent', e.target.checked)} />
            <span>I understand this information is used only to respond to my request and should not include medical or treatment details. <span aria-hidden="true">*</span></span>
          </label>
          <button className="primary-action" type="submit" disabled={state === 'submitting'}>
            {state === 'submitting' ? 'Sending request…' : 'Request a callback'}
          </button>
        </form>
      </section>
      <PublicFooter emergency />
    </main>
  );
}

function PublicState({ title, body, loading = false }: { title: string; body?: string; loading?: boolean }) {
  return (
    <main className="public-shell">
      <PublicBrand />
      <section className="public-card centered-state" aria-live="polite">
        {loading ? <span className="spinner" aria-hidden="true" /> : <span className="state-icon" aria-hidden="true">—</span>}
        <h1>{title}</h1>
        {body ? <p>{body}</p> : null}
      </section>
      <PublicFooter />
    </main>
  );
}

export function PublicHandoff({ token }: { token: string }) {
  const [record, setRecord] = useState<HandoffRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'unavailable'>('loading');
  const [message, setMessage] = useState('');

  async function load(conflict = false) {
    setState('loading');
    setMessage('');
    try {
      const next = await publicAction<HandoffRecord>({ action: 'handoff.resolve', token });
      setRecord(next);
      setState('ready');
      if (conflict) setMessage('This handoff changed elsewhere. The latest status is shown below.');
    } catch {
      setState('unavailable');
    }
  }

  useEffect(() => { void load(); }, [token]);

  async function advance() {
    if (!record?.allowedNextStatus) return;
    setState('saving');
    setMessage('');
    try {
      const next = await publicAction<{ status: HandoffStatus; version: number }>({
        action: 'handoff.transition', token, expectedVersion: record.version, nextStatus: record.allowedNextStatus,
      });
      const allowedNextStatus = STATUS_STEPS[STATUS_STEPS.findIndex((step) => step.value === next.status) + 1]?.value ?? null;
      setRecord({ ...record, ...next, allowedNextStatus });
      setState('ready');
      setMessage(`Status updated to ${statusLabel(next.status)}.`);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 409) await load(true);
      else if (status === 404 || status === 410) setState('unavailable');
      else { setState('ready'); setMessage('The status could not be updated. Please try again.'); }
    }
  }

  if (state === 'loading' && !record) return <PublicState title="Loading handoff status…" loading />;
  if (state === 'unavailable') return <PublicState title="This handoff link is unavailable" body="It may have expired, been closed, or been replaced. Please contact the person who shared it with you." />;
  if (!record) return null;
  const activeIndex = STATUS_STEPS.findIndex((step) => step.value === record.status);

  return (
    <main className="public-shell handoff-shell">
      <PublicBrand />
      <section className="public-card" aria-labelledby="handoff-title">
        <p className="eyebrow">Secure handoff status</p>
        <h1 id="handoff-title">Referral {record.clientAlias}</h1>
        <p className="lede">A privacy-safe progress update from <strong>{record.senderPracticeDisplay}</strong> to <strong>{record.recipientDisplay}</strong>.</p>
        <div className="current-status">
          <span>Current status</span>
          <strong>{statusLabel(record.status)}</strong>
        </div>
        {message ? <div className={message.startsWith('Status updated') ? 'success' : 'notice'} role="status">{message}</div> : null}

        <ol className="progress-list" aria-label="Handoff progress">
          {STATUS_STEPS.map((step, index) => {
            const complete = index < activeIndex;
            const current = index === activeIndex;
            return (
              <li key={step.value} className={complete ? 'complete' : current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
                <span className="step-marker" aria-hidden="true">{complete ? '✓' : index + 1}</span>
                <span><strong>{step.label}</strong><small>{step.detail}</small></span>
              </li>
            );
          })}
        </ol>

        {record.allowedNextStatus ? (
          <div className="transition-panel">
            <p><strong>Confirm the next step</strong></p>
            <p>This only records progress. It does not share clinical or contact information.</p>
            <button className="primary-action" type="button" onClick={() => void advance()} disabled={state === 'saving'}>
              {state === 'saving' ? 'Updating…' : `Confirm ${statusLabel(record.allowedNextStatus)}`}
            </button>
          </div>
        ) : (
          <div className="complete-panel"><strong>Handoff complete</strong><span>No further status updates are needed.</span></div>
        )}
      </section>
      <PublicFooter />
    </main>
  );
}

function statusLabel(status: HandoffStatus): string {
  return STATUS_STEPS.find((step) => step.value === status)?.label ?? status;
}
