import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTRACT_VERSIONS,
  ExecutorResult,
  PlanningDecision,
  ReviewDecision,
  RunId,
  TaskId,
  ValidationBundle,
  asDecisionId,
  asReviewId,
  asRunId,
  asTaskId,
  asValidationId,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { FakeAdapter, FakeArtifactStore } from "../src/fake.js";
import { StateStore } from "../src/persistence.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";

export interface TestFixture {
  root: string;
  dbPath: string;
  clock: FixedClock;
  ids: SequenceIdSource;
  store: StateStore;
  adapter: FakeAdapter;
  artifacts: FakeArtifactStore;
  core: KerbsFlowCore;
  runId: RunId;
  taskId: TaskId;
  decision: PlanningDecision;
  close(): void;
}

export function createFixture(): TestFixture {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-phase1-"));
  const dbPath = join(root, "kerbsflow.sqlite");
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  const ids = new SequenceIdSource("fixture");
  const store = StateStore.open(dbPath, { clock, ids });
  const adapter = new FakeAdapter(clock, ids);
  const artifacts = new FakeArtifactStore(ids);
  const core = new KerbsFlowCore(store, adapter, artifacts, { clock, ids });
  const runId = asRunId("run_fixture");
  const taskId = asTaskId("task_fixture");
  const decision: PlanningDecision = {
    schemaVersion: CONTRACT_VERSIONS.planningDecision,
    decisionId: asDecisionId("decision_fixture"),
    runId,
    taskId,
    action: {
      kind: "implementation",
      summary: "implement the synthetic Phase 1 change",
      acceptance: ["focused evidence is persisted"],
      validationLevel: "focused",
      positiveScope: ["src"],
      negativeScope: ["real provider execution"],
    },
    route: { adapter: "fake", model: "fake" },
    requiredCapabilities: ["simulated_execution"],
    selectedSkills: ["ponytail"],
    canonicalContextHash: "synthetic-context-hash",
    policyVersion: "phase1-test-policy",
  };

  return {
    root,
    dbPath,
    clock,
    ids,
    store,
    adapter,
    artifacts,
    core,
    runId,
    taskId,
    decision,
    close() {
      this.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function primeReady(fixture: TestFixture): void {
  fixture.core.startRun(fixture.runId, "synthetic objective", "start");
  fixture.core.completeIntake(fixture.runId, 1, "intake");
  fixture.core.plan(fixture.runId, 2, "plan", fixture.decision);
}

export function primeExecute(fixture: TestFixture): void {
  primeReady(fixture);
  fixture.core.prepareExecution(fixture.runId, 3, "prepare");
}

export function validationFor(fixture: TestFixture, outcome: ValidationBundle["outcome"] = "passed"): ValidationBundle {
  return {
    schemaVersion: CONTRACT_VERSIONS.validation,
    validationId: asValidationId(`validation_${outcome}`),
    runId: fixture.runId,
    taskId: fixture.taskId,
    ...(fixture.core.readModel(fixture.runId)?.run.activeAttemptId === null || fixture.core.readModel(fixture.runId)?.run.activeAttemptId === undefined
      ? {}
      : { attemptId: fixture.core.readModel(fixture.runId)!.run.activeAttemptId! }),
    level: "focused",
    outcome,
    summary: `synthetic ${outcome} focused validation`,
    checks: [{ name: "synthetic check", outcome: outcome === "passed" ? "passed" : "failed", evidenceClass: "simulated", evidenceRefs: [] }],
    evidence: [{
      schemaVersion: CONTRACT_VERSIONS.validation,
      id: asValidationId(`validation_evidence_${outcome}`),
      kind: "check",
      classification: "simulated",
      summary: "fake adapter evidence",
    }],
  };
}

export function reviewFor(fixture: TestFixture, outcome: ReviewDecision["outcome"], suffix: string): ReviewDecision {
  return {
    schemaVersion: CONTRACT_VERSIONS.reviewDecision,
    reviewId: asReviewId(`review_${suffix}`),
    runId: fixture.runId,
    taskId: fixture.taskId,
    outcome,
    summary: `synthetic ${outcome} review`,
    evidenceRefs: [],
    reasonCode: `synthetic_${outcome}`,
  };
}

export function executorResultFor(fixture: TestFixture, overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  const attemptId = fixture.core.readModel(fixture.runId)?.run.activeAttemptId;
  if (attemptId === null || attemptId === undefined) {
    throw new Error("executor result fixture requires an active attempt");
  }
  return {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: fixture.runId,
    taskId: fixture.taskId,
    attemptId,
    executor: { adapter: "fake", adapterVersion: "phase1", provider: "synthetic", model: "fake" },
    outcome: "succeeded",
    failureClass: null,
    scopeClaim: "within_scope",
    summary: "synthetic executor result",
    filesChanged: [],
    checks: [{ name: "synthetic check", outcome: "passed", evidenceClass: "simulated", evidenceRefs: [] }],
    evidence: [],
    invariantViolations: [],
    risks: [],
    warnings: [],
    artifacts: [],
    humanGate: null,
    recommendedNext: "verify_focused",
    exit: { kind: "normal", code: 0 },
    ...overrides,
  };
}
