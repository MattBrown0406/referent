import type { Partner } from '../data';

export type VoiceTouchKind = 'call' | 'text' | 'email' | 'meeting' | 'other';
export type VoicePartnerConfidence = 'none' | 'low' | 'medium' | 'high';

export type VoiceDraftWarning = {
  code: 'possible-clinical-detail' | 'possible-family-detail';
  message: string;
};

export type VoiceFollowUpDraft = {
  title: string;
  dueOn: string; // local YYYY-MM-DD
  dueTime?: string; // local HH:MM
};

/**
 * An editable suggestion only. Consumers must show this draft for approval and
 * must not treat the parser result as permission to persist anything.
 */
export type VoiceTranscriptDraft = {
  partnerId?: string;
  partnerName?: string;
  partnerConfidence: VoicePartnerConfidence;
  touchKind: VoiceTouchKind;
  note: string;
  followUp?: VoiceFollowUpDraft;
  warnings: VoiceDraftWarning[];
  approvalRequired: true;
  autoSave: false;
};

type PartnerSuggestion = {
  partnerId?: string;
  partnerName?: string;
  confidence: VoicePartnerConfidence;
};

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const DATE_PHRASE =
  '\\b(?:today|tomorrow|next\\s+week|in\\s+\\d+\\s+(?:days?|weeks?)|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?)\\b';

function normalizedWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function containsPhrase(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

function suggestPartner(transcript: string, partners: readonly Partner[]): PartnerSuggestion {
  const spoken = normalizedWords(transcript);
  const matches = partners
    .map((partner) => {
      const fullName = normalizedWords(partner.name);
      const organization = normalizedWords(partner.organization);
      const nameMatch = fullName.split(' ').length >= 2 && containsPhrase(spoken, fullName);
      const organizationMatch = organization.length >= 4 && containsPhrase(spoken, organization);
      return { partner, score: nameMatch || organizationMatch ? 3 : 0 };
    })
    .filter((match) => match.score > 0);

  if (matches.length === 0) return { confidence: 'none' };

  const bestScore = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === bestScore);
  if (best.length !== 1) return { confidence: 'none' };

  return {
    partnerId: best[0].partner.id,
    partnerName: best[0].partner.name,
    confidence: 'high',
  };
}

function detectTouchKind(transcript: string): VoiceTouchKind {
  if (/\b(?:met\s+with|meeting|had\s+(?:a\s+)?meeting|sat\s+down\s+with)\b/i.test(transcript)) return 'meeting';
  if (/\b(?:texted|sent\s+(?:a\s+)?text|sms(?:ed)?)\b/i.test(transcript)) return 'text';
  if (/\b(?:emailed|sent\s+(?:an\s+)?email)\b/i.test(transcript)) return 'email';
  if (/\b(?:called|phoned|spoke\s+(?:to|with)|voicemail|phone\s+call)\b/i.test(transcript)) return 'call';
  return 'other';
}

function addLocalDays(referenceDate: Date, days: number): Date {
  return new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate() + days,
    12,
    0,
    0,
    0,
  );
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function weekdayIndex(phrase: string): number | undefined {
  const lower = phrase.toLocaleLowerCase();
  const prefixes = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const index = prefixes.findIndex((prefix) => lower.startsWith(prefix));
  return index >= 0 ? index : undefined;
}

function parseLocalDueDate(phrase: string, referenceDate: Date): string | undefined {
  const normalized = phrase.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  let days: number | undefined;

  if (normalized === 'today') days = 0;
  else if (normalized === 'tomorrow') days = 1;
  else if (normalized === 'next week') days = 7;
  else {
    const relative = normalized.match(/^in (\d+) (days?|weeks?)$/);
    if (relative) {
      const amount = Number(relative[1]);
      days = relative[2].startsWith('week') ? amount * 7 : amount;
    } else {
      const targetDay = weekdayIndex(normalized);
      if (targetDay !== undefined) {
        const difference = (targetDay - referenceDate.getDay() + 7) % 7;
        days = difference === 0 ? 7 : difference;
      }
    }
  }

  return days === undefined ? undefined : formatLocalDate(addLocalDays(referenceDate, days));
}

