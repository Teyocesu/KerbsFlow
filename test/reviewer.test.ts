import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SemanticReviewAdapter } from "../src/adapter.js";
import {
  CONTRACT_VERSIONS,
  asReviewId,
  asValidationId,
  type AdapterDescriptor,
  type CancelOutcome,
  type NormalizedEvent,
  type SemanticReviewHandle,
  type SemanticReviewRequest,
} from "../src/contracts.js";
import { GitWorktreeManager } from "../src/git.js";
import { IndependentSemanticReviewer, type SemanticReviewInput } from "../src/reviewer.js";
import { StateStore } from "../src/persistence.js";
import { createFixture, primeExecute, validationFor } from "./helpers.js";
import { createGitRepository } from "./phase2-helpers.js";

class FakeReviewAdapter implements SemanticReviewAdapter {
  probeCalled = false;
  request?: SemanticReviewRequest;
  mutatePath?: string;
  throwOnStart = false;
  providerSessionId = "review-session";
  result: unknown;

  constructor(result: unknown) {
    this.result = result;
  }

  probeReview(): AdapterDescriptor {
    this.probeCalled = true;
    return descriptor();
  }

  startReview(request: SemanticReviewRequest): SemanticReviewHandle {
    assert.equal(this.probeCalled, true, "read-only capability probe must precede reviewer dispatch");
    this.request = request;
    if (this.throwOnStart) {
      throw new Error("synthetic dispatch ambiguity");
    }
    if (this.mutatePath !== undefined) {
      writeFileSync(this.mutatePath, "reviewer mutation\n", "utf8");
    }
    return {
      schemaVersion: CONTRACT_VERSIONS.semanticReviewHandle,
      reviewAttemptId: request.reviewAttemptId,
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      providerSessionId: this.providerSessionId,
    };
  }

  async *reviewEvents(_handle: SemanticReviewHandle): AsyncIterable<NormalizedEvent> {}

  async waitReview(_handle: SemanticReviewHandle): Promise<unknown> {
    return this.result;
  }

  cancelReview(_handle: SemanticReviewHandle, reason: string): CancelOutcome {
    return { outcome: "cancelled", summary: reason };
  }
}

test("fresh semantic reviewer persists a scoped structured inspected result", async () => {
  const fixture = reviewerFixture("success");
  try {
    const result = await fixture.reviewer.review(fixture.input);
    assert.equal(result.outcome, "supports_continuation");
    assert.equal(fixture.adapter.request?.role, "review");
    assert.deepEqual(fixture.adapter.request?.permissionPolicy, { filesystem: "read_only", network: "denied" });
    const stored = fixture.fixture.store.getSemanticReviewAttempt(fixture.input.reviewAttemptId);
    assert.equal(stored?.lifecycle, "SUCCEEDED");
    assert.match(stored?.request.promptSummary ?? "", /context omitted from SQLite/);
    assert.doesNotMatch(stored?.request.promptSummary ?? "", /synthetic contract|synthetic diff/);
  } finally {
    fixture.close();
  }
});

test("likely credentials are rejected before reviewer dispatch or persistence", async () => {
  const fixture = reviewerFixture("sensitive_context");
  try {
    fixture.input.diff = "const API_KEY='sk-fixture123456';";
    await assert.rejects(() => fixture.reviewer.review(fixture.input), /credential|sensitive/i);
    assert.equal(fixture.adapter.request, undefined);
    assert.equal(fixture.fixture.store.getSemanticReviewAttempt(fixture.input.reviewAttemptId), undefined);
  } finally {
    fixture.close();
  }
});

test("malformed reviewer output fails closed and restart disposition forbids duplicate review", async () => {
  const fixture = reviewerFixture("malformed");
  try {
    fixture.adapter.result = { schemaVersion: "kerbsflow.semantic-review-result/v0" };
    await assert.rejects(() => fixture.reviewer.review(fixture.input), /schemaVersion/i);
    assert.equal(fixture.fixture.store.getSemanticReviewAttempt(fixture.input.reviewAttemptId)?.lifecycle, "UNKNOWN");
    assert.equal(fixture.reviewer.recoveryDisposition(fixture.input.reviewAttemptId).disposition, "human_gate");
  } finally {
    fixture.close();
  }
});

test("reviewer dispatch ambiguity persists UNKNOWN and forbids redispatch", async () => {
  const fixture = reviewerFixture("dispatch_ambiguity");
  try {
    fixture.adapter.throwOnStart = true;
    await assert.rejects(() => fixture.reviewer.review(fixture.input), /dispatch ambiguity/i);
    assert.equal(fixture.fixture.store.getSemanticReviewAttempt(fixture.input.reviewAttemptId)?.lifecycle, "UNKNOWN");
    assert.equal(fixture.reviewer.recoveryDisposition(fixture.input.reviewAttemptId).disposition, "human_gate");
  } finally {
    fixture.close();
  }
});

test("reviewer identity mismatch and implementation-session reuse fail closed", async () => {
  const mismatched = reviewerFixture("mismatch");
  try {
    mismatched.adapter.result = { ...validReview(mismatched), taskId: "task_other" };
    await assert.rejects(() => mismatched.reviewer.review(mismatched.input), /identity|scope/i);
  } finally {
    mismatched.close();
  }

  const reused = reviewerFixture("reused");
  try {
    reused.adapter.providerSessionId = "implementation-session";
    reused.input.implementerProviderSessionId = "implementation-session";
    await assert.rejects(() => reused.reviewer.review(reused.input), /independent|reused/i);
  } finally {
    reused.close();
  }
});

