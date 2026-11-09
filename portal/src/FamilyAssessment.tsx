import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DSM_SEVERITY_LABEL,
  NOTES,
  SECTIONS,
  WITHDRAWAL_TEXT,
  dsmCount,
  dsmSeverity,
  fieldVisible,
  firstProblemField,
  pruneHidden,
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
  photoContentType,
  photoProblem,
  mergeAnswers,
  sameAnswers,
  saveOutcome,
  savedLine,
  type AssessmentView,
  type OpenAssessment,
} from './assessment-link-rules';
import { projectUrl, publishableKey, signedOutSupabase as supabase } from './supabase';

// /f#<token>: the family assessment a practice sent (migration
// 20261109140000; docs/FAMILY_ASSESSMENT.md). Signed out: the 256-bit token
// in the fragment is the only key, so it never reaches a server log or a
// Referer header. It is kept for this tab (sessionStorage) so a reload
// works, and taken out of the address bar.
//
// The family answers twelve sections (src/assessment-schema.ts, shared word
// for word with the app), saved as they go, so they can stop and come back
// with the same link. Every save carries the revision the page has; the
// server refuses an older one (another tab or another family member saved
// since), and the page then loads the newest answers instead of writing
// over them. Answers that suggest danger show 911 and 988. The last step is
// one consent, signed by checking a box and typing a full name. Once sent,
// the link shows only "sent": never the answers again.

const TOKEN_KEY = 'referralfit.familyAssessment.v1';
const SAVE_DELAY_MS = 1500;
// Free text is judged for danger only once typing pauses, so the banner does
// not flash on and off while someone types "None".
const FLAG_DELAY_MS = 1200;
const CONSENT_STEP = SECTIONS.length + 1;
const TEXT_KINDS = new Set(['text', 'textarea', 'email', 'phone', 'number', 'date']);

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
type Side = 'front' | 'back';

