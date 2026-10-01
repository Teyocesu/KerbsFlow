import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type AttemptId,
  type CommandId,
  type CommandResult,
  type ExecutorResult,
  type GateId,
  type RunId,
  type TaskId,
  asCommandId,
  asGateId,
  asTaskId,
  isTerminalState,
  parseAdapterDescriptor,
  parseCommand,
  parseExecutorResult,
} from "./contracts.js";
import { KerbsFlowCore } from "./core.js";
import { KerbsFlowError, StateVersionConflictError } from "./errors.js";
import { Phase2Loop, type ExecutionDispatchBoundary, type FailureDispositionBoundary, type Phase2LoopRequest, type Phase2LoopResult } from "./phase2.js";
import type { PlanningMaster } from "./planning.js";
import { StateStore, type RunLaunchBinding, type StoredGate } from "./persistence.js";
import { RandomIdSource, type IdSource } from "./runtime.js";
import { isLegalTransition } from "./state-machine.js";
import type { FocusedCheckCommand, PhaseCheckCommand } from "./verifier.js";

export interface TrustedLaunchProfile {
  launchProfileId: string;
  launchProfileHash: string;
  canonicalRepositoryPath: string;
  expectedBaseOid?: string;
  focusedCheck: FocusedCheckCommand;
  phaseCheck?: PhaseCheckCommand;
  executionTimeoutMs: number;
  failurePolicy?: Phase2LoopRequest["failurePolicy"];
  semanticReview?: Phase2LoopRequest["semanticReview"];
  planningMaster: PlanningMaster;
}

export interface CoordinatorStartRequest {
  runId: RunId;
  objective: string;
  commandId: CommandId;
  idempotencyKey: string;
  expectedStateVersion: number;
}

export interface CoordinatorControlRequest {
  runId: RunId;
  commandId: CommandId;
  idempotencyKey: string;
  expectedStateVersion: number;
}

export interface CoordinatorCancelRequest extends CoordinatorControlRequest {
  reason: string;
}

export interface CoordinatorGateResolutionRequest extends CoordinatorControlRequest {
  gateId: GateId;
  optionId: string;
  note?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

type ResumeOutcome =
  | { kind: "resumed"; result: CommandResult }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

interface ResumeClaim {
  request: CoordinatorControlRequest;
  acknowledgement: Deferred<ResumeOutcome>;
  operation: Promise<CommandResult>;
}

interface PauseClaim {
  request: CoordinatorControlRequest;
  quiescent: Deferred<void>;
  resume: Deferred<"resume" | "cancel">;
  resumeClaim?: ResumeClaim;
  status: "claimed" | "paused" | "resuming";
  operation?: Promise<CommandResult>;
}

interface CancelClaim {
  request: CoordinatorCancelRequest;
  operation?: Promise<CommandResult>;
}

interface GateBoundaryIdentity {
  gateId: GateId;
  taskId: TaskId;
  attemptId: AttemptId;
}

interface PendingGateBoundary {
  expected: GateBoundaryIdentity;
  registration: Deferred<{ held: HeldGateBoundary; exact: boolean }>;
}

interface GateResolutionClaim {
  request: CoordinatorGateResolutionRequest;
  pendingBoundary?: PendingGateBoundary;
  operation?: Promise<CommandResult>;
}

interface HeldGateBoundary extends GateBoundaryIdentity {
  wake: Deferred<void>;
}

interface FailureDispositionClaim {
  stateVersion: number;
}

interface ExecutionDispatchClaim {
  stateVersion: number;
}

type GateOptionPreflight =
  | { kind: "immediate"; held?: HeldGateBoundary }
  | { kind: "await-held"; boundary: GateBoundaryIdentity };

interface RunReservation {
  runId: RunId;
  taskId?: TaskId;
  launchBinding?: RunLaunchBinding;
  startupBlocked: boolean;
  driveSettled: boolean;
  drivePromise?: Promise<void>;
  driveError?: unknown;
  driveResult?: Phase2LoopResult;
  settled: Deferred<void>;
  cancelCheckpoint: Deferred<void>;
  cancelRequested: boolean;
  pauseClaim?: PauseClaim;
  cancelClaim?: CancelClaim;
  gateResolutionClaim?: GateResolutionClaim;
  heldGate?: HeldGateBoundary;
  failureDispositionClaim?: FailureDispositionClaim;
  executionDispatchClaim?: ExecutionDispatchClaim;
  signalledAttempts: Set<string>;
}

export class Phase2DriveControlStop extends Error {
  constructor() {
    super("Phase2 drive stopped at a coordinator cancellation checkpoint");
    this.name = "Phase2DriveControlStop";
  }
}

export class RunCoordinator {
  private readonly profile: TrustedLaunchProfile;
  private reservation: RunReservation | undefined;

  constructor(
    private readonly core: KerbsFlowCore,
    private readonly store: StateStore,
    private readonly phase2: Pick<Phase2Loop, "driveStarted">,
    launchProfile: TrustedLaunchProfile,
    private readonly ids: IdSource = new RandomIdSource(),
  ) {
    this.profile = canonicalTrustedLaunchProfile(launchProfile);
    const unfinished = this.store.listUnfinishedRuns();
    if (unfinished.length > 1) {
      throw new KerbsFlowError("MULTIPLE_UNFINISHED_RUNS", "startup found multiple unfinished runs; one RunCoordinator cannot truthfully own more than one drive");
    }
    if (unfinished.length === 1) this.reservation = newReservation(unfinished[0]!.runId, true);
  }

  get activeRunId(): RunId | undefined {
    this.reconcileTerminalReservation();
    return this.reservation?.runId;
  }

