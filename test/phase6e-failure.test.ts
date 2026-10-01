import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asCommandId, asRunId, type RunId } from "../src/contracts.js";
import { DatabaseIntegrityError, KerbsFlowError, StateVersionConflictError } from "../src/errors.js";
import type { GitWorktreeManager } from "../src/git.js";
import type { PlanningMasterResult } from "../src/planning.js";
import { LocalApiServer } from "../src/local-api.js";
import { Phase2DriveControlStop } from "../src/run-coordinator.js";
import { PHASE4_ROUTING_POLICY } from "../src/routing.js";
import { createPhase6CStack, deferred, waitFor, type Phase6CStack } from "./phase6c-harness.js";

async function client(stack: Phase6CStack) {
  await stack.api.start();
  const origin = `http://127.0.0.1:${stack.api.port()}`;
  const html = await (await fetch(origin)).text();
  const token = html.match(/name="kerbsflow-token" content="([^"]+)"/u)?.[1];
  assert.ok(token);
  let sequence = 0;
  return {
    async post(path: string, expectedStateVersion: number, payload: Record<string, unknown>, identity?: { commandId: string; idempotencyKey: string }) {
      sequence += 1;
      const response = await fetch(origin + path, {
        method: "POST",
        headers: { Origin: origin, "X-KerbsFlow-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "kerbsflow.local-command/v1",
          commandId: identity?.commandId ?? `command_failure_${sequence}`,
          idempotencyKey: identity?.idempotencyKey ?? `failure:${sequence}`,
          expectedStateVersion,
          payload,
        }),
      });
      return { status: response.status, body: await response.json() as { to?: string; replayed?: boolean; error?: { code: string } } };
    },
    async snapshot(runId: string) {
      const response = await fetch(`${origin}/v1/runs/${runId}/snapshot`, { headers: { "X-KerbsFlow-Token": token } });
      assert.equal(response.status, 200);
      return await response.json() as { run: { state: string }; currentTask: unknown; currentGate: unknown };
    },
  };
}

async function nextRunStarts(stack: Phase6CStack, api: Awaited<ReturnType<typeof client>>, runId: string) {
  assert.equal(stack.coordinator.activeRunId, undefined);
  assert.equal((await api.post("/v1/runs", 0, { runId, objective: "start after the previous drive failed safely" })).status, 200);
  const handle = await stack.adapter.started.promise;
  assert.equal(handle.runId, runId);
  stack.adapter.finish(handle, "succeeded");
  await waitFor(() => stack.store.getRun(asRunId(runId))?.state === "NEXT_PHASE" ? true : undefined, "next run completes through its own drive");
}

function startDrive(stack: Phase6CStack, runId: RunId) {
  stack.coordinator.start({ runId, objective: "exercise a classified failure boundary", commandId: asCommandId(`command_${runId}`), idempotencyKey: `start:${runId}`, expectedStateVersion: 0 });
  return (stack.coordinator as unknown as { reservation: { drivePromise: Promise<void>; driveError?: unknown; driveSettled: boolean; pauseClaim?: unknown; cancelClaim?: unknown; failureDispositionClaim?: unknown } }).reservation;
}

