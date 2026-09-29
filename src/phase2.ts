import {
  CONTRACT_VERSIONS,
  type ExecutorResult,
  type AttemptId,
  type FailureClassification,
  type GateId,
  type CommandResult,
  type PlanningDecision,
  type ReviewDecision,
  type RunId,
  type TaskId,
  asDecisionId,
  asReviewId,
  parsePlanningDecision,
  parseExecutorResult,
} from "./contracts.js";
import { CanonicalIntentGuard } from "./canonical.js";
import { KerbsFlowCore } from "./core.js";
import { KerbsFlowError } from "./errors.js";
import { GitWorktreeManager, type RepositoryIntake, type WorktreeRecord } from "./git.js";
import { FailurePolicyCoordinator, escalatePlanningRoute, type FailureAction } from "./phase3.js";
import {
  buildExecutorPrompt,
  noneSteerObservation,
  type PlanningMaster,
  type ReworkFailureContext,
  type PlanningMasterResult,
  type PlanningSteerObservation,
} from "./planning.js";
import {
  PHASE4_ROUTING_POLICY,
  assertTrustedRoutingDecision,
  createAttemptRoutingProvenance,
  PolicyRouter,
  type TrustedRoutingDecision,
} from "./routing.js";
import { StateStore, type StoredFailureOccurrence } from "./persistence.js";
import { IndependentSemanticReviewer } from "./reviewer.js";
import type { IdSource } from "./runtime.js";
import { FocusedVerifier, type FocusedCheckCommand, type FocusedVerificationResult, type PhaseCheckCommand } from "./verifier.js";

export interface Phase2LoopRequest {
  runId: RunId;
  taskId: TaskId;
  objective: string;
  repositoryPath: string;
  expectedBaseOid?: string;
  planningDecision?: PlanningDecision;
  focusedCheck: FocusedCheckCommand;
  phaseCheck?: PhaseCheckCommand;
  executionTimeoutMs: number;
  failurePolicy?: {
    transientFailureClasses?: FailureClassification[];
    higherCodexRoute?: { model: string; reasoning?: string };
  };
  semanticReview?: { model: string; reasoning?: string; canonicalContract: string };
  routingDecision?: TrustedRoutingDecision;
}

export interface Phase2LoopResult {
  verdict: "PASS" | "REWORK" | "HUMAN_GATE" | "RECOVERY" | "FAILED" | "CANCELLED";
  intake?: RepositoryIntake;
  worktree?: WorktreeRecord;
  executorResult?: ExecutorResult;
  verification?: FocusedVerificationResult;
  intakeIssue?: { code: string; summary: string };
  attempts?: number;
  stateVersion: number;
}

export interface Phase2DriveControls {
  checkpoint?: () => Promise<number | void>;
  waitForGateResolution?: (boundary: { gateId: GateId; taskId: TaskId; attemptId: AttemptId }) => Promise<number>;
  planningMaster?: PlanningMaster;
}

export class Phase2Loop {
  constructor(
    private readonly core: KerbsFlowCore,
    private readonly store: StateStore,
    private readonly git: GitWorktreeManager,
    private readonly verifier: FocusedVerifier,
    private readonly ids: IdSource,
    private readonly semanticReviewer?: IndependentSemanticReviewer,
    private readonly planningMaster?: PlanningMaster,
  ) {}

  async run(request: Phase2LoopRequest): Promise<Phase2LoopResult> {
    this.assertRequest(request, this.planningMaster);
    this.core.startRun(request.runId, request.objective, `${request.runId}:start`);
    return this.driveStarted(request);
  }

