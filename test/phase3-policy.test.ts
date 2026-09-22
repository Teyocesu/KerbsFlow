import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_VERSIONS,
  asAttemptId,
  asRunId,
  asTaskId,
  asValidationId,
  type ValidationBundle,
} from "../src/contracts.js";
import {
  assertEvidenceAuthority,
  createFailureFingerprint,
  decideFailureAction,
  decideTrustedReview,
  escalatePlanningRoute,
  selectValidationLevel,
  validationSatisfiesLevel,
} from "../src/phase3.js";
import { createPhase2PlanningDecision } from "../src/planning.js";

test("evidence sources cannot silently inflate their authority", () => {
  assert.doesNotThrow(() => assertEvidenceAuthority("verifier_command", "automatically_tested"));
  assert.doesNotThrow(() => assertEvidenceAuthority("semantic_review", "inspected"));
  assert.doesNotThrow(() => assertEvidenceAuthority("executor_claim", "not_tested"));
  assert.throws(() => assertEvidenceAuthority("executor_claim", "automatically_tested"), /inflated|must be classified/i);
  assert.throws(() => assertEvidenceAuthority("semantic_review", "automatically_tested"), /inflated|must be classified/i);
});

test("validation levels select the stronger requirement and never masquerade upward", () => {
  assert.equal(selectValidationLevel("focused", "phase"), "phase");
  assert.equal(selectValidationLevel("full", "phase"), "full");
  assert.equal(validationSatisfiesLevel(bundle("focused"), "phase"), false);
  assert.equal(validationSatisfiesLevel(bundle("full"), "phase"), true);
});

test("failure fingerprints discard volatile paths, IDs, timestamps, and numbers", () => {
  const first = createFailureFingerprint({
    failureClass: "validation_failure",
    reasonCode: "focused-check-failed",
    diagnostic: "run_abc failed at /private/tmp/work-123/test.ts:42 on 2026-09-21T12:00:00.000Z",
    category: "tests",
    checkIdentity: "npm test",
  });
  const second = createFailureFingerprint({
    failureClass: "validation_failure",
    reasonCode: "focused check failed",
    diagnostic: "run_xyz failed at /private/tmp/work-999/test.ts:77 on 2026-09-22T13:10:11.000Z",
    category: "tests",
    checkIdentity: "npm test",
  });
  assert.equal(first.fingerprint, second.fingerprint);
});

test("materially distinct failure causes retain distinct fingerprints", () => {
  const scope = createFailureFingerprint({ failureClass: "scope_violation", reasonCode: "scope", diagnostic: "README changed", category: "scope" });
  const invariant = createFailureFingerprint({ failureClass: "invariant_violation", reasonCode: "isolation", diagnostic: "tmp write allowed", category: "filesystem" });
  assert.notEqual(scope.fingerprint, invariant.fingerprint);
});

test("bounded retry, rework, escalation, and repeated-loop policy is deterministic", () => {
  const base = { occurrence: 1, implementationAttempts: 1, maxImplementationAttempts: 2 as const, transient: false, causalDiagnosis: true, scopeUnchanged: true, eligibleHigherRoute: true, alreadyEscalated: false };
  assert.equal(decideFailureAction({ ...base, failureClass: "executor_error", transient: true }).action, "retry_same_route");
  assert.equal(decideFailureAction({ ...base, failureClass: "implementation_failure" }).action, "rework");
  assert.equal(decideFailureAction({ ...base, failureClass: "scope_violation", causalDiagnosis: false }).action, "human_gate");
  assert.equal(decideFailureAction({ ...base, failureClass: "invariant_violation" }).action, "escalate");
  assert.equal(decideFailureAction({ ...base, failureClass: "requirement_or_architecture_ambiguity" }).action, "human_gate");
  assert.equal(decideFailureAction({ ...base, failureClass: "security_or_privilege_gate" }).action, "human_gate");
  assert.equal(decideFailureAction({ ...base, failureClass: "implementation_failure", occurrence: 2 }).action, "escalate");
  assert.equal(decideFailureAction({ ...base, failureClass: "implementation_failure", occurrence: 2, alreadyEscalated: true }).action, "human_gate");
  assert.equal(decideFailureAction({ ...base, failureClass: "implementation_failure", implementationAttempts: 2 }).action, "human_gate");
});

test("model escalation changes only route model/reasoning", () => {
  const decision = createPhase2PlanningDecision({
    decisionId: "decision_escalation",
    runId: asRunId("run_escalation"),
    taskId: asTaskId("task_escalation"),
    objective: "bounded work",
    acceptance: ["same acceptance"],
    positiveScope: ["src"],
    negativeScope: ["docs/SPEC-v0.1.0.md"],
    model: "gpt-low",
    canonicalContext: "fixed",
  });
  const escalated = escalatePlanningRoute(decision, { model: "gpt-high", reasoning: "high" });
  assert.deepEqual(escalated.action, decision.action);
  assert.equal(escalated.canonicalContextHash, decision.canonicalContextHash);
  assert.equal(escalated.route.model, "gpt-high");
  assert.equal(escalated.route.reasoning, "high");
});

test("trusted phase close rejects lower evidence and accepts a passing phase bundle", () => {
  assert.equal(decideTrustedReview({ requiredLevel: "phase", validation: bundle("focused"), antiGreenwashing: [], canonicalIntentCurrent: true, phaseCloseRequested: true }).outcome, "rework");
  assert.equal(decideTrustedReview({ requiredLevel: "phase", validation: bundle("phase"), antiGreenwashing: [], canonicalIntentCurrent: true, phaseCloseRequested: true }).outcome, "next_phase");
  assert.equal(decideTrustedReview({
    requiredLevel: "phase",
    validation: {
      ...bundle("phase"),
      evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId("validation_claim_only"), kind: "result", classification: "not_tested", summary: "executor says tests passed" }],
    },
    antiGreenwashing: [],
    canonicalIntentCurrent: true,
    phaseCloseRequested: true,
  }).reasonCode, "validation_proof_insufficient");
  assert.equal(decideTrustedReview({ requiredLevel: "phase", validation: bundle("phase"), antiGreenwashing: [], canonicalIntentCurrent: false, phaseCloseRequested: true }).outcome, "human_gate");
});

function bundle(level: "focused" | "phase" | "full"): ValidationBundle {
  return {
    schemaVersion: CONTRACT_VERSIONS.validation,
    validationId: asValidationId(`validation_${level}`),
    runId: asRunId("run_policy"),
    taskId: asTaskId("task_policy"),
    attemptId: asAttemptId("attempt_policy"),
    level,
    outcome: "passed",
    summary: "independent validation passed",
    checks: [{ name: "gate", outcome: "passed", evidenceClass: "automatically_tested", evidenceRefs: [] }],
    evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId(`validation_evidence_${level}`), kind: "check", classification: "automatically_tested", summary: "command ran" }],
  };
}