for (const control of ["pause", "cancel"] as const) {
  test(`READY dispatch yields to late ${control} from the production free checkpoint`, { timeout: 15_000 }, async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const runId = asRunId(`run_ready_late_${control}`);
    const claimed = deferred<void>();
    const getRun = stack.store.getRun.bind(stack.store);
    let readyReads = 0;
    let operation: Promise<unknown> | undefined;
    stack.store.getRun = (id) => {
      const run = getRun(id);
      if (id === runId && run?.state === "READY" && ++readyReads === 2) {
        queueMicrotask(() => {
          const request = { runId, commandId: asCommandId(`command_ready_${control}`), idempotencyKey: `ready:${control}`, expectedStateVersion: run.stateVersion };
          operation = control === "pause" ? stack.coordinator.pause(request) : stack.coordinator.cancel({ ...request, reason: "claim before a new executor dispatch" });
          void operation.catch(() => undefined);
          claimed.resolve();
        });
      }
      return run;
    };
    const reservation = startDrive(stack, runId);
    try {
      await claimed.promise;
      const first = await Promise.race([
        operation!.then(() => "control"),
        stack.adapter.started.promise.then(() => "executor"),
      ]);
      assert.equal(first, "control", "the earlier control must prevent the new external operation");
      assert.equal(stack.adapter.requests.length, 0);
      const taskId = stack.store.getRunLaunchBinding(runId)!.taskId;
      assert.equal(stack.store.countTaskAttempts(runId, taskId), 0, "even PREPARED must wait for control ownership");
      assert.equal(stack.store.getRun(runId)?.activeAttemptId, null);
      assert.equal(stack.adapter.cancelCalls, 0);
      if (control === "pause") {
        const paused = stack.store.getRun(runId)!;
        assert.equal(paused.state, "PAUSED");
        assert.equal(paused.pauseContract?.resumeTarget, "READY");
        assert.equal(stack.coordinator.activeRunId, runId);
        assert.throws(() => stack.coordinator.start({ runId: asRunId("run_ready_competing"), objective: "Pause owns READY", commandId: asCommandId("command_ready_competing"), idempotencyKey: "ready:competing", expectedStateVersion: 0 }),
          (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT");
        await stack.coordinator.resume({ runId, commandId: asCommandId("command_ready_resume"), idempotencyKey: "ready:resume", expectedStateVersion: paused.stateVersion });
        const handle = await stack.adapter.started.promise;
        assert.equal(stack.adapter.requests.length, 1);
        assert.equal(stack.planningInputs.initial.length, 1, "Resume must continue the existing plan");
        stack.adapter.finish(handle, "succeeded");
        await reservation.drivePromise;
        assert.equal(stack.store.getRun(runId)?.state, "NEXT_PHASE");
      } else {
        await reservation.drivePromise;
        assert.equal(stack.store.getRun(runId)?.state, "CANCELLED");
        assert.equal(stack.coordinator.activeRunId, undefined);
        const api = await client(stack);
        await nextRunStarts(stack, api, "run_after_ready_cancel");
      }
    } finally {
      if (stack.store.getRun(runId)?.state === "PAUSED") {
        await stack.coordinator.cancel({ runId, commandId: asCommandId(`command_ready_cleanup_${control}`), idempotencyKey: `ready:cleanup:${control}`, expectedStateVersion: stack.store.getRun(runId)!.stateVersion, reason: "settle the regression fixture" });
      } else if (stack.adapter.requests.length !== 0 && !reservation.driveSettled) {
        stack.adapter.finishNext("cancelled");
      }
      await operation?.catch(() => undefined);
      if (stack.store.getRun(runId)?.state === "PAUSED") {
        await stack.coordinator.cancel({ runId, commandId: asCommandId(`command_ready_final_cleanup_${control}`), idempotencyKey: `ready:final-cleanup:${control}`, expectedStateVersion: stack.store.getRun(runId)!.stateVersion, reason: "release a hold reached during fixture cleanup" });
      }
      await reservation.drivePromise;
      await stack.close();
    }
  });
}


for (const control of ["pause", "cancel"] as const) {
  test(`execution dispatch owns preparation and handle persistence before later ${control}`, { timeout: 15_000 }, async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const runId = asRunId(`run_dispatch_first_${control}`);
    const begun = deferred<void>();
    const release = deferred<void>();
    const beginAttempt = stack.core.beginAttempt.bind(stack.core);
    stack.core.beginAttempt = async (...args) => {
      const result = await beginAttempt(...args);
      begun.resolve();
      await release.promise;
      return result;
    };
    const start = stack.adapter.start.bind(stack.adapter);
    stack.adapter.start = request => {
      const reservation = (stack.coordinator as unknown as { reservation: { executionDispatchClaim?: unknown } }).reservation;
      assert.ok(reservation.executionDispatchClaim, "the external start must belong to the exact dispatch boundary");
      assert.equal(stack.store.getAttempt(request.attemptId)?.lifecycle, "PREPARED");
      return start(request);
    };
    const signal = stack.adapter.cancel.bind(stack.adapter);
    const cancellationOrder: string[] = [];
    const requestCancellation = stack.core.requestRealCancellation.bind(stack.core);
    stack.core.requestRealCancellation = (...args) => {
      const result = requestCancellation(...args);
      cancellationOrder.push(stack.store.getCancellationIntent(stack.store.getRun(runId)!.activeAttemptId!)!.status);
      return result;
    };
    stack.adapter.cancel = (handle, reason) => {
      cancellationOrder.push(stack.store.getCancellationIntent(handle.attemptId)!.status);
      return signal(handle, reason);
    };
    const reservation = startDrive(stack, runId);
    let unexpected: Promise<unknown> | undefined;
    try {
      await begun.promise;
      const active = stack.store.getRun(runId)!;
      assert.equal(active.state, "EXECUTE");
      assert.equal(stack.store.getAttempt(active.activeAttemptId!)?.lifecycle, "RUNNING", "dispatch owns persisted provider identity too");
      assert.equal(stack.adapter.requests.length, 1);
      const request = { runId, commandId: asCommandId(`command_dispatch_late_${control}`), idempotencyKey: `dispatch:late:${control}`, expectedStateVersion: active.stateVersion };
      assert.throws(() => {
        unexpected = control === "pause" ? stack.coordinator.pause(request) : stack.coordinator.cancel({ ...request, reason: "cannot overtake dispatch" });
      }, (error: unknown) => error instanceof KerbsFlowError && error.code === "CONTROL_COMMAND_IN_PROGRESS");
      assert.equal(stack.store.getCancellationIntent(active.activeAttemptId!), undefined);
      assert.equal(stack.adapter.cancelCalls, 0);
      release.resolve();
      const handle = await stack.adapter.started.promise;
      const owners = reservation as typeof reservation & { executionDispatchClaim?: unknown };
      assert.equal(owners.executionDispatchClaim, undefined);
      const fresh = { ...request, commandId: asCommandId(`command_dispatch_fresh_${control}`), idempotencyKey: `dispatch:fresh:${control}` };
      if (control === "pause") {
        const paused = stack.coordinator.pause(fresh);
        assert.equal(stack.store.getRun(runId)?.state, "EXECUTE");
        stack.adapter.finish(handle, "succeeded");
        const result = await paused;
        assert.equal(result.to, "PAUSED");
        assert.equal(stack.store.getRun(runId)?.pauseContract?.resumeTarget, "VERIFY_FOCUSED");
        await stack.coordinator.resume({ runId, commandId: asCommandId("command_dispatch_fresh_resume"), idempotencyKey: "dispatch:fresh:resume", expectedStateVersion: result.stateVersion });
        await reservation.drivePromise;
        assert.equal(stack.store.getRun(runId)?.state, "NEXT_PHASE");
      } else {
        const result = await stack.coordinator.cancel({ ...fresh, reason: "Cancel now sees the active executor" });
        await reservation.drivePromise;
        assert.equal(result.to, "CANCELLED");
        assert.deepEqual(cancellationOrder, ["REQUESTED", "SIGNAL_PENDING"]);
        assert.equal(stack.adapter.cancelCalls, 1);
        assert.equal(stack.store.getCancellationIntent(handle.attemptId)?.status, "CANCELLED");
        assert.equal(stack.coordinator.activeRunId, undefined);
      }
      assert.equal(stack.adapter.requests.length, 1);
      assert.equal(owners.executionDispatchClaim, undefined);
    } finally {
      release.resolve();
      if (stack.adapter.requests.length !== 0 && !reservation.driveSettled && stack.store.getRun(runId)?.state === "EXECUTE") stack.adapter.finishNext("cancelled");
      await unexpected?.catch(() => undefined);
      if (stack.store.getRun(runId)?.state === "PAUSED") {
        await stack.coordinator.cancel({ runId, commandId: asCommandId(`command_dispatch_cleanup_${control}`), idempotencyKey: `dispatch:cleanup:${control}`, expectedStateVersion: stack.store.getRun(runId)!.stateVersion, reason: "settle the dispatch fixture" });
      }
      await reservation.drivePromise;
      await stack.close();
    }
  });
}

