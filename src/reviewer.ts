import { createHash } from "node:crypto";

import type { SemanticReviewAdapter } from "./adapter.js";
import {
  CONTRACT_VERSIONS,
  type ArtifactId,
  type AttemptId,
  type ReviewId,
  type RunId,
  type SemanticReviewRequest,
  type SemanticReviewResult,
  type TaskId,
  type ValidationBundle,
  parseSemanticReviewResult,
} from "./contracts.js";
import { KerbsFlowError } from "./errors.js";
import { GitWorktreeManager, type WorktreeRecord } from "./git.js";
import { StateStore } from "./persistence.js";

export interface SemanticReviewInput {
  reviewAttemptId: ReviewId;
  runId: RunId;
  taskId: TaskId;
  attemptId: AttemptId;
  worktree: WorktreeRecord;
  model: string;
  reasoning?: string;
  canonicalContextHash: string;
  canonicalContract: string;
  diff: string;
  validation: ValidationBundle;
  evidenceRefs: ArtifactId[];
  implementerProviderSessionId?: string;
}

export type ReviewerRecoveryDisposition =
  | { disposition: "exact_result"; result: SemanticReviewResult }
  | { disposition: "human_gate"; reason: string }
  | { disposition: "failed"; reason: string };

export class IndependentSemanticReviewer {
  constructor(
    private readonly store: StateStore,
    private readonly adapter: SemanticReviewAdapter,
    private readonly git: GitWorktreeManager,
  ) {}

  async review(input: SemanticReviewInput): Promise<SemanticReviewResult> {
    this.adapter.probeReview();
    assertReviewContextContainsNoLikelySecret(input);
    const promptSummary = buildSemanticReviewPrompt(input);
    const request: SemanticReviewRequest = {
      schemaVersion: CONTRACT_VERSIONS.semanticReviewRequest,
      reviewAttemptId: input.reviewAttemptId,
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      role: "review",
      workingDirectory: input.worktree.path,
      promptSummary,
      model: input.model,
      ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
      permissionPolicy: { filesystem: "read_only", network: "denied" },
      canonicalContextHash: input.canonicalContextHash,
      diffHash: createHash("sha256").update(input.diff).digest("hex"),
      validationIds: [input.validation.validationId],
      expectedResultSchema: CONTRACT_VERSIONS.semanticReviewResult,
    };
    this.store.prepareSemanticReview(request);
    const before = this.git.inspect(input.worktree);
    try {
      const handle = this.adapter.startReview(request);
      if (input.implementerProviderSessionId !== undefined && handle.providerSessionId === input.implementerProviderSessionId) {
        throw new KerbsFlowError("REVIEW_NOT_INDEPENDENT", "semantic reviewer reused the implementation provider session");
      }
      this.store.markSemanticReviewRunning(input.reviewAttemptId, handle as unknown as Record<string, string>);
      for await (const _event of this.adapter.reviewEvents(handle)) {
        // Events are bounded adapter evidence; the structured terminal result remains authoritative input.
      }
      const result = parseSemanticReviewResult(await this.adapter.waitReview(handle));
      if (result.reviewAttemptId !== input.reviewAttemptId || result.runId !== input.runId || result.taskId !== input.taskId || result.attemptId !== input.attemptId) {
        throw new KerbsFlowError("REVIEW_SCOPE_MISMATCH", "semantic reviewer result identity/scope is not bound to the request");
      }
      if (result.evidence.some((evidence) => evidence.classification !== "inspected")) {
        throw new KerbsFlowError("EVIDENCE_CLASSIFICATION_INFLATED", "semantic reviewer evidence cannot be classified as execution proof");
      }
      if (result.evidence.length === 0) {
        throw new KerbsFlowError("REVIEW_EVIDENCE_REQUIRED", "semantic reviewer must identify inspected evidence supporting its result");
      }
      const after = this.git.inspect(input.worktree);
      if (before.headOid !== after.headOid || before.diff !== after.diff || JSON.stringify(before.status) !== JSON.stringify(after.status)) {
        throw new KerbsFlowError("REVIEWER_MUTATED_WORKTREE", "semantic reviewer mutated worktree evidence despite read-only authority");
      }
      return this.store.completeSemanticReview(input.reviewAttemptId, result).result!;
    } catch (error) {
      const current = this.store.getSemanticReviewAttempt(input.reviewAttemptId);
      if (current?.lifecycle === "PREPARED" || current?.lifecycle === "RUNNING") {
        this.store.failSemanticReview(input.reviewAttemptId, error instanceof Error ? error.message : "semantic review failed", true);
      }
      throw error;
    }
  }