function parseTime(command: string): string | undefined {
  if (/\bat\s+noon\b/i.test(command)) return '12:00';
  if (/\bat\s+midnight\b/i.test(command)) return '00:00';

  const match = command.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[3]?.toLocaleLowerCase().replace(/\./g, '');
  if (hour > 23 || minute > 59 || (meridiem && hour > 12)) return undefined;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

type FollowUpParse = { followUp?: VoiceFollowUpDraft; command?: string };

function parseFollowUp(
  transcript: string,
  referenceDate: Date,
  partnerName?: string,
): FollowUpParse {
  // Date phrases only create follow-ups when they occur in an action command;
  // "called today" describes a touch and must not create a task.
  const actionPattern = new RegExp(
    `(?:follow\\s*up|check\\s+in|reach\\s+out|call|text|email)\\b[^.!?\\n]*?(${DATE_PHRASE})[^.!?\\n]*[.!?]?`,
    'i',
  );
  const match = transcript.match(actionPattern);
  if (!match) return {};

  const dueOn = parseLocalDueDate(match[1], referenceDate);
  if (!dueOn) return {};

  const command = match[0].trim();
  const action = command.match(/^\s*(follow\s*up|check\s+in|reach\s+out|call|text|email)\b/i)?.[1]
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
  const displayName = partnerName?.trim();
  let title: string;
  if (action === 'call') title = `Call${displayName ? ` ${displayName}` : ''}`;
  else if (action === 'text') title = `Text${displayName ? ` ${displayName}` : ''}`;
  else if (action === 'email') title = `Email${displayName ? ` ${displayName}` : ''}`;
  else title = `Follow up${displayName ? ` — ${displayName}` : ''}`;

  const dueTime = parseTime(command);
  return {
    command,
    followUp: { title, dueOn, ...(dueTime ? { dueTime } : {}) },
  };
}

function cleanNote(transcript: string, followUpCommand?: string): string {
  let note = transcript.normalize('NFKC').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (followUpCommand) note = note.replace(followUpCommand, ' ').replace(/\s+/g, ' ').trim();
  note = note.replace(/^(?:um+|uh+|okay|ok)[,\s]+/i, '').trim();
  note = note.replace(/\s+([,.;!?])/g, '$1').replace(/^[,.;:\-\s]+|[,;:\-\s]+$/g, '').trim();
  return note;
}

function detectWarnings(transcript: string, partners: readonly Partner[]): VoiceDraftWarning[] {
  const warnings: VoiceDraftWarning[] = [];
  // Do not flag words that occur only inside a known contact or organization
  // name (for example, "Cascade Detox" or "Family Recovery").
  let detailText = transcript;
  for (const partner of partners) {
    for (const label of [partner.name, partner.organization]) {
      const escaped = label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escaped) detailText = detailText.replace(new RegExp(escaped, 'gi'), ' ');
    }
  }

  const clinical = /\b(?:diagnos(?:is|ed)|bipolar|schizophren(?:ia|ic)|psychosis|suicid(?:e|al)|self[- ]harm|overdose|relaps(?:e|ed)|detox|medication|clinical|medical|mental health|substance use)\b/i;
  const family = /\b(?:mother|father|mom|dad|parent|daughter|son|sister|brother|wife|husband|spouse|family)\b/i;

  if (clinical.test(detailText)) {
    warnings.push({
      code: 'possible-clinical-detail',
      message: 'Possible clinical detail detected. Review and remove sensitive detail before placing this note in the referral ledger.',
    });
  }
  if (family.test(detailText)) {
    warnings.push({
      code: 'possible-family-detail',
      message: 'Possible sensitive family detail detected. Review and remove sensitive detail before placing this note in the referral ledger.',
    });
  }
  return warnings;
}

/**
 * Converts a transient transcript into an editable, never-auto-saved draft.
 * This function is deterministic and has no storage, network, or clock access.
 */
export function parseVoiceTranscript(
  transcript: string,
  partners: readonly Partner[],
  referenceDate: Date,
): VoiceTranscriptDraft {
  const input = transcript.trim();
  if (!input) {
    return {
      partnerConfidence: 'none',
      touchKind: 'other',
      note: '',
      warnings: [],
      approvalRequired: true,
      autoSave: false,
    };
  }

  const suggestion = suggestPartner(input, partners);
  const parsedFollowUp = parseFollowUp(input, referenceDate, suggestion.partnerName);

  return {
    ...(suggestion.partnerId ? { partnerId: suggestion.partnerId } : {}),
    ...(suggestion.partnerName ? { partnerName: suggestion.partnerName } : {}),
    partnerConfidence: suggestion.confidence,
    touchKind: detectTouchKind(input),
    note: cleanNote(input, parsedFollowUp.command),
    ...(parsedFollowUp.followUp ? { followUp: parsedFollowUp.followUp } : {}),
    warnings: detectWarnings(input, partners),
    approvalRequired: true,
    autoSave: false,
  };
}