for (const key of ["different", "same"] as const) {
  test(`pending cancellation owns its command ID against ${key}-key Steer`, { timeout: 15_000 }, async () => {
    const stack = createPhase6CStack();
    const runId = asRunId(`run_pending_cancel_id_${key}`);
    const reconciling = deferred<void>();
    const release = deferred<void>();
    const duplicateEntered = deferred<void>();
    const reconcile = stack.adapter.reconcile.bind(stack.adapter);
    stack.adapter.reconcile = async (identity) => { reconciling.resolve(); await release.promise; return reconcile(identity); };
    const cancel = stack.coordinator.cancel.bind(stack.coordinator);
    let cancelCalls = 0;
    stack.coordinator.cancel = (request) => {
      const operation = cancel(request);
      if (++cancelCalls === 2) duplicateEntered.resolve();
      return operation;
    };
    let pending: Promise<unknown> | undefined;
    let duplicate: Promise<unknown> | undefined;
    let freshApi: LocalApiServer | undefined;
    const reservation = startDrive(stack, runId);
    try {
      const api = await client(stack);
      const handle = await stack.adapter.started.promise;
      const version = stack.store.getRun(runId)!.stateVersion;
      const identity = { commandId: `command_cancel_owned_${key}`, idempotencyKey: `cancel:owned:${key}` };
      const reason = "cancel with the exact owned identity";
      pending = api.post(`/v1/runs/${runId}/cancel`, version, { reason }, identity);
      await reconciling.promise;
      assert.equal(stack.adapter.cancelCalls, 1);
      assert.equal(stack.store.getCancellationIntent(handle.attemptId)?.status, "SIGNALLED");
      const before = { run: stack.store.getRun(runId), attempt: stack.store.getAttempt(handle.attemptId), intent: stack.store.getCancellationIntent(handle.attemptId), transitions: stack.store.listTransitions(runId) };
      const stolenIdentity = { ...identity, idempotencyKey: key === "same" ? identity.idempotencyKey : "steer:stolen" };
      const rejected = await api.post(`/v1/runs/${runId}/steer`, version, { text: "bounded instruction must not steal Cancel" }, stolenIdentity);
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error?.code, "COMMAND_ID_CONFLICT");
      assert.equal(stack.store.getPendingSteerInstruction(runId), undefined);
      assert.equal(stack.store.getCommandIdempotencyKey(asCommandId(identity.commandId)), undefined);
      assert.deepEqual({ run: stack.store.getRun(runId), attempt: stack.store.getAttempt(handle.attemptId), intent: stack.store.getCancellationIntent(handle.attemptId), transitions: stack.store.listTransitions(runId) }, before);

      if (key === "different") {
        freshApi = new LocalApiServer({ core: stack.core, coordinator: stack.coordinator, store: stack.store, artifacts: stack.artifacts });
        const fresh = await client({ ...stack, api: freshApi });
        const durableConflict = await fresh.post(`/v1/runs/${runId}/steer`, version, { text: "a fresh API has no local pending owner" }, stolenIdentity);
        assert.equal(durableConflict.status, 409);
        assert.equal(durableConflict.body.error?.code, "COMMAND_ID_CONFLICT");
        duplicate = api.post(`/v1/runs/${runId}/cancel`, version, { reason }, identity);
        await duplicateEntered.promise;
      }
      release.resolve();
      const result = await pending as Awaited<ReturnType<typeof api.post>>;
      assert.equal(result.status, 200);
      assert.equal(result.body.to, "CANCELLED");
      if (duplicate !== undefined) assert.deepEqual(await duplicate, result);
      await reservation.drivePromise;
      assert.equal(stack.store.getRun(runId)?.state, "CANCELLED");
      assert.equal(stack.store.getCancellationIntent(handle.attemptId)?.status, "CANCELLED");
      assert.equal(stack.store.getAttempt(handle.attemptId)?.lifecycle, "CANCELLED");
      assert.equal(stack.adapter.cancelCalls, 1);
      assert.equal(stack.coordinator.activeRunId, undefined);
      const replay = await api.post(`/v1/runs/${runId}/cancel`, version, { reason }, identity);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.to, "CANCELLED");
      assert.equal(replay.body.replayed, true);
      assert.equal(stack.adapter.cancelCalls, 1);
    } finally {
      release.resolve();
      await pending;
      await duplicate;
      await reservation.drivePromise;
      await freshApi?.close();
      await stack.close();
    }
  });
}