function logoUrl(path: string | null): string | null {
  return path ? supabase.storage.from('org-logos').getPublicUrl(path).data.publicUrl : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** 911 and 988, tappable. */
function CrisisLine({ urgent = false }: { urgent?: boolean }) {
  return (
    <p className={urgent ? 'fa-crisis' : 'fa-crisis-inline'} role={urgent ? 'alert' : undefined}>
      In danger now? <a href="tel:911">Call 911</a>. Mental health crisis? <a href="tel:988">Call</a> or <a href="sms:988">text 988</a>.
      {urgent ? ' You can finish this later; your answers are saved.' : ''}
    </p>
  );
}

export default function FamilyAssessment() {
  const [token] = useState(readToken);
  const [view, setView] = useState<AssessmentView | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [answers, setAnswers] = useState<Answers>({});
  const [flagAnswers, setFlagAnswers] = useState<Answers>({});
  const [step, setStep] = useState(0);
  const [resumeStep, setResumeStep] = useState(0);
  const [problem, setProblem] = useState('');
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [cards, setCards] = useState({ front: false, back: false });
  const [uploading, setUploading] = useState<'' | Side>('');
  const [photoError, setPhotoError] = useState<Record<Side, string>>({ front: '', back: '' });
  const [agreed, setAgreed] = useState(false);
  const [signName, setSignName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ at: Date; answers: Answers } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The answers, step and revision as of the last change, for saving outside React's updates.
  const answersRef = useRef<Answers>({});
  const stepRef = useRef(0);
  const revisionRef = useRef(0);
  // The answers the server is known to have at revisionRef: what this page
  // changed since is what it keeps when another tab or device saved too.
  const baseRef = useRef<Answers>({});
  // Saves whose answer never came back (the network dropped, the phone
  // slept): if one of them landed, a refusal later is this page's own save.
  const unconfirmedRef = useRef<Answers[]>([]);
  const editsRef = useRef(0);
  const conflictsRef = useRef(0);

  // What is waiting to be saved; one save at a time, the newest answers last.
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const flagTimerRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const submittedRef = useRef(false);

  const open = view && view.status === 'open' ? view as OpenAssessment : null;

  /**
   * Loads the assessment. `keepPlace`: stay on the step the family is on (a
   * refresh when the page comes back); a refresh never replaces answers
   * typed, or waiting to be saved, while it was on its way.
   */
  const fetchView = useCallback(async (keepPlace = false): Promise<AssessmentView | null> => {
    if (!token) { setLoad('unavailable'); return null; }
    const edits = editsRef.current;
    try {
      const { data, error } = await supabase.rpc('public_family_assessment_open', { p_token: token });
      if (error) { setLoad((current) => (current === 'ready' ? current : 'unreachable')); return null; }
      const next = assessmentViewFromJson(data);
      if (!next) { closedRef.current = true; setLoad('unavailable'); return null; }
      if (keepPlace && next.status === 'open' && (editsRef.current !== edits || dirtyRef.current || savingRef.current)) return next;
      setView(next);
      if (next.status === 'open') {
        answersRef.current = next.answers;
        baseRef.current = next.answers;
        revisionRef.current = next.revision;
        unconfirmedRef.current = [];
        dirtyRef.current = false;
        setAnswers(next.answers);
        setFlagAnswers(next.answers);
        setResumeStep(Math.min(Math.max(next.step, 0), CONSENT_STEP));
        if (!keepPlace) { stepRef.current = 0; setStep(0); }
        setCards({ front: next.cardFront, back: next.cardBack });
        setSavedAt(next.lastSavedAt ? new Date(next.lastSavedAt) : null);
      } else {
        closedRef.current = true;
      }
      setLoad('ready');
      return next;
    } catch {
      setLoad((current) => (current === 'ready' ? current : 'unreachable'));
      return null;
    }
  }, [token]);

  useEffect(() => {
    // Keep the token out of history entries and screenshots of the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    void fetchView();
    // Another link opened in this same tab (only the address's #part
    // changes, so the page does not load again): open that one.
    const onHash = () => { if (assessmentTokenFrom(window.location.hash)) window.location.reload(); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [fetchView]);

  /**
   * Another tab or device saved since this page's revision (RFA02). Its
   * answers are taken, with every answer this page changed kept on top
   * (mergeAnswers), and saved again. When the server's answers are this
   * page's own (a save whose answer was lost), nothing was changed elsewhere.
   */
  const resolveConflict = useCallback(async (sent: Answers): Promise<'merged' | 'own' | 'retry' | 'closed'> => {
    if (!token) return 'retry';
    let fresh: AssessmentView | null;
    try {
      const { data, error } = await supabase.rpc('public_family_assessment_open', { p_token: token });
      // A failed read is not a closed assessment: keep everything and try again.
      if (error) { dirtyRef.current = true; return 'retry'; }
      fresh = assessmentViewFromJson(data);
    } catch {
      dirtyRef.current = true;
      return 'retry';
    }
    if (!fresh || fresh.status !== 'open') { closedRef.current = true; await fetchView(); return 'closed'; }
    const own = sameAnswers(fresh.answers, sent) || unconfirmedRef.current.some((item) => sameAnswers(item, fresh.answers));
    // The server holds this page's own earlier save: the page's answers as
    // they are now are the newest (an answer changed back stays changed back).
    const merged = own ? answersRef.current : mergeAnswers(baseRef.current, answersRef.current, fresh.answers);
    revisionRef.current = fresh.revision;
    baseRef.current = fresh.answers;
    unconfirmedRef.current = [];
    answersRef.current = merged;
    setAnswers(merged);
    setFlagAnswers(merged);
    setCards({ front: fresh.cardFront, back: fresh.cardBack });
    if (!sameAnswers(merged, fresh.answers)) dirtyRef.current = true;
    if (!own) {
      conflictsRef.current += 1;
      setNotice('Some answers were also changed in another tab or on another device. Both sets of changes are kept; please look this section over.');
    }
    return own ? 'own' : 'merged';
  }, [token, fetchView]);

  // Every save goes with keepalive (when small enough for it), so one made
  // as the page is hidden or closed still arrives after the page is gone.
  const sendSave = useCallback(async (answersToSave: Answers, stepToSave: number, revision: number) => {
    const body = JSON.stringify({ p_token: token, p_answers: answersToSave, p_step: stepToSave, p_revision: revision });
    const response = await fetch(`${projectUrl}/rest/v1/rpc/public_family_assessment_save`, {
      method: 'POST',
      // The 64 KB keepalive limit is in bytes (a character can be up to 4).
      keepalive: new TextEncoder().encode(body).length < 60_000,
      headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json' },
      body,
    });
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok) return { data: json, error: null };
    return { data: null, error: { code: typeof json?.code === 'string' ? json.code : String(response.status), message: typeof json?.message === 'string' ? json.message : '' } };
  }, [token]);

  const flush = useCallback(async () => {
    if (!token || savingRef.current || !dirtyRef.current || closedRef.current) return;
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    savingRef.current = true;
    dirtyRef.current = false;
    const pending = { answers: answersRef.current, step: stepRef.current };
    setSaveState('saving');
    let retry = false;
    try {
      const { data, error } = await sendSave(pending.answers, pending.step, revisionRef.current);
      switch (saveOutcome(error)) {
        case 'saved': {
          const revision = Number(data?.revision);
          if (Number.isInteger(revision)) revisionRef.current = revision;
          baseRef.current = pending.answers;
          unconfirmedRef.current = [];
          setSavedAt(new Date());
          setSaveState(dirtyRef.current ? 'saving' : 'saved');
          if (pending.step >= 1) setResumeStep(pending.step);
          break;
        }
        case 'changed_elsewhere': {
          const outcome = await resolveConflict(pending.answers);
          if (outcome === 'retry') { retry = true; setSaveState('failed'); break; }
          setSaveState(dirtyRef.current ? 'saving' : 'saved');
          break;
        }
        case 'already_sent':
        case 'link_stopped':
          closedRef.current = true;
          await fetchView();
          break;
        case 'too_long':
          setSaveState('failed');
          setProblem('Your answers are too long to save. Please shorten the longest ones.');
          break;
        default:
          dirtyRef.current = true;
          retry = true;
          setSaveState('failed');
      }
    } catch {
      // The save may still have landed: remember what it carried.
      unconfirmedRef.current = [...unconfirmedRef.current, pending.answers].slice(-5);
      dirtyRef.current = true;
      retry = true;
      setSaveState('failed');
    } finally {
      savingRef.current = false;
    }
    // Answers changed while saving, or the last try failed: try again soon.
    if (dirtyRef.current && !closedRef.current) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { void flush(); }, retry ? SAVE_DELAY_MS * 4 : SAVE_DELAY_MS);
    }
  }, [token, fetchView, resolveConflict, sendSave]);

  function queueSave(now = false) {
    if (closedRef.current) return;
    dirtyRef.current = true;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flush(); }, now ? 0 : SAVE_DELAY_MS);
  }

  // Phones: save when the page is hidden (another app, the lock screen, the
  // camera) and as it goes away; when it comes back with nothing waiting,
  // pick up what another tab or device saved. A sent assessment shown again
  // from the back-forward cache reloads, so its answers are not shown again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { void flush(); return; }
      if (dirtyRef.current) { void flush(); return; }
      if (!savingRef.current && !closedRef.current && stepRef.current > 0) void fetchView(true);
    };
    const onPageHide = () => { void flush(); };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (submittedRef.current) { window.location.reload(); return; }
      // Back from the back-forward cache: send what is still waiting, or
      // pick up the revision the save made as the page left.
      if (dirtyRef.current) { void flush(); return; }
      if (!savingRef.current && !closedRef.current) void fetchView(true);
    };
    // Closing the tab with answers not saved yet: the browser asks first
    // (the save is sent either way).
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (closedRef.current || (!dirtyRef.current && !savingRef.current)) return;
      void flush();
      event.preventDefault();
      event.returnValue = '';
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [flush, fetchView]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    if (flagTimerRef.current) window.clearTimeout(flagTimerRef.current);
  }, []);

  function setAnswer(field: Field, value: unknown) {
    editsRef.current += 1;
    const next = { ...answersRef.current, [field.id]: value };
    answersRef.current = next;
    setAnswers(next);
    queueSave();
    setProblem('');
    if (invalidField === field.id) setInvalidField(null);
    if (flagTimerRef.current) window.clearTimeout(flagTimerRef.current);
    if (TEXT_KINDS.has(field.kind)) flagTimerRef.current = window.setTimeout(() => setFlagAnswers(answersRef.current), FLAG_DELAY_MS);
    else setFlagAnswers(next);
  }

  function goTo(next: number) {
    stepRef.current = next;
    setStep(next);
    setProblem('');
    setNotice('');
    setInvalidField(null);
    // The welcome screen is not a place to come back to: only sections are saved as the step.
    if (next >= 1) queueSave(true);
    window.scrollTo({ top: 0 });
    window.setTimeout(() => headingRef.current?.focus(), 0);
  }

  function nextStep() {
    const section = SECTIONS[step - 1];
    if (section) {
      const why = sectionProblem(section, answers);
      if (why) {
        setProblem(why);
        const id = firstProblemField(section, answers);
        setInvalidField(id);
        if (id) window.setTimeout(() => document.getElementById(`fa-${id}`)?.focus(), 0);
        return;
      }
    }
    goTo(step + 1);
  }

  async function uploadCard(side: Side, file: File | undefined) {
    if (!file || !token || uploading) return;
    const why = photoProblem(file);
    if (why) { setPhotoError((current) => ({ ...current, [side]: why })); return; }
    setUploading(side);
    setPhotoError((current) => ({ ...current, [side]: '' }));
    try {
      // A new name for every photo (the upload function picks it), then
      // the function records it: a late upload never changes a sent card.
      const signed = await supabase.functions.invoke('family-assessment-upload', { body: { token, side } });
      const target = signed.data as { path?: string; token?: string } | null;
      if (signed.error || !target?.path || !target.token) throw new Error('sign');
      const sent = await supabase.storage.from('assessment-files').uploadToSignedUrl(target.path, target.token, file, { contentType: photoContentType(file) });
      if (sent.error) throw new Error('upload');
      const done = await supabase.functions.invoke('family-assessment-upload', { body: { token, side, action: 'done', path: target.path } });
      if (done.error || (done.data as { done?: unknown } | null)?.done !== true) throw new Error('done');
      setCards((current) => ({ ...current, [side]: true }));
    } catch {
      setPhotoError((current) => ({ ...current, [side]: 'The photo was not sent. Check your connection and try again, or type the details from the card below.' }));
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
    if (uploading) { setProblem('Wait a moment for the card photo to finish sending.'); return; }
    setSubmitting(true);
    setProblem('');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    // A save still on its way would move the revision on: wait for it (a few seconds at most).
    const conflicts = conflictsRef.current;
    for (let waited = 0; savingRef.current && waited < 8000; waited += 100) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (savingRef.current) { setSubmitting(false); setProblem('Still saving your answers. Try again in a moment.'); return; }
    // Answers came in from another device while waiting: the family looks
    // them over before signing for them.
    if (conflictsRef.current !== conflicts) {
      setSubmitting(false);
      setNotice('Some answers were changed on another device while you were signing. Please look them over, then sign again.');
      return;
    }
    // Answers to questions that are now hidden are not kept.
    const final = pruneHidden(answersRef.current);
    try {
      const { error } = await supabase.rpc('public_family_assessment_submit', {
        p_token: token,
        p_answers: final,
        p_agreed: true,
        p_name: signName.trim(),
        p_consent_version: open.consentVersion,
        p_client: navigator.userAgent.slice(0, 300),
        p_revision: revisionRef.current,
      });
      if (error) {
        const outcome = saveOutcome(error);
        if (outcome === 'already_sent' || outcome === 'link_stopped') { closedRef.current = true; await fetchView(); return; }
        if (outcome === 'changed_elsewhere') {
          const resolved = await resolveConflict(answersRef.current);
          if (dirtyRef.current) queueSave(true);
          if (resolved === 'merged') setNotice('Some answers were changed in another tab or on another device. Please look them over, then sign again.');
          else if (resolved === 'own' || resolved === 'retry') setProblem('It was not sent yet. Your answers are being saved; please try again in a moment.');
          return;
        }
        setProblem(error.code && error.message ? error.message : 'It was not sent. Check your connection and try again.');
        return;
      }
      dirtyRef.current = false;
      closedRef.current = true;
      submittedRef.current = true;
      setSubmitted({ at: new Date(), answers: final });
      window.scrollTo({ top: 0 });
    } catch {
      setProblem('It was not sent. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Return in a one-line field never moves to the next section by itself.
  function keepEnter(event: React.KeyboardEvent<HTMLFormElement>) {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && target.tagName === 'INPUT' && !['submit', 'button', 'checkbox', 'radio'].includes((target as HTMLInputElement).type)) {
      event.preventDefault();
    }
  }

  const flags = useMemo(() => safetyFlags(flagAnswers), [flagAnswers]);
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

  if (load === 'loading') return <main className="shell fa">{header}<p className="fa-muted">Opening your assessment…</p></main>;
  if (load === 'unreachable') {
    return (
      <main className="shell fa">
        {header}
        <div className="card"><h2>We could not reach the server</h2><p className="help">Check your connection, then try again. Your saved answers are safe.</p>
          <CrisisLine />
          <button type="button" onClick={() => { setLoad('loading'); void fetchView(); }}>Try again</button></div>
      </main>
    );
  }
  if (load === 'unavailable' || !view) {
    return (
      <main className="shell fa">
        {header}
        <div className="card"><h2>This link is not active</h2>
          <p className="help">It may be incomplete, older than the newest link you were sent, or it may have expired or been stopped. Ask your practitioner to send a new link.</p>
          <CrisisLine /></div>
      </main>
    );
  }

  if (submitted) {
    return (
      <main className="shell fa fa-done">
        {header}
        <div className="card fa-noprint">
          <h2>Thank you. Your assessment was sent to {practice}.</h2>
          <p className="help">{practice} will read it and reach out to you. You can save a copy for your records now: after you leave this page, the link no longer shows your answers.</p>
          <CrisisLine />
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
      <main className="shell fa">
        {header}
        <div className="card"><h2>This assessment was already sent</h2>
          <p className="help">{practice} received it{view.submittedAt ? ` on ${longDate(view.submittedAt)}` : ''}. For your privacy, the answers are not shown here. Reply to the email from {practice} if you need to add something.</p>
          <CrisisLine /></div>
      </main>
    );
  }

  const openView = view as OpenAssessment;
  const section = step >= 1 && step <= SECTIONS.length ? SECTIONS[step - 1] : null;
  const saveText = savedLine(saveState, savedAt);
  const resumeAt = Math.max(1, Math.min(resumeStep || 1, CONSENT_STEP));

  return (
    <main className="shell fa">
      {header}
      {flags.length ? <CrisisLine urgent /> : null}

      {step > 0 ? (
        <div className="fa-progress" aria-hidden="true">
          <div className="fa-progress-bar" style={{ width: `${Math.round((Math.min(step, CONSENT_STEP) / CONSENT_STEP) * 100)}%` }} />
        </div>
      ) : null}
      {step > 0 ? <p className="fa-save">{section ? `Section ${step} of ${SECTIONS.length}` : 'Last step'}{saveText ? ` · ${saveText}` : ''}</p> : null}
      {saveState === 'failed' ? <p className="fa-hidden" role="status">Your answers are not saved yet.</p> : null}
      {notice ? <p className="fa-notice" role="status">{notice}</p> : null}

      {step === 0 ? (
        <div className="card">
          <h2 tabIndex={-1} ref={headingRef}>{openView.recipientName ? `Hello, ${openView.recipientName.split(' ')[0]}` : 'Welcome'}</h2>
          <p className="help">{NOTES.intro(practice)}</p>
          <p className="help">{NOTES.time} {NOTES.saving}</p>
          <p className="help">{NOTES.privacy(practice)}{openView.expiresAt ? ` This link works until ${longDate(openView.expiresAt)}.` : ''}</p>
          <CrisisLine />
          <button type="button" onClick={() => goTo(resumeAt)}>
            {resumeStep > 0 || Object.keys(answers).length ? 'Continue where you left off' : 'Start'}
          </button>
        </div>
      ) : null}

      {section ? (
        <form className="card" onSubmit={(event) => { event.preventDefault(); nextStep(); }} onKeyDown={keepEnter} noValidate>
          <h2 tabIndex={-1} ref={headingRef}>{section.title}</h2>
          {section.intro ? <p className="help">{section.intro}</p> : null}
          {section.id === 'mental_health' ? <div className="fa-warning">{NOTES.mentalHealthWarning}</div> : null}
          {section.fields.filter((field) => fieldVisible(field, answers)).map((field) => (
            <div key={field.id}>
              <FieldInput
                field={field}
                value={answers[field.id]}
                invalid={invalidField === field.id}
                onChange={(value) => setAnswer(field, value)}
                card={field.id === 'insuranceCardFront' ? cards.front : field.id === 'insuranceCardBack' ? cards.back : false}
                uploading={uploading}
                photoError={field.id === 'insuranceCardFront' ? photoError.front : field.id === 'insuranceCardBack' ? photoError.back : ''}
                onPhoto={(side, file) => { void uploadCard(side, file); }}
              />
              {field.id === 'deliriumTremensHistory' && withdrawalWarning(answers) ? <div className="fa-warning" role="alert">{WITHDRAWAL_TEXT}</div> : null}
            </div>
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
        <form className="card" onSubmit={submit} onKeyDown={keepEnter} noValidate>
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
  invalid: boolean;
  onChange: (value: unknown) => void;
  card: boolean;
  uploading: '' | Side;
  photoError: string;
  onPhoto: (side: Side, file: File | undefined) => void;
};

function FieldInput({ field, value, invalid, onChange, card, uploading, photoError, onPhoto }: FieldProps) {
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
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.target.value.slice(0, 200))}
            autoComplete={field.id === 'contactEmail' ? 'email' : field.id === 'contactPhone' ? 'tel' : field.id === 'contactName' ? 'name' : 'off'}
          />
        </div>
      );
    case 'textarea':
      return (
        <div className="fa-field">
          {label}{help}
          <textarea id={id} value={asText(value)} aria-invalid={invalid || undefined} onChange={(event) => onChange(event.target.value.slice(0, 4000))} />
        </div>
      );
    case 'choice': {
      const values = field.values ?? field.options;
      if (field.options.length <= 4) {
        return (
          <fieldset className="fa-field fa-radios" aria-invalid={invalid || undefined}>
            <legend>{field.label}{required ? ' (required)' : ''}</legend>{help}
            {field.options.map((option, index) => (
              <label key={values[index]} className="fa-check">
                <input id={index === 0 ? id : undefined} type="radio" name={id} value={values[index]} checked={value === values[index]} onChange={() => onChange(values[index])} />
                <span>{option}</span>
              </label>
            ))}
          </fieldset>
        );
      }
      return (
        <div className="fa-field">
          {label}{help}
          <select id={id} value={asText(value)} aria-invalid={invalid || undefined} onChange={(event) => onChange(event.target.value)}>
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
      const addId = `${id}-add`;
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
              <button type="button" className="fa-secondary" onClick={() => {
                onChange(rows.filter((_, i) => i !== index));
                window.setTimeout(() => document.getElementById(addId)?.focus(), 0);
              }}>Remove {field.itemLabel.toLowerCase()} {index + 1}</button>
            </div>
          ))}
          {rows.length < 20 ? <button id={addId} type="button" className="fa-secondary" onClick={() => onChange([...rows, {}])}>Add {field.itemLabel.toLowerCase()}</button> : null}
        </fieldset>
      );
    }
    case 'photo': {
      const side: Side = field.id === 'insuranceCardFront' ? 'front' : 'back';
      return (
        <div className="fa-field">
          <label htmlFor={id}>{field.label} (optional)</label>
          {side === 'front' ? <p className="fa-help">{NOTES.insuranceWhy} {NOTES.insuranceCard}</p> : null}
          {/* image/*: an iPhone then sends its HEIC photos as JPEG, which every screen can show. */}
          <input id={id} type="file" accept="image/*" disabled={Boolean(uploading)}
            onChange={(event) => { onPhoto(side, event.target.files?.[0]); event.target.value = ''; }} />
          {photoError ? <p className="fa-problem" role="alert">{photoError}</p> : null}
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