test("reviewer worktree mutation is detected even when the adapter claims success", async () => {
  const fixture = reviewerFixture("mutation");
  try {
    fixture.adapter.mutatePath = join(fixture.worktree.path, "README.md");
    await assert.rejects(() => fixture.reviewer.review(fixture.input), /mutated worktree/i);
    assert.equal(fixture.fixture.store.getSemanticReviewAttempt(fixture.input.reviewAttemptId)?.lifecycle, "UNKNOWN");
  } finally {
    fixture.close();
  }
});

test("review recovery continues an ingested result exactly and gates a PREPARED crash without redispatch", async () => {
  const completed = reviewerFixture("recovery_complete");
  try {
    const expected = await completed.reviewer.review(completed.input);
    completed.fixture.store.close();
    completed.fixture.store = StateStore.open(completed.fixture.dbPath, { clock: completed.fixture.clock, ids: completed.fixture.ids });
    const restarted = new IndependentSemanticReviewer(completed.fixture.store, completed.adapter, completed.git);
    const disposition = restarted.recoveryDisposition(completed.input.reviewAttemptId);
    assert.equal(disposition.disposition, "exact_result");
    if (disposition.disposition === "exact_result") {
      assert.deepEqual(disposition.result, expected);
    }
  } finally {
    completed.close();
  }

  const prepared = reviewerFixture("recovery_prepared");
  try {
    const request = semanticRequest(prepared.input);
    prepared.fixture.store.prepareSemanticReview(request);
    prepared.fixture.store.close();
    prepared.fixture.store = StateStore.open(prepared.fixture.dbPath, { clock: prepared.fixture.clock, ids: prepared.fixture.ids });
    const restarted = new IndependentSemanticReviewer(prepared.fixture.store, prepared.adapter, prepared.git);
    const disposition = restarted.recoveryDisposition(prepared.input.reviewAttemptId);
    assert.equal(disposition.disposition, "human_gate");
    assert.match(disposition.disposition === "human_gate" ? disposition.reason : "", /PREPARED|duplicate/i);
  } finally {
    prepared.close();
  }
});

function reviewerFixture(suffix: string) {
  const fixture = createFixture();
  primeExecute(fixture);
  const repository = createGitRepository();
  const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-reviewer-"));
  const git = new GitWorktreeManager(runtime);
  const worktree = git.create(git.intake(repository.root), `run_review_${suffix}`);
  const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
  assert.ok(attemptId);
  const input: SemanticReviewInput = {
    reviewAttemptId: asReviewId(`review_${suffix}`),
    runId: fixture.runId,
    taskId: fixture.taskId,
    attemptId,
    worktree,
    model: "fixture-review-model",
    canonicalContextHash: "canonical-hash",
    canonicalContract: "synthetic contract",
    diff: "synthetic diff",
    validation: validationFor(fixture),
    evidenceRefs: [],
  };
  const adapter = new FakeReviewAdapter(undefined);
  const reviewer = new IndependentSemanticReviewer(fixture.store, adapter, git);
  const resultFixture = { fixture, repository, runtime, git, worktree, input, adapter, reviewer };
  adapter.result = validReview(resultFixture);
  return {
    ...resultFixture,
    close() {
      fixture.close();
      rmSync(runtime, { recursive: true, force: true });
      rmSync(repository.root, { recursive: true, force: true });
    },
  };
}

function validReview(fixture: { input: SemanticReviewInput }): Record<string, unknown> {
  return {
    schemaVersion: CONTRACT_VERSIONS.semanticReviewResult,
    reviewAttemptId: fixture.input.reviewAttemptId,
    runId: fixture.input.runId,
    taskId: fixture.input.taskId,
    attemptId: fixture.input.attemptId,
    reviewer: { adapter: "fake-review", adapterVersion: "1", provider: "synthetic", model: "fixture-review-model" },
    outcome: "supports_continuation",
    summary: "bounded evidence supports continuation",
    findings: [],
    evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId(`validation_review_${fixture.input.reviewAttemptId}`), kind: "review", classification: "inspected", summary: "semantic diff inspection" }],
    scopeConcerns: [],
    invariantViolations: [],
  };
}

function descriptor(): AdapterDescriptor {
  return {
    schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
    adapter: "fake-review",
    provider: "synthetic",
    adapterVersion: "1",
    capabilities: {
      eventTransport: "async_iterable",
      finalJsonSchema: true,
      modelSelection: true,
      reasoningEffort: ["high"],
      agentSelection: false,
      filesystemEnforcement: "enforced",
      network: { providerControlPlane: "not_applicable", workload: "enforced" },
      cancellation: "simulated",
      resumableSession: false,
      authentication: { owner: "none", mode: "none" },
      healthProbe: true,
    },
  };
}

function semanticRequest(input: SemanticReviewInput): SemanticReviewRequest {
  return {
    schemaVersion: CONTRACT_VERSIONS.semanticReviewRequest,
    reviewAttemptId: input.reviewAttemptId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    role: "review",
    workingDirectory: input.worktree.path,
    promptSummary: "bounded synthetic review",
    model: input.model,
    permissionPolicy: { filesystem: "read_only", network: "denied" },
    canonicalContextHash: input.canonicalContextHash,
    diffHash: "synthetic-diff-hash",
    validationIds: [input.validation.validationId],
    expectedResultSchema: CONTRACT_VERSIONS.semanticReviewResult,
  };
}
