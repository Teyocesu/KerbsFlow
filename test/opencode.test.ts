import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorAdapter } from "../src/adapter.js";

import {
  OPENCODE_EXECUTOR_PERMISSIONS,
  OPENCODE_RESULT_END,
  OPENCODE_RESULT_START,
  OPENCODE_SDK_VERSION,
  OpenCodeAdapter,
  type OpenCodeHostBoundary,
  type OpenCodeHostCreateOptions,
} from "../src/opencode.js";
import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  type ExecutionRequest,
  type ExecutorResult,
  asAttemptId,
  asRunId,
  asTaskId,
  parseExecutorResult,
  parsePlanningDecision,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { FakeArtifactStore } from "../src/fake.js";
import { createPhase2PlanningDecision } from "../src/planning.js";
import { StateStore } from "../src/persistence.js";
import { PolicyRouter, RoutedExecutorAdapter, RoutingDiscovery, createAttemptRoutingProvenance, type RoutedPlanning } from "../src/routing.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";

test("the official OpenCode V2 SDK is pinned and its embedded API enforces the tested tool policy without a listener", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-sdk-"));
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(packageJson.dependencies["@opencode/sdk"], OPENCODE_SDK_VERSION);
  const packageName: string = "@opencode/sdk";
  const sdk = await import(packageName) as unknown as { OpenCode: { create(options: unknown): Promise<OpenCodeHostBoundary> } };
  const before = activeServers();
  const host = await sdk.OpenCode.create({
    app: { name: "kerbsflow-test", version: OPENCODE_SDK_VERSION },
    database: { path: join(root, "sessions.sqlite") },
    events: { persist: true },
    config: {
      project: false,
      content: JSON.stringify({
        websearch: false,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    },
    fs: { filewatcher: false },
  });
  try {
    const info = await host.server.info();
    assert.deepEqual(info.urls, []);
    assert.equal(activeServers(), before);
    const session = await host.sessions.create({
      title: "permission probe",
      agent: "build",
      model: { id: "unused", providerID: "unused" },
      location: { directory: root },
      metadata: {},
      permissions: OPENCODE_EXECUTOR_PERMISSIONS,
    });
    const check = async (action: string, resource: string) => (await host.permission.create({ sessionID: session.id, action, resources: [resource] })).effect;
    assert.equal(await check("read", "src/index.ts"), "allow");
    assert.equal(await check("edit", "src/index.ts"), "allow");
    assert.equal(await check("read", ".env"), "deny");
    assert.equal(await check("edit", ".env"), "deny");
    assert.equal(await check("read", ".env.local"), "deny");
    assert.equal(await check("edit", ".env.local"), "deny");
    assert.equal(await check("edit", ".env.production"), "deny");
    assert.equal(await check("read", "packages/api/.env"), "deny");
    assert.equal(await check("edit", "packages/api/.env.test"), "deny");
    assert.equal(await check("external_directory", "/private/tmp/*"), "deny");
    assert.equal(await check("shell", "git status"), "deny");
    assert.equal(await check("webfetch", "https://example.com"), "deny");
    assert.equal(await check("websearch", "latest release"), "deny");
    assert.equal(await check("unknown_mcp_tool", "*"), "deny");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(activeServers(), before);
});

test("OpenCodeAdapter owns the embedded host, reports truthful capability strength, and closes it explicitly", async () => {
  const fixture = adapterFixture();
  try {
    const descriptor = fixture.adapter.probe();
    assert.equal(descriptor.adapterVersion, OPENCODE_SDK_VERSION);
    assert.equal(descriptor.capabilities.finalJsonSchema, false);
    assert.equal(descriptor.capabilities.filesystemEnforcement, "tool_policy_only");
    assert.deepEqual(descriptor.capabilities.network, { providerControlPlane: "provider_owned", workload: "tool_policy_only" });
    assert.equal(descriptor.capabilities.cancellation, "native");
    const readiness = await fixture.adapter.readiness(fixture.root);
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.providers, [{ id: "opencode", name: "OpenCode", activation: "enabled" }]);
    assert.equal(JSON.stringify(readiness).includes("apiKey"), false);
    assert.equal(fixture.options?.database.path, join(realpathSync(fixture.root), "opencode", "sessions.sqlite"));
    assert.equal(fixture.options?.events.persist, true);
    assert.equal(fixture.options?.config.project, false);
    assert.match(fixture.options?.config.content ?? "", /"websearch":false/);
    await fixture.adapter.close();
    assert.equal(fixture.host.closed, 1);
  } finally {
    fixture.cleanup();
  }
});

test("OpenCodeAdapter normalizes durable events and accepts only the exact delimited scoped result", async () => {
  const fixture = adapterFixture();
  try {
    fixture.host.logEvents = [
      event("event-1", 1, "session.execution.started"),
      event("event-1", 1, "session.execution.started"),
      event("event-3", 3, "future.event"),
      null,
      event("event-4", 4, "session.idle"),
      event("event-5", 5, "session.execution.succeeded"),
    ];
    const request = executionRequest(fixture.root, "attempt_opencode_valid");
    const handle = fixture.adapter.start(request);
    const events = [];
    for await (const value of fixture.adapter.events(handle)) events.push(value);
    const result = parseExecutorResult(await fixture.adapter.wait(handle));
    assert.equal(result.attemptId, request.attemptId);
    assert.equal(result.executor.adapter, "opencode");
    assert.equal(result.executor.provider, "opencode");
    assert.equal(result.executor.model, "opencode/muse-fixture");
    assert.ok(events.some((value) => value.summary.includes("duplicate")));
    assert.ok(events.some((value) => value.summary.includes("gap")));
    assert.ok(events.some((value) => value.summary.includes("future.event")));
    assert.ok(events.some((value) => value.summary.includes("malformed")));
    assert.ok(events.some((value) => value.summary.includes("session.idle") && value.kind === "progress"));
    assert.equal(events.at(-1)?.kind, "completed");
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    fixture.cleanup();
  }
});

test("the unchanged core lifecycle reaches focused verification through OpenCodeAdapter", async () => {
  const fixture = adapterFixture();
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("opencode-core");
  const store = StateStore.open(join(fixture.root, "state.sqlite"), { clock, ids });
  try {
    fixture.host.logEvents = [event("event-start", 1, "session.execution.started"), event("event-terminal", 2, "session.execution.succeeded")];
    const base = createPhase2PlanningDecision({
      decisionId: "decision_opencode_core",
      runId: asRunId("run_opencode_core"),
      taskId: asTaskId("task_opencode_core"),
      objective: "make one bounded synthetic change",
      acceptance: ["structured result is ingested"],
      positiveScope: ["src/example.ts"],
      negativeScope: ["secrets"],
      model: "placeholder",
      canonicalContext: "opencode core lifecycle",
    });
    const routed = await trustedOpenCodeRoute(fixture.adapter, parsePlanningDecision({ ...base, route: { adapter: "opencode", model: "opencode/muse-fixture" }, policyVersion: "kerbsflow.phase4-routing/v1" }), fixture.root);
    const decision = routed.planningDecision;
    const core = new KerbsFlowCore(store, fixture.adapter, new FakeArtifactStore(ids), {
      clock,
      ids,
      configuration: {
        hardInvariants: DEFAULT_HARD_INVARIANTS,
        projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["opencode", "codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
        userPreferences: DEFAULT_USER_PREFERENCES,
        runOverride: DEFAULT_RUN_OVERRIDE,
      },
    });
    let command = core.startRun(decision.runId, "synthetic OpenCode core run", "opencode-core:start");
    command = core.completeIntake(decision.runId, command.stateVersion, "opencode-core:intake");
    command = core.plan(decision.runId, command.stateVersion, "opencode-core:plan", decision);
    store.recordRoutingDecision(routed.routingDecision);
    command = core.prepareExecution(decision.runId, command.stateVersion, "opencode-core:prepare");
    recordPreparedRoute(store, routed);
    command = await core.beginAttempt(decision.runId, command.stateVersion, "opencode-core:begin", fixture.root, { timeoutMs: 5000 });
    command = await core.completeAttempt(decision.runId, command.stateVersion, "opencode-core:complete");
    assert.equal(command.to, "VERIFY_FOCUSED");
    assert.deepEqual(store.listTransitions(decision.runId).map((transition) => transition.to), ["INTAKE", "PLAN", "READY", "EXECUTE", "VERIFY_FOCUSED"]);
    assert.match(store.readModel(decision.runId)?.activeAttempt?.providerIdentityJson ?? "", /opencode:.*:session:/);
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    store.close();
    fixture.cleanup();
  }
});

test("ambiguous OpenCode terminal output enters RECOVERY without dispatching a fallback adapter", async () => {
  const fixture = adapterFixture();
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("opencode-ambiguous");
  const store = StateStore.open(join(fixture.root, "state.sqlite"), { clock, ids });
  try {
    fixture.host.contextScenario = "missing";
    fixture.host.logEvents = [event("event-terminal", 1, "session.execution.succeeded")];
    const routed = await trustedOpenCodeRoute(fixture.adapter, openCodeDecision("ambiguous"), fixture.root);
    const decision = routed.planningDecision;
    let codexStarts = 0;
    const core = openCodeCore(store, new RoutedExecutorAdapter([fixture.adapter, trackingCodexAdapter(() => { codexStarts += 1; })]), clock, ids);
    let command = core.startRun(decision.runId, "ambiguous OpenCode output", "opencode-ambiguous:start");
    command = core.completeIntake(decision.runId, command.stateVersion, "opencode-ambiguous:intake");
    command = core.plan(decision.runId, command.stateVersion, "opencode-ambiguous:plan", decision);
    store.recordRoutingDecision(routed.routingDecision);
    command = core.prepareExecution(decision.runId, command.stateVersion, "opencode-ambiguous:prepare");
    recordPreparedRoute(store, routed);
    command = await core.beginAttempt(decision.runId, command.stateVersion, "opencode-ambiguous:begin", fixture.root, { timeoutMs: 5000 });
    command = await core.completeAttempt(decision.runId, command.stateVersion, "opencode-ambiguous:complete");
    assert.equal(command.to, "RECOVERY");
    assert.equal(fixture.host.sessionsById.size, 1);
    assert.equal(codexStarts, 0);
    assert.equal(store.listTransitions(decision.runId).filter((transition) => transition.to === "EXECUTE").length, 1);
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    store.close();
    fixture.cleanup();
  }
});

test("an accepted but nonterminal OpenCode interrupt remains RECOVERY through the shared cancellation flow", async () => {
  const fixture = adapterFixture({ interruptLeavesRunning: true });
  const clock = new FixedClock("2026-09-22T12:00:00.000Z");
  const ids = new SequenceIdSource("opencode-uncertain-cancel");
  const store = StateStore.open(join(fixture.root, "state.sqlite"), { clock, ids });
  try {
    const routed = await trustedOpenCodeRoute(fixture.adapter, openCodeDecision("uncertain_cancel"), fixture.root);
    const decision = routed.planningDecision;
    const core = openCodeCore(store, fixture.adapter, clock, ids);
    let command = core.startRun(decision.runId, "uncertain OpenCode cancellation", "opencode-cancel:start");
    command = core.completeIntake(decision.runId, command.stateVersion, "opencode-cancel:intake");
    command = core.plan(decision.runId, command.stateVersion, "opencode-cancel:plan", decision);
    store.recordRoutingDecision(routed.routingDecision);
    command = core.prepareExecution(decision.runId, command.stateVersion, "opencode-cancel:prepare");
    recordPreparedRoute(store, routed);
    command = await core.beginAttempt(decision.runId, command.stateVersion, "opencode-cancel:begin", fixture.root, { timeoutMs: 5000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const attemptId = core.readModel(decision.runId)?.run.activeAttemptId;
    assert.ok(attemptId);
    core.requestRealCancellation(decision.runId, command.stateVersion, "opencode-cancel:intent", "synthetic stop");
    core.signalRealCancellation(decision.runId, command.stateVersion, "opencode-cancel:signal");
    const reconciled = await core.reconcileRealCancellation(decision.runId, command.stateVersion, "opencode-cancel:reconcile");
    assert.equal(reconciled.to, "RECOVERY");
    assert.equal(store.getCancellationIntent(attemptId)?.status, "UNCERTAIN");
    assert.match(core.readModel(decision.runId)?.run.recoveryReason ?? "", /automatic replay is prohibited/i);
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    store.close();
    fixture.cleanup();
  }
});

for (const scenario of ["missing", "malformed", "identity"] as const) {
  test(`OpenCodeAdapter rejects ${scenario} terminal output`, async () => {
    const fixture = adapterFixture();
    try {
      fixture.host.contextScenario = scenario;
      fixture.host.logEvents = [event("event-terminal", 1, "session.execution.succeeded")];
      const handle = fixture.adapter.start(executionRequest(fixture.root, `attempt_opencode_${scenario}`));
      for await (const _event of fixture.adapter.events(handle)) { /* drain */ }
      const raw = await fixture.adapter.wait(handle);
      assert.throws(() => parseExecutorResult(raw));
    } finally {
      await fixture.adapter.close().catch(() => undefined);
      fixture.cleanup();
    }
  });
}

for (const [name, messages] of [
  ["an earlier valid result followed by prose", (session: FakeSession) => [assistant(resultBlock(session)), assistant("later commentary")]],
  ["an earlier malformed marker followed by a valid result", (session: FakeSession) => [assistant(`${OPENCODE_RESULT_START}\n{bad json}`), assistant(resultBlock(session))]],
  ["multiple blocks in the final assistant output", (session: FakeSession) => [assistant(`${resultBlock(session)}\n${resultBlock(session)}`)]],
  ["prose after the final marker", (session: FakeSession) => [assistant(`${resultBlock(session)}\nextra prose`)]],
] as const) {
  test(`OpenCodeAdapter rejects ${name}`, async () => {
    const fixture = adapterFixture();
    try {
      fixture.host.contextBuilder = messages;
      fixture.host.logEvents = [event("event-terminal", 1, "session.execution.succeeded")];
      const handle = fixture.adapter.start(executionRequest(fixture.root, `attempt_opencode_exact_${name.replaceAll(" ", "_")}`));
      for await (const _event of fixture.adapter.events(handle)) { /* drain */ }
      const raw = await fixture.adapter.wait(handle);
      assert.throws(() => parseExecutorResult(raw));
    } finally {
      await fixture.adapter.close().catch(() => undefined);
      fixture.cleanup();
    }
  });
}

test("premature iterator completion is a warning and never substitutes for terminal session/result evidence", async () => {
  const fixture = adapterFixture();
  try {
    fixture.host.logEvents = [event("event-start", 1, "session.execution.started")];
    const handle = fixture.adapter.start(executionRequest(fixture.root, "attempt_opencode_premature"));
    const events = [];
    for await (const value of fixture.adapter.events(handle)) events.push(value);
    assert.equal(events.at(-1)?.kind, "warning");
    assert.match(events.at(-1)?.summary ?? "", /ended before terminal/i);
    assert.equal(parseExecutorResult(await fixture.adapter.wait(handle)).outcome, "succeeded");
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    fixture.cleanup();
  }
});

test("returning the normalized event iterator closes the provider iterator and aborts its subscription", async () => {
  const fixture = adapterFixture();
  try {
    fixture.host.logEvents = [event("event-start", 1, "session.execution.started"), event("event-terminal", 2, "session.execution.succeeded")];
    const handle = fixture.adapter.start(executionRequest(fixture.root, "attempt_opencode_iterator_return"));
    for await (const value of fixture.adapter.events(handle)) {
      assert.equal(value.kind, "started");
      break;
    }
    assert.equal(fixture.host.logReturned, 1);
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    fixture.cleanup();
  }
});

test("native interrupt remains uncertain until reconciliation proves terminal cancellation", async () => {
  const fixture = adapterFixture({ interruptDelayMs: 5 });
  try {
    fixture.host.logEvents = [];
    const request = executionRequest(fixture.root, "attempt_opencode_cancel");
    const handle = fixture.adapter.start(request);
    for await (const _event of fixture.adapter.events(handle)) { /* ensure session creation */ }
    assert.equal(fixture.adapter.cancel(handle, "synthetic cancellation").outcome, "unknown");
    const reconciliation = await fixture.adapter.reconcile(request);
    assert.equal(reconciliation.outcome, "terminal");
    assert.equal(reconciliation.result?.outcome, "cancelled");
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    fixture.cleanup();
  }
});

test("restart reconciliation finds the exact persisted session and ingests its structured result once", async () => {
  const fixture = adapterFixture();
  try {
    fixture.host.logEvents = [event("event-terminal", 1, "session.execution.succeeded")];
    const request = executionRequest(fixture.root, "attempt_opencode_recovery");
    const handle = fixture.adapter.start(request);
    for await (const _event of fixture.adapter.events(handle)) { /* create persistent identity */ }
    await fixture.host.sessions.wait({ sessionID: fixture.host.sessionsById.keys().next().value as string });
    const restarted = new OpenCodeAdapter({ runtimeRoot: fixture.root, createHost: async () => fixture.host, hostIdentity: "restarted" });
    const reconciliation = await restarted.reconcile(request);
    assert.equal(reconciliation.outcome, "terminal");
    assert.equal(reconciliation.result?.attemptId, request.attemptId);
    await restarted.close();
  } finally {
    fixture.cleanup();
  }
});

test("no persisted session proves pre-creation loss, while duplicate identities fail reconciliation closed", async () => {
  const fixture = adapterFixture({ sessionPageSize: 1 });
  try {
    const identity = executionRequest(fixture.root, "attempt_opencode_absent");
    assert.equal((await fixture.adapter.reconcile(identity)).outcome, "not_found");
    fixture.host.seed(identity, "session-one");
    fixture.host.seed(identity, "session-two");
    assert.equal((await fixture.adapter.reconcile(identity)).outcome, "unknown");
  } finally {
    await fixture.adapter.close().catch(() => undefined);
    fixture.cleanup();
  }
});

test("active-session close uses native interrupt, and close/listener failures are never reported as clean", async () => {
  const active = adapterFixture();
  try {
    const handle = active.adapter.start(executionRequest(active.root, "attempt_opencode_close"));
    for await (const _event of active.adapter.events(handle)) { /* create active session */ }
    await active.adapter.close();
    assert.equal(active.host.interrupts, 1);
    assert.equal(active.host.closed, 1);
  } finally {
    active.cleanup();
  }

  const failed = adapterFixture({ closeFails: true });
  try {
    await failed.adapter.readiness(failed.root);
    await assert.rejects(failed.adapter.close(), /close failed/i);
  } finally {
    failed.cleanup();
  }

  const listener = adapterFixture({ urls: ["http://127.0.0.1:9999"] });
  try {
    await assert.rejects(listener.adapter.readiness(listener.root), /listener/i);
    assert.equal(listener.host.closed, 1);
  } finally {
    listener.cleanup();
  }

  const uncertain = adapterFixture({ interruptLeavesRunning: true });
  try {
    const handle = uncertain.adapter.start(executionRequest(uncertain.root, "attempt_opencode_close_uncertain"));
    for await (const _event of uncertain.adapter.events(handle)) { /* create active session */ }
    await assert.rejects(uncertain.adapter.close(), /unproven active sessions/i);
    assert.equal(uncertain.host.closed, 1);
  } finally {
    uncertain.cleanup();
  }
});

test("close before session creation aborts preparation and proves that no session exists", async () => {
  const modelGate = deferred<void>();
  const fixture = adapterFixture({ modelListGate: modelGate });
  try {
    fixture.adapter.start(executionRequest(fixture.root, "attempt_close_before_create"));
    await fixture.host.modelListEntered.promise;
    await fixture.adapter.close();
    assert.equal(fixture.host.createCalls, 0);
    assert.equal(fixture.host.sessionsById.size, 0);
  } finally {
    fixture.cleanup();
  }
});

test("close during delayed session creation aborts it with proven no external session", async () => {
  const createGate = deferred<void>();
  const fixture = adapterFixture({ createGate });
  try {
    fixture.adapter.start(executionRequest(fixture.root, "attempt_close_during_create"));
    await fixture.host.createEntered.promise;
    await fixture.adapter.close();
    assert.equal(fixture.host.sessionsById.size, 0);
  } finally {
    fixture.cleanup();
  }
});

test("close discovers a session created externally before prepare assigns its identity", async () => {
  const createGate = deferred<void>();
  const fixture = adapterFixture({ createGate, createExternallyBeforeGate: true });
  try {
    fixture.adapter.start(executionRequest(fixture.root, "attempt_close_external_before_assignment"));
    await fixture.host.createEntered.promise;
    assert.equal(fixture.host.sessionsById.size, 1);
    await fixture.adapter.close();
    assert.equal(fixture.host.interrupts, 1);
    assert.equal([...fixture.host.sessionsById.values()][0]?.outcome, "interrupted");
  } finally {
    fixture.cleanup();
  }
});

test("close during prompt dispatch interrupts and reconciles the already-created session", async () => {
  const promptGate = deferred<void>();
  const fixture = adapterFixture({ promptGate });
  try {
    fixture.adapter.start(executionRequest(fixture.root, "attempt_close_during_prompt"));
    await fixture.host.promptEntered.promise;
    await fixture.adapter.close();
    assert.equal(fixture.host.interrupts, 1);
    assert.equal([...fixture.host.sessionsById.values()][0]?.outcome, "interrupted");
  } finally {
    fixture.cleanup();
  }
});

test("possible provider dispatch with unknown terminal state makes close uncertain", async () => {
  const promptGate = deferred<void>();
  const fixture = adapterFixture({ promptGate, ignorePromptAbort: true, interruptLeavesRunning: true });
  try {
    fixture.adapter.start(executionRequest(fixture.root, "attempt_close_unknown_dispatch"));
    await fixture.host.promptEntered.promise;
    await assert.rejects(fixture.adapter.close(), /OPENCODE_CLOSE_UNCERTAIN|unproven active sessions/i);
    assert.equal(fixture.host.closed, 1);
  } finally {
    promptGate.resolve();
    fixture.cleanup();
  }
});

test("close is idempotent and new starts are rejected as soon as close begins", async () => {
  const fixture = adapterFixture();
  try {
    const closing = fixture.adapter.close();
    assert.throws(() => fixture.adapter.start(executionRequest(fixture.root, "attempt_after_close")), /close|closing/i);
    await closing;
    await fixture.adapter.close();
    assert.equal(fixture.host.closed, 0);
  } finally {
    fixture.cleanup();
  }
});

function executionRequest(root: string, attempt: string): ExecutionRequest {
  return {
    schemaVersion: CONTRACT_VERSIONS.executionRequest,
    runId: asRunId(`run_${attempt}`),
    taskId: asTaskId(`task_${attempt}`),
    attemptId: asAttemptId(attempt),
    role: "implementation",
    workingDirectory: root,
    promptSummary: "make one synthetic bounded change",
    model: "opencode/muse-fixture",
    permissionPolicy: { filesystem: "worktree_only", network: "denied" },
    timeoutMs: 5000,
    expectedResultSchema: CONTRACT_VERSIONS.executorResult,
  };
}

function openCodeDecision(suffix: string) {
  const base = createPhase2PlanningDecision({
    decisionId: `decision_opencode_${suffix}`,
    runId: asRunId(`run_opencode_${suffix}`),
    taskId: asTaskId(`task_opencode_${suffix}`),
    objective: "make one bounded synthetic change",
    acceptance: ["structured result is ingested"],
    positiveScope: ["src/example.ts"],
    negativeScope: ["secrets"],
    model: "placeholder",
    canonicalContext: `opencode ${suffix} lifecycle`,
  });
  return parsePlanningDecision({ ...base, route: { adapter: "opencode", model: "opencode/muse-fixture" }, policyVersion: "kerbsflow.phase4-routing/v1" });
}

async function trustedOpenCodeRoute(adapter: ExecutorAdapter, decision: ReturnType<typeof openCodeDecision>, workingDirectory: string): Promise<RoutedPlanning> {
  const discovery = await new RoutingDiscovery([{ adapter: "opencode", implementation: adapter }], { now: () => "2026-09-22T12:00:00.000Z" }).discover({
    workingDirectory,
    models: [{ adapter: "opencode", provider: "opencode", model: "opencode/muse-fixture", family: "muse" }],
  });
  return new PolicyRouter().route({ planningDecision: decision, classification: "normal", discovery });
}

function recordPreparedRoute(store: StateStore, routed: RoutedPlanning): void {
  const attemptId = store.readModel(routed.planningDecision.runId)?.run.activeAttemptId;
  assert.ok(attemptId);
  store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
    routingDecision: routed.routingDecision,
    planningDecision: routed.planningDecision,
    attemptId,
    selectionReason: routed.routingDecision.selectionReason,
  }));
}

function openCodeCore(store: StateStore, adapter: ExecutorAdapter, clock: FixedClock, ids: SequenceIdSource): KerbsFlowCore {
  return new KerbsFlowCore(store, adapter, new FakeArtifactStore(ids), {
    clock,
    ids,
    configuration: {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: { schemaVersion: CONTRACT_VERSIONS.config, allowedAdapters: ["opencode", "codex"], maxImplementationAttempts: 2, validationLevel: "focused", workloadNetwork: "denied", automaticReleaseActions: false },
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: DEFAULT_RUN_OVERRIDE,
    },
  });
}

function trackingCodexAdapter(onStart: () => void): ExecutorAdapter {
  return {
    probe: () => ({
      schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
      adapter: "codex",
      provider: "openai",
      adapterVersion: "fixture",
      capabilities: {
        eventTransport: "jsonl", finalJsonSchema: true, modelSelection: true, reasoningEffort: ["max"], agentSelection: false,
        filesystemEnforcement: "enforced", network: { providerControlPlane: "provider_owned", workload: "enforced" },
        cancellation: "process_only", resumableSession: true, authentication: { owner: "provider", mode: "provider-owned" }, healthProbe: true,
      },
    }),
    start: (request) => { onStart(); return { schemaVersion: CONTRACT_VERSIONS.attemptHandle, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId }; },
    events: async function* () { /* no events */ },
    wait: async () => ({ schemaVersion: "invalid" }),
    cancel: () => ({ outcome: "unknown", summary: "not used" }),
    reconcile: async () => ({ outcome: "not_found", summary: "not used" }),
  };
}

function resultFor(session: FakeSession, wrongIdentity = false): ExecutorResult {
  return {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: asRunId(wrongIdentity ? "run_wrong" : session.metadata.kerbsflowRunId!),
    taskId: asTaskId(session.metadata.kerbsflowTaskId!),
    attemptId: asAttemptId(session.metadata.kerbsflowAttemptId!),
    executor: { adapter: "opencode", adapterVersion: OPENCODE_SDK_VERSION, provider: "opencode", model: "opencode/muse-fixture" },
    outcome: "succeeded",
    failureClass: null,
    scopeClaim: "within_scope",
    summary: "synthetic OpenCode fixture completed",
    filesChanged: [],
    checks: [],
    evidence: [],
    invariantViolations: [],
    risks: [],
    warnings: [],
    artifacts: [],
    humanGate: null,
    recommendedNext: "verify_focused",
    exit: { kind: "normal", code: 0 },
  };
}

interface FakeSession {
  id: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  metadata: Record<string, string>;
}

interface FakeHostBehavior {
  closeFails?: boolean;
  urls?: string[];
  interruptDelayMs?: number;
  interruptLeavesRunning?: boolean;
  sessionPageSize?: number;
  modelListGate?: Deferred<void>;
  createGate?: Deferred<void>;
  createExternallyBeforeGate?: boolean;
  promptGate?: Deferred<void>;
  ignorePromptAbort?: boolean;
}

class FakeOpenCodeHost implements OpenCodeHostBoundary {
  readonly sessionsById = new Map<string, FakeSession>();
  logEvents: unknown[] = [];
  contextScenario: "valid" | "missing" | "malformed" | "identity" = "valid";
  contextBuilder?: (session: FakeSession) => unknown[];
  closed = 0;
  interrupts = 0;
  logReturned = 0;
  createCalls = 0;
  readonly modelListEntered = deferred<void>();
  readonly createEntered = deferred<void>();
  readonly promptEntered = deferred<void>();

  constructor(private readonly behavior: FakeHostBehavior = {}) {}

  readonly server = {
    info: async () => ({ version: OPENCODE_SDK_VERSION, pid: process.pid, urls: this.behavior.urls ?? [], paths: { tmp: "/synthetic/opencode" } }),
  };

  readonly provider = {
    list: async () => ({ data: [{ id: "opencode", name: "OpenCode", activation: "enabled" as const }] }),
  };

  readonly model = {
    list: async (_input?: unknown, options?: { signal?: AbortSignal }) => {
      this.modelListEntered.resolve();
      await waitForGate(this.behavior.modelListGate, options?.signal);
      return { data: [{ id: "muse-fixture", modelID: "muse-fixture", providerID: "opencode", name: "Muse Fixture", enabled: true, status: "active" as const, variants: [] }] };
    },
  };

  readonly permission = {
    create: async () => ({ id: "permission_fixture", effect: "deny" as const }),
  };

  readonly sessions = {
    create: async (input: { metadata: Record<string, string> }, options?: { signal?: AbortSignal }) => {
      this.createCalls += 1;
      this.createEntered.resolve();
      const session: FakeSession = { id: `session-${this.sessionsById.size + 1}`, metadata: input.metadata };
      if (this.behavior.createExternallyBeforeGate) this.sessionsById.set(session.id, session);
      await waitForGate(this.behavior.createGate, options?.signal);
      if (!this.behavior.createExternallyBeforeGate) this.sessionsById.set(session.id, session);
      return session;
    },
    prompt: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      this.promptEntered.resolve();
      await waitForGate(this.behavior.promptGate, options?.signal, this.behavior.ignorePromptAbort ?? false);
      return { id: "inbox-fixture" };
    },
    wait: async ({ sessionID }: { sessionID: string }) => {
      const session = this.required(sessionID);
      session.outcome ??= "succeeded";
    },
    get: async ({ sessionID }: { sessionID: string }) => this.required(sessionID),
    list: async (input?: { cursor?: string }) => {
      const sessions = [...this.sessionsById.values()];
      const start = input?.cursor === undefined ? 0 : Number(input.cursor);
      const size = this.behavior.sessionPageSize ?? sessions.length;
      const next = start + size < sessions.length ? String(start + size) : undefined;
      return { data: sessions.slice(start, start + size), ...(next === undefined ? {} : { cursor: { next } }) };
    },
    context: async ({ sessionID }: { sessionID: string }) => {
      const session = this.required(sessionID);
      if (this.contextBuilder !== undefined) return this.contextBuilder(session);
      if (this.contextScenario === "missing") return [{ type: "assistant", content: [{ type: "text", text: "done" }] }];
      if (this.contextScenario === "malformed") return [{ type: "assistant", content: [{ type: "text", text: `${OPENCODE_RESULT_START}\n{bad json}\n${OPENCODE_RESULT_END}` }] }];
      const result = resultFor(session, this.contextScenario === "identity");
      return [{ type: "assistant", content: [{ type: "text", text: `${OPENCODE_RESULT_START}\n${JSON.stringify(result)}\n${OPENCODE_RESULT_END}` }] }];
    },
    log: (_input: unknown, options?: { signal?: AbortSignal }) => {
      const self = this;
      return (async function* () {
        try {
          for (const value of self.logEvents) {
            if (options?.signal?.aborted) return;
            yield value;
          }
        } finally {
          self.logReturned += 1;
        }
      })();
    },
    interrupt: async ({ sessionID }: { sessionID: string }) => {
      this.interrupts += 1;
      if (this.behavior.interruptDelayMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.behavior.interruptDelayMs));
      }
      if (!this.behavior.interruptLeavesRunning) this.required(sessionID).outcome = "interrupted";
      return { interrupted: true };
    },
  };

  seed(request: ExecutionRequest, id: string): void {
    this.sessionsById.set(id, {
      id,
      metadata: {
        kerbsflowRunId: request.runId,
        kerbsflowTaskId: request.taskId,
        kerbsflowAttemptId: request.attemptId,
        kerbsflowProviderID: "opencode",
        kerbsflowModelID: "muse-fixture",
      },
    });
  }

  async close(): Promise<void> {
    this.closed += 1;
    if (this.behavior.closeFails) throw new Error("synthetic close failed");
  }

  private required(id: string): FakeSession {
    const session = this.sessionsById.get(id);
    if (session === undefined) throw new Error(`missing fake session ${id}`);
    return session;
  }
}

