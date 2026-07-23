import { createEmptyWorkflowState } from './state';
import type {
  CaseKind,
  CaseStatus,
  LegacyProvenance,
  PaymentStatus,
  WorkflowState,
} from './types';

export class LegacyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

export interface LegacyImportOptions {
  sourceId: string;
  importedAt: string;
  defaultTimeZone: string;
}

export interface LegacyImportResult {
  state: WorkflowState;
  warnings: string[];
  fingerprint: string;
  alreadyImported: boolean;
}

type UnknownRecord = Record<string, unknown>;
interface LegacyPayload extends UnknownRecord {
  families: unknown[];
  scheduleItems: unknown[];
  tasks: unknown[];
}

const CHECKLIST_LABELS: Record<string, string> = {
  contractSent: 'Contract sent',
  contractSigned: 'Contract signed',
  paymentReceived: 'Payment received',
  prepCallCompleted: 'Prep call completed',
  treatmentSelected: 'Treatment selected',
  interventionDateSet: 'Intervention date set',
  interventionCompleted: 'Intervention completed',
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(input: string | unknown): LegacyPayload {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new LegacyImportError('Legacy payload is not valid JSON');
    }
  }
  if (!isRecord(parsed)) throw new LegacyImportError('Legacy payload must be a top-level object');
  if (!Array.isArray(parsed.families) || !Array.isArray(parsed.scheduleItems) || !Array.isArray(parsed.tasks)) {
    throw new LegacyImportError('Legacy payload must contain families, scheduleItems, and tasks arrays');
  }
  return parsed as LegacyPayload;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  const hash = (seed: number, prime: number, reverse = false) => {
    let result = seed;
    for (let step = 0; step < text.length; step += 1) {
      const index = reverse ? text.length - step - 1 : step;
      result ^= text.charCodeAt(index);
      result = Math.imul(result, prime);
      result ^= result >>> 13;
    }
    return (result >>> 0).toString(16).padStart(8, '0');
  };
  // A 96-bit composite plus byte length avoids the practical collision risk of
  // the former single 32-bit FNV value while remaining synchronous in Hermes.
  return `c96-${text.length.toString(16)}-${hash(0x811c9dc5, 0x01000193)}${hash(0x9e3779b9, 0x85ebca6b, true)}${hash(0xc2b2ae35, 0x27d4eb2d)}`;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function legacyId(record: UnknownRecord, fallback: string): string {
  const value = record.id ?? record.localId ?? record.local_id;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return fallback;
}

function sourceEntityId(sourceId: string, kind: string, id: string): string {
  return `legacy:${encodeURIComponent(sourceId)}:${kind}:${encodeURIComponent(id)}`;
}

function provenance(sourceId: string, id: string, importedAt: string): LegacyProvenance {
  return { sourceId, legacyId: id, importedAt };
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function caseKind(value: unknown): CaseKind {
  return typeof value === 'string' && value.trim().toLowerCase() === 'coaching' ? 'coaching' : 'intervention';
}

function caseStatus(value: unknown, warnings: string[], familyId: string): CaseStatus {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'new';
  const aliases: Record<string, CaseStatus> = {
    new: 'new', active: 'engaged', engaged: 'engaged', prep: 'preparing', preparing: 'preparing',
    scheduled: 'scheduled', completed: 'completed', complete: 'completed', closed: 'closed',
  };
  const status = aliases[normalized];
  if (status) return status;
  warnings.push(`Family ${familyId} has unknown status ${String(value)}; imported as new`);
  return 'new';
}

function canonicalInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function dateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
}

function localDateTimeToIso(date: string, time: string, timeZone: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const target = Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)),
    hour, minute,
  );
  let guess = target;
  try {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(guess));
      const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
      const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
      guess += target - represented;
    }
    const result = new Date(guess);
    const roundTrip = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(result);
    const value = (type: Intl.DateTimeFormatPartTypes) => roundTrip.find((item) => item.type === type)?.value;
    if (`${value('year')}-${value('month')}-${value('day')}` !== date
      || Number(value('hour')) !== hour || Number(value('minute')) !== minute) return undefined;
    return result.toISOString();
  } catch {
    return undefined;
  }
}