  recoveryDisposition(reviewAttemptId: ReviewId): ReviewerRecoveryDisposition {
    const attempt = this.store.getSemanticReviewAttempt(reviewAttemptId);
    if (attempt === undefined) {
      return { disposition: "human_gate", reason: "semantic review attempt is missing" };
    }
    if (attempt.lifecycle === "SUCCEEDED" && attempt.result !== null) {
      return { disposition: "exact_result", result: attempt.result };
    }
    if (attempt.lifecycle === "PREPARED" || attempt.lifecycle === "RUNNING" || attempt.lifecycle === "UNKNOWN") {
      return { disposition: "human_gate", reason: `semantic review is ${attempt.lifecycle}; do not dispatch a duplicate reviewer` };
    }
    return { disposition: "failed", reason: attempt.failureSummary ?? "semantic reviewer failed" };
  }
}

export function buildSemanticReviewPrompt(input: SemanticReviewInput): string {
  const contract = bounded(input.canonicalContract, 5000, "canonical contract");
  const diff = bounded(input.diff, 8000, "diff");
  const evidence = bounded(JSON.stringify({
    validationId: input.validation.validationId,
    level: input.validation.level,
    outcome: input.validation.outcome,
    checks: input.validation.checks,
    evidence: input.validation.evidence,
    artifactRefs: input.evidenceRefs,
  }), 3000, "validation evidence");
  return [
    "You are a fresh independent KerbsFlow semantic reviewer.",
    "You have read-only authority. Do not modify source, canonical documents, artifacts, Git state, or configuration.",
    "Assess only the supplied contract, diff, and classified evidence. Do not broaden scope or claim execution evidence.",
    "Do not authorize commit, push, merge, tag, release, deployment, production, or any other high-impact action.",
    `Identity: run=${input.runId} task=${input.taskId} attempt=${input.attemptId} review=${input.reviewAttemptId}`,
    `Canonical context hash: ${input.canonicalContextHash}`,
    "Canonical contract excerpt:",
    contract,
    "Bounded diff:",
    diff,
    "Classified deterministic evidence:",
    evidence,
    "Return only the requested kerbsflow.semantic-review-result/v1 object. Every reviewer evidence item must remain classified as inspected.",
  ].join("\n");
}

function bounded(value: string, maximum: number, label: string): string {
  if (Buffer.byteLength(value) > maximum) {
    throw new KerbsFlowError("REVIEW_CONTEXT_TOO_LARGE", `${label} exceeds its ${maximum}-byte bound`);
  }
  return value;
}

function assertReviewContextContainsNoLikelySecret(input: SemanticReviewInput): void {
  const context = [input.canonicalContract, input.diff, JSON.stringify(input.validation), JSON.stringify(input.evidenceRefs)].join("\n");
  if (
    /\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[^\s"']+|\bAKIA[0-9A-Z]{16}\b/iu.test(context)
    || /\b(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*["']?[^\s"',;}]{8,}/iu.test(context)
  ) {
    throw new KerbsFlowError("REVIEW_CONTEXT_SENSITIVE", "semantic review context contains likely credential material and cannot be dispatched or persisted");
  }
}
