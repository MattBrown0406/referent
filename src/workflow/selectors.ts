import type { CaseDetail, CaseStatus, WorkflowAppointment, WorkflowState } from './types';

const CASE_STATUSES: CaseStatus[] = ['new', 'engaged', 'preparing', 'scheduled', 'completed', 'closed'];

function localDateAt(isoInstant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoInstant));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function selectTodaysAppointments(
  state: WorkflowState,
  timeZone: string,
  date: string,
): WorkflowAppointment[] {
  return Object.values(state.appointments)
    .filter((appointment) => localDateAt(appointment.startsAt, timeZone) === date)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export function selectOpenTasks(state: WorkflowState) {
  return Object.values(state.tasks)
    .filter((task) => task.completedAt === null)
    .sort((left, right) => (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31'));
}

export function selectRevenue(state: WorkflowState, asOfDate: string): { mtdCents: number; ytdCents: number } {
  const year = asOfDate.slice(0, 4);
  const month = asOfDate.slice(0, 7);
  let mtdCents = 0;
  let ytdCents = 0;
  for (const payment of Object.values(state.payments)) {
    if (payment.status !== 'received' || payment.effectiveDate > asOfDate) continue;
    if (payment.effectiveDate.slice(0, 4) === year) ytdCents += payment.amountCents;
    if (payment.effectiveDate.slice(0, 7) === month) mtdCents += payment.amountCents;
  }
  return { mtdCents, ytdCents };
}

export function selectPipelineCounts(state: WorkflowState): Record<CaseStatus, number> {
  const counts = Object.fromEntries(CASE_STATUSES.map((status) => [status, 0])) as Record<CaseStatus, number>;
  for (const workflowCase of Object.values(state.cases)) {
    if (workflowCase.archivedAt === null) counts[workflowCase.status] += 1;
  }
  return counts;
}

export function selectOutstandingBalanceCents(state: WorkflowState, caseId?: string): number {
  return Object.values(state.payments)
    .filter((payment) => payment.status === 'pending' && (!caseId || payment.caseId === caseId))
    .filter((payment) => caseId !== undefined || state.cases[payment.caseId]?.archivedAt === null)
    .reduce((total, payment) => total + payment.amountCents, 0);
}

export function selectCaseDetail(state: WorkflowState, caseId: string): CaseDetail | undefined {
  const workflowCase = state.cases[caseId];
  if (!workflowCase) return undefined;
  const linked = <T extends { caseId?: string }>(records: Record<string, T>) =>
    Object.values(records).filter((record) => record.caseId === caseId);
  return {
    case: workflowCase,
    participants: linked(state.participants),
    checklistItems: linked(state.checklistItems),
    documents: linked(state.documents),
    tasks: linked(state.tasks),
    appointments: linked(state.appointments),
    payments: linked(state.payments),
    outstandingBalanceCents: selectOutstandingBalanceCents(state, caseId),
  };
}
