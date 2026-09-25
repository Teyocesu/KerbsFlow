import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AdapterRoutingReadiness, ExecutorAdapter } from "../src/adapter.js";
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
import {
  PolicyRouter,
  RoutedExecutorAdapter,
  RoutingDiscovery,
  createAttemptRoutingProvenance,
  type RouteModelPolicy,
  type RoutingDiscoveryAuthority,
  type TrustedAttemptRoutingProvenance,
  type TrustedRoutingDecision,
} from "../src/routing.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";

test("authoritative live discovery selects Muse and records the capability snapshot", async () => {
  const { discovery, probes, readiness } = await discover();
  const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery });
  assert.deepEqual(routed.planningDecision.route, { adapter: "opencode", model: "opencode/muse-current" });
  assert.equal(routed.routingDecision.selected.family, "muse");
  assert.equal(routed.routingDecision.capabilitySnapshotHash.length, 64);
  assert.equal(routed.routingDecision.discoveredAt, "2026-09-22T12:00:00.000Z");
  assert.deepEqual(probes, { opencode: 1, codex: 1 });
  assert.equal(readiness.count, 1);
});

test("fabricated discovery and routing decisions cannot impersonate runtime authority", async () => {
  const actual = await discover();
  const fakeDiscovery = { ...actual.discovery } as RoutingDiscoveryAuthority;
  assert.throws(() => new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: fakeDiscovery }), /authority|authoritative/i);

  const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: actual.discovery });
  const fakeDecision = { ...routed.routingDecision } as TrustedRoutingDecision;
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-route-authority-"));
  const store = StateStore.open(join(root, "state.sqlite"));
  try {
    assert.throws(() => store.recordRoutingDecision(fakeDecision), /authority|authoritative/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered adapter identity mismatch fails discovery closed", async () => {
  const discovery = new RoutingDiscovery([{ adapter: "opencode", implementation: descriptorOnlyAdapter(codexDescriptor(), readiness()) }]);
  await assert.rejects(discovery.discover({ workingDirectory: "/synthetic", models: models().slice(0, 1) }), /reported itself as codex/i);
});

test("undiscovered Muse falls back to Luna Max and shell work cannot use OpenCode", async () => {
  const unavailable = await discover({ readiness: { ready: false, models: [], reason: "no enabled Muse model" } });
  const fallback = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: unavailable.discovery });
  assert.deepEqual(fallback.planningDecision.route, { adapter: "codex", model: "openai/luna-current", reasoning: "max" });
  assert.match(fallback.routingDecision.fallbackReason ?? "", /not discovered|no enabled/i);

  const available = await discover();
  const shell = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: available.discovery, requiresShell: true });
  assert.equal(shell.routingDecision.selected.family, "luna");
  assert.match(shell.routingDecision.fallbackReason ?? "", /denies shell/i);
});

test("missing probed capabilities make a route unsuitable and Codex requires enforced boundaries", async () => {
  const weakOpenCode = opencodeDescriptor();
  weakOpenCode.capabilities.cancellation = "none";
  const noCodex = await discover({ opencodeDescriptor: weakOpenCode, codexProbeError: new Error("Codex unavailable") });
  assert.throws(() => new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: noCodex.discovery }), /no Phase 4 route/i);

  const weakCodex = codexDescriptor();
  weakCodex.capabilities.network.workload = "tool_policy_only";
  const noMuse = await discover({ readiness: { ready: false, models: [], reason: "Muse unavailable" }, codexDescriptor: weakCodex });
  assert.throws(() => new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: noMuse.discovery }), /no Phase 4 route/i);
});

test("a task requiring OS-enforced isolation cannot use a tool-policy-only route", async () => {
  const available = await discover();
  const routed = new PolicyRouter().route({
    planningDecision: baseDecision(),
    classification: "normal",
    discovery: available.discovery,
    requiredIsolation: { filesystem: "enforced", workloadNetwork: "enforced" },
  });
  assert.equal(routed.routingDecision.selected.adapter, "codex");
  assert.match(routed.routingDecision.fallbackReason ?? "", /weaker than required/i);

  const unavailable = await discover({ codexProbeError: new Error("Codex unavailable") });
  assert.throws(() => new PolicyRouter().route({
    planningDecision: baseDecision(),
    classification: "normal",
    discovery: unavailable.discovery,
    requiredIsolation: { filesystem: "enforced", workloadNetwork: "enforced" },
  }), /route.*unavailable|no Phase 4 route/i);
});

