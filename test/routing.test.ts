import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorAdapter } from "../src/adapter.js";
import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  type AdapterDescriptor,
  type AttemptHandle,
  type ExecutionRequest,
  asReviewId,
  asRunId,
  asTaskId,
  asValidationId,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { FakeArtifactStore } from "../src/fake.js";
import { createPhase2PlanningDecision } from "../src/planning.js";
import { StateStore } from "../src/persistence.js";
import { escalatePlanningRoute } from "../src/phase3.js";
import { PolicyRouter, RoutedExecutorAdapter, type RouteCandidate } from "../src/routing.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";

test("normal eligible work selects a discovered Muse/OpenCode route", () => {
  const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: candidates() });
  assert.deepEqual(routed.planningDecision.route, { adapter: "opencode", model: "opencode/muse-current" });
  assert.equal(routed.routingDecision.selected.family, "muse");
  assert.equal(routed.routingDecision.fallbackReason, undefined);
});

test("unavailable or shell-unsuitable Muse falls back deterministically to Luna Max", () => {
  const unavailable = candidates().map((candidate) => candidate.family === "muse" ? { ...candidate, available: false } : candidate);
  const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: unavailable });
  assert.deepEqual(routed.planningDecision.route, { adapter: "codex", model: "openai/luna-current", reasoning: "max" });
  assert.match(routed.routingDecision.fallbackReason ?? "", /unavailable/i);

  const shell = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: candidates(), requiresShell: true });
  assert.equal(shell.routingDecision.selected.family, "luna");
  assert.match(shell.routingDecision.fallbackReason ?? "", /denies shell/i);
});

test("difficult and high-impact work use Codex Sol without making Muse eligible", () => {
  const difficult = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "difficult", candidates: candidates() });
  assert.deepEqual(difficult.planningDecision.route, { adapter: "codex", model: "openai/sol-current", reasoning: "medium" });
  const high = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "high_impact", candidates: candidates() });
  assert.deepEqual(high.planningDecision.route, { adapter: "codex", model: "openai/sol-current", reasoning: "high" });
  assert.ok(high.routingDecision.consideredRoutes.find((route) => route.family === "muse")?.reasons.some((reason) => reason.includes("not eligible")));
});

test("Luna Medium is structurally rejected and no supported route fails closed", () => {
  const prohibited = candidates().map((candidate) => candidate.family === "luna" ? { ...candidate, reasoning: "medium" } : candidate);
  assert.throws(() => new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: prohibited }), /Luna Medium/i);
  const unavailable = candidates().map((candidate) => ({ ...candidate, available: false }));
  assert.throws(() => new PolicyRouter().route({ planningDecision: baseDecision(), classification: "high_impact", candidates: unavailable }), /no Phase 4 route/i);
});

test("Codex fallback requires both enforced filesystem and workload-network isolation", () => {
  const unsafe = candidates().map((candidate) => candidate.adapter === "codex"
    ? { ...candidate, descriptor: { ...candidate.descriptor, capabilities: { ...candidate.descriptor.capabilities, network: { ...candidate.descriptor.capabilities.network, workload: "tool_policy_only" as const } } } }
    : { ...candidate, available: false });
  assert.throws(
    () => new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: unsafe }),
    /no Phase 4 route/i,
  );
});