test("pending Pause command ID excludes Steer before any durable Pause receipt", { timeout: 15_000 }, async () => {
  const stack = createPhase6CStack();
  const runId = asRunId("run_pending_pause_id");
  const entered = deferred<void>();
  const pause = stack.coordinator.pause.bind(stack.coordinator);
  stack.coordinator.pause = request => { const result = pause(request); entered.resolve(); return result; };
  const reservation = startDrive(stack, runId);
  let pending: ReturnType<Awaited<ReturnType<typeof client>>["post"]> | undefined;
  try {
    const api = await client(stack);
    const handle = await stack.adapter.started.promise;
    const version = stack.store.getRun(runId)!.stateVersion;
    const identity = { commandId: "command_pending_pause", idempotencyKey: "pending:pause" };
    pending = api.post(`/v1/runs/${runId}/pause`, version, {}, identity);
    await entered.promise;
    assert.equal(stack.store.getCommandIdempotencyKey(asCommandId(identity.commandId)), undefined);
    const rejected = await api.post(`/v1/runs/${runId}/steer`, version, { text: "cannot steal a pending Pause" }, { ...identity, idempotencyKey: "pending:pause:steer" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error?.code, "COMMAND_ID_CONFLICT");
    assert.equal(stack.store.getPendingSteerInstruction(runId), undefined);
    assert.equal(stack.store.getRun(runId)?.state, "EXECUTE");
    stack.adapter.finish(handle, "succeeded");
    assert.equal((await pending).body.to, "PAUSED");
    await stack.coordinator.cancel({ runId, commandId: asCommandId("command_pending_pause_cleanup"), idempotencyKey: "pending:pause:cleanup", expectedStateVersion: stack.store.getRun(runId)!.stateVersion, reason: "settle the paused fixture" });
    await reservation.drivePromise;
    assert.equal(stack.coordinator.activeRunId, undefined);
  } finally {
    if (stack.store.getRun(runId)?.state === "EXECUTE") stack.adapter.finishNext("cancelled");
    await pending?.catch(() => undefined);
    await reservation.drivePromise;
    await stack.close();
  }
});


test("pre-intent filesystem denial durably fails setup and releases the next Start", async () => {
  const stack = createPhase6CStack({ phaseCheck: true });
  const runId = asRunId("run_setup_os_failure");
  const owned = join(stack.root, "runtime", "owned");
  try {
    chmodSync(owned, 0o500);
    const api = await client(stack);
    const start = await api.post("/v1/runs", 0, { runId, objective: "handle a real pre-intent filesystem denial" });
    assert.equal(start.status, 200);
    assert.equal(start.body.to, "INTAKE");
    await waitFor(() => stack.store.getRun(runId)?.state === "FAILED" ? true : undefined, "durable setup failure");
    const snapshot = await api.snapshot(runId);
    assert.equal(snapshot.run.state, "FAILED");
    assert.equal(stack.store.listTransitions(runId).at(-1)?.reasonCode, "worktree_setup_failed");
    assert.equal(snapshot.currentTask, null);
    assert.equal(snapshot.currentGate, null);
    assert.equal(stack.planningInputs.initial.length, 0);
    assert.equal(stack.adapter.requests.length, 0);
    assert.equal(stack.store.getWorktree(runId), undefined);
    assert.equal(existsSync(join(owned, "worktree-records", `${runId}.json`)), false);
    chmodSync(owned, 0o700);
    await nextRunStarts(stack, api, "run_after_setup_os_failure");
  } finally {
    chmodSync(owned, 0o700);
    await stack.close();
  }
});

test("initial planner rejection fails durably without consuming Steer or exposing diagnostics", async () => {
  const stack = createPhase6CStack({ phaseCheck: true });
  const runId = asRunId("run_initial_planner_failure");
  const started = deferred<void>();
  const release = deferred<void>();
  const planInitial = stack.planningMaster.planInitial.bind(stack.planningMaster);
  const diagnostic = "synthetic provider failure at /private/qa/provider with secret diagnostic contents";
  let failedCalls = 0;
  stack.planningMaster.planInitial = async (input) => {
    if (input.runId !== runId) return planInitial(input);
    failedCalls += 1;
    started.resolve();
    await release.promise;
    throw new Error(diagnostic);
  };
  try {
    const api = await client(stack);
    assert.equal((await api.post("/v1/runs", 0, { runId, objective: "report the initial planning failure truthfully" })).status, 200);
    await started.promise;
    const before = stack.store.getRun(runId)!;
    const worktree = stack.store.getWorktree(runId)!;
    const marker = readFileSync(worktree.markerPath, "utf8");
    assert.equal((await api.post(`/v1/runs/${runId}/steer`, before.stateVersion, { text: "Keep the pending instruction bounded" })).status, 200);
    const steer = stack.store.getPendingSteerInstruction(runId);
    assert.ok(steer);
    release.resolve();
    await waitFor(() => stack.store.getRun(runId)?.state === "FAILED" ? true : undefined, "durable initial planner failure");
    const snapshot = await api.snapshot(runId);
    assert.equal(snapshot.run.state, "FAILED");
    assert.equal(snapshot.currentTask, null);
    assert.equal(snapshot.currentGate, null);
    assert.equal(stack.store.listTransitions(runId).at(-1)?.reasonCode, "initial_planning_failed");
    assert.equal(failedCalls, 1, "an unavailable provider is not automatically retried");
    assert.equal(stack.adapter.requests.length, 0);
    assert.deepEqual(stack.store.getWorktree(runId), worktree);
    assert.equal(readFileSync(worktree.markerPath, "utf8"), marker);
    assert.deepEqual(stack.store.getPendingSteerInstruction(runId), steer);
    assert.equal(JSON.stringify(snapshot).includes(diagnostic), false);
    assert.equal(JSON.stringify(stack.store.listTransitions(runId)).includes(diagnostic), false);
    await nextRunStarts(stack, api, "run_after_initial_planner_failure");
  } finally {
    release.resolve();
    await stack.close();
  }
});

for (const control of ["pause", "cancel"] as const) {
  test(`initial planning failure respects a claimed ${control} boundary`, async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const runId = asRunId(`run_planning_failure_${control}`);
    const started = deferred<void>();
    const release = deferred<void>();
    const planInitial = stack.planningMaster.planInitial.bind(stack.planningMaster);
    stack.planningMaster.planInitial = async (input) => {
      if (input.runId !== runId) return planInitial(input);
      started.resolve();
      await release.promise;
      throw new Error("synthetic provider failure after a control claim");
    };
    let response: ReturnType<Awaited<ReturnType<typeof client>>["post"]> | undefined;
    try {
      const api = await client(stack);
      assert.equal((await api.post("/v1/runs", 0, { runId, objective: "preserve control ownership during planning failure" })).status, 200);
      await started.promise;
      const run = stack.store.getRun(runId)!;
      response = api.post(`/v1/runs/${runId}/${control}`, run.stateVersion, control === "cancel" ? { reason: "cancel the failed planning operation" } : {});
      const reservation = (stack.coordinator as unknown as { reservation?: { pauseClaim?: unknown; cancelClaim?: unknown } }).reservation;
      await waitFor(() => reservation?.[control === "pause" ? "pauseClaim" : "cancelClaim"] !== undefined ? true : undefined, "control claims the live boundary");
      assert.equal(stack.store.getRun(runId)?.state, "PLAN", "Pause cannot succeed while the planner is pending");
      assert.equal(stack.coordinator.activeRunId, runId);
      const competing = await api.post("/v1/runs", 0, { runId: `run_planning_competing_${control}`, objective: "pending control owns the slot" });
      assert.equal(competing.status, 409);
      assert.equal(competing.body.error?.code, "ACTIVE_RUN_CONFLICT");
      release.resolve();
      const result = await response;
      assert.equal(result.status, 200);
      if (control === "pause") {
        assert.equal(result.body.to, "PAUSED");
        const paused = stack.store.getRun(runId)!;
        assert.equal(paused.pauseContract?.resumeTarget, "PLAN");
        assert.equal(stack.store.listTransitions(runId).some((transition) => transition.to === "FAILED"), false);
        assert.equal(stack.coordinator.activeRunId, runId);
        assert.equal((await api.post("/v1/runs", 0, { runId: `run_paused_competing_${control}`, objective: "Pause retains ownership" })).status, 409);
        assert.equal((await api.post(`/v1/runs/${runId}/resume`, paused.stateVersion, {})).status, 200);
        await waitFor(() => stack.store.getRun(runId)?.state === "FAILED" ? true : undefined, "failed planning disposition after Resume");
      } else {
        assert.equal(result.body.to, "CANCELLED");
        assert.equal(stack.store.getRun(runId)?.state, "CANCELLED");
        assert.equal(stack.store.listTransitions(runId).some((transition) => transition.to === "FAILED"), false);
      }
      assert.equal(stack.adapter.requests.length, 0);
      assert.equal(stack.coordinator.activeRunId, undefined);
      await nextRunStarts(stack, api, `run_after_planning_control_${control}`);
    } finally {
      release.resolve();
      await response;
      await stack.close();
    }
  });
}