test("core Phase 4 dispatch rejects missing routing authority before adapter start", async () => {
  const missingDecision = await preparedRoutingFixture("missing-decision");
  try {
    await assert.rejects(
      missingDecision.core.beginAttempt(missingDecision.routed.planningDecision.runId, missingDecision.command.stateVersion, "missing-decision:begin", missingDecision.root),
      /routing decision|routing authority/i,
    );
    assert.equal(missingDecision.starts.count, 0);
  } finally {
    missingDecision.close();
  }

  const missingProvenance = await preparedRoutingFixture("missing-provenance");
  try {
    missingProvenance.store.recordRoutingDecision(missingProvenance.routed.routingDecision);
    await assert.rejects(
      missingProvenance.core.beginAttempt(missingProvenance.routed.planningDecision.runId, missingProvenance.command.stateVersion, "missing-provenance:begin", missingProvenance.root),
      /attempt routing provenance|routing authority/i,
    );
    assert.equal(missingProvenance.starts.count, 0);
  } finally {
    missingProvenance.close();
  }
});

test("plain or cross-run attempt provenance cannot authorize Phase 4 dispatch", async () => {
  const source = await preparedRoutingFixture("authority-source");
  const target = await preparedRoutingFixture("authority-target");
  try {
    source.store.recordRoutingDecision(source.routed.routingDecision);
    target.store.recordRoutingDecision(target.routed.routingDecision);
    const sourceProvenance = createAttemptRoutingProvenance({
      routingDecision: source.routed.routingDecision,
      planningDecision: source.routed.planningDecision,
      attemptId: source.attemptId,
      selectionReason: source.routed.routingDecision.selectionReason,
    });
    const fabricated = { ...sourceProvenance } as TrustedAttemptRoutingProvenance;
    assert.throws(() => source.store.recordAttemptRoutingProvenance(fabricated), /authority|trusted routing decision/i);
    assert.throws(() => target.store.recordAttemptRoutingProvenance(sourceProvenance), /scope|persisted attempt/i);
    await assert.rejects(
      target.core.beginAttempt(target.routed.planningDecision.runId, target.command.stateVersion, "authority-target:begin", target.root),
      /attempt routing provenance|routing authority/i,
    );
    assert.equal(source.starts.count, 0);
    assert.equal(target.starts.count, 0);
  } finally {
    source.close();
    target.close();
  }
});

test("prepared OpenCode capability drift is rejected before dispatch", async () => {
  const weaker = opencodeDescriptor();
  weaker.capabilities.cancellation = "none";
  const fixture = await preparedRoutingFixture("opencode-drift", { runtimeDescriptor: weaker });
  try {
    fixture.store.recordRoutingDecision(fixture.routed.routingDecision);
    const provenance = createAttemptRoutingProvenance({
      routingDecision: fixture.routed.routingDecision,
      planningDecision: fixture.routed.planningDecision,
      attemptId: fixture.attemptId,
      selectionReason: fixture.routed.routingDecision.selectionReason,
    });
    assert.throws(() => fixture.store.recordAttemptRoutingProvenance(provenance), /descriptor|capability snapshot/i);
    await assert.rejects(
      fixture.core.beginAttempt(fixture.routed.planningDecision.runId, fixture.command.stateVersion, "opencode-drift:begin", fixture.root),
      /attempt routing provenance|routing authority/i,
    );
    assert.equal(fixture.starts.count, 0);
  } finally {
    fixture.close();
  }
});

test("prepared Codex without enforced workload network is rejected before dispatch", async () => {
  const weaker = codexDescriptor();
  weaker.capabilities.network.workload = "tool_policy_only";
  const fixture = await preparedRoutingFixture("codex-drift", { classification: "high_impact", runtimeDescriptor: weaker });
  try {
    fixture.store.recordRoutingDecision(fixture.routed.routingDecision);
    const provenance = createAttemptRoutingProvenance({
      routingDecision: fixture.routed.routingDecision,
      planningDecision: fixture.routed.planningDecision,
      attemptId: fixture.attemptId,
      selectionReason: fixture.routed.routingDecision.selectionReason,
    });
    assert.throws(() => fixture.store.recordAttemptRoutingProvenance(provenance), /descriptor|capability snapshot/i);
    await assert.rejects(
      fixture.core.beginAttempt(fixture.routed.planningDecision.runId, fixture.command.stateVersion, "codex-drift:begin", fixture.root),
      /attempt routing provenance|routing authority/i,
    );
    assert.equal(fixture.starts.count, 0);
  } finally {
    fixture.close();
  }
});