  getActionableGateOptionIds(runId: RunId, gateId: GateId): readonly string[] {
    const reservation = this.reservation;
    if (reservation === undefined || reservation.runId !== runId) return [];
    const run = this.store.getRun(runId);
    const storedGate = this.store.getGate(gateId);
    if (run === undefined || run.state !== "HUMAN_GATE" || run.currentGateId !== gateId
      || storedGate === undefined || storedGate.runId !== runId || storedGate.gateId !== gateId
      || storedGate.status !== "open" || storedGate.gate.status !== "open") return [];

    const actionable = new Set<string>();
    for (const option of storedGate.gate.options) {
      try {
        this.preflightGateOption(reservation, run, storedGate, option);
        actionable.add(option.id);
      } catch (error) {
        if (error instanceof KerbsFlowError && (error.code === "GATE_CONTINUATION_UNAVAILABLE" || error.code === "CONTROL_COMMAND_IN_PROGRESS")) continue;
        throw error;
      }
    }
    return [...actionable];
  }

  start(request: CoordinatorStartRequest): CommandResult {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      expectedStateVersion: request.expectedStateVersion,
      kind: "start",
      objective: request.objective,
    });
    if (command.kind !== "start" || command.expectedStateVersion !== 0) {
      throw new KerbsFlowError("START_PRECONDITION_INVALID", "coordinator Start requires expectedStateVersion 0");
    }