for (const control of ["pause", "cancel"] as const) {
  test(`real pre-intent EACCES waits for the claimed ${control} boundary`, async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const runId = asRunId(`run_setup_failure_${control}`);
    const owned = join(stack.root, "runtime", "owned");
    const claimed = deferred<void>();
    const driveStarted = stack.phase2.driveStarted.bind(stack.phase2);
    let checkpoints = 0;
    let operation: Promise<unknown> | undefined;
    stack.phase2.driveStarted = (request, controls) => driveStarted(request, { ...controls, checkpoint: async () => {
      const version = await controls?.checkpoint?.();
      if (++checkpoints === 3) queueMicrotask(() => {
        const run = stack.store.getRun(runId)!;
        const command = { runId, commandId: asCommandId(`command_setup_${control}`), idempotencyKey: `setup:${control}`, expectedStateVersion: run.stateVersion };
        operation = control === "pause" ? stack.coordinator.pause(command) : stack.coordinator.cancel({ ...command, reason: "cancel before setup failure disposition" });
        claimed.resolve();
      });
      return version;
    } });
    try {
      chmodSync(owned, 0o500);
      const api = await client(stack);
      const reservation = startDrive(stack, runId);
      await claimed.promise;
      await operation;
      assert.equal(stack.adapter.requests.length, 0);
      assert.equal(stack.planningInputs.initial.length, 0);
      assert.equal(stack.store.getWorktree(runId), undefined);
      assert.equal(existsSync(join(owned, "worktree-records", `${runId}.json`)), false);
      assert.equal(stack.store.listTransitions(runId).some(t => t.to === "FAILED" || t.to === "HUMAN_GATE"), false);
      if (control === "pause") {
        const paused = stack.store.getRun(runId)!;
        assert.equal(paused.state, "PAUSED");
        assert.equal(paused.pauseContract?.resumeTarget, "PLAN");
        assert.equal(reservation.driveSettled, false);
        assert.equal(stack.coordinator.activeRunId, runId);
        const competing = await api.post("/v1/runs", 0, { runId: "run_setup_paused_competing", objective: "Pause owns the slot" });
        assert.equal(competing.status, 409);
        assert.equal(competing.body.error?.code, "ACTIVE_RUN_CONFLICT");
        assert.equal((await api.post(`/v1/runs/${runId}/resume`, paused.stateVersion, {})).status, 200);
        await reservation.drivePromise;
        assert.equal(stack.store.getRun(runId)?.state, "FAILED");
        assert.equal(stack.store.listTransitions(runId).at(-1)?.reasonCode, "worktree_setup_failed");
      } else {
        await reservation.drivePromise;
        assert.equal(stack.store.getRun(runId)?.state, "CANCELLED");
        assert.ok(reservation.driveError instanceof Phase2DriveControlStop);
      }
      chmodSync(owned, 0o700);
      await nextRunStarts(stack, api, `run_after_setup_control_${control}`);
    } finally {
      chmodSync(owned, 0o700);
      const current = stack.store.getRun(runId);
      if (current?.state === "PAUSED") await stack.coordinator.cancel({ runId, commandId: asCommandId(`command_cleanup_${control}`), idempotencyKey: `cleanup:${control}`, expectedStateVersion: current.stateVersion, reason: "end the synthetic test" });
      await operation?.catch(() => undefined);
      await stack.close();
    }
  });
}

