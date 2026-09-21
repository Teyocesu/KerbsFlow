import type {
  AdapterDescriptor,
  AttemptHandle,
  AttemptId,
  CancelOutcome,
  ExecutionRequest,
  NormalizedEvent,
  ReconcileOutcome,
  RunId,
  TaskId,
} from "./contracts.js";

export interface ExecutorAdapter {
  probe(): AdapterDescriptor;
  start(request: ExecutionRequest): AttemptHandle;
  events(handle: AttemptHandle): AsyncIterable<NormalizedEvent>;
  wait(handle: AttemptHandle): Promise<unknown>;
  cancel(handle: AttemptHandle, reason: string): CancelOutcome;
  reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome>;
}
