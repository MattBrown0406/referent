// The family assessment on the practitioner's side (docs/FAMILY_ASSESSMENT.md):
// reading the rows (20261109140000 family_assessments), what to say about
// one, the answers grouped by level-of-care area for rating by hand, and the
// answers without who anyone is, for an AI suggestion on the practitioner's
// own key. Pure: no React, no network, so scripts/family-assessment-test.mjs
// covers it.

import {
  DSM_SEVERITY_LABEL,
  SAFETY_FLAG_LABEL,
  SECTIONS,
  dsmCount,
  dsmSeverity,
  fieldIndex,
  fieldVisible,
  safetyFlags,
  sectionAnswerLines,
  withdrawalWarning,
  type Answers,
  type Field,
  type SafetyFlag,
} from './assessment-schema';
import type { DimensionKey } from './level-of-care';

export const FAMILY_ASSESSMENT_PAGE = 'https://portal.referralfit.com/f';

export type FamilyAssessmentStatus = 'sent' | 'started' | 'submitted' | 'revoked';

export type FamilyAssessment = {
  id: string;
  caseId: string;
  status: FamilyAssessmentStatus;
  recipientName: string;
  recipientEmail: string;
  answers: Answers;
  step: number;
  cardFront: boolean;
  cardBack: boolean;
  urgent: SafetyFlag[];
  consentName: string;
  consentVersion: string;
  consentText: string;
  consentAt: string;
  createdAt: string;
  emailedAt: string;
  startedAt: string;
  lastSavedAt: string;
  submittedAt: string;
  revokedAt: string;
  expiresAt: string;
};

const STATUSES: FamilyAssessmentStatus[] = ['sent', 'started', 'submitted', 'revoked'];
const FLAGS = Object.keys(SAFETY_FLAG_LABEL) as SafetyFlag[];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A family_assessments row, read defensively; null when it is not one. */
export function assessmentFromRow(value: unknown): FamilyAssessment | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const status = STATUSES.find((item) => item === row.status);
  if (!status || typeof row.id !== 'string' || typeof row.case_id !== 'string') return null;
  const answers = row.answers && typeof row.answers === 'object' && !Array.isArray(row.answers) ? row.answers as Answers : {};
  return {
    id: row.id,
    caseId: row.case_id,
    status,
    recipientName: str(row.recipient_name),
    recipientEmail: str(row.recipient_email),
    answers,
    step: typeof row.step === 'number' ? row.step : 0,
    cardFront: Boolean(row.card_front_at),
    cardBack: Boolean(row.card_back_at),
    urgent: Array.isArray(row.urgent) ? row.urgent.filter((flag): flag is SafetyFlag => FLAGS.includes(flag as SafetyFlag)) : [],
    consentName: str(row.consent_name),
    consentVersion: str(row.consent_version),
    consentText: str(row.consent_text),
    consentAt: str(row.consent_at),
    createdAt: str(row.created_at),
    emailedAt: str(row.emailed_at),
    startedAt: str(row.started_at),
    lastSavedAt: str(row.last_saved_at),
    submittedAt: str(row.submitted_at),
    revokedAt: str(row.revoked_at),
    expiresAt: str(row.expires_at),
  };
}

