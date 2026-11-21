// A case brief for a program's admissions team (Matt, 2026-11-21).
//
// One short, plain summary of a finished family assessment: who (age and
// gender only), substances, withdrawal and medical risk, mental health,
// readiness, earlier treatment, home, payment, level of care and urgency.
// It is what an admissions call usually spends ten minutes on.
//
// Built only from the assessment's CHOICES (never its free-text boxes,
// which can name people, places and programs), so it carries no names,
// contact details, birth date, member or group numbers, program names or
// dollar amounts. The practitioner reads and can edit it before it goes;
// shareBriefProblem checks the edited text with the same rules every other
// text programs read is checked with (identifying-text.ts).
//
// Pure (no React, no Supabase): scripts/case-brief-test.mjs.

import { choiceLabel, fieldIndex, type Answers, type Field } from './assessment-schema';
import { identifyingTextProblem } from './identifying-text';

export type BriefInput = {
  answers: Answers;
  /** The carrier on the case's Benefits, if any (never the member id). */
  planCarrier?: string;
  /** The case's level-of-care rating, if any. */
  rated?: { chosenLevel: string; recommended: string } | null;
};

const FIELDS = fieldIndex();
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const yes = (value: unknown): boolean => value === 'yes' || value === true;
const no = (value: unknown): boolean => value === 'no';

function words(id: string, value: unknown): string {
  const field = FIELDS.get(id);
  return field ? choiceLabel(field, value) : text(value);
}

function subWords(listId: string, subId: string, value: unknown): string {
  const list = FIELDS.get(listId);
  if (!list || list.kind !== 'list') return text(value);
  const sub = list.fields.find((item: Field) => item.id === subId);
  return sub ? choiceLabel(sub, value) : text(value);
}

/** Only the part before " - " or " (": "Contemplation - Aware of ..." is "Contemplation". */
const short = (label: string): string => label.split(/ - | \(/)[0].trim();

function ageWords(answers: Answers): string {
  const raw = answers.age;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0 || value >= 120) return '';
  // Ages over 89 are grouped, as de-identified health records do.
  return value >= 90 ? '90 or older' : `${Math.floor(value)}`;
}