test("routing metadata persists without provider secrets and links to the exact prepared attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-routing-"));
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("routing");
  const store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  try {
    const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: candidates() });
    const adapter = new RoutedExecutorAdapter([descriptorOnlyAdapter(opencodeDescriptor()), descriptorOnlyAdapter(codexDescriptor())]);
    const core = new KerbsFlowCore(store, adapter, new FakeArtifactStore(ids), {
      clock,
      ids,
      configuration: {
        hardInvariants: DEFAULT_HARD_INVARIANTS,
        projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["opencode", "codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
        userPreferences: DEFAULT_USER_PREFERENCES,
        runOverride: DEFAULT_RUN_OVERRIDE,
      },
    });
    let command = core.startRun(routed.planningDecision.runId, "synthetic route", "start-routing");
    command = core.completeIntake(routed.planningDecision.runId, command.stateVersion, "intake-routing");
    command = core.plan(routed.planningDecision.runId, command.stateVersion, "plan-routing", routed.planningDecision);
    const stored = store.recordRoutingDecision(routed.routingDecision);
    assert.deepEqual(stored.decision.selected, routed.routingDecision.selected);
    command = core.prepareExecution(routed.planningDecision.runId, command.stateVersion, "prepare-routing");
    const attemptId = store.readModel(routed.planningDecision.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    const linked = store.linkRoutingDecision(routed.routingDecision.planningDecisionId, attemptId!);
    assert.equal(linked.decision.attemptId, attemptId);
    const secret = { ...routed.routingDecision, selectionReason: "Bearer sk-synthetic-secret-value" };
    assert.throws(() => store.recordRoutingDecision(secret), /secret|credential/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared core selects the routed adapter again when Phase 3 escalates OpenCode to Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-routing-escalation-"));
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("routing-escalation");
  const store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  try {
    const initial = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: candidates() }).planningDecision;
    const routedAdapter = new RoutedExecutorAdapter([descriptorOnlyAdapter(opencodeDescriptor()), descriptorOnlyAdapter(codexDescriptor())]);
    const core = new KerbsFlowCore(store, routedAdapter, new FakeArtifactStore(ids), {
      clock,
      ids,
      configuration: {
        hardInvariants: DEFAULT_HARD_INVARIANTS,
        projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["opencode", "codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
        userPreferences: DEFAULT_USER_PREFERENCES,
        runOverride: DEFAULT_RUN_OVERRIDE,
      },
    });
    let command = core.startRun(initial.runId, "synthetic cross-adapter escalation", "route-escalation:start");
    command = core.completeIntake(initial.runId, command.stateVersion, "route-escalation:intake");
    command = core.plan(initial.runId, command.stateVersion, "route-escalation:plan", initial);
    command = core.prepareExecution(initial.runId, command.stateVersion, "route-escalation:prepare:1");
    command = await core.beginAttempt(initial.runId, command.stateVersion, "route-escalation:begin:1", root);
    const firstAttempt = core.readModel(initial.runId)?.activeAttempt;
    assert.ok(firstAttempt);
    command = await core.completeAttempt(initial.runId, command.stateVersion, "route-escalation:complete:1", executorFailure(initial, firstAttempt!.attemptId));
    command = core.recordFocusedValidation(initial.runId, command.stateVersion, "route-escalation:validate:1", {
      schemaVersion: CONTRACT_VERSIONS.validation,
      validationId: asValidationId("validation_route_escalation"),
      runId: initial.runId,
      taskId: initial.taskId,
      attemptId: firstAttempt!.attemptId,
      level: "focused",
      outcome: "failed",
      summary: "synthetic first-route failure",
      checks: [{ name: "synthetic", outcome: "failed", evidenceClass: "simulated", evidenceRefs: [] }],
      evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId("validation_evidence_route_escalation"), kind: "check", classification: "simulated", summary: "synthetic route evidence" }],
    });
    command = core.review(initial.runId, command.stateVersion, "route-escalation:review:1", {
      schemaVersion: CONTRACT_VERSIONS.reviewDecision,
      reviewId: asReviewId("review_route_escalation"),
      runId: initial.runId,
      taskId: initial.taskId,
      outcome: "rework",
      summary: "escalate to the approved Codex fallback",
      evidenceRefs: [],
      reasonCode: "synthetic_route_escalation",
    });
    const escalated = escalatePlanningRoute(initial, { model: "openai/sol-current", reasoning: "high" });
    assert.deepEqual(escalated.route, { adapter: "codex", model: "openai/sol-current", reasoning: "high" });
    command = core.reworkToReady(initial.runId, command.stateVersion, "route-escalation:ready:2", escalated);
    core.prepareExecution(initial.runId, command.stateVersion, "route-escalation:prepare:2");
    const descriptors = store.listTaskAttempts(initial.runId, initial.taskId).map((attempt) => JSON.parse(attempt.adapterDescriptorJson ?? "{}") as { adapter?: string });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.adapter), ["opencode", "codex"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("core rejects a planning route whose active adapter descriptor does not match", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-routing-mismatch-"));
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("mismatch");
  const store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  try {
    const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", candidates: candidates() });
    const core = new KerbsFlowCore(store, descriptorOnlyAdapter(codexDescriptor()), new FakeArtifactStore(ids), {
      clock,
      ids,
      configuration: {
        hardInvariants: DEFAULT_HARD_INVARIANTS,
        projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["opencode", "codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
        userPreferences: DEFAULT_USER_PREFERENCES,
        runOverride: DEFAULT_RUN_OVERRIDE,
      },
    });
    let command = core.startRun(routed.planningDecision.runId, "synthetic mismatch", "start-mismatch");
    command = core.completeIntake(routed.planningDecision.runId, command.stateVersion, "intake-mismatch");
    command = core.plan(routed.planningDecision.runId, command.stateVersion, "plan-mismatch", routed.planningDecision);
    assert.throws(() => core.prepareExecution(routed.planningDecision.runId, command.stateVersion, "prepare-mismatch"), /does not match active adapter/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function baseDecision() {
  return createPhase2PlanningDecision({
    decisionId: "decision_phase4_route",
    runId: asRunId("run_phase4_route"),
    taskId: asTaskId("task_phase4_route"),
    objective: "implement an ordinary synthetic feature",
    acceptance: ["the focused check passes"],
    positiveScope: ["src/example.ts"],
    negativeScope: ["secrets", "release"],
    model: "placeholder",
    canonicalContext: "phase4 route fixture",
  });
}

function candidates(): RouteCandidate[] {
  return [
    { adapter: "opencode", provider: "opencode", model: "opencode/muse-current", family: "muse", available: true, descriptor: opencodeDescriptor() },
    { adapter: "codex", provider: "openai", model: "openai/luna-current", family: "luna", reasoning: "max", available: true, descriptor: codexDescriptor() },
    { adapter: "codex", provider: "openai", model: "openai/sol-current", family: "sol", reasoning: "medium", available: true, descriptor: codexDescriptor() },
    { adapter: "codex", provider: "openai", model: "openai/sol-current", family: "sol", reasoning: "high", available: true, descriptor: codexDescriptor() },
  ];
}

function opencodeDescriptor(): AdapterDescriptor {
  return {
    schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
    adapter: "opencode",
    provider: "provider-selected",
    adapterVersion: "2.0.13",
    capabilities: {
      eventTransport: "async_iterable",
      finalJsonSchema: false,
      modelSelection: true,
      reasoningEffort: [],
      agentSelection: true,
      filesystemEnforcement: "tool_policy_only",
      network: { providerControlPlane: "provider_owned", workload: "tool_policy_only" },
      cancellation: "native",
      resumableSession: true,
      authentication: { owner: "provider", mode: "provider-owned" },
      healthProbe: true,
    },
  };
}

function codexDescriptor(): AdapterDescriptor {
  return {
    schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
    adapter: "codex",
    provider: "openai",
    adapterVersion: "fixture",
    capabilities: {
      eventTransport: "jsonl",
      finalJsonSchema: true,
      modelSelection: true,
      reasoningEffort: ["medium", "high", "max"],
      agentSelection: false,
      filesystemEnforcement: "enforced",
      network: { providerControlPlane: "provider_owned", workload: "enforced" },
      cancellation: "process_only",
      resumableSession: true,
      authentication: { owner: "provider", mode: "provider-owned" },
      healthProbe: true,
    },
  };
}

function executorFailure(decision: ReturnType<typeof baseDecision>, attemptId: ReturnType<typeof import("../src/contracts.js").asAttemptId>) {
  return {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: decision.runId,
    taskId: decision.taskId,
    attemptId,
    executor: { adapter: "opencode", adapterVersion: "2.0.13", provider: "opencode", model: "opencode/muse-current" },
    outcome: "failed",
    failureClass: "implementation_failure",
    scopeClaim: "within_scope",
    summary: "synthetic first-route failure",
    filesChanged: [],
    checks: [],
    evidence: [],
    invariantViolations: [],
    risks: [],
    warnings: [],
    artifacts: [],
    humanGate: null,
    recommendedNext: "rework",
    exit: { kind: "normal", code: 1 },
  };
}

function descriptorOnlyAdapter(descriptor: AdapterDescriptor): ExecutorAdapter {
  return {
    probe: () => descriptor,
    start: (request: ExecutionRequest): AttemptHandle => ({ schemaVersion: CONTRACT_VERSIONS.attemptHandle, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId }),
    events: async function* () { /* no events needed */ },
    wait: async () => ({ schemaVersion: "invalid" }),
    cancel: () => ({ outcome: "unknown", summary: "not used" }),
    reconcile: async () => ({ outcome: "unknown", summary: "not used" }),
  };
}