function dollarsToCents(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const normalized = String(value).trim().replace(/[$,]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

function cloneState(state: WorkflowState): WorkflowState {
  return {
    cases: { ...state.cases }, participants: { ...state.participants },
    checklistItems: { ...state.checklistItems }, documents: { ...state.documents },
    tasks: { ...state.tasks }, appointments: { ...state.appointments },
    payments: { ...state.payments }, imports: { ...state.imports },
  };
}

export function importLegacyInterventionOS(
  state: WorkflowState,
  input: string | unknown,
  options: LegacyImportOptions,
): LegacyImportResult {
  if (!options.sourceId.trim()) throw new LegacyImportError('sourceId is required');
  const importedAt = canonicalInstant(options.importedAt);
  if (!importedAt) throw new LegacyImportError('importedAt must be an ISO instant');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: options.defaultTimeZone }).format(new Date(0));
  } catch {
    throw new LegacyImportError('defaultTimeZone must be a valid IANA timezone');
  }

  const payload = parsePayload(input);
  const sourceFingerprint = fingerprint(payload);
  const importId = `${options.sourceId}:${sourceFingerprint}`;
  const priorImport = Object.values(state.imports).find((item) => item.sourceId === options.sourceId);
  if (priorImport) {
    if (priorImport.fingerprint === sourceFingerprint) {
      return { state, warnings: [], fingerprint: sourceFingerprint, alreadyImported: true };
    }
    throw new LegacyImportError(`Source ${options.sourceId} was already imported with different content`);
  }

  const next = cloneState(state ?? createEmptyWorkflowState());
  const warnings: string[] = [];
  const names = new Map<string, string[]>();
  const seenLegacyIds = new Map<string, Set<string>>();
  const claimLegacyId = (kind: string, oldId: string) => {
    const seen = seenLegacyIds.get(kind) ?? new Set<string>();
    if (seen.has(oldId)) throw new LegacyImportError(`Duplicate legacy ${kind} id: ${oldId}`);
    seen.add(oldId);
    seenLegacyIds.set(kind, seen);
  };
  const requireAvailable = (collection: Record<string, unknown>, id: string, kind: string) => {
    if (Object.prototype.hasOwnProperty.call(collection, id)) {
      throw new LegacyImportError(`Import would overwrite an existing ${kind}: ${id}`);
    }
  };

  payload.families.forEach((rawFamily, familyIndex) => {
    if (!isRecord(rawFamily)) {
      warnings.push(`Skipped malformed family at index ${familyIndex}`);
      return;
    }
    const oldId = legacyId(rawFamily, `index-${familyIndex}`);
    claimLegacyId('family', oldId);
    const id = sourceEntityId(options.sourceId, 'case', oldId);
    requireAvailable(next.cases, id, 'case');
    const name = text(rawFamily.name) ?? `Unnamed family ${familyIndex + 1}`;
    const createdAt = canonicalInstant(rawFamily.createdAt ?? rawFamily.created_at) ?? importedAt;
    const updatedAt = canonicalInstant(rawFamily.updatedAt ?? rawFamily.updated_at) ?? importedAt;
    next.cases[id] = {
      id,
      kind: caseKind(rawFamily.type),
      name,
      status: caseStatus(rawFamily.status, warnings, oldId),
      archivedAt: rawFamily.archived === true ? updatedAt : null,
      referralId: text(rawFamily.referralId ?? rawFamily.referral_id),
      referralMatchId: text(rawFamily.referralMatchId ?? rawFamily.referral_match_id),
      placementPartnerId: text(rawFamily.placementPartnerId ?? rawFamily.placement_partner_id),
      identifiedPatientName: text(rawFamily.ipName ?? rawFamily.ip_name),
      primarySubstance: text(rawFamily.primarySubstance ?? rawFamily.primary_substance),
      contact: text(rawFamily.contact), notes: text(rawFamily.notes), focus: text(rawFamily.focus),
      createdAt, updatedAt, legacy: provenance(options.sourceId, oldId, importedAt),
    };
    const normalized = normalizeName(name);
    names.set(normalized, [...(names.get(normalized) ?? []), id]);

    if (Array.isArray(rawFamily.participants)) {
      rawFamily.participants.forEach((rawParticipant, participantIndex) => {
        if (!isRecord(rawParticipant) || !text(rawParticipant.name)) {
          warnings.push(`Skipped malformed participant ${participantIndex} for family ${oldId}`);
          return;
        }
        const participantOldId = legacyId(rawParticipant, `${oldId}-${participantIndex}`);
        claimLegacyId('participant', participantOldId);
        const participantId = sourceEntityId(options.sourceId, 'participant', participantOldId);
        requireAvailable(next.participants, participantId, 'participant');
        next.participants[participantId] = {
          id: participantId, caseId: id, name: text(rawParticipant.name)!, role: text(rawParticipant.role),
          phone: text(rawParticipant.phone), email: text(rawParticipant.email), notes: text(rawParticipant.notes),
          legacy: provenance(options.sourceId, participantOldId, importedAt),
        };
      });
    } else if (rawFamily.participants !== undefined) {
      warnings.push(`Family ${oldId} participants were not an array`);
    }

    if (isRecord(rawFamily.checklist)) {
      Object.entries(rawFamily.checklist).forEach(([key, completed], checklistIndex) => {
        if (typeof completed !== 'boolean') {
          warnings.push(`Skipped non-boolean checklist value ${key} for family ${oldId}`);
          return;
        }
        const checklistOldId = `${oldId}-${key}`;
        const checklistId = sourceEntityId(options.sourceId, 'checklist', checklistOldId);
        requireAvailable(next.checklistItems, checklistId, 'checklist item');
        next.checklistItems[checklistId] = {
          id: checklistId, caseId: id, key, label: CHECKLIST_LABELS[key] ?? key,
          completedAt: completed ? importedAt : null,
          legacy: provenance(options.sourceId, checklistOldId, importedAt),
        };
      });
    } else if (rawFamily.checklist !== undefined) {
      warnings.push(`Family ${oldId} checklist was not an object`);
    }

    if (Array.isArray(rawFamily.documents)) {
      rawFamily.documents.forEach((rawDocument, documentIndex) => {
        const name = typeof rawDocument === 'string' ? text(rawDocument) : isRecord(rawDocument) ? text(rawDocument.name) : undefined;
        if (!name) {
          warnings.push(`Skipped malformed document ${documentIndex} for family ${oldId}`);
          return;
        }
        const documentOldId = isRecord(rawDocument)
          ? legacyId(rawDocument, `${oldId}-${documentIndex}`)
          : `${oldId}-${documentIndex}`;
        claimLegacyId('document', documentOldId);
        const documentId = sourceEntityId(options.sourceId, 'document', documentOldId);
        requireAvailable(next.documents, documentId, 'document reference');
        next.documents[documentId] = {
          id: documentId, caseId: id, name,
          legacy: provenance(options.sourceId, documentOldId, importedAt),
        };
      });
    } else if (rawFamily.documents !== undefined) {
      warnings.push(`Family ${oldId} documents were not an array`);
    }

    const amountCents = dollarsToCents(rawFamily.amount);
    if (amountCents !== undefined && amountCents > 0) {
      const paymentOldId = `${oldId}-amount`;
      const paymentId = sourceEntityId(options.sourceId, 'payment', paymentOldId);
      requireAvailable(next.payments, paymentId, 'payment');
      const status: PaymentStatus = String(rawFamily.paymentStatus ?? rawFamily.payment_status).toLowerCase() === 'received'
        ? 'received' : 'pending';
      const effectiveDate = dateOnly(rawFamily.paymentEffectiveDate ?? rawFamily.payment_effective_date)
        ?? (canonicalInstant(payload.savedAt)?.slice(0, 10))
        ?? importedAt.slice(0, 10);
      next.payments[paymentId] = {
        id: paymentId, caseId: id, amountCents, status, effectiveDate,
        legacy: provenance(options.sourceId, paymentOldId, importedAt),
      };
    } else if (rawFamily.amount !== undefined && amountCents === undefined) {
      warnings.push(`Family ${oldId} has an invalid dollar amount`);
    }
  });

  const resolveFamily = (rawName: unknown, kind: string, oldId: string): string | undefined => {
    const familyName = text(rawName);
    if (!familyName || normalizeName(familyName) === 'general') return undefined;
    const matches = names.get(normalizeName(familyName)) ?? [];
    if (matches.length === 1) return matches[0];
    warnings.push(matches.length > 1
      ? `${kind} ${oldId} has ambiguous family name "${familyName}"; case link omitted`
      : `${kind} ${oldId} family name "${familyName}" was not found; case link omitted`);
    return undefined;
  };

  payload.tasks.forEach((rawTask, index) => {
    if (!isRecord(rawTask) || !text(rawTask.title)) {
      warnings.push(`Skipped malformed task at index ${index}`);
      return;
    }
    const oldId = legacyId(rawTask, `index-${index}`);
    claimLegacyId('task', oldId);
    const id = sourceEntityId(options.sourceId, 'task', oldId);
    requireAvailable(next.tasks, id, 'task');
    const updatedAt = canonicalInstant(rawTask.updatedAt ?? rawTask.updated_at) ?? importedAt;
    next.tasks[id] = {
      id, caseId: resolveFamily(rawTask.family ?? rawTask.familyName ?? rawTask.family_name, 'Task', oldId),
      title: text(rawTask.title)!, dueDate: dateOnly(rawTask.dueDate ?? rawTask.due_date), note: text(rawTask.note),
      completedAt: rawTask.completed === true ? updatedAt : null,
      createdAt: canonicalInstant(rawTask.createdAt ?? rawTask.created_at) ?? importedAt,
      updatedAt, legacy: provenance(options.sourceId, oldId, importedAt),
    };
  });

  payload.scheduleItems.forEach((rawAppointment, index) => {
    if (!isRecord(rawAppointment) || !text(rawAppointment.title)) {
      warnings.push(`Skipped malformed schedule item at index ${index}`);
      return;
    }
    const oldId = legacyId(rawAppointment, `index-${index}`);
    claimLegacyId('appointment', oldId);
    const itemTimeZone = text(rawAppointment.timeZone ?? rawAppointment.time_zone) ?? options.defaultTimeZone;
    let timeZone = itemTimeZone;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    } catch {
      warnings.push(`Schedule item ${oldId} has invalid timezone "${itemTimeZone}"; used ${options.defaultTimeZone}`);
      timeZone = options.defaultTimeZone;
    }
    const date = dateOnly(rawAppointment.date ?? rawAppointment.itemDate ?? rawAppointment.item_date);
    const time = text(rawAppointment.time ?? rawAppointment.itemTime ?? rawAppointment.item_time) ?? '09:00';
    const startsAt = canonicalInstant(rawAppointment.startsAt ?? rawAppointment.starts_at)
      ?? (date ? localDateTimeToIso(date, time, timeZone) : undefined);
    if (!startsAt) {
      warnings.push(`Skipped schedule item ${oldId} with invalid date/start`);
      return;
    }
    const parsedEnd = canonicalInstant(rawAppointment.endsAt ?? rawAppointment.ends_at);
    const endsAt = parsedEnd && parsedEnd > startsAt
      ? parsedEnd
      : new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString();
    const id = sourceEntityId(options.sourceId, 'appointment', oldId);
    requireAvailable(next.appointments, id, 'appointment');
    next.appointments[id] = {
      id, caseId: resolveFamily(rawAppointment.family ?? rawAppointment.familyName ?? rawAppointment.family_name, 'Schedule item', oldId),
      title: text(rawAppointment.title)!, startsAt, endsAt,
      timeZone,
      note: text(rawAppointment.note),
      createdAt: canonicalInstant(rawAppointment.createdAt ?? rawAppointment.created_at) ?? importedAt,
      updatedAt: canonicalInstant(rawAppointment.updatedAt ?? rawAppointment.updated_at) ?? importedAt,
      legacy: provenance(options.sourceId, oldId, importedAt),
    };
  });

  next.imports[importId] = { id: importId, sourceId: options.sourceId, fingerprint: sourceFingerprint, importedAt };
  return { state: next, warnings, fingerprint: sourceFingerprint, alreadyImported: false };
}