/** The text-free lines of the brief, in reading order. */
export function caseBriefLines(input: BriefInput): string[] {
  const { answers } = input;
  const lines: string[] = [];
  const add = (label: string, parts: string[]) => {
    const kept = parts.filter(Boolean);
    if (kept.length) lines.push(`- ${label}: ${kept.join('; ')}`);
  };

  // Who.
  const age = ageWords(answers);
  const gender = words('gender', answers.gender);
  add('Client', [age ? `age ${age}` : '', gender ? gender.toLowerCase() : '', words('veteranStatus', answers.veteranStatus) === 'Veteran' ? 'veteran' : words('veteranStatus', answers.veteranStatus) === 'Active Duty' ? 'active duty' : '']);

  // Substances, from the structured rows only.
  const rows = Array.isArray(answers.substancesUsed) ? answers.substancesUsed.filter((row) => row && typeof row === 'object') as Record<string, unknown>[] : [];
  const substances = rows
    .map((row) => {
      const name = subWords('substancesUsed', 'substance', row.substance);
      if (!name || name === 'Other') return '';
      const detail = [
        subWords('substancesUsed', 'frequency', row.frequency).toLowerCase(),
        short(subWords('substancesUsed', 'routeOfAdministration', row.routeOfAdministration)).toLowerCase(),
        row.currentlyUsing === true ? 'current' : '',
      ].filter(Boolean).join(', ');
      return detail ? `${short(name)} (${detail})` : short(name);
    })
    .filter(Boolean);
  add('Substances', substances);
  add('Use', [
    answers.durationOfUse ? `problem use ${words('durationOfUse', answers.durationOfUse).toLowerCase()}` : '',
    answers.longestSobrietyPeriod ? `longest sober: ${words('longestSobrietyPeriod', answers.longestSobrietyPeriod).toLowerCase()}` : '',
    yes(answers.polysubstanceUse) ? 'polysubstance' : '',
    text(answers.ivDrugUse) === 'current' ? 'IV use now' : text(answers.ivDrugUse) === 'past' ? 'IV use in the past' : '',
    yes(answers.overdoseHistory) ? 'has overdosed before' : '',
  ]);

  // Withdrawal and medical.
  const physical = Array.isArray(answers.physicalWithdrawalSymptoms) ? answers.physicalWithdrawalSymptoms.filter((item) => typeof item === 'string' && item.trim()) as string[] : [];
  add('Withdrawal', [
    yes(answers.seizureHistory) ? 'seizures in withdrawal' : '',
    yes(answers.deliriumTremensHistory) ? 'DTs in withdrawal' : '',
    physical.length ? `${physical.length} physical sign${physical.length === 1 ? '' : 's'} seen (${physical.slice(0, 4).map(short).join(', ').toLowerCase()}${physical.length > 4 ? ', more' : ''})` : '',
    yes(answers.hospitalizedDetox) ? 'medical detox before' : '',
  ]);
  add('Medical', [
    yes(answers.healthIssues) ? 'known health issues' : '',
    yes(answers.chronicPain) ? 'chronic pain' : '',
    yes(answers.prescribedMedications) ? 'takes prescribed medications' : '',
    yes(answers.recentERVisits) ? 'recent ER visits or hospital stays' : '',
  ]);

  // Mental health and safety.
  const suicide = text(answers.suicideIdeation);
  add('Mental health', [
    yes(answers.psychiatricHistory) ? 'psychiatric diagnoses or hospital stays' : '',
    yes(answers.mentalHealthSigns) ? 'signs of depression, anxiety or a mood disorder' : '',
    text(answers.traumaHistory) === 'yes' ? 'trauma history' : text(answers.traumaHistory) === 'suspected' ? 'trauma suspected' : '',
  ]);
  add('Safety', [
    suicide === 'yes' ? 'current suicidal thoughts reported' : '',
    yes(answers.suicideAttemptsHistory) ? 'past suicide attempt' : '',
    yes(answers.selfHarmHistory) ? 'past self-harm' : '',
    yes(answers.homicidalIdeation) ? 'homicidal thoughts or threats reported' : '',
    yes(answers.violenceHistory) ? 'history of violence or aggression' : '',
  ]);

  // Readiness and earlier treatment.
  add('Readiness', [
    answers.stageOfChange ? short(words('stageOfChange', answers.stageOfChange)).toLowerCase() : '',
    answers.acknowledgesProblem ? words('acknowledgesProblem', answers.acknowledgesProblem).toLowerCase() : '',
    answers.willingnessToChange ? `willing ${text(answers.willingnessToChange)} of 10` : '',
  ]);
  const programs = yes(answers.priorTreatment) && Array.isArray(answers.treatmentHistory)
    ? answers.treatmentHistory.filter((row) => row && typeof row === 'object') as Record<string, unknown>[]
    : [];
  if (programs.length) {
    const types = Array.from(new Set(programs.map((row) => subWords('treatmentHistory', 'programType', row.programType)).filter((label) => label && label !== 'Other'))).map((label) => label.toLowerCase());
    const completed = programs.filter((row) => row.successfulCompletion === true).length;
    add('Earlier treatment', [`${programs.length} program${programs.length === 1 ? '' : 's'}${types.length ? ` (${types.join(', ')})` : ''}`, `${completed} completed`]);
  } else if (no(answers.priorTreatment)) {
    add('Earlier treatment', ['none']);
  }

  // Home.
  add('Home', [
    no(answers.stableLiving) ? 'no stable housing' : yes(answers.stableLiving) ? 'stable housing' : '',
    yes(answers.peopleUsingInHome) ? 'others use at home' : '',
    answers.supportNetwork ? `support network ${words('supportNetwork', answers.supportNetwork).toLowerCase()}` : '',
    yes(answers.legalIssues) ? 'current legal issues' : '',
    yes(answers.probationParole) ? 'on probation or parole' : '',
  ]);

  // Payment: the carrier only, never numbers or the budget.
  const carrier = (input.planCarrier || '').trim();
  const typed = text(answers.insuranceProvider);
  const budget = text(answers.budgetForTreatment);
  add('Payment', [
    carrier ? `insurance: ${carrier}` : '',
    !carrier && yes(answers.stateMedicaid) ? 'State Medicaid' : '',
    !carrier && !yes(answers.stateMedicaid) && typed ? 'insurance (plan to confirm)' : '',
    !carrier && !typed && !yes(answers.stateMedicaid) && budget && budget !== 'not-applicable' ? 'self-pay' : '',
  ]);

  // Level of care and urgency.
  if (input.rated) add('Level of care', [`${input.rated.chosenLevel} (rated by the practitioner; recommended: ${input.rated.recommended})`]);
  if (answers.urgencyLevel) add('Urgency', [short(words('urgencyLevel', answers.urgencyLevel))]);
  return lines;
}

export const BRIEF_HEADER = 'CASE BRIEF';
export const BRIEF_FOOTER = 'From the family’s assessment and the practitioner’s rating. No names or contact details; ask the practitioner for anything else.';

/** The whole brief as plain text, ready to read, edit and share. '' when the answers say nothing. */
export function caseBriefText(input: BriefInput): string {
  const lines = caseBriefLines(input);
  if (!lines.length) return '';
  return [BRIEF_HEADER, ...lines, '', BRIEF_FOOTER].join('\n');
}

/**
 * The first thing in an edited brief a program should not read, or null:
 * the shared identifying-text rules, line by line (they refuse line breaks
 * in one field), with the case's names. `names` are the case title, the
 * contact names and the names the family typed in the assessment.
 */
export function shareBriefProblem(brief: string, names: string[]): string | null {
  for (const line of brief.split('\n')) {
    if (!line.trim()) continue;
    const problem = identifyingTextProblem(line, names.filter((name) => name.trim()));
    if (problem) return problem;
  }
  return null;
}

/** The names on an assessment the brief must never carry. */
export function assessmentNames(answers: Answers): string[] {
  const names = [text(answers.fullName), text(answers.contactName)];
  const members = Array.isArray(answers.familyMembersParticipating) ? answers.familyMembersParticipating : [];
  for (const row of members) {
    if (row && typeof row === 'object') names.push(text((row as Record<string, unknown>).name));
  }
  return names.filter(Boolean);
}
