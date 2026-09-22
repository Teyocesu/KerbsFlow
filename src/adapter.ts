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
  SemanticReviewHandle,
  SemanticReviewRequest,
} from "./contracts.js";

export interface ExecutorAdapter {
  probe(): AdapterDescriptor;
  start(request: ExecutionRequest): AttemptHandle;
  events(handle: AttemptHandle): AsyncIterable<NormalizedEvent>;
  wait(handle: AttemptHandle): Promise<unknown>;
  cancel(handle: AttemptHandle, reason: string): CancelOutcome;
  reconcile(identity: { runId: RunId; taskId: TaskId; attemptId: AttemptId }): Promise<ReconcileOutcome>;
}

export interface SemanticReviewAdapter {
  probeReview(): AdapterDescriptor;
  startReview(request: SemanticReviewRequest): SemanticReviewHandle;
  reviewEvents(handle: SemanticReviewHandle): AsyncIterable<NormalizedEvent>;
  waitReview(handle: SemanticReviewHandle): Promise<unknown>;
  cancelReview(handle: SemanticReviewHandle, reason: string): CancelOutcome;
}
