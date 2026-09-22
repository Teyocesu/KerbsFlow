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

export interface AdapterRoutingReadiness {
  ready: boolean;
  models: Array<{
    provider: string;
    model: string;
    aliases: string[];
    reasoning: string[];
  }>;
  reason: string;
}

export interface ExecutorAdapter {
  select?(adapter: string): void;
  probe(): AdapterDescriptor;
  routingReadiness?(workingDirectory: string): Promise<AdapterRoutingReadiness>;
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