for (const boundary of ["setup", "planner"] as const) {
  for (const control of ["pause", "cancel"] as const) {
    test(`${boundary} failure yields to late ${control} after a free checkpoint`, { timeout: 15_000 }, async () => {
      const stack = createPhase6CStack({ phaseCheck: true });
      const runId = asRunId(`run_late_${boundary}_${control}`);
      const owned = join(stack.root, "runtime", "owned");
      const manager = (stack.phase2 as unknown as { git: GitWorktreeManager }).git;
      const original = manager.snapshot(stack.repository.root);
      const planInitial = stack.planningMaster.planInitial.bind(stack.planningMaster);
      const claimed = deferred<void>();
      const coordinator = stack.coordinator as unknown as { checkpoint(reservation: unknown): Promise<number> };
      const checkpoint = coordinator.checkpoint.bind(coordinator);
      let checkpoints = 0;
      let operation: Promise<unknown> | undefined;
      let filesystemCode: string | undefined;
      if (boundary === "setup") {
        const create = manager.create.bind(manager);
        manager.create = (...args) => {
          try {
            return create(...args);
          } catch (error) {
            filesystemCode = (error as NodeJS.ErrnoException).code;
            throw error;
          }
        };
      } else {
        stack.planningMaster.planInitial = () => { throw new Error("synthetic late planner failure at /private/test/provider"); };
      }
      coordinator.checkpoint = async (reservation) => {
        const version = await checkpoint(reservation);
        if (++checkpoints === (boundary === "setup" ? 4 : 6)) {
          assert.equal(stack.store.getRun(runId)?.state, "PLAN");
          assert.equal(version, 2);
          queueMicrotask(() => {
            const command = { runId, commandId: asCommandId(`command_late_${boundary}_${control}`), idempotencyKey: `late:${boundary}:${control}`, expectedStateVersion: version };
            operation = control === "pause" ? stack.coordinator.pause(command) : stack.coordinator.cancel({ ...command, reason: "late cancellation owns the failure boundary" });
            void operation.catch(() => undefined);
            assert.equal(stack.coordinator.activeRunId, runId);
            assert.throws(() => stack.coordinator.start({ runId: asRunId(`run_late_competing_${boundary}_${control}`), objective: "the pending control owns the reservation", commandId: asCommandId(`command_late_competing_${boundary}_${control}`), idempotencyKey: `late:competing:${boundary}:${control}`, expectedStateVersion: 0 }),
              (error: unknown) => error instanceof KerbsFlowError && error.code === "ACTIVE_RUN_CONFLICT");
            claimed.resolve();
          });
        }
        return version;
      };
      try {
        if (boundary === "setup") chmodSync(owned, 0o500);
        const api = await client(stack);
        const reservation = startDrive(stack, runId);
        await claimed.promise;
        await operation;
        assert.equal(stack.store.listTransitions(runId).some(t => t.to === "FAILED"), false);
        if (control === "pause") {
          const paused = stack.store.getRun(runId)!;
          assert.equal(paused.state, "PAUSED");
          assert.equal(paused.stateVersion, 3);
          assert.equal(paused.pauseContract?.resumeTarget, "PLAN");
          assert.equal(reservation.driveSettled, false);
          assert.equal(stack.coordinator.activeRunId, runId);
          const competing = await api.post("/v1/runs", 0, { runId: `run_late_paused_competing_${boundary}`, objective: "the paused drive owns the reservation" });
          assert.equal(competing.status, 409);
          assert.equal(competing.body.error?.code, "ACTIVE_RUN_CONFLICT");
          assert.equal((await api.post(`/v1/runs/${runId}/resume`, 3, {})).status, 200);
        }
        await reservation.drivePromise;
        const run = stack.store.getRun(runId)!;
        assert.equal(run.state, control === "pause" ? "FAILED" : "CANCELLED");
        assert.equal(run.stateVersion, control === "pause" ? 5 : 3);
        assert.equal(stack.store.listTransitions(runId).filter(t => t.to === "FAILED" || t.to === "CANCELLED").length, 1);
        assert.equal(stack.adapter.requests.length, 0);
        if (boundary === "setup") {
          assert.equal(filesystemCode, "EACCES");
          assert.equal(stack.planningInputs.initial.length, 0);
          assert.equal(stack.store.getWorktree(runId), undefined);
          assert.equal(existsSync(join(owned, "worktree-records", `${runId}.json`)), false);
        } else {
          const worktree = stack.store.getWorktree(runId)!;
          assert.ok(existsSync(worktree.worktreePath));
          assert.equal(JSON.parse(readFileSync(worktree.markerPath, "utf8")).schemaVersion, "kerbsflow.worktree/v1");
        }
        assert.deepEqual(manager.snapshot(stack.repository.root), original);
        chmodSync(owned, 0o700);
        stack.planningMaster.planInitial = planInitial;
        await nextRunStarts(stack, api, `run_after_late_${boundary}_${control}`);
      } finally {
        chmodSync(owned, 0o700);
        const run = stack.store.getRun(runId);
        if (run?.state === "PAUSED") await stack.coordinator.cancel({ runId, commandId: asCommandId(`command_cleanup_late_${boundary}_${control}`), idempotencyKey: `cleanup:late:${boundary}:${control}`, expectedStateVersion: run.stateVersion, reason: "end the synthetic test" });
        await operation?.catch(() => undefined);
        await stack.close();
      }
    });
  }
}