test("core revalidates durable descriptor capability identity immediately before dispatch", async () => {
  const fixture = await preparedRoutingFixture("dispatch-recheck");
  try {
    fixture.store.recordRoutingDecision(fixture.routed.routingDecision);
    fixture.store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
      routingDecision: fixture.routed.routingDecision,
      planningDecision: fixture.routed.planningDecision,
      attemptId: fixture.attemptId,
      selectionReason: fixture.routed.routingDecision.selectionReason,
    }));
    const weaker = opencodeDescriptor();
    weaker.capabilities.resumableSession = false;
    const database = new DatabaseSync(join(fixture.root, "state.sqlite"));
    try {
      database.prepare("UPDATE attempts SET adapter_descriptor_json = ? WHERE attempt_id = ?").run(JSON.stringify(weaker), fixture.attemptId);
    } finally {
      database.close();
    }
    await assert.rejects(
      fixture.core.beginAttempt(fixture.routed.planningDecision.runId, fixture.command.stateVersion, "dispatch-recheck:begin", fixture.root),
      /descriptor|capability snapshot/i,
    );
    assert.equal(fixture.starts.count, 0);
  } finally {
    fixture.close();
  }
});

test("capability-identical adapter instances authorize trusted OpenCode and Codex dispatch", async () => {
  for (const [suffix, classification] of [["trusted-opencode", "normal"], ["trusted-codex", "high_impact"]] as const) {
    const fixture = await preparedRoutingFixture(suffix, { classification });
    try {
      fixture.store.recordRoutingDecision(fixture.routed.routingDecision);
      fixture.store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
        routingDecision: fixture.routed.routingDecision,
        planningDecision: fixture.routed.planningDecision,
        attemptId: fixture.attemptId,
        selectionReason: fixture.routed.routingDecision.selectionReason,
      }));
      await fixture.core.beginAttempt(fixture.routed.planningDecision.runId, fixture.command.stateVersion, `${suffix}:begin`, fixture.root);
      assert.equal(fixture.starts.count, 1);
    } finally {
      fixture.close();
    }
  }
});

test("difficult/high-impact routes and Luna Medium remain frozen policy", async () => {
  const actual = await discover();
  const difficult = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "difficult", discovery: actual.discovery });
  assert.deepEqual(difficult.planningDecision.route, { adapter: "codex", model: "openai/sol-current", reasoning: "medium" });
  const high = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "high_impact", discovery: actual.discovery });
  assert.deepEqual(high.planningDecision.route, { adapter: "codex", model: "openai/sol-current", reasoning: "high" });

  const prohibited = [...models(), { adapter: "codex", provider: "openai", model: "openai/luna-current", family: "luna", reasoning: "medium" } satisfies RouteModelPolicy];
  await assert.rejects(new RoutingDiscovery([
    { adapter: "opencode", implementation: descriptorOnlyAdapter(opencodeDescriptor(), readiness()) },
    { adapter: "codex", implementation: descriptorOnlyAdapter(codexDescriptor()) },
  ]).discover({ workingDirectory: "/synthetic", models: prohibited }), /Luna Medium/i);
});

