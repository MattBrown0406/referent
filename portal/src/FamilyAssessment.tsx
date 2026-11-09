import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CRISIS_SHORT,
  CRISIS_TEXT,
  DSM_SEVERITY_LABEL,
  NOTES,
  SECTIONS,
  WITHDRAWAL_TEXT,
  dsmCount,
  dsmSeverity,
  fieldVisible,
  safetyFlags,
  sectionAnswerLines,
  sectionProblem,
  withdrawalWarning,
  type Answers,
  type Field,
} from './assessment-schema';
import {
  assessmentTokenFrom,
  assessmentViewFromJson,
  longDate,
  photoProblem,
  savedLine,
  type AssessmentView,
  type OpenAssessment,
} from './assessment-link-rules';
import { signedOutSupabase as supabase } from './supabase';

// /f#<token>: the family assessment a practice sent (migration
// 20261109140000; docs/FAMILY_ASSESSMENT.md). Signed out: the 256-bit token
// in the fragment is the only key, so it never reaches a server log or a
// Referer header. It is kept for this tab (sessionStorage) so a reload
// works, and taken out of the address bar.
//
// The family answers twelve sections (src/assessment-schema.ts, shared word
// for word with the app), saved as they go, so they can stop and come back
// with the same link. Answers that suggest danger show 911 and 988 at once.
// The last step is one consent, signed by checking a box and typing a full
// name. Once sent, the link shows only "sent": never the answers again.

const TOKEN_KEY = 'referralfit.familyAssessment.v1';
const SAVE_DELAY_MS = 1500;
const CONSENT_STEP = SECTIONS.length + 1;