/** The assessment a case shows: the newest one (a finished one stays shown until a newer one is sent). */
export function currentAssessment(list: FamilyAssessment[]): FamilyAssessment | null {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** Open: the family can still fill it in (sent or started, not past its date). */
export function isOpen(assessment: FamilyAssessment, now = new Date()): boolean {
  return (assessment.status === 'sent' || assessment.status === 'started') && Date.parse(assessment.expiresAt) > now.getTime();
}

function shortDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One line for the case: where the assessment stands. */
export function statusLine(assessment: FamilyAssessment, now = new Date()): string {
  if (assessment.status === 'submitted') {
    return `Finished ${shortDate(assessment.submittedAt)}${assessment.urgent.length ? ' · needs attention today' : ''}`;
  }
  if (assessment.status === 'revoked') return `Stopped ${shortDate(assessment.revokedAt)}`;
  if (!isOpen(assessment, now)) return `The link expired ${shortDate(assessment.expiresAt)}. Send a new one.`;
  const to = assessment.recipientName ? ` to ${assessment.recipientName}` : '';
  if (assessment.status === 'started') {
    const section = Math.min(Math.max(assessment.step, 1), SECTIONS.length);
    return `In progress${to} · section ${section} of ${SECTIONS.length} · saved ${shortDate(assessment.lastSavedAt)}`;
  }
  return `Sent${to} ${shortDate(assessment.emailedAt || assessment.createdAt)} · not started yet`;
}

/** The private link for a token (only the newest five links of an assessment work). */
export function assessmentLink(token: string): string {
  return `${FAMILY_ASSESSMENT_PAGE}#${token}`;
}

/** What to send in a text or email of the practitioner's own. */
export function linkMessage(practice: string, link: string): string {
  const name = practice.trim() || 'Our practice';
  return `${name} would like you to fill out a confidential family assessment about your loved one. It takes about 30 to 45 minutes, saves as you go, and you can come back to it with this private link: ${link}\nPlease do not forward it. If anyone is in danger, call 911; for a mental health crisis, call or text 988.`;
}

// ─── Reading the answers ─────────────────────────────────────────────────────

export type Alert = { text: string; severity: 'urgent' | 'medical' };

/** What the practitioner should see first: danger now, and withdrawal that needs a doctor. */
export function assessmentAlerts(assessment: FamilyAssessment): Alert[] {
  // The flags the server stored on submit, or the same rules on what was saved so far.
  const flags = assessment.status === 'submitted' ? assessment.urgent : safetyFlags(assessment.answers);
  const alerts: Alert[] = flags.map((flag) => ({ text: SAFETY_FLAG_LABEL[flag], severity: 'urgent' }));
  if (withdrawalWarning(assessment.answers)) alerts.push({ text: 'Seizures or DTs in past withdrawal: medically supervised withdrawal', severity: 'medical' });
  return alerts;
}

/** "7 of 11 DSM-5 criteria checked by the family: Severe" */
export function dsmLine(answers: Answers): string {
  const count = dsmCount(answers);
  return `${count} of 11 DSM-5 criteria checked by the family: ${DSM_SEVERITY_LABEL[dsmSeverity(count)]}. Not a diagnosis.`;
}

export type SectionLines = { id: string; title: string; lines: { label: string; value: string }[] };

/** Every answered section, in order, as "question: answer" lines. */
export function answerSections(answers: Answers): SectionLines[] {
  return SECTIONS
    .map((section) => ({ id: section.id, title: section.title, lines: sectionAnswerLines(section, answers) }))
    .filter((section) => section.lines.length);
}

// The questions that speak to each level-of-care area, for the practitioner
// rating by hand (shown under each area) and for the AI suggestion.
export const DIMENSION_FIELDS: Record<DimensionKey, string[]> = {
  withdrawal: ['primarySubstances', 'substancesUsed', 'typicalDailyUse', 'ivDrugUse', 'overdoseHistory', 'naloxoneReversals',
    'physicalWithdrawalSymptoms', 'psychologicalWithdrawalSymptoms', 'withdrawalDescription', 'seizureHistory',
    'deliriumTremensHistory', 'hospitalizedDetox'],
  physical: ['healthIssues', 'healthIssuesList', 'chronicPain', 'recentERVisits', 'prescribedMedications', 'prescribedMedicationsList'],
  emotional: ['mentalHealthSigns', 'currentMentalHealthSymptoms', 'suicideIdeation', 'suicideAttemptsHistory', 'selfHarmHistory',
    'homicidalIdeation', 'traumaHistory', 'traumaDetails', 'psychiatricHistory', 'psychiatricDetails', 'violenceHistory'],
  readiness: ['stageOfChange', 'acknowledgesProblem', 'willingnessToChange', 'resistanceFactors', 'whatWorkedBefore', 'whatDidntWork'],
  relapse: ['durationOfUse', 'longestSobrietyPeriod', 'relapseTriggers', 'highRiskSituations', 'priorTreatment', 'treatmentHistory',
    'twelveStepInvolvement'],
  environment: ['livingSituation', 'stableLiving', 'peopleUsingInHome', 'supportNetwork', 'legalIssues', 'probationParole',
    'legalIssuesDetails', 'familyEnabling', 'enablingDetails', 'childrenPresent', 'familyUnityLevel'],
};

const FIELDS = fieldIndex();

function lineFor(field: Field, answers: Answers): string {
  const section = SECTIONS.find((item) => item.fields.includes(field));
  if (!section || !fieldVisible(field, answers)) return '';
  const line = sectionAnswerLines({ ...section, fields: [field] }, answers)[0];
  return line ? `${line.label}: ${line.value}` : '';
}

/** Under each area of the level-of-care sheet: what the family said about it. */
export function dimensionHints(answers: Answers): Record<DimensionKey, string[]> {
  const hints = {} as Record<DimensionKey, string[]>;
  for (const [key, ids] of Object.entries(DIMENSION_FIELDS) as [DimensionKey, string[]][]) {
    hints[key] = ids
      .map((id) => FIELDS.get(id))
      .filter((field): field is Field => Boolean(field))
      .map((field) => lineFor(field, answers))
      .filter(Boolean);
    if (key === 'relapse' && dsmCount(answers) > 0) hints[key].push(dsmLine(answers));
  }
  return hints;
}

// Who anyone is: never sent for an AI suggestion. Free text can still name
// people, which the practitioner is told before sending.
export const IDENTIFYING_FIELDS = new Set([
  'contactName', 'contactEmail', 'contactPhone', 'bestDayToContact', 'bestTimeToContact',
  'fullName', 'dateOfBirth', 'occupation',
  'insuranceProvider', 'insurancePolicyNumber', 'insuranceGroupNumber', 'insurancePhone', 'stateMedicaid', 'budgetForTreatment',
]);
// Names inside list rows.
const IDENTIFYING_ROW_FIELDS = new Set(['name', 'programName']);

/** The answers for an AI suggestion: every answered section, without who anyone is. */
export function levelOfCareFacts(answers: Answers): { section: string; lines: string[] }[] {
  const safe: Answers = {};
  for (const [id, value] of Object.entries(answers)) {
    if (IDENTIFYING_FIELDS.has(id)) continue;
    safe[id] = Array.isArray(value)
      ? value.map((row) => (row && typeof row === 'object' && !Array.isArray(row)
        ? Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key]) => !IDENTIFYING_ROW_FIELDS.has(key)))
        : row))
      : value;
  }
  return answerSections(safe).map((section) => ({
    section: section.title,
    lines: section.lines.map((line) => `${line.label}: ${line.value}`),
  }));
}
