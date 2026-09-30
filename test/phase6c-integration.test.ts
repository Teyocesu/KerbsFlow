import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { asCommandId, asGateId, asInstructionId, asRunId, asTaskId, type RunId } from "../src/contracts.js";
import { createPhase2PlanningDecision } from "../src/planning.js";
import { createPhase6CStack, waitFor } from "./phase6c-harness.js";

interface HttpResponse {
  status: number;
  body: string;
}

interface Snapshot {
  run: { runId: string; state: string; stateVersion: number; pauseContract: { resumeTarget: string } | null };
  activeAttempt: { attemptId: string; lifecycle: string } | null;
  currentGate: { gateId: string; status: string; options: Array<{ id: string; target: string }> } | null;
  pendingSteer: Record<string, unknown> | null;
}

test("Phase 6C controls run through LocalApiServer, RunCoordinator, Phase2Loop and durable state", async (suite) => {
  await suite.test("Start ownership, Steer secrecy/consumption, quiescent Pause and persisted Resume target", async () => {
    const stack = createPhase6CStack({ holdFirstInitialPlan: true, phaseCheck: true });
    const runId = asRunId("run_phase6c_pause_steer");
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      const started = await post(stack.api, token, "/v1/runs", envelope("command_6c_start", "idem_6c_start", 0, {
        runId,
        objective: "create the synthetic result",
      }));
      assert.equal(started.status, 200);
      assert.equal(json(started).to, "INTAKE");
      assert.equal(stack.coordinator.activeRunId, runId, "the real coordinator must own the accepted HTTP Start");
      const binding = stack.store.getRunLaunchBinding(runId);
      assert.ok(binding, "Start must persist the trusted host-side launch binding");
      assert.equal(binding.canonicalRepositoryPath, realpathSync(stack.repository.root));
      assert.equal(binding.launchProfileId, "phase6c-synthetic-profile");
      assert.equal(stack.store.getRun("run_phase6c_competing" as typeof runId), undefined);

      const firstPlan = await stack.firstInitialPlanStarted.promise;
      assert.equal(stack.store.getRun(runId)?.state, "PLAN");
      const competing = await post(stack.api, token, "/v1/runs", envelope("command_6c_competing", "idem_6c_competing", 0, {
        runId: "run_phase6c_competing",
        objective: "must not acquire the active slot",
      }));
      assert.equal(competing.status, 409);
      assert.equal(errorCode(competing), "ACTIVE_RUN_CONFLICT");
      assert.equal(stack.store.getRun("run_phase6c_competing" as typeof runId), undefined);

      const beforeSteer = await snapshot(stack.api, token, runId);
      const steerText = "QA cedar instruction: keep this synthetic change narrow";
      const steered = await post(stack.api, token, `/v1/runs/${runId}/steer`, envelope("command_6c_steer", "idem_6c_steer", beforeSteer.run.stateVersion, { text: steerText }));
      assert.equal(steered.status, 200);
      const pending = await snapshot(stack.api, token, runId);
      assert.deepEqual(Object.keys(pending.pendingSteer ?? {}).sort(), ["createdAt", "instructionId", "pending"]);
      assert.equal(JSON.stringify(pending).includes(steerText), false, "raw Steer text must stay out of the snapshot projection");
      assert.equal(firstPlan.steer.text, null, "the first in-flight plan must have observed no Steer");

      stack.releaseFirstInitialPlan.resolve();
      const retriedPlan = await waitFor(() => stack.planningInputs.initial.length >= 2 ? stack.planningInputs.initial[1] : undefined, "stale Planning Master retry");
      assert.equal(retriedPlan.steer.text, steerText, "the retried planning boundary must receive the queued Steer");
      const activeHandle = await stack.adapter.started.promise;
      const active = await snapshot(stack.api, token, runId);
      assert.equal(active.run.state, "EXECUTE");
      assert.equal(active.activeAttempt?.attemptId, activeHandle.attemptId);
      assert.equal(stack.adapter.requests.length, 1);

      let pauseFinished = false;
      const pauseResponsePromise = post(stack.api, token, `/v1/runs/${runId}/pause`, envelope("command_6c_pause", "idem_6c_pause", active.run.stateVersion, {}))
        .then((response) => { pauseFinished = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(pauseFinished, false, "Pause must remain pending while the owned executor is active");
      assert.equal(stack.store.getRun(runId)?.state, "EXECUTE", "the run cannot claim PAUSED before executor quiescence");
      assert.equal(stack.store.getAttempt(activeHandle.attemptId)?.lifecycle, "RUNNING");

      stack.adapter.finish(activeHandle, "succeeded");
      const pausedResponse = await pauseResponsePromise;
      assert.equal(pausedResponse.status, 200);
      assert.equal(json(pausedResponse).to, "PAUSED");
      const paused = await snapshot(stack.api, token, runId);
      assert.equal(paused.run.state, "PAUSED");
      assert.equal(paused.run.pauseContract?.resumeTarget, "VERIFY_FOCUSED");
      assert.equal(stack.store.getRun(runId)?.pauseContract?.resumeTarget, "VERIFY_FOCUSED");

      const stale = await post(stack.api, token, `/v1/runs/${runId}/steer`, envelope("command_6c_stale", "idem_6c_stale", active.run.stateVersion, { text: "stale mutation" }));
      assert.equal(stale.status, 409);
      assert.equal(stack.store.getRun(runId)?.state, "PAUSED", "a stale API mutation cannot create a false transition");
      const repaired = await snapshot(stack.api, token, runId);
      assert.equal(repaired.run.state, "PAUSED");
      assert.equal(repaired.run.stateVersion, paused.run.stateVersion, "the authoritative snapshot supplies the current version");

      const resumed = await post(stack.api, token, `/v1/runs/${runId}/resume`, envelope("command_6c_resume", "idem_6c_resume", paused.run.stateVersion, {}));
      assert.equal(resumed.status, 200);
      assert.equal(json(resumed).to, "VERIFY_FOCUSED");
      await waitFor(() => stack.store.getRun(runId)?.state === "NEXT_PHASE" ? true : undefined, "same Phase2 drive to complete focused and phase verification");
      assert.equal(stack.adapter.requests.length, 1, "resume must continue the existing drive without replaying execution");
      assert.equal((await snapshot(stack.api, token, runId)).pendingSteer, null);
      const instructionId = String(pending.pendingSteer?.instructionId);
      const instruction = stack.store.getSteerInstruction(asInstructionId(instructionId));
      assert.ok(instruction?.consumedAt, "the accepted plan must consume the Steer exactly once");
      assert.equal(stack.store.getSteerInstruction(asInstructionId(instructionId))?.instructionId, instructionId);
      const eventStream = await readSse(stack.api, token, runId, stack.store.listTransitions(runId).length);
      assert.equal(eventStream.includes(steerText), false, "raw Steer text must not appear in the production SSE projection");
      assert.equal((await get(stack.api, token, "/app.js")).status, 200, "LocalApiServer must serve the production UI asset");

      const terminal = await post(stack.api, token, `/v1/runs/${runId}/cancel`, envelope("command_6c_cleanup", "idem_6c_cleanup", (await snapshot(stack.api, token, runId)).run.stateVersion, { reason: "finish synthetic integration fixture" }));
      assert.equal(terminal.status, 200);
      assert.equal(json(terminal).to, "CANCELLED");
    } finally {
      await stack.close();
    }
  });

  await suite.test("persisted human gate rejects stale/unoffered choices and accepts a scoped option", async () => {
    const stack = createPhase6CStack();
    const runId = asRunId("run_phase6c_gate");
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      const started = await post(stack.api, token, "/v1/runs", envelope("command_gate_start", "idem_gate_start", 0, { runId, objective: "reach a synthetic human gate" }));
      assert.equal(started.status, 200);
      const handle = await stack.adapter.started.promise;
      stack.adapter.finish(handle, "blocked");
      await waitFor(() => stack.store.getRun(runId)?.state === "HUMAN_GATE" ? true : undefined, "integrated HUMAN_GATE");
      const gateSnapshot = await snapshot(stack.api, token, runId);
      const gate = gateSnapshot.currentGate;
      assert.ok(gate);
      const transitionsBefore = stack.store.listTransitions(runId).length;

      const invalidOption = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_gate_invalid", "idem_gate_invalid", gateSnapshot.run.stateVersion, { optionId: "not-offered", note: "" }));
      assert.equal(invalidOption.status, 409);
      assert.equal(errorCode(invalidOption), "GATE_OPTION_INVALID");
      assert.equal(stack.store.listTransitions(runId).length, transitionsBefore);

      const staleOption = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_gate_stale", "idem_gate_stale", gateSnapshot.run.stateVersion - 1, { optionId: "cancel", note: "stale" }));
      assert.equal(staleOption.status, 409);
      assert.equal(stack.store.getRun(runId)?.state, "HUMAN_GATE");
      assert.equal((await snapshot(stack.api, token, runId)).currentGate?.gateId, gate.gateId, "snapshot repair retains the authoritative open gate");

      assert.ok(gate.options.some((option) => option.id === "cancel" && option.target === "CANCELLED"));
      const resolved = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_gate_resolve", "idem_gate_resolve", gateSnapshot.run.stateVersion, { optionId: "cancel", note: "QA chose the explicit cancel option" }));
      assert.equal(resolved.status, 200);
      assert.equal(json(resolved).to, "CANCELLED");
      const repaired = await snapshot(stack.api, token, runId);
      assert.equal(repaired.run.state, "CANCELLED");
      assert.equal(repaired.currentGate, null);
      const stored = stack.store.getGate(asGateId(gate.gateId));
      assert.equal(stored?.status, "rejected");
      assert.equal(stored?.gate.resolution?.note, "QA chose the explicit cancel option");
    } finally {
      await stack.close();
    }
  });

  await suite.test("missing trusted phase validation offers only executable terminal choices over authenticated HTTP", async () => {
    for (const target of ["FAILED", "CANCELLED"] as const) {
      const stack = createPhase6CStack();
      const runId = asRunId(`run_phase6c_missing_phase_${target.toLowerCase()}`);
      const nextRun = asRunId(`run_phase6c_after_missing_phase_${target.toLowerCase()}`);
      try {
        await stack.api.start();
        const token = await bootstrapToken(stack.api);
        assert.equal((await post(stack.api, token, "/v1/runs", envelope(`command_missing_start_${target}`, `idem_missing_start_${target}`, 0, { runId, objective: "complete synthetic work without a trusted phase check" }))).status, 200);
        const handle = await stack.adapter.started.promise;
        stack.adapter.finish(handle, "succeeded");
        await waitFor(() => stack.store.getRun(runId)?.state === "HUMAN_GATE" ? true : undefined, "missing phase validation gate");
        const before = await snapshot(stack.api, token, runId);
        const gate = before.currentGate;
        assert.ok(gate);
        assert.equal(stack.store.getGate(asGateId(gate.gateId))?.gate.reasonCode, "phase_validation_plan_missing");
        assert.ok(gate.options.length >= 2);
        assert.deepEqual(gate.options.map((option) => option.target).sort(), ["CANCELLED", "FAILED"]);
        assert.equal(gate.options.some((option) => option.target === "REWORK"), false);
        const option = gate.options.find((candidate) => candidate.target === target);
        assert.ok(option);
        const planningBefore = stack.planningInputs.initial.length + stack.planningInputs.rework.length;
        const resolved = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope(`command_missing_resolve_${target}`, `idem_missing_resolve_${target}`, before.run.stateVersion, { optionId: option.id }));
        assert.equal(resolved.status, 200);
        assert.equal(json(resolved).to, target);
        assert.equal(stack.store.getRun(runId)?.state, target);
        assert.equal((await snapshot(stack.api, token, runId)).run.state, target);
        assert.equal(stack.coordinator.activeRunId, undefined);
        assert.equal(stack.planningInputs.initial.length + stack.planningInputs.rework.length, planningBefore, "terminal choice must not invoke Planning Master");
        assert.equal((await post(stack.api, token, "/v1/runs", envelope(`command_missing_next_${target}`, `idem_missing_next_${target}`, 0, { runId: nextRun, objective: "own the released slot" }))).status, 200);
        assert.equal(stack.coordinator.activeRunId, nextRun);
        await waitFor(() => stack.adapter.requests.length === 2 ? stack.adapter.requests[1] : undefined, "next run executor");
        stack.adapter.finishNext("blocked");
        await waitFor(() => stack.store.getRun(nextRun)?.state === "HUMAN_GATE" ? true : undefined, "next run gate");
        const nextSnapshot = await snapshot(stack.api, token, nextRun);
        assert.ok(nextSnapshot.currentGate);
        assert.equal((await post(stack.api, token, `/v1/runs/${nextRun}/gates/${nextSnapshot.currentGate.gateId}/resolve`, envelope(`command_missing_cleanup_${target}`, `idem_missing_cleanup_${target}`, nextSnapshot.run.stateVersion, { optionId: "cancel" }))).status, 200);
      } finally {
        await stack.close();
      }
    }
  });

  await suite.test("terminal gate resolution settles its drive, coalesces duplicates, and old replay preserves the next Start slot", async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const firstRun = asRunId("run_phase6c_gate_terminal");
    const nextRun = asRunId("run_phase6c_gate_next_start");
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      assert.equal((await post(stack.api, token, "/v1/runs", envelope("command_terminal_start", "idem_terminal_start", 0, { runId: firstRun, objective: "settle one gate-owned drive" }))).status, 200);
      const handle = await stack.adapter.started.promise;
      stack.adapter.finish(handle, "blocked");
      await waitFor(() => stack.store.getRun(firstRun)?.state === "HUMAN_GATE" ? true : undefined, "held executor gate");
      const before = await snapshot(stack.api, token, firstRun);
      const gate = before.currentGate;
      assert.ok(gate);
      const terminalCommand = envelope("command_terminal_gate", "idem_terminal_gate", before.run.stateVersion, { optionId: "cancel", note: "terminal duplicate race" });
      const path = `/v1/runs/${firstRun}/gates/${gate.gateId}/resolve`;
      const transitionsBefore = stack.store.listTransitions(firstRun).length;
      const duplicates = await Promise.all([
        post(stack.api, token, path, terminalCommand),
        post(stack.api, token, path, terminalCommand),
      ]);
      assert.deepEqual(duplicates.map((response) => response.status), [200, 200]);
      assert.ok(duplicates.every((response) => json(response).to === "CANCELLED"));
      assert.equal(stack.store.listTransitions(firstRun).length, transitionsBefore + 1, "the gate decision must commit once");
      assert.equal((await snapshot(stack.api, token, firstRun)).run.state, "CANCELLED");
      await waitFor(() => stack.coordinator.activeRunId === undefined ? true : undefined, "terminal drive reservation release");
      assert.equal(stack.store.listUnfinishedRuns().length, 0, "terminal resolution must settle before the next Start can own the slot");

      assert.equal((await post(stack.api, token, "/v1/runs", envelope("command_next_start", "idem_next_start", 0, { runId: nextRun, objective: "own the next drive" }))).status, 200);
      await waitFor(() => stack.adapter.requests.length === 2 ? stack.adapter.requests[1] : undefined, "executor for the next Start");
      const nextVersion = stack.store.getRun(nextRun)?.stateVersion;
      const replay = await post(stack.api, token, path, terminalCommand);
      assert.equal(replay.status, 200);
      assert.equal(json(replay).replayed, true);
      assert.equal(stack.coordinator.activeRunId, nextRun, "replay of the old terminal gate cannot release the new reservation");
      assert.equal(stack.store.getRun(nextRun)?.stateVersion, nextVersion, "old replay cannot wake or mutate the next drive");

      stack.adapter.finishNext("succeeded");
      await waitFor(() => stack.store.getRun(nextRun)?.state === "NEXT_PHASE" ? true : undefined, "the next Start's one owned drive");
      assert.equal(stack.planningInputs.initial.length, 2);
      assert.equal(stack.adapter.requests.length, 2, "old gate replay must not install or duplicate a drive");
    } finally {
      await stack.close();
    }
  });

  await suite.test("executor-blocked REWORK resumes the same drive after Pause during execution", async () => {
    const stack = createPhase6CStack({ phaseCheck: true, reworkOptionId: "/synthetic/rework" });
    const runId = asRunId("run_phase6c_gate_rework");
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      assert.equal((await post(stack.api, token, "/v1/runs", envelope("command_rework_start", "idem_rework_start", 0, { runId, objective: "continue the blocked implementation" }))).status, 200);
      const firstHandle = await stack.adapter.started.promise;
      const executing = await snapshot(stack.api, token, runId);
      const pausePromise = post(stack.api, token, `/v1/runs/${runId}/pause`, envelope("command_rework_pause", "idem_rework_pause", executing.run.stateVersion, {}));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(stack.store.getRun(runId)?.state, "EXECUTE", "Pause remains pending until the running executor returns");

      const rawClaim = stack.adapter.finish(firstHandle, "blocked");
      assert.equal(rawClaim.humanGate?.options.find((option) => option.target === "REWORK")?.id, "/synthetic/rework");
      const paused = await pausePromise;
      assert.equal(paused.status, 200);
      assert.equal(json(paused).to, "PAUSED");
      const pausedSnapshot = await snapshot(stack.api, token, runId);
      assert.equal(pausedSnapshot.run.pauseContract?.resumeTarget, "HUMAN_GATE");
      const resumed = await post(stack.api, token, `/v1/runs/${runId}/resume`, envelope("command_rework_resume", "idem_rework_resume", pausedSnapshot.run.stateVersion, {}));
      assert.equal(resumed.status, 200);
      assert.equal(json(resumed).to, "HUMAN_GATE");
      const gateSnapshot = await snapshot(stack.api, token, runId);
      const gate = gateSnapshot.currentGate;
      assert.ok(gate);
      assert.deepEqual(gate.options.map((option) => option.target).sort(), ["CANCELLED", "FAILED", "REWORK"], "executor-blocked gates always preserve both terminal escape paths");
      const persistedGate = stack.store.getGate(asGateId(gate.gateId));
      assert.ok(persistedGate);
      const persistedRework = persistedGate.gate.options.find((option) => option.target === "REWORK");
      const snapshotRework = gate.options.find((option) => option.target === "REWORK");
      assert.ok(persistedRework);
      assert.ok(snapshotRework);
      assert.equal(persistedRework.id, "rework");
      assert.match(persistedRework.id, /^[a-z][a-z0-9_]{0,99}$/u);
      assert.equal(snapshotRework.id, persistedRework.id, "snapshot control identity must equal the persisted Core-owned ID exactly");
      assert.notEqual(snapshotRework.id, "[path redacted]");
      assert.doesNotMatch(JSON.stringify(gateSnapshot), /\/synthetic\/rework/u, "the raw executor ID must not reach the browser snapshot");
      const persistedAttempt = stack.store.getAttempt(firstHandle.attemptId);
      assert.ok(persistedAttempt?.outcomeJson);
      const rawStoredResult = JSON.parse(persistedAttempt.outcomeJson) as { humanGate: { options: Array<{ id: string; target: string }> } };
      assert.equal(rawStoredResult.humanGate.options.find((option) => option.target === "REWORK")?.id, "/synthetic/rework", "the attempt outcome retains the raw executor claim as evidence");
      const gatePath = `/v1/runs/${runId}/gates/${gate.gateId}/resolve`;
      const reworkCommand = envelope("command_rework_gate", "idem_rework_gate", gateSnapshot.run.stateVersion, { optionId: snapshotRework.id, note: "continue the persisted blocked result" });
      const worktreeBefore = stack.store.getWorktree(runId);
      assert.ok(worktreeBefore);
      assert.equal(stack.coordinator.activeRunId, runId, "the original Phase2 drive remains held at the gate");
      const accepted = await post(stack.api, token, gatePath, reworkCommand);
      assert.equal(accepted.status, 200);
      assert.equal(json(accepted).to, "REWORK");
      assert.equal(stack.coordinator.activeRunId, runId, "REWORK continues the same live drive");
      const replay = await post(stack.api, token, gatePath, reworkCommand);
      assert.equal(replay.status, 200);
      assert.equal(json(replay).replayed, true);
      const secondRequest = await waitFor(() => stack.adapter.requests.length === 2 ? stack.adapter.requests[1] : undefined, "second implementation attempt after gate rework");
      assert.equal(stack.planningInputs.initial.length, 1, "REWORK must not rerun intake or initial planning");
      assert.equal(stack.planningInputs.rework.length, 1);
      assert.equal(stack.planningInputs.rework[0]?.failure.resultingAction, "rework");
      assert.equal(stack.planningInputs.rework[0]?.failure.failureClass, "security_or_privilege_gate");
      assert.equal(stack.planningInputs.rework[0]?.failure.reasonCode, "security_or_privilege_gate");
      assert.equal(secondRequest.taskId, firstHandle.taskId);
      assert.notEqual(secondRequest.attemptId, firstHandle.attemptId);
      const worktreeAfter = stack.store.getWorktree(runId);
      assert.equal(worktreeAfter?.worktreeGitDirectory, worktreeBefore.worktreeGitDirectory, "REWORK must not recreate the owned worktree");
      assert.equal(worktreeAfter?.createdAt, worktreeBefore.createdAt);
      assert.equal(worktreeAfter?.worktreePath, worktreeBefore.worktreePath);
      assert.equal(stack.adapter.requests.length, 2, "replayed REWORK must not create another attempt");
      assert.equal(stack.store.countTaskAttempts(runId, firstHandle.taskId), 2, "gate resolution starts exactly one bounded next attempt");

      stack.adapter.finishNext("succeeded");
      await waitFor(() => stack.store.getRun(runId)?.state === "NEXT_PHASE" ? true : undefined, "focused and phase verification after REWORK");
      const transitions = stack.store.listTransitions(runId);
      assert.equal(transitions.filter((transition) => transition.reasonCode === "intake_validated").length, 1);
      assert.ok(transitions.some((transition) => transition.to === "VERIFY_FOCUSED"));
      assert.ok(transitions.some((transition) => transition.to === "VERIFY_PHASE"));
      assert.equal(stack.adapter.requests.length, 2, "the old blocked result is not replayed through execution or verification");
      assert.equal(stack.store.countTaskAttempts(runId, firstHandle.taskId), 2, "no prior attempt or additional attempt is replayed");
    } finally {
      await stack.close();
    }
  });

  await suite.test("legacy unsupported gate targets and exhausted REWORK budget fail before mutation", async () => {
    const stack = createPhase6CStack({ maxImplementationAttempts: 1, extraGateTarget: "PLAN" });
    const runId = asRunId("run_phase6c_gate_fail_closed");
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      assert.equal((await post(stack.api, token, "/v1/runs", envelope("command_fail_closed_start", "idem_fail_closed_start", 0, { runId, objective: "reject unproven gate continuations" }))).status, 200);
      const handle = await stack.adapter.started.promise;
      stack.adapter.finish(handle, "blocked");
      await waitFor(() => stack.store.getRun(runId)?.state === "HUMAN_GATE" ? true : undefined, "blocked attempt at an open gate");
      const gateSnapshot = await snapshot(stack.api, token, runId);
      const gate = gateSnapshot.currentGate;
      assert.ok(gate);
      assert.deepEqual(gate.options.map((option) => option.target).sort(), ["CANCELLED", "FAILED"], "core filters executor proposals that cannot continue");
      const persisted = stack.store.getGate(asGateId(gate.gateId));
      assert.ok(persisted);
      const legacy = {
        ...persisted.gate,
        options: [
          ...persisted.gate.options,
          { id: "rework", label: "Legacy rework", consequence: "Unsupported exhausted continuation.", target: "REWORK" },
          { id: "unsupported", label: "Legacy plan", consequence: "Unsupported target.", target: "PLAN" },
        ],
      };
      const database = new DatabaseSync(join(stack.root, "runtime", "state.sqlite"));
      try {
        database.prepare("UPDATE human_gates SET gate_json = ? WHERE gate_id = ?").run(JSON.stringify(legacy), gate.gateId);
      } finally {
        database.close();
      }
      const transitionsBefore = stack.store.listTransitions(runId);
      const attemptCount = stack.store.countTaskAttempts(runId, handle.taskId);
      assert.equal(attemptCount, 1);
      assert.equal(stack.core.configuration.effectiveMaxImplementationAttempts, 1);

      const unsupported = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_fail_closed_plan", "idem_fail_closed_plan", gateSnapshot.run.stateVersion, { optionId: "unsupported", note: "must remain open" }));
      assert.equal(unsupported.status, 409);
      assert.equal(errorCode(unsupported), "GATE_CONTINUATION_UNAVAILABLE");
      assert.equal(stack.store.getRun(runId)?.state, "HUMAN_GATE");
      assert.equal(stack.store.getGate(asGateId(gate.gateId))?.status, "open");
      assert.deepEqual(stack.store.listTransitions(runId), transitionsBefore);

      const exhausted = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_fail_closed_rework", "idem_fail_closed_rework", gateSnapshot.run.stateVersion, { optionId: "rework", note: "budget is exhausted" }));
      assert.equal(exhausted.status, 409);
      assert.equal(errorCode(exhausted), "GATE_CONTINUATION_UNAVAILABLE");
      assert.equal(stack.store.getRun(runId)?.state, "HUMAN_GATE");
      assert.equal(stack.store.getGate(asGateId(gate.gateId))?.status, "open");
      assert.deepEqual(stack.store.listTransitions(runId), transitionsBefore);
      assert.equal(stack.planningInputs.rework.length, 0);
      assert.equal(stack.adapter.requests.length, 1);

      const closed = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_fail_closed_cleanup", "idem_fail_closed_cleanup", gateSnapshot.run.stateVersion, { optionId: "cancel", note: "close test run" }));
      assert.equal(closed.status, 200);
      assert.equal(json(closed).to, "CANCELLED");
    } finally {
      await stack.close();
    }
  });

  await suite.test("Pause and Cancel wake a held gate loop without allowing gate-resolution races", async () => {
    const stack = createPhase6CStack();
    const runId = asRunId("run_phase6c_gate_controls");
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      assert.equal((await post(stack.api, token, "/v1/runs", envelope("command_gate_controls_start", "idem_gate_controls_start", 0, { runId, objective: "hold a blocked gate through Pause and Cancel" }))).status, 200);
      const handle = await stack.adapter.started.promise;
      stack.adapter.finish(handle, "blocked");
      await waitFor(() => stack.store.getRun(runId)?.state === "HUMAN_GATE" ? true : undefined, "held executor gate");
      const gateSnapshot = await snapshot(stack.api, token, runId);
      const gate = gateSnapshot.currentGate;
      assert.ok(gate);

      const pause = await post(stack.api, token, `/v1/runs/${runId}/pause`, envelope("command_gate_controls_pause", "idem_gate_controls_pause", gateSnapshot.run.stateVersion, {}));
      assert.equal(pause.status, 200);
      assert.equal(json(pause).to, "PAUSED");
      const paused = await snapshot(stack.api, token, runId);
      assert.equal(paused.run.pauseContract?.resumeTarget, "HUMAN_GATE");
      const gateWhilePaused = await post(stack.api, token, `/v1/runs/${runId}/gates/${gate.gateId}/resolve`, envelope("command_gate_controls_paused_resolve", "idem_gate_controls_paused_resolve", paused.run.stateVersion, { optionId: "cancel", note: "cannot resolve while paused" }));
      assert.equal(gateWhilePaused.status, 409);
      assert.equal(stack.store.getGate(asGateId(gate.gateId))?.status, "open");

      const resume = await post(stack.api, token, `/v1/runs/${runId}/resume`, envelope("command_gate_controls_resume", "idem_gate_controls_resume", paused.run.stateVersion, {}));
      assert.equal(resume.status, 200);
      assert.equal(json(resume).to, "HUMAN_GATE");
      const resumed = await snapshot(stack.api, token, runId);
      const cancelPromise = stack.coordinator.cancel({
        runId,
        commandId: asCommandId("command_gate_controls_cancel"),
        idempotencyKey: "idem_gate_controls_cancel",
        expectedStateVersion: resumed.run.stateVersion,
        reason: "Cancel at the held executor gate",
      });
      assert.throws(() => stack.coordinator.resolveGate({
        runId,
        commandId: asCommandId("command_gate_controls_racing_gate"),
        idempotencyKey: "idem_gate_controls_racing_gate",
        expectedStateVersion: resumed.run.stateVersion,
        gateId: asGateId(gate.gateId),
        optionId: "rework",
        note: "must not race a claimed Cancel",
      }), /control boundary/u);
      const cancelled = await cancelPromise;
      assert.equal(cancelled.to, "CANCELLED");
      assert.equal(stack.store.getRun(runId)?.state, "CANCELLED");
      assert.equal(stack.adapter.requests.length, 1);
      assert.equal(stack.coordinator.activeRunId, undefined);
    } finally {
      await stack.close();
    }
  });

  await suite.test("active Cancel signals once and reaches CANCELLED only with terminal proof", async () => {
    const stack = createPhase6CStack();
    const runId = asRunId("run_phase6c_cancel");
    const commandId = "command_external_cancel_6c";
    const idempotencyKey = "external-cancel-6c";
    try {
      await stack.api.start();
      const token = await bootstrapToken(stack.api);
      assert.equal((await post(stack.api, token, "/v1/runs", envelope("command_cancel_start", "idem_cancel_start", 0, { runId, objective: "hold synthetic work for active cancellation" }))).status, 200);
      const handle = await stack.adapter.started.promise;
      const active = await snapshot(stack.api, token, runId);
      assert.equal(active.run.state, "EXECUTE");
      const beforeOverflow = stack.store.getRun(runId);
      assert.ok(beforeOverflow);
      const transitionsBeforeOverflow = stack.store.listTransitions(runId);
      const tooLong = await post(stack.api, token, `/v1/runs/${runId}/cancel`, envelope(commandId, idempotencyKey, active.run.stateVersion, { reason: "€".repeat(1000) }));
      assert.equal(tooLong.status, 400);
      assert.equal(stack.store.getRun(runId)?.state, beforeOverflow.state);
      assert.equal(stack.store.getRun(runId)?.stateVersion, beforeOverflow.stateVersion);
      assert.deepEqual(stack.store.listTransitions(runId), transitionsBeforeOverflow);
      assert.equal(stack.store.getCommandIdempotencyKey(asCommandId(commandId)), undefined);
      assert.equal(stack.store.getCancellationIntent(handle.attemptId), undefined);
      assert.equal(stack.adapter.cancelCalls, 0);

      const validReason = `${"€".repeat(341)}a`;
      assert.equal(Buffer.byteLength(validReason, "utf8"), 1024);
      const cancelled = await post(stack.api, token, `/v1/runs/${runId}/cancel`, envelope(commandId, idempotencyKey, active.run.stateVersion, { reason: validReason }));
      assert.equal(cancelled.status, 200);
      const response = json(cancelled);
      assert.equal(response.to, "CANCELLED");
      assert.equal(response.commandId, commandId, "HTTP must return the external command identity");
      assert.equal(response.idempotencyKey, idempotencyKey);
      assert.equal(stack.adapter.cancelCalls, 1, "the coordinator may signal the active adapter at most once");
      assert.equal((await snapshot(stack.api, token, runId)).run.state, "CANCELLED");
      const intent = stack.store.getCancellationIntent(handle.attemptId);
      assert.equal(intent?.status, "CANCELLED");
      assert.equal(intent?.reason, validReason);
      assert.equal(stack.store.getAttempt(handle.attemptId)?.lifecycle, "CANCELLED");
      assert.equal((await stack.adapter.reconcile({ runId, taskId: handle.taskId, attemptId: handle.attemptId })).outcome, "terminal");
    } finally {
      await stack.close();
    }
  });

  await suite.test("headless Phase2 remains usable without starting LocalApiServer", async () => {
    const stack = createPhase6CStack({ phaseCheck: true });
    const runId = asRunId("run_phase6c_headless");
    try {
      const taskId = stack.store.getRunLaunchBinding(runId)?.taskId;
      assert.equal(taskId, undefined, "headless Phase2 is not prebound by a UI/server Start");
      const plannedTaskId = asTaskId("task_phase6c_headless");
      const decision = createPhase2PlanningDecision({
        decisionId: "decision_phase6c_headless",
        runId,
        taskId: plannedTaskId,
        objective: "complete a headless synthetic Phase2 run",
        acceptance: ["the synthetic result passes the independent check"],
        positiveScope: ["result.txt"],
        negativeScope: ["docs", "test"],
        model: "synthetic-model",
        canonicalContext: "headless phase6c control integration",
      });
      const headless = stack.phase2.run({
        runId,
        taskId: plannedTaskId,
        objective: decision.action.summary,
        repositoryPath: stack.repository.root,
        expectedBaseOid: stack.repository.head,
        planningDecision: decision,
        focusedCheck: { name: "synthetic result", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5_000 },
        phaseCheck: { level: "phase", commandId: "phase6c-headless-check", name: "synthetic result", executable: process.execPath, args: ["check.mjs"], timeoutMs: 5_000 },
        executionTimeoutMs: 5_000,
      });
      const handle = await stack.adapter.started.promise;
      stack.adapter.finish(handle, "succeeded");
      const result = await headless;
      assert.equal(result.verdict, "PASS");
      assert.equal(stack.adapter.requests.length, 1);
      assert.equal(stack.store.getRun(runId)?.state, "NEXT_PHASE");
    } finally {
      await stack.close();
    }
  });
});