test("routing decision and separate provenance for every attempt persist without secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-routing-"));
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("routing");
  const store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  try {
    const actual = await discover();
    const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: actual.discovery });
    const starts = { count: 0 };
    const adapter = new RoutedExecutorAdapter([descriptorOnlyAdapter(opencodeDescriptor(), readiness(), undefined, undefined, () => { starts.count += 1; }), descriptorOnlyAdapter(codexDescriptor(), undefined, undefined, undefined, () => { starts.count += 1; })]);
    const core = configuredCore(store, adapter, clock, ids);
    let command = core.startRun(routed.planningDecision.runId, "synthetic route", "start-routing");
    command = core.completeIntake(routed.planningDecision.runId, command.stateVersion, "intake-routing");
    command = core.plan(routed.planningDecision.runId, command.stateVersion, "plan-routing", routed.planningDecision);
    store.recordRoutingDecision(routed.routingDecision);

    command = core.prepareExecution(routed.planningDecision.runId, command.stateVersion, "prepare-routing-1");
    assert.equal(JSON.parse(store.readModel(routed.planningDecision.runId)?.activeAttempt?.adapterDescriptorJson ?? "{}").adapter, "opencode");
    const firstAttempt = store.readModel(routed.planningDecision.runId)?.run.activeAttemptId;
    assert.ok(firstAttempt);
    store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({ routingDecision: routed.routingDecision, planningDecision: routed.planningDecision, attemptId: firstAttempt!, selectionReason: routed.routingDecision.selectionReason }));
    command = await core.beginAttempt(routed.planningDecision.runId, command.stateVersion, "begin-routing-1", root);
    command = await core.completeAttempt(routed.planningDecision.runId, command.stateVersion, "complete-routing-1", executorFailure(routed.planningDecision, firstAttempt!));
    command = core.recordFocusedValidation(routed.planningDecision.runId, command.stateVersion, "validate-routing-1", failedValidation(routed.planningDecision, firstAttempt!));
    command = core.review(routed.planningDecision.runId, command.stateVersion, "review-routing-1", {
      schemaVersion: CONTRACT_VERSIONS.reviewDecision,
      reviewId: asReviewId("review_route_escalation"),
      runId: routed.planningDecision.runId,
      taskId: routed.planningDecision.taskId,
      outcome: "rework",
      summary: "escalate to trusted Codex fallback",
      evidenceRefs: [],
      reasonCode: "synthetic_route_escalation",
    });
    const escalated = escalatePlanningRoute(routed.planningDecision, { model: "openai/sol-current", reasoning: "high" });
    command = core.reworkToReady(routed.planningDecision.runId, command.stateVersion, "ready-routing-2", escalated);
    command = core.prepareExecution(routed.planningDecision.runId, command.stateVersion, "prepare-routing-2");
    assert.equal(JSON.parse(store.readModel(routed.planningDecision.runId)?.activeAttempt?.adapterDescriptorJson ?? "{}").adapter, "codex");
    const secondAttempt = store.readModel(routed.planningDecision.runId)?.run.activeAttemptId;
    assert.ok(secondAttempt);
    await assert.rejects(() => core.beginAttempt(routed.planningDecision.runId, command.stateVersion, "begin-routing-2-missing", root), /attempt routing provenance|routing authority/i);
    assert.equal(starts.count, 1, "provenance from the first attempt cannot authorize the second attempt");
    store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
      routingDecision: routed.routingDecision,
      planningDecision: escalated,
      attemptId: secondAttempt!,
      selectionReason: "failure policy escalated",
      escalationReason: "first route failed independent verification",
    }));
    await core.beginAttempt(routed.planningDecision.runId, command.stateVersion, "begin-routing-2", root);
    assert.equal(starts.count, 2);

    const provenance = store.listAttemptRoutingProvenance(routed.planningDecision.runId, routed.planningDecision.taskId);
    assert.deepEqual(provenance.map((entry) => entry.provenance.selected.adapter), ["opencode", "codex"]);
    assert.equal(provenance[1]?.provenance.escalationReason, "first route failed independent verification");
    assert.notEqual(provenance[0]?.provenance.attemptId, provenance[1]?.provenance.attemptId);

    const secret = { ...routed.routingDecision, selectionReason: "Bearer sk-synthetic-secret-value" } as TrustedRoutingDecision;
    assert.throws(() => store.recordRoutingDecision(secret), /secret|credential/i);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an escalated attempt cannot use a route absent from the trusted discovery snapshot", async () => {
  const actual = await discover();
  const routed = new PolicyRouter().route({ planningDecision: baseDecision(), classification: "normal", discovery: actual.discovery });
  const absent = escalatePlanningRoute(routed.planningDecision, { model: "openai/unseen", reasoning: "high" });
  assert.throws(() => createAttemptRoutingProvenance({ routingDecision: routed.routingDecision, planningDecision: absent, attemptId: "attempt_absent" as never, selectionReason: "untrusted escalation" }), /not an available and suitable route/i);
});