for (const resumeBeforeCancel of [false, true]) {
  test(`Cancel retires a ${resumeBeforeCancel ? "resuming" : "paused"} failure-disposition boundary`, { timeout: 10_000 }, async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const runId = asRunId("run_paused_disposition_cancel");
    const started = deferred<void>();
    const release = deferred<void>();
    const planInitial = stack.planningMaster.planInitial.bind(stack.planningMaster);
    stack.planningMaster.planInitial = async (input) => {
      if (input.runId !== runId) return planInitial(input);
      started.resolve();
      await release.promise;
      throw new Error("synthetic pending planning failure");
    };
    try {
      const api = await client(stack);
      const reservation = startDrive(stack, runId);
      await started.promise;
      const pause = stack.coordinator.pause({ runId, commandId: asCommandId("command_disposition_pause"), idempotencyKey: "disposition:pause", expectedStateVersion: 2 });
      release.resolve();
      await pause;
      assert.equal(stack.store.getRun(runId)?.state, "PAUSED");
      assert.equal(stack.store.getRun(runId)?.stateVersion, 3);
      assert.equal(reservation.failureDispositionClaim, undefined);
      assert.equal(stack.coordinator.activeRunId, runId);
      if (resumeBeforeCancel) {
        const resumeRequest = { runId, commandId: asCommandId("command_disposition_resume"), idempotencyKey: "disposition:resume", expectedStateVersion: 3 };
        const resume = stack.coordinator.resume(resumeRequest);
        const rejected = assert.rejects(resume, (error: unknown) => error instanceof KerbsFlowError && error.code === "CANCEL_ALREADY_CLAIMED");
        assert.equal(stack.store.getRun(runId)?.state, "PAUSED");
        assert.equal(stack.store.getCommandIdempotencyKey(resumeRequest.commandId), undefined);
        await stack.coordinator.cancel({ runId, commandId: asCommandId("command_disposition_cancel"), idempotencyKey: "disposition:cancel", expectedStateVersion: 3, reason: "cancel before the resumed failure disposition" });
        await rejected;
        assert.equal(stack.store.getCommandIdempotencyKey(resumeRequest.commandId), undefined);
        await assert.rejects(stack.coordinator.resume(resumeRequest), (error: unknown) => error instanceof KerbsFlowError && error.code === "RUN_NOT_OWNED");
      } else {
        assert.equal((await api.post(`/v1/runs/${runId}/cancel`, 3, { reason: "cancel the paused pending failure" })).status, 200);
      }
      await reservation.drivePromise;
      assert.equal(stack.store.getRun(runId)?.state, "CANCELLED");
      assert.equal(stack.store.getRun(runId)?.stateVersion, 4);
      assert.equal(stack.store.listTransitions(runId).some(t => t.reasonCode === "resume_persisted_target"), false);
      assert.ok(reservation.driveError instanceof Phase2DriveControlStop);
      assert.equal(stack.store.listTransitions(runId).some(t => t.to === "FAILED"), false);
      assert.equal(reservation.pauseClaim, undefined);
      assert.equal(reservation.failureDispositionClaim, undefined);
      assert.equal(stack.adapter.requests.length, 0);
      await nextRunStarts(stack, api, "run_after_paused_disposition_cancel");
    } finally {
      release.resolve();
      await stack.close();
    }
  });
}

const classificationCases = [
  { name: "control", error: new Phase2DriveControlStop(), state: "PLAN", reason: undefined },
  { name: "integrity", error: new DatabaseIntegrityError("synthetic integrity diagnostic"), state: "PLAN", reason: undefined },
  { name: "version", error: new StateVersionConflictError("run_synthetic", 2, 3), state: "PLAN", reason: undefined },
  { name: "internal", error: new TypeError("synthetic internal diagnostic at /private/test"), state: "FAILED", reason: "initial_planning_internal_error" },
  { name: "canonical", error: new KerbsFlowError("CANONICAL_INTENT_DRIFT", "synthetic canonical diagnostic"), state: "HUMAN_GATE", reason: "initial_planning_trust_violation" },
  { name: "security", error: new KerbsFlowError("STEER_SECRET_REJECTED", "synthetic secret diagnostic"), state: "HUMAN_GATE", reason: "initial_planning_trust_violation" },
  { name: "unknown", error: { message: "synthetic unknown object diagnostic" }, state: "PLAN", reason: undefined },
] as const;

for (const entry of classificationCases) {
  test(`initial planner ${entry.name} failure preserves its authority category`, async () => {
    const stack = createPhase6CStack();
    const runId = asRunId(`run_classification_${entry.name}`);
    stack.planningMaster.planInitial = () => { throw entry.error; };
    if (entry.state === "HUMAN_GATE") {
      const gateFailure = stack.core.gateInitialPlanningTrustFailure.bind(stack.core);
      stack.core.gateInitialPlanningTrustFailure = (...args) => {
        const result = gateFailure(...args);
        const gate = stack.core.readModel(runId)!.currentGate!;
        const reservation = (stack.coordinator as unknown as { reservation: { failureDispositionClaim?: unknown } }).reservation;
        assert.ok(reservation.failureDispositionClaim);
        assert.throws(() => stack.coordinator.resolveGate({ runId, gateId: gate.gateId, optionId: "fail", commandId: asCommandId(`command_gate_during_failure_${entry.name}`), idempotencyKey: `gate:during:failure:${entry.name}`, expectedStateVersion: result.stateVersion }),
          (error: unknown) => error instanceof KerbsFlowError && error.code === "CONTROL_COMMAND_IN_PROGRESS");
        assert.equal(stack.store.getRun(runId)?.state, "HUMAN_GATE");
        return result;
      };
    }
    try {
      const api = await client(stack);
      const reservation = startDrive(stack, runId);
      await reservation.drivePromise;
      assert.equal(reservation.failureDispositionClaim, undefined);
      const run = stack.store.getRun(runId)!;
      const transitions = stack.store.listTransitions(runId);
      assert.equal(run.state, entry.state);
      assert.equal(transitions.some(t => t.reasonCode === "initial_planning_failed"), false);
      assert.equal(stack.adapter.requests.length, 0);
      assert.ok(stack.store.getWorktree(runId));
      if (entry.reason === undefined) {
        assert.strictEqual(reservation.driveError, entry.error);
        assert.deepEqual(transitions.map(t => t.to), ["INTAKE", "PLAN"]);
        assert.equal(stack.coordinator.activeRunId, runId);
        const competing = await api.post("/v1/runs", 0, { runId: `run_class_competing_${entry.name}`, objective: "fail-closed retains ownership" });
        assert.equal(competing.status, 409);
        assert.equal(competing.body.error?.code, "ACTIVE_RUN_CONFLICT");
      } else {
        assert.equal(transitions.at(-1)?.reasonCode, entry.reason);
        const snapshot = await api.snapshot(runId);
        if (entry.error instanceof Error) {
          assert.equal(JSON.stringify(snapshot).includes(entry.error.message), false);
          assert.equal(JSON.stringify(transitions).includes(entry.error.message), false);
        }
        if (entry.state === "HUMAN_GATE") {
          const gate = stack.core.readModel(runId)!.currentGate!;
          assert.deepEqual(gate.gate.options.map(o => [o.id, o.target]), [["fail", "FAILED"], ["cancel", "CANCELLED"]]);
          assert.equal(stack.coordinator.activeRunId, runId);
          const resolved = await api.post(`/v1/runs/${runId}/gates/${gate.gateId}/resolve`, run.stateVersion, { optionId: entry.name === "canonical" ? "fail" : "cancel" });
          assert.equal(resolved.status, 200);
        }
        assert.equal(stack.coordinator.activeRunId, undefined);
      }
    } finally {
      await stack.close();
    }
  });
}