function readToken(): string | null {
  const hash = window.location.hash.replace(/^#/, '').trim();
  const fromHash = assessmentTokenFrom(window.location.hash);
  try {
    if (fromHash) {
      window.sessionStorage.setItem(TOKEN_KEY, fromHash);
      return fromHash;
    }
    if (hash) {
      // A cut-off or wrong link never falls back to one opened earlier.
      window.sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return assessmentTokenFrom(window.sessionStorage.getItem(TOKEN_KEY) || '');
  } catch {
    return fromHash;
  }
}

type LoadState = 'loading' | 'ready' | 'unavailable' | 'unreachable';
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

function logoUrl(path: string | null): string | null {
  return path ? supabase.storage.from('org-logos').getPublicUrl(path).data.publicUrl : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export default function FamilyAssessment() {
  const [token] = useState(readToken);
  const [view, setView] = useState<AssessmentView | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [answers, setAnswers] = useState<Answers>({});
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [cards, setCards] = useState({ front: false, back: false });
  const [uploading, setUploading] = useState<'' | 'front' | 'back'>('');
  const [agreed, setAgreed] = useState(false);
  const [signName, setSignName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ at: Date; answers: Answers } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The answers and step as of the last change, for saving outside React's updates.
  const answersRef = useRef<Answers>({});
  const stepRef = useRef(0);

  // What is waiting to be saved; one save at a time, the newest answers last.
  const latestRef = useRef<{ answers: Answers; step: number } | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const closedRef = useRef(false);

  const open = view && view.status === 'open' ? view as OpenAssessment : null;

  const fetchView = useCallback(async () => {
    if (!token) { setLoad('unavailable'); return; }
    try {
      const { data, error } = await supabase.rpc('public_family_assessment_open', { p_token: token });
      if (error) { setLoad('unreachable'); return; }
      const next = assessmentViewFromJson(data);
      if (!next) { setLoad('unavailable'); return; }
      setView(next);
      if (next.status === 'open') {
        answersRef.current = next.answers;
        stepRef.current = 0;
        setAnswers(next.answers);
        setStep(0);
        setCards({ front: next.cardFront, back: next.cardBack });
        setSavedAt(next.lastSavedAt ? new Date(next.lastSavedAt) : null);
      }
      setLoad('ready');
    } catch {
      setLoad('unreachable');
    }
  }, [token]);

  useEffect(() => {
    // Keep the token out of history entries and screenshots of the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void fetchView();
  }, [fetchView]);

  const flush = useCallback(async () => {
    if (!token || savingRef.current || !dirtyRef.current || !latestRef.current || closedRef.current) return;
    savingRef.current = true;
    dirtyRef.current = false;
    const pending = latestRef.current;
    setSaveState('saving');
    try {
      const { error } = await supabase.rpc('public_family_assessment_save', { p_token: token, p_answers: pending.answers, p_step: pending.step });
      if (error) {
        if (error.code === 'P0002' || error.code === '22023') {
          // The link stopped or the assessment was already sent: show what the server says now.
          closedRef.current = true;
          await fetchView();
        } else {
          dirtyRef.current = true;
          setSaveState('failed');
        }
      } else {
        setSaveState('saved');
        setSavedAt(new Date());
      }
    } catch {
      dirtyRef.current = true;
      setSaveState('failed');
    } finally {
      savingRef.current = false;
    }
    // Answers changed while saving, or the last try failed: try again soon.
    if (dirtyRef.current && !closedRef.current) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS * 4);
    }
  }, [token, fetchView]);

  function queueSave(nextAnswers: Answers, nextStep: number, now = false) {
    latestRef.current = { answers: nextAnswers, step: nextStep };
    dirtyRef.current = true;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flush(); }, now ? 0 : SAVE_DELAY_MS);
  }

  // Leaving with unsaved answers: one last try, and the browser asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current || submitted) return;
      void flush();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [flush, submitted]);

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  function setAnswer(id: string, value: unknown) {
    const next = { ...answersRef.current, [id]: value };
    answersRef.current = next;
    setAnswers(next);
    queueSave(next, stepRef.current);
    setProblem('');
  }

  function goTo(next: number) {
    stepRef.current = next;
    setStep(next);
    setProblem('');
    queueSave(answersRef.current, next, true);
    window.scrollTo({ top: 0 });
    window.setTimeout(() => headingRef.current?.focus(), 0);
  }

  function nextStep() {
    const section = SECTIONS[step - 1];
    if (section) {
      const why = sectionProblem(section, answers);
      if (why) { setProblem(why); return; }
    }
    goTo(step + 1);
  }

  async function uploadCard(side: 'front' | 'back', file: File | undefined) {
    if (!file || !token || uploading) return;
    const why = photoProblem(file);
    if (why) { setProblem(why); return; }
    setUploading(side);
    setProblem('');
    try {
      const signed = await supabase.functions.invoke('family-assessment-upload', { body: { token, side } });
      const target = signed.data as { path?: string; token?: string } | null;
      if (signed.error || !target?.path || !target.token) throw new Error('sign');
      const sent = await supabase.storage.from('assessment-files').uploadToSignedUrl(target.path, target.token, file, { contentType: file.type, upsert: true });
      if (sent.error) throw new Error('upload');
      const { error } = await supabase.rpc('public_family_assessment_photo_done', { p_token: token, p_side: side });
      if (error) throw new Error('done');
      setCards((current) => ({ ...current, [side]: true }));
    } catch {
      setProblem('The photo was not sent. Check your connection and try again, or type the details from the card below.');
    } finally {
      setUploading('');
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!open || !token || submitting) return;
    for (const [index, section] of SECTIONS.entries()) {
      const why = sectionProblem(section, answers);
      if (why) { setProblem(`Section ${index + 1}, ${section.title}: ${why}`); return; }
    }
    if (!agreed) { setProblem('Check the box to agree before sending.'); return; }
    if (signName.trim().length < 2) { setProblem('Type your full name to sign.'); return; }
    setSubmitting(true);
    setProblem('');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    try {
      const { error } = await supabase.rpc('public_family_assessment_submit', {
        p_token: token,
        p_answers: answers,
        p_agreed: true,
        p_name: signName.trim(),
        p_consent_version: open.consentVersion,
        p_client: navigator.userAgent.slice(0, 300),
      });
      if (error) {
        if (error.code === 'P0002') { setLoad('unavailable'); return; }
        setProblem(error.code && error.message ? error.message : 'It was not sent. Check your connection and try again.');
        return;
      }
      dirtyRef.current = false;
      closedRef.current = true;
      setSubmitted({ at: new Date(), answers });
      window.scrollTo({ top: 0 });
    } catch {
      setProblem('It was not sent. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const flags = useMemo(() => safetyFlags(answers), [answers]);
  const practice = view?.practiceName || 'Your practitioner';
  const logo = logoUrl(view?.logoPath ?? null);

  useEffect(() => {
    document.title = view ? `${view.practiceName}: family assessment` : 'Family assessment';
  }, [view]);

  const header = (
    <header className="fa-brand">
      {logo ? <img src={logo} alt="" className="fa-logo" /> : null}
      <div>
        <div className="fa-practice">{practice}</div>
        <div className="fa-sub">Confidential family assessment</div>
      </div>
    </header>
  );

  if (load === 'loading') return <main className="shell">{header}<p className="fa-muted">Opening your assessment…</p></main>;
  if (load === 'unreachable') {
    return (
      <main className="shell">
        {header}
        <div className="card"><h2>We could not reach the server</h2><p className="help">Check your connection, then reload this page. Your saved answers are safe.</p>
          <button type="button" onClick={() => { setLoad('loading'); void fetchView(); }}>Try again</button></div>
      </main>
    );
  }
  if (load === 'unavailable' || !view) {
    return (
      <main className="shell">
        {header}
        <div className="card"><h2>This link is not active</h2>
          <p className="help">It may be incomplete, older than the newest link you were sent, or it may have expired or been stopped. Ask your practitioner to send a new link.</p>
          <p className="fa-crisis-inline">{CRISIS_SHORT}</p></div>
      </main>
    );
  }

  if (submitted) {
    return (
      <main className="shell fa-done">
        {header}
        <div className="card fa-noprint">
          <h2>Thank you. Your assessment was sent to {practice}.</h2>
          <p className="help">{practice} will read it and reach out to you. You can save a copy for your records now: after you leave this page, the link no longer shows your answers.</p>
          <p className="fa-crisis-inline">{CRISIS_SHORT}</p>
          <button type="button" onClick={() => window.print()}>Print or save a copy</button>
        </div>
        <section className="fa-copy" aria-label="Your answers">
          <h2>Family assessment for {practice}</h2>
          <p className="fa-muted">Sent {submitted.at.toLocaleString()}. Signed by {signName.trim()}.</p>
          {SECTIONS.map((section) => {
            const lines = sectionAnswerLines(section, submitted.answers);
            if (!lines.length) return null;
            return (
              <div key={section.id} className="fa-copy-section">
                <h3>{section.title}</h3>
                <dl>{lines.map((line) => <div key={line.label}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
              </div>
            );
          })}
          {open ? <div className="fa-copy-section"><h3>Consent</h3><p className="fa-consent">{open.consentText}</p></div> : null}
        </section>
      </main>
    );
  }

  if (view.status === 'submitted') {
    return (
      <main className="shell">
        {header}
        <div className="card"><h2>This assessment was already sent</h2>
          <p className="help">{practice} received it{view.submittedAt ? ` on ${longDate(view.submittedAt)}` : ''}. For your privacy, the answers are not shown here. Reply to the email from {practice} if you need to add something.</p>
          <p className="fa-crisis-inline">{CRISIS_SHORT}</p></div>
      </main>
    );
  }

  const openView = view as OpenAssessment;
  const section = step >= 1 && step <= SECTIONS.length ? SECTIONS[step - 1] : null;
  const saveText = savedLine(saveState, savedAt);

  return (
    <main className="shell fa">
      {header}
      {flags.length ? <div className="fa-crisis" role="alert">{CRISIS_TEXT}</div> : null}

      {step > 0 ? (
        <div className="fa-progress" aria-hidden="true">
          <div className="fa-progress-bar" style={{ width: `${Math.round((Math.min(step, CONSENT_STEP) / CONSENT_STEP) * 100)}%` }} />
        </div>
      ) : null}
      <p className="fa-save" aria-live="polite">{step > 0 ? `${section ? `Section ${step} of ${SECTIONS.length}` : 'Last step'}${saveText ? ` · ${saveText}` : ''}` : ''}</p>

      {step === 0 ? (
        <div className="card">
          <h2 tabIndex={-1} ref={headingRef}>{openView.recipientName ? `Hello, ${openView.recipientName.split(' ')[0]}` : 'Welcome'}</h2>
          <p className="help">{NOTES.intro(practice)}</p>
          <p className="help">{NOTES.time} {NOTES.saving}</p>
          <p className="help">{NOTES.privacy(practice)}{openView.expiresAt ? ` This link works until ${longDate(openView.expiresAt)}.` : ''}</p>
          <p className="fa-crisis-inline">{CRISIS_TEXT}</p>
          <button type="button" onClick={() => goTo(Math.max(1, Math.min(openView.step || 1, CONSENT_STEP)))}>
            {openView.step > 0 ? 'Continue where you left off' : 'Start'}
          </button>
        </div>
      ) : null}

      {section ? (
        <form className="card" onSubmit={(event) => { event.preventDefault(); nextStep(); }} noValidate>
          <h2 tabIndex={-1} ref={headingRef}>{section.title}</h2>
          {section.intro ? <p className="help">{section.intro}</p> : null}
          {section.id === 'mental_health' ? <div className="fa-warning">{NOTES.mentalHealthWarning}</div> : null}
          {section.id === 'medical_withdrawal' && withdrawalWarning(answers) ? <div className="fa-warning" role="alert">{WITHDRAWAL_TEXT}</div> : null}
          {section.fields.filter((field) => fieldVisible(field, answers)).map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={answers[field.id]}
              onChange={(value) => setAnswer(field.id, value)}
              card={field.id === 'insuranceCardFront' ? cards.front : field.id === 'insuranceCardBack' ? cards.back : false}
              uploading={uploading}
              onPhoto={(side, file) => { void uploadCard(side, file); }}
            />
          ))}
          {section.id === 'dsm' ? (
            <div className="fa-readout">
              <strong>Checked: {dsmCount(answers)} of 11.</strong> {DSM_SEVERITY_LABEL[dsmSeverity(dsmCount(answers))]} (2-3 mild, 4-5 moderate, 6 or more severe). {NOTES.dsmNote}
            </div>
          ) : null}
          {problem ? <p className="fa-problem" role="alert">{problem}</p> : null}
          <div className="fa-nav">
            <button type="button" className="fa-secondary" onClick={() => goTo(step - 1)}>Back</button>
            <button type="submit">Next</button>
          </div>
        </form>
      ) : null}

      {step === CONSENT_STEP ? (
        <form className="card" onSubmit={submit} noValidate>
          <h2 tabIndex={-1} ref={headingRef}>Consent and signature</h2>
          <p className="help">Please read this, then check the box and type your full name to sign and send your assessment to {practice}.</p>
          <p className="fa-consent">{openView.consentText}</p>
          <label className="fa-check">
            <input type="checkbox" checked={agreed} onChange={(event) => { setAgreed(event.target.checked); setProblem(''); }} />
            <span>I have read this and I agree.</span>
          </label>
          <label htmlFor="fa-sign">Your full name (electronic signature)</label>
          <input id="fa-sign" value={signName} onChange={(event) => { setSignName(event.target.value); setProblem(''); }} autoComplete="name" maxLength={120} />
          <p className="fa-muted">Date: {new Date().toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</p>
          {problem ? <p className="fa-problem" role="alert">{problem}</p> : null}
          <div className="fa-nav">
            <button type="button" className="fa-secondary" onClick={() => goTo(SECTIONS.length)}>Back</button>
            <button type="submit" disabled={submitting}>{submitting ? 'Sending…' : `Sign and send to ${practice}`}</button>
          </div>
        </form>
      ) : null}
    </main>
  );
}

type FieldProps = {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  card: boolean;
  uploading: '' | 'front' | 'back';
  onPhoto: (side: 'front' | 'back', file: File | undefined) => void;
};

function FieldInput({ field, value, onChange, card, uploading, onPhoto }: FieldProps) {
  const id = `fa-${field.id}`;
  const required = 'required' in field && field.required;
  const label = <label htmlFor={id}>{field.label}{required ? ' (required)' : ''}</label>;
  const help = 'help' in field && field.help ? <p className="fa-help">{field.help}</p> : null;

  switch (field.kind) {
    case 'text':
    case 'email':
    case 'phone':
    case 'date':
    case 'number':
      return (
        <div className="fa-field">
          {label}{help}
          <input
            id={id}
            type={field.kind === 'phone' ? 'tel' : field.kind === 'number' ? 'text' : field.kind}
            inputMode={field.kind === 'number' ? 'numeric' : undefined}
            value={asText(value)}
            onChange={(event) => onChange(event.target.value.slice(0, 200))}
            autoComplete={field.id === 'contactEmail' ? 'email' : field.id === 'contactPhone' ? 'tel' : field.id === 'contactName' ? 'name' : 'off'}
          />
        </div>
      );
    case 'textarea':
      return (
        <div className="fa-field">
          {label}{help}
          <textarea id={id} value={asText(value)} onChange={(event) => onChange(event.target.value.slice(0, 4000))} />
        </div>
      );
    case 'choice': {
      const values = field.values ?? field.options;
      if (field.options.length <= 4) {
        return (
          <fieldset className="fa-field fa-radios">
            <legend>{field.label}{required ? ' (required)' : ''}</legend>{help}
            {field.options.map((option, index) => (
              <label key={values[index]} className="fa-check">
                <input type="radio" name={id} value={values[index]} checked={value === values[index]} onChange={() => onChange(values[index])} />
                <span>{option}</span>
              </label>
            ))}
          </fieldset>
        );
      }
      return (
        <div className="fa-field">
          {label}{help}
          <select id={id} value={asText(value)} onChange={(event) => onChange(event.target.value)}>
            <option value="">Choose…</option>
            {field.options.map((option, index) => <option key={values[index]} value={values[index]}>{option}</option>)}
          </select>
        </div>
      );
    }
    case 'yesno':
      return (
        <fieldset className="fa-field fa-radios fa-inline">
          <legend>{field.label}{required ? ' (required)' : ''}</legend>{help}
          {(['yes', 'no'] as const).map((choice) => (
            <label key={choice} className="fa-check">
              <input type="radio" name={id} value={choice} checked={value === choice} onChange={() => onChange(choice)} />
              <span>{choice === 'yes' ? 'Yes' : 'No'}</span>
            </label>
          ))}
        </fieldset>
      );
    case 'multi': {
      const chosen = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      return (
        <fieldset className="fa-field">
          <legend>{field.label}</legend>{help}
          <div className="fa-grid">
            {field.options.map((option) => (
              <label key={option} className="fa-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(option)}
                  onChange={(event) => onChange(event.target.checked ? [...chosen, option] : chosen.filter((item) => item !== option))}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    case 'list': {
      const rows = Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
      const update = (index: number, key: string, next: unknown) => onChange(rows.map((row, i) => (i === index ? { ...row, [key]: next } : row)));
      return (
        <fieldset className="fa-field">
          <legend>{field.label}</legend>{help}
          {rows.map((row, index) => (
            <div key={index} className="fa-row">
              <div className="fa-row-title">{field.itemLabel} {index + 1}</div>
              {field.fields.map((sub) => (
                sub.kind === 'yesno' ? (
                  <label key={sub.id} className="fa-check">
                    <input type="checkbox" checked={row[sub.id] === true} onChange={(event) => update(index, sub.id, event.target.checked)} />
                    <span>{sub.label}</span>
                  </label>
                ) : sub.kind === 'choice' ? (
                  <div key={sub.id} className="fa-field">
                    <label htmlFor={`${id}-${index}-${sub.id}`}>{sub.label}</label>
                    <select id={`${id}-${index}-${sub.id}`} value={asText(row[sub.id])} onChange={(event) => update(index, sub.id, event.target.value)}>
                      <option value="">Choose…</option>
                      {sub.options.map((option, i) => <option key={option} value={(sub.values ?? sub.options)[i]}>{option}</option>)}
                    </select>
                  </div>
                ) : (
                  <div key={sub.id} className="fa-field">
                    <label htmlFor={`${id}-${index}-${sub.id}`}>{sub.label}</label>
                    <input id={`${id}-${index}-${sub.id}`} value={asText(row[sub.id])} placeholder={'help' in sub ? sub.help : undefined}
                      inputMode={sub.kind === 'number' ? 'numeric' : undefined}
                      onChange={(event) => update(index, sub.id, event.target.value.slice(0, 200))} />
                  </div>
                )
              ))}
              <button type="button" className="fa-secondary" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove {field.itemLabel.toLowerCase()} {index + 1}</button>
            </div>
          ))}
          {rows.length < 20 ? <button type="button" className="fa-secondary" onClick={() => onChange([...rows, {}])}>Add {field.itemLabel.toLowerCase()}</button> : null}
        </fieldset>
      );
    }
    case 'photo': {
      const side = field.id === 'insuranceCardFront' ? 'front' : 'back';
      return (
        <div className="fa-field">
          <label htmlFor={id}>{field.label} (optional)</label>
          {side === 'front' ? <p className="fa-help">{NOTES.insuranceWhy} {NOTES.insuranceCard}</p> : null}
          <input id={id} type="file" accept="image/jpeg,image/png,image/heic,image/webp" disabled={Boolean(uploading)}
            onChange={(event) => { onPhoto(side, event.target.files?.[0]); event.target.value = ''; }} />
          <p className="fa-muted" aria-live="polite">{uploading === side ? 'Sending the photo…' : card ? `${side === 'front' ? 'Front' : 'Back'} received. Choose another photo to replace it.` : 'JPG, PNG, HEIC or WebP, up to 10 MB.'}</p>
          {side === 'back' ? <p className="fa-help">{NOTES.insuranceTyped}</p> : null}
        </div>
      );
    }
    case 'dsm': {
      const checked = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return (
        <fieldset className="fa-field">
          <legend className="fa-hidden">{field.label}</legend>
          {field.criteria.map((item) => (
            <label key={item.id} className="fa-check fa-criterion">
              <input type="checkbox" checked={checked[item.id] === true} onChange={(event) => onChange({ ...checked, [item.id]: event.target.checked })} />
              <span><strong>{item.criterion}</strong><br />{item.question}<br /><em>{item.examples}</em></span>
            </label>
          ))}
        </fieldset>
      );
    }
    default:
      return null;
  }
}