function baseDecision(suffix = "route") {
  return createPhase2PlanningDecision({ decisionId: `decision_phase4_${suffix}`, runId: asRunId(`run_phase4_${suffix}`), taskId: asTaskId(`task_phase4_${suffix}`), objective: "implement an ordinary synthetic feature", acceptance: ["the focused check passes"], positiveScope: ["src/example.ts"], negativeScope: ["secrets", "release"], model: "placeholder", canonicalContext: `phase4 ${suffix} fixture` });
}

function models(): RouteModelPolicy[] {
  return [
    { adapter: "opencode", provider: "opencode", model: "opencode/muse-current", family: "muse" },
    { adapter: "codex", provider: "openai", model: "openai/luna-current", family: "luna", reasoning: "max" },
    { adapter: "codex", provider: "openai", model: "openai/sol-current", family: "sol", reasoning: "medium" },
    { adapter: "codex", provider: "openai", model: "openai/sol-current", family: "sol", reasoning: "high" },
  ];
}

async function discover(overrides: { readiness?: AdapterRoutingReadiness; opencodeDescriptor?: AdapterDescriptor; codexDescriptor?: AdapterDescriptor; codexProbeError?: Error } = {}) {
  const probes = { opencode: 0, codex: 0 };
  const readinessCalls = { count: 0 };
  const open = descriptorOnlyAdapter(overrides.opencodeDescriptor ?? opencodeDescriptor(), overrides.readiness ?? readiness(), () => { probes.opencode += 1; }, () => { readinessCalls.count += 1; });
  const codex = descriptorOnlyAdapter(overrides.codexDescriptor ?? codexDescriptor(), undefined, () => { probes.codex += 1; if (overrides.codexProbeError !== undefined) throw overrides.codexProbeError; });
  const discovery = await new RoutingDiscovery([{ adapter: "opencode", implementation: open }, { adapter: "codex", implementation: codex }], { now: () => "2026-09-22T12:00:00.000Z" }).discover({ workingDirectory: "/synthetic", models: models() });
  return { discovery, probes, readiness: readinessCalls };
}

function readiness(): AdapterRoutingReadiness {
  return { ready: true, models: [{ provider: "opencode", model: "opencode/muse-current", aliases: ["muse-current"], reasoning: [] }], reason: "Muse is enabled" };
}

function opencodeDescriptor(): AdapterDescriptor {
  return { schemaVersion: CONTRACT_VERSIONS.adapterDescriptor, adapter: "opencode", provider: "provider-selected", adapterVersion: "2.0.13", capabilities: { eventTransport: "async_iterable", finalJsonSchema: false, modelSelection: true, reasoningEffort: [], agentSelection: true, filesystemEnforcement: "tool_policy_only", network: { providerControlPlane: "provider_owned", workload: "tool_policy_only" }, cancellation: "native", resumableSession: true, authentication: { owner: "provider", mode: "provider-owned" }, healthProbe: true } };
}

function codexDescriptor(): AdapterDescriptor {
  return { schemaVersion: CONTRACT_VERSIONS.adapterDescriptor, adapter: "codex", provider: "openai", adapterVersion: "fixture", capabilities: { eventTransport: "jsonl", finalJsonSchema: true, modelSelection: true, reasoningEffort: ["medium", "high", "max"], agentSelection: false, filesystemEnforcement: "enforced", network: { providerControlPlane: "provider_owned", workload: "enforced" }, cancellation: "process_only", resumableSession: true, authentication: { owner: "provider", mode: "provider-owned" }, healthProbe: true } };
}

function descriptorOnlyAdapter(descriptor: AdapterDescriptor, routing?: AdapterRoutingReadiness, onProbe?: () => void, onReadiness?: () => void, onStart?: () => void): ExecutorAdapter {
  return { probe: () => { onProbe?.(); return descriptor; }, ...(routing === undefined ? {} : { routingReadiness: async () => { onReadiness?.(); return routing; } }), start: (request: ExecutionRequest): AttemptHandle => { onStart?.(); return { schemaVersion: CONTRACT_VERSIONS.attemptHandle, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId }; }, events: async function* () { /* no events needed */ }, wait: async () => ({ schemaVersion: "invalid" }), cancel: () => ({ outcome: "unknown", summary: "not used" }), reconcile: async () => ({ outcome: "unknown", summary: "not used" }) };
}