for (const boundary of ["result", "identity", "routing", "core"] as const) {
  test(`successful planner leaves ${boundary} validation errors outside invocation handling`, async () => {
    const stack = createPhase6CStack();
    const runId = asRunId(`run_after_plan_${boundary}`);
    const planInitial = stack.planningMaster.planInitial.bind(stack.planningMaster);
    stack.planningMaster.planInitial = async input => {
      const result = await planInitial(input);
      switch (boundary) {
        case "result": return {} as PlanningMasterResult;
        case "identity": return { decision: { ...result.decision, runId: asRunId("run_wrong_identity") } };
        case "routing": return { decision: { ...result.decision, policyVersion: PHASE4_ROUTING_POLICY } };
        case "core": return { decision: { ...result.decision, route: { adapter: "opencode", model: "synthetic" } } };
      }
    };
    const expected = { result: "PLANNING_MASTER_RESULT_INVALID", identity: "COMMAND_SCOPE_MISMATCH", routing: "ROUTING_AUTHORITY_REQUIRED", core: "ROUTE_NOT_ALLOWED" };
    try {
      const reservation = startDrive(stack, runId);
      await reservation.drivePromise;
      assert.ok(reservation.driveError instanceof KerbsFlowError);
      assert.equal(reservation.driveError.code, expected[boundary]);
      assert.deepEqual(stack.store.listTransitions(runId).map(t => t.to), ["INTAKE", "PLAN"]);
      assert.equal(stack.coordinator.activeRunId, runId);
      assert.equal(stack.adapter.requests.length, 0);
    } finally {
      await stack.close();
    }
  });
}

for (const boundary of ["setup", "planner"] as const) {
  for (const errorBoundary of ["checkpoint", "core"] as const) {
    test(`${boundary} failure cannot absorb an error from its disposition ${errorBoundary}`, async () => {
      const stack = createPhase6CStack();
      const runId = asRunId(`run_checkpoint_error_${boundary}`);
      const error = new StateVersionConflictError(runId, 2, 3);
      const coordinator = stack.coordinator as unknown as { checkpoint(reservation: unknown): Promise<number> };
      const checkpoint = coordinator.checkpoint.bind(coordinator);
      const owned = join(stack.root, "runtime", "owned");
      let checkpoints = 0;
      if (boundary === "planner") stack.planningMaster.planInitial = () => { throw new Error("synthetic invocation failure"); };
      if (errorBoundary === "checkpoint") {
        coordinator.checkpoint = async (reservation) => {
          const version = await checkpoint(reservation);
          if (++checkpoints === (boundary === "setup" ? 4 : 6)) throw error;
          return version;
        };
      } else {
        const fail = () => {
          const reservation = (stack.coordinator as unknown as { reservation: { failureDispositionClaim?: unknown } }).reservation;
          assert.ok(reservation.failureDispositionClaim, "Core runs while the disposition owns the boundary");
          throw error;
        };
        if (boundary === "setup") stack.core.failPlanWorktreeSetup = fail;
        else stack.core.failInitialPlanning = fail;
      }
      try {
        if (boundary === "setup") chmodSync(owned, 0o500);
        const reservation = startDrive(stack, runId);
        await reservation.drivePromise;
        assert.strictEqual(reservation.driveError, error);
        assert.equal(reservation.failureDispositionClaim, undefined);
        assert.equal(stack.store.getRun(runId)?.state, "PLAN");
        assert.equal(stack.coordinator.activeRunId, runId);
        assert.equal(stack.store.listTransitions(runId).some(t => t.to === "FAILED" || t.to === "HUMAN_GATE"), false);
      } finally {
        chmodSync(owned, 0o700);
        await stack.close();
      }
    });
  }
}

test("unexpected setup programmer error propagates without claiming ordinary OS failure", async () => {
  const stack = createPhase6CStack();
  const runId = asRunId("run_setup_internal");
  const error = new TypeError("synthetic setup invariant bug");
  const manager = (stack.phase2 as unknown as { git: GitWorktreeManager }).git;
  manager.create = () => { throw error; };
  try {
    const reservation = startDrive(stack, runId);
    await reservation.drivePromise;
    assert.strictEqual(reservation.driveError, error);
    assert.deepEqual(stack.store.listTransitions(runId).map(t => t.to), ["INTAKE", "PLAN"]);
    assert.equal(stack.coordinator.activeRunId, runId);
    assert.equal(stack.store.getWorktree(runId), undefined);
    assert.equal(stack.adapter.requests.length, 0);
  } finally {
    await stack.close();
  }
});