function envelope(commandId: string, idempotencyKey: string, expectedStateVersion: number, payload: Record<string, unknown>) {
  return { schemaVersion: "kerbsflow.local-command/v1", commandId, idempotencyKey, expectedStateVersion, payload };
}

function json(response: HttpResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorCode(response: HttpResponse): unknown {
  const error = json(response).error;
  return typeof error === "object" && error !== null && !Array.isArray(error)
    ? (error as Record<string, unknown>).code
    : undefined;
}

async function bootstrapToken(api: ReturnType<typeof createPhase6CStack>["api"]): Promise<string> {
  const response = await get(api, undefined, "/");
  assert.equal(response.status, 200);
  const token = /<meta name="kerbsflow-token" content="([A-Za-z0-9_-]+)">/u.exec(response.body)?.[1];
  assert.ok(token, "bootstrap document must provide its per-launch token");
  return token;
}

async function snapshot(api: ReturnType<typeof createPhase6CStack>["api"], token: string, runId: RunId): Promise<Snapshot> {
  const response = await get(api, token, `/v1/runs/${runId}/snapshot`);
  assert.equal(response.status, 200);
  return JSON.parse(response.body) as Snapshot;
}

function post(api: ReturnType<typeof createPhase6CStack>["api"], token: string, path: string, body: unknown): Promise<HttpResponse> {
  return request(api, token, path, "POST", body);
}

function get(api: ReturnType<typeof createPhase6CStack>["api"], token: string | undefined, path: string): Promise<HttpResponse> {
  return request(api, token, path, "GET");
}

function request(api: ReturnType<typeof createPhase6CStack>["api"], token: string | undefined, path: string, method: "GET" | "POST", body?: unknown): Promise<HttpResponse> {
  const headers: Record<string, string> = { host: `127.0.0.1:${api.port()}` };
  if (path !== "/") {
    assert.ok(token);
    headers["X-KerbsFlow-Token"] = token;
  }
  if (method === "POST") {
    headers.origin = `http://127.0.0.1:${api.port()}`;
    headers["content-type"] = "application/json";
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: api.port(), path, method, headers, setHost: false, agent: false }, (response) => {
      response.setEncoding("utf8");
      let content = "";
      response.on("data", (chunk: string) => { content += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: content }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function readSse(api: ReturnType<typeof createPhase6CStack>["api"], token: string, runId: RunId, expectedEvents: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: api.port(),
      path: `/v1/runs/${runId}/events`,
      method: "GET",
      headers: { host: `127.0.0.1:${api.port()}`, "X-KerbsFlow-Token": token, "Last-Event-ID": "0" },
      setHost: false,
      agent: false,
    }, (response: IncomingMessage) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        content += chunk;
        const eventCount = content.split("\n\n").filter((frame) => frame.includes("event: state")).length;
        if (eventCount >= expectedEvents) {
          response.destroy();
          resolve(content);
        }
      });
      response.on("error", () => { /* the request is intentionally closed after the persisted cursor is read */ });
      setTimeout(() => {
        response.destroy();
        reject(new Error("timed out reading persisted SSE state events"));
      }, 2_000).unref();
    });
    req.on("error", (error) => {
      if (!/socket hang up/u.test(error.message)) reject(error);
    });
    req.end();
  });
}