async function preparedRoutingFixture(
  suffix: string,
  options: { classification?: "normal" | "difficult" | "high_impact"; runtimeDescriptor?: AdapterDescriptor } = {},
) {
  const root = mkdtempSync(join(tmpdir(), `kerbsflow-routing-${suffix}-`));
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource(suffix);
  const store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  const discovery = await new RoutingDiscovery([
    { adapter: "opencode", implementation: descriptorOnlyAdapter(opencodeDescriptor(), readiness()) },
    { adapter: "codex", implementation: descriptorOnlyAdapter(codexDescriptor()) },
  ], { now: () => "2026-09-22T12:00:00.000Z" }).discover({ workingDirectory: root, models: models() });
  const routed = new PolicyRouter().route({ planningDecision: baseDecision(suffix), classification: options.classification ?? "normal", discovery });
  const starts = { count: 0 };
  const runtimeDescriptor = options.runtimeDescriptor ?? (routed.planningDecision.route.adapter === "opencode" ? opencodeDescriptor() : codexDescriptor());
  const runtime = descriptorOnlyAdapter(runtimeDescriptor, routed.planningDecision.route.adapter === "opencode" ? readiness() : undefined, undefined, undefined, () => { starts.count += 1; });
  const core = configuredCore(store, new RoutedExecutorAdapter([runtime]), clock, ids);
  let command = core.startRun(routed.planningDecision.runId, "synthetic route", `${suffix}:start`);
  command = core.completeIntake(routed.planningDecision.runId, command.stateVersion, `${suffix}:intake`);
  command = core.plan(routed.planningDecision.runId, command.stateVersion, `${suffix}:plan`, routed.planningDecision);
  command = core.prepareExecution(routed.planningDecision.runId, command.stateVersion, `${suffix}:prepare`);
  const attemptId = store.readModel(routed.planningDecision.runId)?.run.activeAttemptId;
  assert.ok(attemptId);
  return {
    root, store, core, routed, command, attemptId, starts,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function configuredCore(store: StateStore, adapter: ExecutorAdapter, clock: FixedClock, ids: SequenceIdSource): KerbsFlowCore {
  return new KerbsFlowCore(store, adapter, new FakeArtifactStore(ids), { clock, ids, configuration: { hardInvariants: DEFAULT_HARD_INVARIANTS, projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["opencode", "codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false }, userPreferences: DEFAULT_USER_PREFERENCES, runOverride: DEFAULT_RUN_OVERRIDE } });
}

function executorFailure(decision: ReturnType<typeof baseDecision>, attemptId: ReturnType<typeof import("../src/contracts.js").asAttemptId>) {
  return { schemaVersion: CONTRACT_VERSIONS.executorResult, runId: decision.runId, taskId: decision.taskId, attemptId, executor: { adapter: "opencode", adapterVersion: "2.0.13", provider: "opencode", model: "opencode/muse-current" }, outcome: "failed" as const, failureClass: "implementation_failure" as const, scopeClaim: "within_scope" as const, summary: "synthetic first-route failure", filesChanged: [], checks: [], evidence: [], invariantViolations: [], risks: [], warnings: [], artifacts: [], humanGate: null, recommendedNext: "rework" as const, exit: { kind: "normal" as const, code: 1 } };
}

function failedValidation(decision: ReturnType<typeof baseDecision>, attemptId: ReturnType<typeof import("../src/contracts.js").asAttemptId>) {
  return { schemaVersion: CONTRACT_VERSIONS.validation, validationId: asValidationId("validation_route_escalation"), runId: decision.runId, taskId: decision.taskId, attemptId, level: "focused" as const, outcome: "failed" as const, summary: "synthetic first-route failure", checks: [{ name: "synthetic", outcome: "failed" as const, evidenceClass: "simulated" as const, evidenceRefs: [] }], evidence: [{ schemaVersion: CONTRACT_VERSIONS.validation, id: asValidationId("validation_evidence_route_escalation"), kind: "check" as const, classification: "simulated" as const, summary: "synthetic route evidence" }] };
}
