import type { WorkflowState } from './types';

export function createEmptyWorkflowState(): WorkflowState {
  return {
    cases: {},
    participants: {},
    checklistItems: {},
    documents: {},
    tasks: {},
    appointments: {},
    payments: {},
    imports: {},
  };
}