    this.reconcileTerminalReservation();
    if (this.reservation !== undefined) {
      if (this.reservation.runId !== request.runId) {
        throw new KerbsFlowError("ACTIVE_RUN_CONFLICT", `run ${this.reservation.runId} owns the coordinator slot`);
      }
      if (this.reservation.startupBlocked) {
        throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "startup found an unfinished run without an owned Phase2 drive; Start cannot claim continuation");
      }
      const taskId = this.reservation.taskId ?? this.ids.next("task");
      const binding = this.reservation.launchBinding ?? this.binding(request.runId, asTaskId(taskId));
      return this.core.startRunWithLaunchBinding(request.runId, request.objective, request.idempotencyKey, binding, request.commandId);
    }

    const reservation = newReservation(request.runId, false);
    this.reservation = reservation;
    try {
      const taskId = asTaskId(this.ids.next("task"));
      const binding = this.binding(request.runId, taskId);
      const driveRequest = this.driveRequest(request.runId, taskId, request.objective);
      const accepted = this.core.startRunWithLaunchBinding(request.runId, request.objective, request.idempotencyKey, binding, request.commandId);
      if (accepted.replayed) {
        const current = this.store.getRun(request.runId);
        if (current !== undefined && !isTerminalState(current.state)) {
          reservation.startupBlocked = true;
          reservation.driveSettled = true;
        } else {
          this.reservation = undefined;
        }
        return accepted;
      }
      reservation.taskId = taskId;
      reservation.launchBinding = binding;
      reservation.drivePromise = Promise.resolve().then(() => this.phase2.driveStarted(driveRequest, {
        planningMaster: this.profile.planningMaster,
        checkpoint: () => this.checkpoint(reservation),
        claimFailureDisposition: () => this.claimFailureDisposition(reservation),
        claimExecutionDispatch: () => this.claimExecutionDispatch(reservation),
        waitForGateResolution: (boundary) => this.waitForGateResolution(reservation, boundary),
      })).then(
        (result) => { reservation.driveResult = result; },
        (error: unknown) => { reservation.driveError = error; },
      ).finally(() => {
        reservation.driveSettled = true;
        reservation.settled.resolve();
        try {
          this.reconcileTerminalReservation(reservation);
        } catch (error) {
          reservation.driveError ??= error;
        }
      });
      return accepted;
    } catch (error) {
      const current = this.store.getRun(request.runId);
      if (current === undefined && this.reservation === reservation) this.reservation = undefined;
      else if (current !== undefined) {
        reservation.startupBlocked = true;
        reservation.driveSettled = true;
      }
      throw error;
    }
  }

  pause(request: CoordinatorControlRequest): Promise<CommandResult> {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      expectedStateVersion: request.expectedStateVersion,
      kind: "pause",
    });
    if (command.kind !== "pause") throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "pause request did not parse as pause");
    const replay = this.store.replayCommand(command);
    if (replay !== undefined) return Promise.resolve(replay);

    const reservation = this.requireReservation(request.runId);
    if (reservation.failureDispositionClaim !== undefined || reservation.executionDispatchClaim !== undefined) {
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "failure disposition or execution dispatch already owns this run's control boundary");
    }
    if (reservation.startupBlocked) throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "startup found an unfinished run without an owned Phase2 drive; pause cannot claim it");
    if (reservation.driveSettled) throw new KerbsFlowError("RUN_DRIVE_NOT_PAUSABLE", "Pause requires a live owned Phase2 drive that can be held at a control checkpoint");
    const run = this.assertRequestVersion(request.runId, request.expectedStateVersion);
    if (!isLegalTransition(run.state, "PAUSED")) throw new KerbsFlowError("PAUSE_NOT_ALLOWED", `cannot pause from ${run.state}`);
    if (reservation.cancelClaim !== undefined || reservation.cancelRequested || reservation.gateResolutionClaim !== undefined) {
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another control command already owns this run's control boundary");
    }
    const existing = reservation.pauseClaim;
    if (existing !== undefined) {
      if (sameControlRequest(existing.request, request)) return existing.operation!;
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another Pause already owns this run's control boundary");
    }

    const claim: PauseClaim = {
      request,
      quiescent: deferred<void>(),
      resume: deferred<"resume" | "cancel">(),
      status: "claimed",
    };
    reservation.pauseClaim = claim;
    reservation.heldGate?.wake.resolve();
    claim.operation = this.finishPause(reservation, claim).catch((error: unknown) => {
      if (reservation.pauseClaim === claim) {
        delete reservation.pauseClaim;
        claim.resume.resolve("resume");
      }
      this.reconcileTerminalReservation(reservation);
      throw error;
    });
    return claim.operation;
  }

  async resume(request: CoordinatorControlRequest): Promise<CommandResult> {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      expectedStateVersion: request.expectedStateVersion,
      kind: "resume",
    });
    if (command.kind !== "resume") throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "resume request did not parse as resume");
    const replay = this.store.replayCommand(command);
    if (replay !== undefined) {
      const reservation = this.reservation;
      if (reservation?.runId === request.runId && reservation.startupBlocked) {
        throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "startup found no owned drive or proven restart checkpoint; replayed Resume cannot claim continuation");
      }
      return replay;
    }

    const reservation = this.requireReservation(request.runId);
    if (reservation.startupBlocked) throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "startup found no owned drive or proven restart checkpoint; Resume is fail-closed");
    const claim = reservation.pauseClaim;
    const pending = claim?.resumeClaim;
    if (pending !== undefined) {
      if (sameControlRequest(pending.request, request)) return pending.operation;
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another Resume already owns this Pause boundary");
    }
    this.assertRequestVersion(request.runId, request.expectedStateVersion);
    if (claim === undefined || claim.status !== "paused" || reservation.driveSettled) {
      throw new KerbsFlowError("RUN_DRIVE_NOT_RESUMABLE", "Resume requires a durable Pause with a live owned Phase2 drive at its checkpoint");
    }
    if (reservation.cancelRequested) throw new KerbsFlowError("CANCEL_ALREADY_CLAIMED", "Cancel superseded this run's Pause");
    const acknowledgement = deferred<ResumeOutcome>();
    const resume: ResumeClaim = {
      request: { ...request },
      acknowledgement,
      operation: acknowledgement.promise.then((outcome) => {
        if (outcome.kind === "resumed") return outcome.result;
        if (outcome.kind === "error") throw outcome.error;
        throw new KerbsFlowError("CANCEL_ALREADY_CLAIMED", "Cancel superseded Resume before its checkpoint committed continuation");
      }),
    };
    claim.resumeClaim = resume;
    claim.status = "resuming";
    claim.resume.resolve("resume");
    return resume.operation;
  }

  cancel(request: CoordinatorCancelRequest): Promise<CommandResult> {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      expectedStateVersion: request.expectedStateVersion,
      kind: "cancel",
      reason: request.reason,
    });
    if (command.kind !== "cancel") throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "cancel request did not parse as cancel");
    const replay = this.store.replayCommand(command);
    if (replay !== undefined) {
      if (replay.to === "CANCELLED" || replay.to === "RECOVERY") return Promise.resolve(replay);
      throw new KerbsFlowError("CANCEL_COMMAND_INCOMPLETE", "the external Cancel identity already has a nonterminal result; refusing to replace or reinterpret its durable command result");
    }

    const reservation = this.requireReservation(request.runId);
    if (reservation.gateResolutionClaim !== undefined || reservation.failureDispositionClaim !== undefined || reservation.executionDispatchClaim !== undefined) {
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another control command already owns this run's control boundary");
    }
    const existing = reservation.cancelClaim;
    if (existing !== undefined) {
      if (sameCancelRequest(existing.request, request)) return existing.operation!;
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another Cancel already owns this run's control boundary");
    }
    const current = this.store.getRun(request.runId);
    if (current === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} does not exist`);
    const activeIntent = current.activeAttemptId === null ? undefined : this.store.getCancellationIntent(current.activeAttemptId);
    if (activeIntent === undefined) {
      this.assertRequestVersion(request.runId, request.expectedStateVersion);
    } else if (activeIntent.requestCommandId !== request.commandId || activeIntent.requestIdempotencyKey !== request.idempotencyKey
      || activeIntent.requestExpectedStateVersion !== request.expectedStateVersion || activeIntent.reason !== request.reason) {
      throw new KerbsFlowError("CANCELLATION_COMMAND_CONFLICT", "the active attempt already belongs to a different external Cancel identity, precondition, or reason");
    }
    if (reservation.pauseClaim !== undefined) {
      reservation.pauseClaim.resume.resolve("cancel");
      reservation.pauseClaim.quiescent.resolve();
    }
    reservation.cancelRequested = true;
    reservation.heldGate?.wake.resolve();
    const claim: CancelClaim = { request };
    claim.operation = this.finishCancel(reservation, request).finally(async () => {
      const current = this.store.getRun(reservation.runId);
      const pause = reservation.pauseClaim;
      if (current?.state === "CANCELLED" && pause !== undefined && (pause.status === "paused" || pause.status === "resuming")) {
        await pause.operation;
        pause.resumeClaim?.acknowledgement.resolve({ kind: "cancelled" });
        if (reservation.pauseClaim === pause) delete reservation.pauseClaim;
      }
      if (reservation.cancelClaim === claim) delete reservation.cancelClaim;
      const attemptId = current?.activeAttemptId;
      const intent = attemptId === null || attemptId === undefined ? undefined : this.store.getCancellationIntent(attemptId);
      if (intent === undefined || intent.status === "CANCELLED") {
        reservation.cancelRequested = false;
      } else if (intent.status === "REQUESTED") {
        reservation.signalledAttempts.delete(intent.attemptId);
      }
      this.reconcileTerminalReservation(reservation);
    });
    reservation.cancelClaim = claim;
    return claim.operation;
  }

  resolveGate(request: CoordinatorGateResolutionRequest): Promise<CommandResult> {
    const command = parseCommand({
      schemaVersion: CONTRACT_VERSIONS.command,
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      expectedStateVersion: request.expectedStateVersion,
      kind: "gate_resolution",
      payload: { optionId: request.optionId, ...(request.note === undefined ? {} : { note: request.note }) },
    });
    if (command.kind !== "gate_resolution") throw new KerbsFlowError("INTERNAL_COMMAND_ERROR", "gate resolution request did not parse as gate_resolution");

    const activeClaim = this.reservation?.gateResolutionClaim;
    if (activeClaim !== undefined && sameGateResolutionRequest(activeClaim.request, request)) return activeClaim.operation!;

    const replay = this.store.replayCommand(command);
    if (replay !== undefined) {
      const details = replay.details;
      const replayGateId = details !== undefined && typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>).gateId
        : undefined;
      if (replay.runId !== request.runId || replayGateId !== request.gateId) {
        throw new KerbsFlowError("GATE_SCOPE_MISMATCH", "replayed gate command does not belong to the supplied run and gate");
      }
      return Promise.resolve(replay);
    }
    if (activeClaim?.request.runId === request.runId) {
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another gate resolution already owns this run's control boundary");
    }

    const reservation = this.requireReservation(request.runId);
    const run = this.assertRequestVersion(request.runId, request.expectedStateVersion);
    const storedGate = this.store.getGate(asGateId(request.gateId));
    if (run.state !== "HUMAN_GATE" || run.currentGateId !== request.gateId
      || storedGate === undefined || storedGate.runId !== request.runId
      || storedGate.gateId !== request.gateId || storedGate.status !== "open" || storedGate.gate.status !== "open") {
      throw new KerbsFlowError("GATE_SCOPE_MISMATCH", "supplied gate is not the current open gate for this run");
    }
    const option = storedGate.gate.options.find((candidate) => candidate.id === request.optionId);
    if (option === undefined) throw new KerbsFlowError("GATE_OPTION_INVALID", "the selected option was not offered by the persisted gate");
    const preflight = this.preflightGateOption(reservation, run, storedGate, option);

    const claim: GateResolutionClaim = { request };
    if (preflight.kind === "await-held") {
      claim.pendingBoundary = { expected: preflight.boundary, registration: deferred() };
    }
    reservation.gateResolutionClaim = claim;
    claim.operation = (preflight.kind === "immediate"
      ? this.finishGateResolution(reservation, request, option.target, preflight.held)
      : this.finishPreHoldGateResolution(reservation, claim, option.target)).finally(() => {
      if (reservation.gateResolutionClaim === claim) delete reservation.gateResolutionClaim;
      this.reconcileTerminalReservation(reservation);
    });
    return claim.operation;
  }

  private preflightGateOption(
    reservation: RunReservation,
    run: NonNullable<ReturnType<StateStore["getRun"]>>,
    storedGate: StoredGate,
    option: StoredGate["gate"]["options"][number],
    claimOwner?: GateResolutionClaim,
  ): GateOptionPreflight {
    if (reservation.pauseClaim !== undefined || reservation.cancelClaim !== undefined || reservation.cancelRequested
      || reservation.failureDispositionClaim !== undefined || reservation.executionDispatchClaim !== undefined
      || (reservation.gateResolutionClaim !== undefined && reservation.gateResolutionClaim !== claimOwner)) {
      throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "Pause, Cancel, or another gate resolution already owns this run's control boundary");
    }
    if (reservation.runId !== run.runId || run.state !== "HUMAN_GATE" || run.currentGateId !== storedGate.gateId
      || storedGate.runId !== reservation.runId || storedGate.status !== "open" || storedGate.gate.status !== "open") {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the supplied gate is no longer the current open gate for this run");
    }

    const held = reservation.heldGate;
    const heldMatches = held !== undefined && held.gateId === storedGate.gateId
      && held.taskId === storedGate.taskId && held.attemptId === storedGate.attemptId;
    if (held !== undefined && !heldMatches) {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the live drive is holding a different gate boundary");
    }
    const liveOwnedDrive = !reservation.startupBlocked && !reservation.driveSettled
      && storedGate.taskId !== null && reservation.taskId === storedGate.taskId;
    const blockedResult = this.executorBlockedGateResult(reservation.runId, run.currentTaskId, run.activeAttemptId, storedGate);
    if (option.target === "REWORK") {
      if (storedGate.taskId === null || storedGate.attemptId === null || !liveOwnedDrive || blockedResult === undefined) {
        throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "REWORK is supported only for a live owned executor-blocked gate continuation");
      }
      if (!blockedResult.humanGate?.options.some((candidate) => candidate.target === "REWORK")) {
        throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the persisted executor result does not prove this gate's REWORK continuation");
      }
      if (this.store.countTaskAttempts(reservation.runId, storedGate.taskId) >= this.core.configuration.effectiveMaxImplementationAttempts) {
        throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the task has exhausted its effective implementation-attempt budget");
      }
      if (heldMatches) return { kind: "immediate", held };
      return { kind: "await-held", boundary: { gateId: storedGate.gateId, taskId: storedGate.taskId, attemptId: storedGate.attemptId } };
    }

    if (option.target === "FAILED" || option.target === "CANCELLED") {
      const activeAttempt = run.activeAttemptId === null ? undefined : this.store.getAttempt(run.activeAttemptId);
      if (activeAttempt !== undefined && (activeAttempt.lifecycle === "PREPARED" || activeAttempt.lifecycle === "RUNNING" || activeAttempt.lifecycle === "UNKNOWN")) {
        throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "terminal gate resolution is unsafe while an attempt is active or ambiguous");
      }
      if (heldMatches) return { kind: "immediate", held };
      if (liveOwnedDrive) {
        if (blockedResult === undefined || storedGate.taskId === null || storedGate.attemptId === null) {
          throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "terminal choice is not tied to the live executor-blocked gate");
        }
        return { kind: "await-held", boundary: { gateId: storedGate.gateId, taskId: storedGate.taskId, attemptId: storedGate.attemptId } };
      }
      if (reservation.startupBlocked || reservation.driveSettled) return { kind: "immediate" };
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the live drive has not reached a held checkpoint for this gate");
    }

    throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "this gate option has no proven coordinator continuation");
  }

  private async finishPreHoldGateResolution(
    reservation: RunReservation,
    claim: GateResolutionClaim,
    target: string,
  ): Promise<CommandResult> {
    const pending = claim.pendingBoundary;
    if (pending === undefined) throw new KerbsFlowError("INTERNAL_GATE_BOUNDARY_ERROR", "pre-hold gate resolution has no expected boundary");
    const registration = await Promise.race([
      pending.registration.promise.then((value) => ({ kind: "registered" as const, value })),
      reservation.settled.promise.then(() => ({ kind: "settled" as const })),
    ]);
    if (registration.kind !== "registered" || !registration.value.exact || this.reservation !== reservation
      || reservation.startupBlocked || reservation.driveSettled) {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the owned Phase2 drive settled before it proved this gate's held boundary");
    }

    const request = claim.request;
    const held = registration.value.held;
    if (!sameGateBoundary(pending.expected, held) || reservation.heldGate !== held) {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "Phase2 registered a different held gate boundary");
    }
    const run = this.assertRequestVersion(request.runId, request.expectedStateVersion);
    const storedGate = this.store.getGate(asGateId(request.gateId));
    if (run.state !== "HUMAN_GATE" || run.currentGateId !== request.gateId
      || storedGate === undefined || storedGate.runId !== request.runId || storedGate.gateId !== request.gateId
      || storedGate.status !== "open" || storedGate.gate.status !== "open"
      || storedGate.taskId !== held.taskId || storedGate.attemptId !== held.attemptId) {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the gate no longer matches the exact held Phase2 boundary");
    }
    const option = storedGate.gate.options.find((candidate) => candidate.id === request.optionId);
    if (option === undefined || option.target !== target) {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the claimed option is no longer policy-valid for the held gate");
    }
    const confirmed = this.preflightGateOption(reservation, run, storedGate, option, claim);
    if (confirmed.kind !== "immediate" || confirmed.held !== held) {
      throw new KerbsFlowError("GATE_CONTINUATION_UNAVAILABLE", "the held gate actionability changed before resolution");
    }
    return this.finishGateResolution(reservation, request, target, held);
  }

  private async finishGateResolution(
    reservation: RunReservation,
    request: CoordinatorGateResolutionRequest,
    target: string,
    held: HeldGateBoundary | undefined,
  ): Promise<CommandResult> {
    const result = this.core.resolveGateScoped(
      request.runId,
      request.expectedStateVersion,
      request.idempotencyKey,
      asGateId(request.gateId),
      request.optionId,
      request.note,
      request.commandId,
    );
    if (held !== undefined) held.wake.resolve();
    if (target === "FAILED" || target === "CANCELLED") {
      if (held !== undefined) await reservation.settled.promise;
      const terminal = this.store.getRun(request.runId);
      if (terminal === undefined || terminal.state !== target || !isTerminalState(terminal.state)) {
        throw new KerbsFlowError("GATE_TERMINAL_UNCONFIRMED", "the persisted run state did not confirm terminal gate resolution");
      }
    }
    return result;
  }

  private async waitForGateResolution(
    reservation: RunReservation,
    boundary: { gateId: GateId; taskId: TaskId; attemptId: AttemptId },
  ): Promise<number> {
    if (reservation.heldGate !== undefined) throw new KerbsFlowError("GATE_BOUNDARY_ALREADY_HELD", "Phase2 already owns a held human-gate boundary");
    const run = this.store.getRun(reservation.runId);
    const gate = this.store.getGate(boundary.gateId);
    if (run === undefined || run.state !== "HUMAN_GATE" || run.currentGateId !== boundary.gateId
      || gate === undefined || gate.status !== "open" || gate.gate.status !== "open"
      || gate.runId !== reservation.runId || gate.taskId !== boundary.taskId || gate.attemptId !== boundary.attemptId
      || this.executorBlockedGateResult(reservation.runId, run.currentTaskId, run.activeAttemptId, gate) === undefined) {
      throw new KerbsFlowError("GATE_BOUNDARY_UNPROVEN", "Phase2 may hold only the persisted executor-blocked gate for its exact task and attempt");
    }
    const held: HeldGateBoundary = { ...boundary, wake: deferred<void>() };
    reservation.heldGate = held;
    const pendingBoundary = reservation.gateResolutionClaim?.pendingBoundary;
    if (reservation.gateResolutionClaim?.request.runId === reservation.runId && pendingBoundary !== undefined) {
      pendingBoundary.registration.resolve({ held, exact: sameGateBoundary(pendingBoundary.expected, held) });
    }
    try {
      while (true) {
        const current = this.store.getRun(reservation.runId);
        if (current === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${reservation.runId} disappeared at its human-gate boundary`);
        if (current.state !== "HUMAN_GATE" || current.currentGateId !== boundary.gateId) return current.stateVersion;
        if (reservation.startupBlocked || reservation.driveSettled) {
          throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "the live Phase2 drive settled before its held gate boundary completed");
        }
        if (reservation.cancelRequested || reservation.pauseClaim !== undefined) {
          await this.checkpoint(reservation);
          continue;
        }
        const wake = held.wake;
        await Promise.race([wake.promise, reservation.settled.promise]);
        if (held.wake === wake) held.wake = deferred<void>();
        await this.checkpoint(reservation);
      }
    } finally {
      if (reservation.heldGate === held) delete reservation.heldGate;
    }
  }

  private executorBlockedGateResult(
    runId: RunId,
    currentTaskId: TaskId | null,
    activeAttemptId: AttemptId | null,
    gate: StoredGate,
  ): ExecutorResult | undefined {
    if (gate.taskId === null || gate.attemptId === null || currentTaskId !== gate.taskId || activeAttemptId !== gate.attemptId) return undefined;
    const attempt = this.store.getAttempt(gate.attemptId);
    if (attempt === undefined || attempt.runId !== runId || attempt.taskId !== gate.taskId || attempt.lifecycle !== "BLOCKED" || attempt.outcomeJson === null) return undefined;
    let result: ExecutorResult;
    try {
      result = parseExecutorResult(JSON.parse(attempt.outcomeJson));
    } catch {
      return undefined;
    }
    if (result.runId !== runId || result.taskId !== gate.taskId || result.attemptId !== gate.attemptId
      || result.outcome !== "blocked" || result.failureClass === null
      || result.humanGate?.gateId !== gate.gateId || result.humanGate.taskId !== gate.taskId || result.humanGate.attemptId !== gate.attemptId) return undefined;
    return result;
  }


  private async finishPause(reservation: RunReservation, claim: PauseClaim): Promise<CommandResult> {
    await Promise.race([claim.quiescent.promise, reservation.settled.promise]);
    if (reservation.cancelRequested || reservation.pauseClaim !== claim) {
      throw new KerbsFlowError("PAUSE_SUPERSEDED", "Cancel superseded Pause before PAUSED could be committed");
    }
    if (reservation.driveSettled) throw new KerbsFlowError("RUN_DRIVE_NOT_PAUSABLE", "Phase2 drive settled before reaching a held control checkpoint");
    const run = this.store.getRun(reservation.runId);
    if (run === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${reservation.runId} disappeared during Pause`);
    const attempt = run.activeAttemptId === null ? undefined : this.store.getAttempt(run.activeAttemptId);
    if (attempt !== undefined && (attempt.lifecycle === "PREPARED" || attempt.lifecycle === "RUNNING" || attempt.lifecycle === "UNKNOWN")) {
      throw new KerbsFlowError("PAUSE_REQUIRES_QUIESCENT_RUN", "Pause cannot commit while an executor attempt is active or ambiguous");
    }
    if (isTerminalState(run.state)) throw new KerbsFlowError("PAUSE_NOT_ALLOWED", `cannot pause terminal state ${run.state}`);
    const result = this.core.pauseAfterQuiescence(
      reservation.runId,
      claim.request.expectedStateVersion,
      run.stateVersion,
      claim.request.idempotencyKey,
      claim.request.commandId,
    );
    claim.status = "paused";
    return result;
  }

  private async finishCancel(reservation: RunReservation, request: CoordinatorCancelRequest): Promise<CommandResult> {
    const initial = this.store.getRun(request.runId);
    if (initial === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} does not exist`);
    if (isTerminalState(initial.state)) {
      throw new KerbsFlowError("CANCEL_NOT_ALLOWED", `run ${request.runId} is already terminal at ${initial.state}`);
    }

    const attempt = initial.activeAttemptId === null ? undefined : this.store.getAttempt(initial.activeAttemptId);
    const nonterminalAttempt = attempt !== undefined && (attempt.lifecycle === "PREPARED" || attempt.lifecycle === "RUNNING" || attempt.lifecycle === "UNKNOWN");
    const descriptor = nonterminalAttempt && attempt.adapterDescriptorJson !== null
      ? parseAdapterDescriptor(JSON.parse(attempt.adapterDescriptorJson))
      : undefined;
    const realAttempt = nonterminalAttempt && descriptor?.adapter !== "fake";

    if (realAttempt && attempt !== undefined) {
      let intent = this.store.getCancellationIntent(attempt.attemptId);
      if (intent === undefined) {
        try {
          this.core.requestRealCancellation(
            request.runId,
            request.expectedStateVersion,
            internalCancellationKey(request.idempotencyKey, "request"),
            request.reason,
            asCommandId(this.ids.next("command")),
            initial.stateVersion,
            { commandId: request.commandId, idempotencyKey: request.idempotencyKey, expectedStateVersion: request.expectedStateVersion },
          );
        } catch (error) {
          if (!(error instanceof KerbsFlowError) || error.code !== "ATTEMPT_NOT_ACTIVE") throw error;
          const latest = this.store.getAttempt(attempt.attemptId);
          if (latest === undefined || latest.lifecycle === "PREPARED" || latest.lifecycle === "RUNNING" || latest.lifecycle === "UNKNOWN") throw error;
          await this.waitForCancelBoundary(reservation);
          const current = this.store.getRun(request.runId);
          if (current === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared during Cancel`);
          return this.core.cancelAfterQuiescence(request.runId, request.expectedStateVersion, current.stateVersion, request.idempotencyKey, request.reason, request.commandId);
        }
        intent = this.store.getCancellationIntent(attempt.attemptId);
      }
      if (intent === undefined) {
        throw new KerbsFlowError("CANCELLATION_INTENT_REQUIRED", "real nonterminal attempt lacks durable cancellation intent");
      }
      if (intent.requestCommandId !== request.commandId || intent.requestIdempotencyKey !== request.idempotencyKey
        || intent.requestExpectedStateVersion !== request.expectedStateVersion || intent.reason !== request.reason) {
        throw new KerbsFlowError("CANCELLATION_COMMAND_CONFLICT", "the active attempt already belongs to a different external Cancel identity, precondition, or reason");
      }
      if (!reservation.startupBlocked && descriptor !== undefined && intent.status === "REQUESTED"
        && !reservation.signalledAttempts.has(attempt.attemptId)) {
        reservation.signalledAttempts.add(attempt.attemptId);
        const current = this.store.getRun(request.runId);
        if (current === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared before cancellation signal`);
        try {
          this.core.signalRealCancellation(request.runId, current.stateVersion, internalCancellationKey(request.idempotencyKey, "signal"));
        } catch (error) {
          const afterSignal = this.store.getCancellationIntent(attempt.attemptId);
          if (afterSignal === undefined || afterSignal.status === "REQUESTED") throw error;
        }
      }
      await this.waitForCancelBoundary(reservation, this.profile.executionTimeoutMs);
      const current = this.store.getRun(request.runId);
      if (current === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared before cancellation reconciliation`);
      return this.core.finalizeCoordinatedCancellation(parseCancelCommand(request), current.stateVersion);
    }

    await this.waitForCancelBoundary(reservation);
    const current = this.store.getRun(request.runId);
    if (current === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared during Cancel`);
    return this.core.cancelAfterQuiescence(request.runId, request.expectedStateVersion, current.stateVersion, request.idempotencyKey, request.reason, request.commandId);
  }

  private async waitForCancelBoundary(reservation: RunReservation, timeoutMs?: number): Promise<void> {
    if (reservation.startupBlocked || reservation.driveSettled) return;
    const boundary = Promise.race([reservation.cancelCheckpoint.promise, reservation.settled.promise]);
    if (timeoutMs === undefined) {
      await boundary;
    } else {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([boundary, new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); })]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
  }

  private async checkpoint(reservation: RunReservation): Promise<number> {
    while (true) {
      if (reservation.cancelRequested) {
        reservation.cancelCheckpoint.resolve();
        reservation.pauseClaim?.quiescent.resolve();
        reservation.pauseClaim?.resume.resolve("cancel");
        reservation.pauseClaim?.resumeClaim?.acknowledgement.resolve({ kind: "cancelled" });
        throw new Phase2DriveControlStop();
      }
      const pause = reservation.pauseClaim;
      if (pause === undefined) return this.store.getRun(reservation.runId)?.stateVersion ?? 0;
      pause.quiescent.resolve();
      const decision = await pause.resume.promise;
      const resume = pause.resumeClaim;
      if (decision === "cancel" || reservation.cancelRequested) {
        resume?.acknowledgement.resolve({ kind: "cancelled" });
        reservation.cancelCheckpoint.resolve();
        throw new Phase2DriveControlStop();
      }
      if (resume === undefined) {
        if (reservation.pauseClaim !== pause) continue;
        throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "Pause checkpoint woke without an owned Resume request");
      }
      let result: CommandResult;
      try {
        if (this.reservation !== reservation || reservation.startupBlocked || reservation.driveSettled
          || reservation.pauseClaim !== pause || pause.status !== "resuming" || pause.resumeClaim !== resume
          || resume.request.runId !== reservation.runId) {
          throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "Resume no longer owns its exact live Pause checkpoint");
        }
        const request = resume.request;
        const run = this.assertRequestVersion(request.runId, request.expectedStateVersion);
        if (run.state !== "PAUSED" || run.pauseContract === null) {
          throw new KerbsFlowError("RESUME_NOT_PAUSED", "Resume requires its persisted Pause boundary at the checkpoint");
        }
        result = this.core.resume(request.runId, request.expectedStateVersion, request.idempotencyKey, request.commandId);
      } catch (error) {
        resume.acknowledgement.resolve({ kind: "error", error });
        if (this.reservation === reservation && reservation.pauseClaim === pause && pause.resumeClaim === resume
          && !reservation.startupBlocked && !reservation.driveSettled && this.store.getRun(reservation.runId)?.state === "PAUSED") {
          delete pause.resumeClaim;
          pause.status = "paused";
          pause.resume = deferred<"resume" | "cancel">();
          continue;
        }
        throw error;
      }
      resume.acknowledgement.resolve({ kind: "resumed", result });
      if (reservation.pauseClaim === pause) delete reservation.pauseClaim;
      this.reconcileTerminalReservation(reservation);
      return result.stateVersion;
    }
  }

  private async claimFailureDisposition(reservation: RunReservation): Promise<FailureDispositionBoundary> {
    while (true) {
      await this.checkpoint(reservation);
      if (this.reservation !== reservation || reservation.startupBlocked || reservation.driveSettled) {
        throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "failure disposition requires the live owned Phase2 drive");
      }
      if (reservation.pauseClaim !== undefined || reservation.cancelClaim !== undefined || reservation.cancelRequested) continue;
      if (reservation.gateResolutionClaim !== undefined || reservation.heldGate !== undefined || reservation.failureDispositionClaim !== undefined || reservation.executionDispatchClaim !== undefined) {
        throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another control command already owns this run's control boundary");
      }
      const run = this.store.getRun(reservation.runId);
      if (run === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${reservation.runId} disappeared before failure disposition`);
      const claim: FailureDispositionClaim = { stateVersion: run.stateVersion };
      reservation.failureDispositionClaim = claim;
      return {
        stateVersion: claim.stateVersion,
        release: () => {
          if (reservation.failureDispositionClaim === claim) {
            delete reservation.failureDispositionClaim;
            this.reconcileTerminalReservation(reservation);
          }
        },
      };
    }
  }

  private requireReservation(runId: RunId): RunReservation {
    const reservation = this.reservation;
    if (reservation === undefined || reservation.runId !== runId) {
      throw new KerbsFlowError("RUN_NOT_OWNED", `run ${runId} does not own the coordinator drive reservation`);
    }
    return reservation;
  }

  private async claimExecutionDispatch(reservation: RunReservation): Promise<ExecutionDispatchBoundary> {
    while (true) {
      await this.checkpoint(reservation);
      if (this.reservation !== reservation || reservation.startupBlocked || reservation.driveSettled) {
        throw new KerbsFlowError("RUN_CONTINUATION_UNAVAILABLE", "execution dispatch requires the live owned Phase2 drive");
      }
      if (reservation.pauseClaim !== undefined || reservation.cancelClaim !== undefined || reservation.cancelRequested) continue;
      if (reservation.gateResolutionClaim !== undefined || reservation.heldGate !== undefined || reservation.failureDispositionClaim !== undefined || reservation.executionDispatchClaim !== undefined) {
        throw new KerbsFlowError("CONTROL_COMMAND_IN_PROGRESS", "another control command already owns this run's control boundary");
      }
      const run = this.store.getRun(reservation.runId);
      if (run === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${reservation.runId} disappeared before execution dispatch`);
      const claim: ExecutionDispatchClaim = { stateVersion: run.stateVersion };
      reservation.executionDispatchClaim = claim;
      return {
        stateVersion: claim.stateVersion,
        release: () => {
          if (reservation.executionDispatchClaim === claim) {
            delete reservation.executionDispatchClaim;
            this.reconcileTerminalReservation(reservation);
          }
        },
      };
    }
  }

  private reconcileTerminalReservation(reservation = this.reservation): void {
    if (reservation === undefined || this.reservation !== reservation || (!reservation.startupBlocked && !reservation.driveSettled)
      || reservation.pauseClaim !== undefined || reservation.cancelClaim !== undefined || reservation.cancelRequested
      || reservation.gateResolutionClaim !== undefined || reservation.heldGate !== undefined || reservation.failureDispositionClaim !== undefined
      || reservation.executionDispatchClaim !== undefined) return;

    const run = this.store.getRun(reservation.runId);
    if (this.reservation === reservation && run?.runId === reservation.runId && isTerminalState(run.state)) {
      this.reservation = undefined;
    }
  }

  private assertRequestVersion(runId: RunId, expectedStateVersion: number) {
    const run = this.store.getRun(runId);
    if (run === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${runId} does not exist`);
    if (run.stateVersion !== expectedStateVersion) {
      throw new StateVersionConflictError(runId, expectedStateVersion, run.stateVersion);
    }
    return run;
  }

  private binding(runId: RunId, taskId: TaskId): RunLaunchBinding {
    return {
      runId,
      taskId,
      canonicalRepositoryPath: this.profile.canonicalRepositoryPath,
      launchProfileId: this.profile.launchProfileId,
      launchProfileHash: this.profile.launchProfileHash,
    };
  }

  private driveRequest(runId: RunId, taskId: TaskId, objective: string): Phase2LoopRequest {
    return {
      runId,
      taskId,
      objective,
      repositoryPath: this.profile.canonicalRepositoryPath,
      ...(this.profile.expectedBaseOid === undefined ? {} : { expectedBaseOid: this.profile.expectedBaseOid }),
      focusedCheck: this.profile.focusedCheck,
      ...(this.profile.phaseCheck === undefined ? {} : { phaseCheck: this.profile.phaseCheck }),
      executionTimeoutMs: this.profile.executionTimeoutMs,
      ...(this.profile.failurePolicy === undefined ? {} : { failurePolicy: this.profile.failurePolicy }),
      ...(this.profile.semanticReview === undefined ? {} : { semanticReview: this.profile.semanticReview }),
    };
  }

}

function canonicalTrustedLaunchProfile(value: TrustedLaunchProfile): TrustedLaunchProfile {
  if (!/^[a-f0-9]{64}$/.test(value.launchProfileHash)) {
    throw new KerbsFlowError("LAUNCH_PROFILE_INVALID", "trusted launch profile hash must be a lowercase SHA-256 digest");
  }
  if (value.launchProfileId.length === 0 || value.launchProfileId.length > 256 || value.launchProfileId !== value.launchProfileId.trim()) {
    throw new KerbsFlowError("LAUNCH_PROFILE_INVALID", "trusted launch profile ID must be trimmed and at most 256 characters");
  }
  if (!Number.isSafeInteger(value.executionTimeoutMs) || value.executionTimeoutMs <= 0) {
    throw new KerbsFlowError("LAUNCH_PROFILE_INVALID", "trusted execution timeout must be a positive safe integer");
  }
  let canonicalRepositoryPath: string;
  try {
    canonicalRepositoryPath = realpathSync(value.canonicalRepositoryPath);
    if (!statSync(canonicalRepositoryPath).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new KerbsFlowError("LAUNCH_PROFILE_INVALID", "trusted repository path must resolve to an existing directory");
  }
  const focusedCheck = Object.freeze({ ...value.focusedCheck, args: [...value.focusedCheck.args] });
  const phaseCheck = value.phaseCheck === undefined
    ? undefined
    : Object.freeze({ ...value.phaseCheck, args: [...value.phaseCheck.args] });
  const failurePolicy = value.failurePolicy === undefined
    ? undefined
    : Object.freeze({
      ...value.failurePolicy,
      ...(value.failurePolicy.transientFailureClasses === undefined ? {} : { transientFailureClasses: [...value.failurePolicy.transientFailureClasses] }),
      ...(value.failurePolicy.higherCodexRoute === undefined ? {} : { higherCodexRoute: Object.freeze({ ...value.failurePolicy.higherCodexRoute }) }),
    });
  const semanticReview = value.semanticReview === undefined ? undefined : Object.freeze({ ...value.semanticReview });
  return Object.freeze({
    launchProfileId: value.launchProfileId,
    launchProfileHash: value.launchProfileHash,
    canonicalRepositoryPath,
    ...(value.expectedBaseOid === undefined ? {} : { expectedBaseOid: value.expectedBaseOid }),
    focusedCheck,
    ...(phaseCheck === undefined ? {} : { phaseCheck }),
    executionTimeoutMs: value.executionTimeoutMs,
    ...(failurePolicy === undefined ? {} : { failurePolicy }),
    ...(semanticReview === undefined ? {} : { semanticReview }),
    planningMaster: value.planningMaster,
  });
}

function newReservation(runId: RunId, startupBlocked: boolean): RunReservation {
  return {
    runId,
    startupBlocked,
    driveSettled: startupBlocked,
    settled: deferred<void>(),
    cancelCheckpoint: deferred<void>(),
    cancelRequested: false,
    signalledAttempts: new Set(),
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function sameControlRequest(left: CoordinatorControlRequest, right: CoordinatorControlRequest): boolean {
  return left.runId === right.runId && left.commandId === right.commandId && left.idempotencyKey === right.idempotencyKey
    && left.expectedStateVersion === right.expectedStateVersion;
}

function sameCancelRequest(left: CoordinatorCancelRequest, right: CoordinatorCancelRequest): boolean {
  return sameControlRequest(left, right) && left.reason === right.reason;
}

function sameGateResolutionRequest(left: CoordinatorGateResolutionRequest, right: CoordinatorGateResolutionRequest): boolean {
  return sameControlRequest(left, right) && left.gateId === right.gateId && left.optionId === right.optionId && left.note === right.note;
}

function sameGateBoundary(left: GateBoundaryIdentity, right: GateBoundaryIdentity): boolean {
  return left.gateId === right.gateId && left.taskId === right.taskId && left.attemptId === right.attemptId;
}

function internalCancellationKey(idempotencyKey: string, phase: "request" | "signal" | "reconcile"): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return `run-coordinator:${digest}:${phase}`;
}

function parseCancelCommand(request: CoordinatorCancelRequest) {
  return parseCommand({
    schemaVersion: CONTRACT_VERSIONS.command,
    commandId: request.commandId,
    idempotencyKey: request.idempotencyKey,
    runId: request.runId,
    expectedStateVersion: request.expectedStateVersion,
    kind: "cancel",
    reason: request.reason,
  });
}