function resultBlock(session: FakeSession): string {
  return `${OPENCODE_RESULT_START}\n${JSON.stringify(resultFor(session))}\n${OPENCODE_RESULT_END}`;
}

function assistant(text: string): unknown {
  return { type: "assistant", content: [{ type: "text", text }] };
}

function adapterFixture(behavior: FakeHostBehavior = {}): {
  root: string;
  host: FakeOpenCodeHost;
  adapter: OpenCodeAdapter;
  options?: OpenCodeHostCreateOptions;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-"));
  const host = new FakeOpenCodeHost(behavior);
  const fixture: { root: string; host: FakeOpenCodeHost; adapter: OpenCodeAdapter; options?: OpenCodeHostCreateOptions; cleanup(): void } = {
    root,
    host,
    adapter: undefined as unknown as OpenCodeAdapter,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  fixture.adapter = new OpenCodeAdapter({
    runtimeRoot: root,
    hostIdentity: "fixture-host",
    now: () => "2026-09-22T12:00:00.000Z",
    closePreparationTimeoutMs: 50,
    createHost: async (options) => {
      fixture.options = options;
      return host;
    },
  });
  return fixture;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForGate(gate: Deferred<void> | undefined, signal: AbortSignal | undefined, ignoreAbort = false): Promise<void> {
  if (signal?.aborted && !ignoreAbort) throw new Error("synthetic operation aborted");
  if (gate === undefined) return;
  if (ignoreAbort || signal === undefined) return gate.promise;
  await Promise.race([
    gate.promise,
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic operation aborted")), { once: true })),
  ]);
}

function event(id: string, sequence: number, type: string): Record<string, unknown> {
  return { id, created: Date.parse("2026-09-22T12:00:00.000Z"), type, durable: { seq: sequence }, data: { sessionID: "session-1" } };
}

function activeServers(): number {
  return (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().filter((handle) => handle instanceof Server).length;
}