  async driveStarted(request: Phase2LoopRequest, controls: Phase2DriveControls = {}): Promise<Phase2LoopResult> {
    const planningMaster = controls.planningMaster ?? this.planningMaster;
    this.assertRequest(request, planningMaster);
    const started = this.store.getRun(request.runId);
    if (started === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} was not accepted before Phase2Loop.driveStarted`);
    if (started.state !== "INTAKE" || this.store.getWorktree(request.runId) !== undefined || started.currentTaskId !== null || started.activeAttemptId !== null) {
      throw new KerbsFlowError("PHASE2_START_BOUNDARY_INVALID", "already-started Phase2 drive requires a fresh INTAKE run with no worktree, task, or attempt");
    }
    let command: Pick<CommandResult, "to" | "stateVersion"> = { to: started.state, stateVersion: started.stateVersion };
    const checkpoint = async (): Promise<void> => {
      const observed = await controls.checkpoint?.();
      const current = observed ?? this.store.getRun(request.runId)?.stateVersion;
      if (current !== undefined) command = { ...command, stateVersion: current };
    };
    await checkpoint();
    let intake: RepositoryIntake;
    try {
      intake = this.git.intake(request.repositoryPath, request.expectedBaseOid === undefined ? {} : { expectedBaseOid: request.expectedBaseOid });
    } catch (error) {
      if (!(error instanceof KerbsFlowError)) throw error;
      const gateable = error.code === "ORIGINAL_CHECKOUT_DIRTY" || error.code === "BASE_OID_MISMATCH"
        || error.code === "GIT_EXECUTABLE_CONFIG_GATE" || error.code === "GIT_CHECKOUT_FILTER_GATE";
      command = gateable
        ? this.core.gateIntake(request.runId, command.stateVersion, `${request.runId}:intake-gate`, error.code, error.message)
        : this.core.failIntake(request.runId, command.stateVersion, `${request.runId}:intake-failed`, error.code, error.message);
      return { verdict: gateable ? "HUMAN_GATE" : "FAILED", intakeIssue: { code: error.code, summary: error.message }, stateVersion: command.stateVersion };
    }
    await checkpoint();
    new CanonicalIntentGuard(this.store).capture(request.runId, intake.repositoryPath, intake.baseOid);
    command = this.core.completeIntake(request.runId, command.stateVersion, `${request.runId}:intake`);
    await checkpoint();
    const worktree = this.git.create(intake, request.runId);
    this.store.recordWorktree({ runId: request.runId, repositoryPath: worktree.repositoryPath, gitCommonDirectory: worktree.gitCommonDirectory, worktreeGitDirectory: worktree.worktreeGitDirectory, baseOid: worktree.baseOid, branch: worktree.branch, worktreePath: worktree.path, markerPath: worktree.markerPath, createdAt: worktree.createdAt });
    await checkpoint();
    const planned = await this.acceptInitialPlan(request, command.stateVersion, planningMaster, controls.checkpoint);
    command = planned.command;
    await checkpoint();
    let decision = planned.decision;
    let currentRoutingDecision = planned.routingDecision;
    this.persistAcceptedRoutingDecision(decision, currentRoutingDecision);
    let attempts = 0;
    let nextSelectionReason = currentRoutingDecision?.selectionReason ?? "pre-Phase-4 planning route";
    let nextEscalationReason: string | undefined;

    while (true) {
      await checkpoint();
      this.assertRoutingForPlanningDecision(decision, currentRoutingDecision);
      attempts += 1;
      command = this.core.prepareExecution(request.runId, command.stateVersion, `${request.runId}:prepare:${attempts}`);
      if (currentRoutingDecision !== undefined) {
        const attemptId = this.store.readModel(request.runId)?.run.activeAttemptId;
        if (attemptId === null || attemptId === undefined) throw new KerbsFlowError("ATTEMPT_REQUIRED", "routing provenance requires the prepared attempt");
        this.store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
          routingDecision: currentRoutingDecision,
          planningDecision: decision,
          attemptId,
          selectionReason: nextSelectionReason,
          ...(nextEscalationReason === undefined ? {} : { escalationReason: nextEscalationReason }),
        }));
      }
      command = await this.core.beginAttempt(request.runId, command.stateVersion, `${request.runId}:begin:${attempts}`, worktree.path, { prompt: buildExecutorPrompt(decision), timeoutMs: request.executionTimeoutMs });
      command = await this.core.completeAttempt(request.runId, command.stateVersion, `${request.runId}:complete:${attempts}`);
      await checkpoint();
      const afterExecution = this.store.readModel(request.runId);
      if (afterExecution === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared`);
      if (afterExecution.run.state === "HUMAN_GATE") {
        const gate = afterExecution.currentGate;
        const blockedAttempt = afterExecution.activeAttempt;
        const blockedResult = blockedAttempt?.outcomeJson === null || blockedAttempt?.outcomeJson === undefined
          ? undefined
          : parseExecutorResult(JSON.parse(blockedAttempt.outcomeJson));
        const heldExecutorGate = controls.waitForGateResolution !== undefined
          && gate?.status === "open" && gate.gate.status === "open"
          && gate.taskId === request.taskId && gate.attemptId !== null
          && blockedAttempt?.lifecycle === "BLOCKED" && blockedAttempt.attemptId === gate.attemptId
          && blockedResult?.runId === request.runId && blockedResult.taskId === request.taskId
          && blockedResult.attemptId === gate.attemptId && blockedResult.outcome === "blocked"
          && blockedResult.failureClass !== null
          && blockedResult.humanGate?.gateId === gate.gateId
          && blockedResult.humanGate.taskId === gate.taskId
          && blockedResult.humanGate.attemptId === gate.attemptId;
        if (!heldExecutorGate || gate === undefined || blockedAttempt === undefined || blockedResult === undefined) {
          return { verdict: "HUMAN_GATE", intake, worktree, attempts, stateVersion: afterExecution.run.stateVersion };
        }

        const resolvedStateVersion = await controls.waitForGateResolution!({ gateId: gate.gateId, taskId: request.taskId, attemptId: blockedAttempt.attemptId });
        await checkpoint();
        const resolvedModel = this.store.readModel(request.runId);
        if (resolvedModel === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared after human-gate resolution`);
        if (resolvedModel.run.stateVersion < resolvedStateVersion) {
          throw new KerbsFlowError("PHASE2_GATE_RESOLUTION_VERSION_INVALID", "the persisted run version moved behind its held-gate checkpoint");
        }
        if (resolvedModel.run.state === "REWORK") {
          const resolvedGate = this.store.getGate(gate.gateId);
          if (resolvedModel.run.currentTaskId !== request.taskId
            || resolvedModel.run.activeAttemptId !== blockedAttempt.attemptId
            || resolvedModel.activeAttempt?.attemptId !== blockedAttempt.attemptId
            || resolvedModel.activeAttempt.outcomeJson !== blockedAttempt.outcomeJson
            || resolvedGate?.status !== "resolved"
            || resolvedGate.gate.resolution?.optionId === undefined
            || !gate.gate.options.some((option) => option.id === resolvedGate.gate.resolution!.optionId && option.target === "REWORK")) {
            throw new KerbsFlowError("PHASE2_GATE_REWORK_BOUNDARY_INVALID", "the persisted REWORK transition no longer matches the held executor result and gate option");
          }
          const failure: ReworkFailureContext = {
            failureClass: blockedResult.failureClass!,
            reasonCode: gate.gate.reasonCode,
            summary: gate.gate.summary,
            resultingAction: "rework",
          };
          nextEscalationReason = undefined;
          nextSelectionReason = "human gate resolution selected bounded rework";
          const reworked = await this.acceptRework(
            request,
            resolvedModel.run.stateVersion,
            decision,
            failure,
            `${request.runId}:human-gate-rework:${attempts}`,
            currentRoutingDecision,
            nextSelectionReason,
            planningMaster,
            controls.checkpoint,
          );
          command = reworked.command;
          decision = reworked.decision;
          currentRoutingDecision = reworked.routingDecision;
          this.persistAcceptedRoutingDecision(decision, currentRoutingDecision);
          continue;
        }
        if (resolvedModel.run.state === "FAILED") {
          return { verdict: "FAILED", intake, worktree, attempts, stateVersion: resolvedModel.run.stateVersion };
        }
        if (resolvedModel.run.state === "CANCELLED") {
          return { verdict: "CANCELLED", intake, worktree, attempts, stateVersion: resolvedModel.run.stateVersion };
        }
        throw new KerbsFlowError("PHASE2_GATE_RESOLUTION_UNSUPPORTED", `held executor gate resolved to unsupported state ${resolvedModel.run.state}`);
      }
      if (afterExecution.run.state === "RECOVERY") return { verdict: "RECOVERY", intake, worktree, attempts, stateVersion: afterExecution.run.stateVersion };
      if (afterExecution.run.state !== "VERIFY_FOCUSED" || afterExecution.activeAttempt?.outcomeJson === null || afterExecution.activeAttempt === undefined) {
        throw new KerbsFlowError("PHASE2_BOUNDARY_INVALID", `executor completed at unexpected state ${afterExecution.run.state}`);
      }
      const executorResult = parseExecutorResult(JSON.parse(afterExecution.activeAttempt.outcomeJson));
      let focused: FocusedVerificationResult;
      try {
        await checkpoint();
        focused = await this.verifier.verify(intake, worktree, decision, executorResult, request.focusedCheck);
      } catch (error) {
        if (!(error instanceof KerbsFlowError) || error.code !== "VERIFICATION_SANDBOX_UNAVAILABLE") throw error;
        await checkpoint();
        command = this.core.gateVerificationSandboxUnavailable(request.runId, command.stateVersion, `${request.runId}:focused-sandbox-gate:${attempts}`);
        return { verdict: "HUMAN_GATE", intake, worktree, executorResult, attempts, stateVersion: command.stateVersion };
      }
      await checkpoint();
      command = this.core.recordFocusedValidation(request.runId, command.stateVersion, `${request.runId}:focused:${attempts}`, focused.bundle);
      await checkpoint();
      if (focused.bundle.outcome !== "passed") {
        const policy = this.recordFailure(request, decision, executorResult, focused, "focused_verification");
        command = this.core.review(request.runId, command.stateVersion, `${request.runId}:focused-policy:${attempts}`, this.reviewForPolicy(request, policy));
        const terminal = this.policyTerminalResult(command.to, intake, worktree, executorResult, focused, attempts, command.stateVersion);
        if (terminal !== undefined) return terminal;
        const reworkFailure = this.reworkFailureContext(request, policy, focused.bundle.summary);
        if (policy.resultingAction === "escalate") {
          nextEscalationReason = reworkFailure.resultingAction === "escalate" ? reworkFailure.escalationReason : undefined;
          nextSelectionReason = `escalated after ${categoryLabel("focused_verification")}`;
        } else {
          nextEscalationReason = undefined;
          nextSelectionReason = `failure policy selected ${policy.resultingAction} after focused verification`;
        }
        const reworked = await this.acceptRework(request, command.stateVersion, decision, reworkFailure, `${request.runId}:continue:${attempts}`, currentRoutingDecision, nextSelectionReason, planningMaster, controls.checkpoint);
        command = reworked.command;
        decision = reworked.decision;
        currentRoutingDecision = reworked.routingDecision;
        this.persistAcceptedRoutingDecision(decision, currentRoutingDecision);
        continue;
      }

      command = this.core.review(request.runId, command.stateVersion, `${request.runId}:focused-review:${attempts}`, {
        schemaVersion: CONTRACT_VERSIONS.reviewDecision,
        reviewId: asReviewId(this.ids.next("review")),
        runId: request.runId,
        taskId: request.taskId,
        outcome: "verify_phase",
        summary: "independent focused verification passed",
        evidenceRefs: [],
        reasonCode: "focused_validation_passed",
      });
      if (request.phaseCheck === undefined) {
        command = this.core.gateMissingPhaseValidation(request.runId, command.stateVersion, `${request.runId}:phase-plan-missing`);
        return { verdict: "HUMAN_GATE", intake, worktree, executorResult, verification: focused, attempts, stateVersion: command.stateVersion };
      }
      let phase: Awaited<ReturnType<FocusedVerifier["verifyPhase"]>>;
      try {
        await checkpoint();
        phase = await this.verifier.verifyPhase(intake, worktree, decision, executorResult, request.phaseCheck);
      } catch (error) {
        if (!(error instanceof KerbsFlowError) || error.code !== "VERIFICATION_SANDBOX_UNAVAILABLE") throw error;
        await checkpoint();
        command = this.core.gateVerificationSandboxUnavailable(request.runId, command.stateVersion, `${request.runId}:phase-sandbox-gate:${attempts}`);
        return { verdict: "HUMAN_GATE", intake, worktree, executorResult, verification: focused, attempts, stateVersion: command.stateVersion };
      }
      await checkpoint();
      this.store.recordAuthoritativePhaseValidation(phase.authoritative);
      await checkpoint();
      if (phase.verification.bundle.outcome !== "passed") {
        const policy = this.recordFailure(request, decision, executorResult, phase.verification, "phase_verification");
        command = this.core.applyPhaseFailurePolicy(request.runId, command.stateVersion, `${request.runId}:phase-policy:${attempts}`, policy.fingerprint);
        const terminal = this.policyTerminalResult(command.to, intake, worktree, executorResult, phase.verification, attempts, command.stateVersion);
        if (terminal !== undefined) return terminal;
        const reworkFailure = this.reworkFailureContext(request, policy, phase.verification.bundle.summary);
        if (policy.resultingAction === "escalate") {
          nextEscalationReason = reworkFailure.resultingAction === "escalate" ? reworkFailure.escalationReason : undefined;
          nextSelectionReason = `escalated after ${categoryLabel("phase_verification")}`;
        } else {
          nextEscalationReason = undefined;
          nextSelectionReason = `failure policy selected ${policy.resultingAction} after phase verification`;
        }
        const reworked = await this.acceptRework(request, command.stateVersion, decision, reworkFailure, `${request.runId}:phase-continue:${attempts}`, currentRoutingDecision, nextSelectionReason, planningMaster, controls.checkpoint);
        command = reworked.command;
        decision = reworked.decision;
        currentRoutingDecision = reworked.routingDecision;
        this.persistAcceptedRoutingDecision(decision, currentRoutingDecision);
        continue;
      }

      let semanticReviewId: ReturnType<typeof asReviewId> | undefined;
      const semanticRequired = phase.verification.suspiciousSignals.some((signal) => !signal.blocksPass && signal.semanticReviewRequired);
      if (semanticRequired && this.semanticReviewer !== undefined && request.semanticReview !== undefined) {
        semanticReviewId = asReviewId(this.ids.next("review"));
        try {
          await checkpoint();
          await this.semanticReviewer.review({
            reviewAttemptId: semanticReviewId,
            runId: request.runId,
            taskId: request.taskId,
            attemptId: executorResult.attemptId,
            worktree,
            model: request.semanticReview.model,
            ...(request.semanticReview.reasoning === undefined ? {} : { reasoning: request.semanticReview.reasoning }),
            canonicalContextHash: decision.canonicalContextHash,
            canonicalContract: request.semanticReview.canonicalContract,
            diff: phase.verification.inspection.diff,
            validation: phase.verification.bundle,
            evidenceRefs: phase.verification.bundle.evidence.flatMap((evidence) => evidence.artifactRef === undefined ? [] : [evidence.artifactRef]),
            ...(providerSessionId(afterExecution.activeAttempt.providerIdentityJson) === undefined ? {} : { implementerProviderSessionId: providerSessionId(afterExecution.activeAttempt.providerIdentityJson)! }),
          });
        } catch {
          semanticReviewId = undefined;
        }
        await checkpoint();
      }
      command = this.core.completeTrustedPhaseValidation(request.runId, command.stateVersion, `${request.runId}:phase-close:${attempts}`, { validationId: phase.authoritative.bundle.validationId, ...(semanticReviewId === undefined ? {} : { semanticReviewId }) });
      return { verdict: command.to === "NEXT_PHASE" ? "PASS" : command.to === "REWORK" ? "REWORK" : command.to === "FAILED" ? "FAILED" : "HUMAN_GATE", intake, worktree, executorResult, verification: phase.verification, attempts, stateVersion: command.stateVersion };
    }
  }

  private assertRequest(request: Phase2LoopRequest, planningMaster: PlanningMaster | undefined): void {
    if (planningMaster !== undefined) {
      if (request.planningDecision !== undefined || request.routingDecision !== undefined) {
        throw new KerbsFlowError("PLANNING_AUTHORITY_CONFLICT", "Planning Master runs receive their decision and routing authority only from PlanningMasterResult");
      }
      return;
    }
    if (request.planningDecision === undefined) {
      throw new KerbsFlowError("PLANNING_DECISION_REQUIRED", "legacy Phase2Loop requests require a precomputed planning decision");
    }
    const decision = parsePlanningDecision(request.planningDecision);
    this.assertPlanningIdentity(decision, request);
    const routing = request.routingDecision === undefined ? undefined : assertTrustedRoutingDecision(request.routingDecision);
    this.assertRoutingForPlanningDecision(decision, routing);
  }

  private assertPlanningIdentity(decision: PlanningDecision, request: Phase2LoopRequest): void {
    if (decision.runId !== request.runId || decision.taskId !== request.taskId) {
      throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "planning decision runId/taskId do not match the Phase2Loop request");
    }
  }

  private assertRoutingForPlanningDecision(decision: PlanningDecision, routing: TrustedRoutingDecision | undefined): void {
    if (routing === undefined) {
      if (decision.policyVersion === PHASE4_ROUTING_POLICY) {
        throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "Phase 4 execution requires trusted routing authority for the accepted planning decision");
      }
      return;
    }
    const trusted = assertTrustedRoutingDecision(routing);
    if (trusted.runId !== decision.runId
      || trusted.taskId !== decision.taskId
      || trusted.planningDecisionId !== decision.decisionId
      || trusted.selected.adapter !== decision.route.adapter
      || trusted.selected.model !== decision.route.model
      || trusted.selected.reasoning !== decision.route.reasoning) {
      throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "trusted routing identity and selected route must exactly match the current planning decision");
    }
    const candidate = trusted.consideredRoutes.find((route) => (
      route.adapter === decision.route.adapter
      && route.model === decision.route.model
      && route.reasoning === decision.route.reasoning
      && route.available
      && route.suitable
      && route.capabilityHash !== undefined
    ));
    if (candidate === undefined) {
      throw new KerbsFlowError("ROUTING_CAPABILITY_MISMATCH", "the selected planning route lacks suitable trusted capability provenance");
    }
  }

  private assertRoutingDecisionCanBePersisted(routing: TrustedRoutingDecision | undefined): void {
    if (routing === undefined) return;
    const existing = this.store.getRoutingDecision(routing.planningDecisionId);
    if (existing !== undefined && JSON.stringify(existing.decision) !== JSON.stringify(routing)) {
      throw new KerbsFlowError("ROUTING_DECISION_CONFLICT", `planning decision ${routing.planningDecisionId} already has different persisted routing authority`);
    }
  }

  private persistAcceptedRoutingDecision(decision: PlanningDecision, routing: TrustedRoutingDecision | undefined): void {
    this.assertRoutingForPlanningDecision(decision, routing);
    if (routing !== undefined) this.store.recordRoutingDecision(routing);
  }

  private recordFailure(request: Phase2LoopRequest, decision: PlanningDecision, executorResult: ExecutorResult, verification: FocusedVerificationResult, category: "focused_verification" | "phase_verification"): StoredFailureOccurrence {
    const failureClass = verification.scopeViolations.length > 0 ? "scope_violation" : executorResult.failureClass ?? "validation_failure";
    const higher = request.failurePolicy?.higherCodexRoute;
    return new FailurePolicyCoordinator(this.store, this.core.configuration.effectiveMaxImplementationAttempts).recordAndDecide({
      runId: request.runId,
      taskId: request.taskId,
      attemptId: executorResult.attemptId,
      failureClass,
      transient: request.failurePolicy?.transientFailureClasses?.includes(failureClass) ?? false,
      causalDiagnosis: verification.scopeViolations.length === 0 && failureClass !== "requirement_or_architecture_ambiguity" && failureClass !== "security_or_privilege_gate",
      scopeUnchanged: verification.scopeViolations.length === 0,
      eligibleHigherRoute: higher !== undefined && (higher.model !== decision.route.model || higher.reasoning !== decision.route.reasoning),
      fingerprintInput: { failureClass, reasonCode: `${category}_failed`, diagnostic: verification.bundle.summary, category, checkIdentity: category === "phase_verification" ? request.phaseCheck?.commandId ?? "missing_phase_check" : request.focusedCheck.name },
      route: decision.route,
    });
  }

  private reviewForPolicy(request: Phase2LoopRequest, policy: StoredFailureOccurrence): ReviewDecision {
    const outcome = policy.resultingAction === "retry_same_route" || policy.resultingAction === "rework" || policy.resultingAction === "escalate" ? "rework" : policy.resultingAction === "failed" ? "failed" : "human_gate";
    return { schemaVersion: CONTRACT_VERSIONS.reviewDecision, reviewId: asReviewId(this.ids.next("review")), runId: request.runId, taskId: request.taskId, outcome, failureClass: policy.failureClass as FailureClassification, summary: `failure policy selected ${policy.resultingAction}`, evidenceRefs: [], reasonCode: policy.escalationReason ?? policy.resultingAction };
  }

  private policyTerminalResult(state: string, intake: RepositoryIntake, worktree: WorktreeRecord, executorResult: ExecutorResult, verification: FocusedVerificationResult, attempts: number, stateVersion: number): Phase2LoopResult | undefined {
    return state === "REWORK" ? undefined : { verdict: state === "FAILED" ? "FAILED" : "HUMAN_GATE", intake, worktree, executorResult, verification, attempts, stateVersion };
  }

  private observeSteer(runId: RunId): PlanningSteerObservation {
    const pending = this.store.getPendingSteerInstruction(runId);
    if (pending === undefined) {
      return noneSteerObservation();
    }
    return { instructionId: pending.instructionId, text: pending.text };
  }

  private reworkFailureContext(request: Phase2LoopRequest, policy: StoredFailureOccurrence, summary: string): ReworkFailureContext {
    const resultingAction = parseFailureAction(policy.resultingAction);
    const base = { failureClass: policy.failureClass, reasonCode: policy.reasonCode, summary };
    if (resultingAction === "escalate") {
      const higher = request.failurePolicy?.higherCodexRoute;
      if (higher === undefined) throw new KerbsFlowError("ESCALATION_ROUTE_REQUIRED", "policy selected escalation without an eligible Codex route");
      return Object.freeze({
        ...base,
        resultingAction,
        escalationReason: policy.escalationReason ?? "failure policy selected an eligible higher Codex route",
        requiredRoute: Object.freeze({
          adapter: "codex" as const,
          model: higher.model,
          ...(higher.reasoning === undefined ? {} : { reasoning: higher.reasoning }),
        }),
      });
    }
    return Object.freeze({ ...base, resultingAction });
  }

  private async acceptInitialPlan(
    request: Phase2LoopRequest,
    initialStateVersion: number,
    planningMaster: PlanningMaster | undefined,
    controlCheckpoint?: Phase2DriveControls["checkpoint"],
  ): Promise<{ command: ReturnType<KerbsFlowCore["plan"]>; decision: PlanningDecision; routingDecision?: TrustedRoutingDecision }> {
    let stateVersion = initialStateVersion;
    if (planningMaster === undefined) {
      if (request.planningDecision === undefined) throw new KerbsFlowError("PLANNING_DECISION_REQUIRED", "legacy Phase2Loop requests require a precomputed planning decision");
      const decision = parsePlanningDecision(request.planningDecision);
      this.assertPlanningIdentity(decision, request);
      const routingDecision = request.routingDecision === undefined ? undefined : assertTrustedRoutingDecision(request.routingDecision);
      this.assertRoutingForPlanningDecision(decision, routingDecision);
      this.assertRoutingDecisionCanBePersisted(routingDecision);
      const command = this.core.plan(request.runId, stateVersion, `${request.runId}:plan`, decision);
      return { command, decision, ...(routingDecision === undefined ? {} : { routingDecision }) };
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observed = await controlCheckpoint?.();
      if (observed !== undefined) stateVersion = observed;
      const steer = this.observeSteer(request.runId);
      const result = parsePlanningMasterResult(await planningMaster.planInitial({ runId: request.runId, taskId: request.taskId, objective: request.objective, steer }));
      const decision = result.decision;
      this.assertPlanningIdentity(decision, request);
      this.assertRoutingForPlanningDecision(decision, result.routingDecision);
      this.assertRoutingDecisionCanBePersisted(result.routingDecision);
      try {
        const command = this.core.plan(request.runId, stateVersion, attempt === 0 ? `${request.runId}:plan` : `${request.runId}:plan:retry`, decision, { instructionId: steer.instructionId, text: steer.text });
        return { command, decision, ...(result.routingDecision === undefined ? {} : { routingDecision: result.routingDecision }) };
      } catch (error) {
        if (!(error instanceof KerbsFlowError) || error.code !== "PLANNING_STEER_STALE") throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private async acceptRework(
    request: Phase2LoopRequest,
    stateVersion: number,
    baseDecision: PlanningDecision,
    failure: ReworkFailureContext,
    idempotencyKey: string,
    currentRoutingDecision: TrustedRoutingDecision | undefined,
    selectionReason: string,
    planningMaster: PlanningMaster | undefined,
    controlCheckpoint?: Phase2DriveControls["checkpoint"],
  ): Promise<{ command: ReturnType<KerbsFlowCore["reworkToReady"]>; decision: PlanningDecision; routingDecision?: TrustedRoutingDecision }> {
    if (planningMaster === undefined) {
      let decision = parsePlanningDecision(baseDecision);
      this.assertPlanningIdentity(decision, request);
      if (failure.resultingAction === "escalate") {
        decision = escalatePlanningRoute(decision, failure.requiredRoute);
      }
      assertFailurePolicyRoute(baseDecision, decision, failure);
      let routingDecision = currentRoutingDecision;
      if (routingDecision !== undefined && !routingMatchesPlanningDecision(routingDecision, decision)) {
        if (decision.decisionId === routingDecision.planningDecisionId) {
          decision = parsePlanningDecision({ ...decision, decisionId: asDecisionId(this.ids.next("decision")) });
        }
        routingDecision = new PolicyRouter().rebindTrustedSelection({ previous: routingDecision, planningDecision: decision, selectionReason });
      }
      this.assertRoutingForPlanningDecision(decision, routingDecision);
      this.assertRoutingDecisionCanBePersisted(routingDecision);
      const command = this.core.reworkToReady(request.runId, stateVersion, idempotencyKey, decision);
      const stored = this.store.getTask(request.taskId);
      const acceptedDecision = stored?.decision ?? decision;
      this.assertPlanningIdentity(acceptedDecision, request);
      this.assertRoutingForPlanningDecision(acceptedDecision, routingDecision);
      return { command, decision: acceptedDecision, ...(routingDecision === undefined ? {} : { routingDecision }) };
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observed = await controlCheckpoint?.();
      if (observed !== undefined) stateVersion = observed;
      const steer = this.observeSteer(request.runId);
      const prior = this.store.getTask(request.taskId)?.decision ?? baseDecision;
      const result = parsePlanningMasterResult(await planningMaster.planRework({ runId: request.runId, taskId: request.taskId, priorDecision: prior, failure, steer }));
      const corrected = result.decision;
      this.assertPlanningIdentity(corrected, request);
      let routingDecision = result.routingDecision;
      if (routingDecision !== undefined) this.assertRoutingForPlanningDecision(corrected, routingDecision);
      if (currentRoutingDecision !== undefined && routingMatchesPlanningDecision(currentRoutingDecision, corrected)) {
        routingDecision = currentRoutingDecision;
      }
      this.assertRoutingForPlanningDecision(corrected, routingDecision);
      this.assertRoutingDecisionCanBePersisted(routingDecision);
      try {
        assertFailurePolicyRoute(prior, corrected, failure);
        const attemptIdempotencyKey = attempt === 0 ? idempotencyKey : attempt === 1 ? `${idempotencyKey}:retry` : `${idempotencyKey}:retry:${attempt}`;
        const command = this.core.reworkToReady(request.runId, stateVersion, attemptIdempotencyKey, corrected, { instructionId: steer.instructionId, text: steer.text });
        return { command, decision: corrected, ...(routingDecision === undefined ? {} : { routingDecision }) };
      } catch (error) {
        if (!(error instanceof KerbsFlowError) || (error.code !== "PLANNING_STEER_STALE" && error.code !== "PLANNING_FAILURE_POLICY_ROUTE_MISMATCH")) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}

function parseFailureAction(value: string): FailureAction {
  switch (value) {
    case "retry_same_route":
    case "rework":
    case "escalate":
    case "human_gate":
    case "failed":
      return value;
    default:
      throw new KerbsFlowError("FAILURE_POLICY_ACTION_INVALID", `failure policy returned unsupported action ${value}`);
  }
}

function assertFailurePolicyRoute(prior: PlanningDecision, corrected: PlanningDecision, failure: ReworkFailureContext): void {
  const requiredRoute = failure.resultingAction === "escalate"
    ? failure.requiredRoute
    : failure.resultingAction === "retry_same_route"
      ? prior.route
      : undefined;
  if (requiredRoute !== undefined && !samePlanningRoute(corrected.route, requiredRoute)) {
    throw new KerbsFlowError("PLANNING_FAILURE_POLICY_ROUTE_MISMATCH", `rework must use the exact route required by ${failure.resultingAction} failure policy`);
  }
}

function samePlanningRoute(left: PlanningDecision["route"], right: { adapter: string; model: string; reasoning?: string }): boolean {
  return left.adapter === right.adapter && left.model === right.model && left.reasoning === right.reasoning;
}

function parsePlanningMasterResult(value: unknown): PlanningMasterResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KerbsFlowError("PLANNING_MASTER_RESULT_INVALID", "Planning Master must return a decision and optional trusted routing decision");
  }
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (key !== "decision" && key !== "routingDecision") {
      throw new KerbsFlowError("PLANNING_MASTER_RESULT_INVALID", `Planning Master returned unknown field ${key}`);
    }
  }
  if (result.decision === undefined) {
    throw new KerbsFlowError("PLANNING_MASTER_RESULT_INVALID", "Planning Master result is missing its decision");
  }
  const decision = parsePlanningDecision(result.decision);
  if (result.routingDecision === undefined) return { decision };
  if (result.routingDecision === null || typeof result.routingDecision !== "object" || Array.isArray(result.routingDecision)) {
    throw new KerbsFlowError("PLANNING_MASTER_RESULT_INVALID", "Planning Master routingDecision must be a runtime-trusted routing decision");
  }
  const routingDecision = assertTrustedRoutingDecision(result.routingDecision as TrustedRoutingDecision);
  return { decision, routingDecision };
}

function routingMatchesPlanningDecision(routing: TrustedRoutingDecision, decision: PlanningDecision): boolean {
  return routing.runId === decision.runId
    && routing.taskId === decision.taskId
    && routing.planningDecisionId === decision.decisionId
    && routing.selected.adapter === decision.route.adapter
    && routing.selected.model === decision.route.model
    && routing.selected.reasoning === decision.route.reasoning;
}

function categoryLabel(category: "focused_verification" | "phase_verification"): string {
  return category === "focused_verification" ? "focused verification" : "phase verification";
}

function providerSessionId(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.providerSessionId === "string" ? parsed.providerSessionId : undefined;
  } catch {
    return undefined;
  }
}
