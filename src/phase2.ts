import {
  CONTRACT_VERSIONS,
  type ExecutorResult,
  type FailureClassification,
  type PlanningDecision,
  type ReviewDecision,
  type RunId,
  type TaskId,
  asReviewId,
  parseExecutorResult,
} from "./contracts.js";
import { CanonicalIntentGuard } from "./canonical.js";
import { KerbsFlowCore } from "./core.js";
import { KerbsFlowError } from "./errors.js";
import { GitWorktreeManager, type RepositoryIntake, type WorktreeRecord } from "./git.js";
import { FailurePolicyCoordinator, escalatePlanningRoute } from "./phase3.js";
import { buildExecutorPrompt } from "./planning.js";
import {
  PHASE4_ROUTING_POLICY,
  assertTrustedRoutingDecision,
  createAttemptRoutingProvenance,
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
  planningDecision: PlanningDecision;
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
  verdict: "PASS" | "REWORK" | "HUMAN_GATE" | "RECOVERY" | "FAILED";
  intake?: RepositoryIntake;
  worktree?: WorktreeRecord;
  executorResult?: ExecutorResult;
  verification?: FocusedVerificationResult;
  intakeIssue?: { code: string; summary: string };
  attempts?: number;
  stateVersion: number;
}

export class Phase2Loop {
  constructor(
    private readonly core: KerbsFlowCore,
    private readonly store: StateStore,
    private readonly git: GitWorktreeManager,
    private readonly verifier: FocusedVerifier,
    private readonly ids: IdSource,
    private readonly semanticReviewer?: IndependentSemanticReviewer,
  ) {}

  async run(request: Phase2LoopRequest): Promise<Phase2LoopResult> {
    this.assertRequest(request);
    let command = this.core.startRun(request.runId, request.objective, `${request.runId}:start`);
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
    new CanonicalIntentGuard(this.store).capture(request.runId, intake.repositoryPath, intake.baseOid);
    command = this.core.completeIntake(request.runId, command.stateVersion, `${request.runId}:intake`);
    const worktree = this.git.create(intake, request.runId);
    this.store.recordWorktree({ runId: request.runId, repositoryPath: worktree.repositoryPath, gitCommonDirectory: worktree.gitCommonDirectory, worktreeGitDirectory: worktree.worktreeGitDirectory, baseOid: worktree.baseOid, branch: worktree.branch, worktreePath: worktree.path, markerPath: worktree.markerPath, createdAt: worktree.createdAt });
    command = this.core.plan(request.runId, command.stateVersion, `${request.runId}:plan`, request.planningDecision);
    if (request.routingDecision !== undefined) this.store.recordRoutingDecision(request.routingDecision);
    let decision = request.planningDecision;
    let attempts = 0;
    let nextSelectionReason = request.routingDecision?.selectionReason ?? "pre-Phase-4 planning route";
    let nextEscalationReason: string | undefined;

    while (true) {
      attempts += 1;
      command = this.core.prepareExecution(request.runId, command.stateVersion, `${request.runId}:prepare:${attempts}`);
      if (request.routingDecision !== undefined) {
        const attemptId = this.store.readModel(request.runId)?.run.activeAttemptId;
        if (attemptId === null || attemptId === undefined) throw new KerbsFlowError("ATTEMPT_REQUIRED", "routing provenance requires the prepared attempt");
        this.store.recordAttemptRoutingProvenance(createAttemptRoutingProvenance({
          routingDecision: request.routingDecision,
          planningDecision: decision,
          attemptId,
          selectionReason: nextSelectionReason,
          ...(nextEscalationReason === undefined ? {} : { escalationReason: nextEscalationReason }),
        }));
      }
      command = await this.core.beginAttempt(request.runId, command.stateVersion, `${request.runId}:begin:${attempts}`, worktree.path, { prompt: buildExecutorPrompt(decision), timeoutMs: request.executionTimeoutMs });
      command = await this.core.completeAttempt(request.runId, command.stateVersion, `${request.runId}:complete:${attempts}`);
      const afterExecution = this.store.readModel(request.runId);
      if (afterExecution === undefined) throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared`);
      if (afterExecution.run.state === "HUMAN_GATE") return { verdict: "HUMAN_GATE", intake, worktree, attempts, stateVersion: afterExecution.run.stateVersion };
      if (afterExecution.run.state === "RECOVERY") return { verdict: "RECOVERY", intake, worktree, attempts, stateVersion: afterExecution.run.stateVersion };
      if (afterExecution.run.state !== "VERIFY_FOCUSED" || afterExecution.activeAttempt?.outcomeJson === null || afterExecution.activeAttempt === undefined) {
        throw new KerbsFlowError("PHASE2_BOUNDARY_INVALID", `executor completed at unexpected state ${afterExecution.run.state}`);
      }
      const executorResult = parseExecutorResult(JSON.parse(afterExecution.activeAttempt.outcomeJson));
      let focused: FocusedVerificationResult;
      try {
        focused = await this.verifier.verify(intake, worktree, decision, executorResult, request.focusedCheck);
      } catch (error) {
        if (!(error instanceof KerbsFlowError) || error.code !== "VERIFICATION_SANDBOX_UNAVAILABLE") throw error;
        command = this.core.gateVerificationSandboxUnavailable(request.runId, command.stateVersion, `${request.runId}:focused-sandbox-gate:${attempts}`);
        return { verdict: "HUMAN_GATE", intake, worktree, executorResult, attempts, stateVersion: command.stateVersion };
      }
      command = this.core.recordFocusedValidation(request.runId, command.stateVersion, `${request.runId}:focused:${attempts}`, focused.bundle);
      if (focused.bundle.outcome !== "passed") {
        const policy = this.recordFailure(request, decision, executorResult, focused, "focused_verification");
        command = this.core.review(request.runId, command.stateVersion, `${request.runId}:focused-policy:${attempts}`, this.reviewForPolicy(request, policy));
        const terminal = this.policyTerminalResult(command.to, intake, worktree, executorResult, focused, attempts, command.stateVersion);
        if (terminal !== undefined) return terminal;
        if (policy.resultingAction === "escalate") {
          const higher = request.failurePolicy?.higherCodexRoute;
          if (higher === undefined) throw new KerbsFlowError("ESCALATION_ROUTE_REQUIRED", "policy selected escalation without an eligible Codex route");
          decision = escalatePlanningRoute(decision, higher);
          nextEscalationReason = policy.escalationReason ?? "failure policy selected an eligible higher Codex route";
          nextSelectionReason = `escalated after ${categoryLabel("focused_verification")}`;
        } else {
          nextEscalationReason = undefined;
          nextSelectionReason = `failure policy selected ${policy.resultingAction} after focused verification`;
        }
        command = this.core.reworkToReady(request.runId, command.stateVersion, `${request.runId}:continue:${attempts}`, decision);
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
        phase = await this.verifier.verifyPhase(intake, worktree, decision, executorResult, request.phaseCheck);
      } catch (error) {
        if (!(error instanceof KerbsFlowError) || error.code !== "VERIFICATION_SANDBOX_UNAVAILABLE") throw error;
        command = this.core.gateVerificationSandboxUnavailable(request.runId, command.stateVersion, `${request.runId}:phase-sandbox-gate:${attempts}`);
        return { verdict: "HUMAN_GATE", intake, worktree, executorResult, verification: focused, attempts, stateVersion: command.stateVersion };
      }
      this.store.recordAuthoritativePhaseValidation(phase.authoritative);
      if (phase.verification.bundle.outcome !== "passed") {
        const policy = this.recordFailure(request, decision, executorResult, phase.verification, "phase_verification");
        command = this.core.applyPhaseFailurePolicy(request.runId, command.stateVersion, `${request.runId}:phase-policy:${attempts}`, policy.fingerprint);
        const terminal = this.policyTerminalResult(command.to, intake, worktree, executorResult, phase.verification, attempts, command.stateVersion);
        if (terminal !== undefined) return terminal;
        if (policy.resultingAction === "escalate") {
          const higher = request.failurePolicy?.higherCodexRoute;
          if (higher === undefined) throw new KerbsFlowError("ESCALATION_ROUTE_REQUIRED", "policy selected escalation without an eligible Codex route");
          decision = escalatePlanningRoute(decision, higher);
          nextEscalationReason = policy.escalationReason ?? "failure policy selected an eligible higher Codex route";
          nextSelectionReason = `escalated after ${categoryLabel("phase_verification")}`;
        } else {
          nextEscalationReason = undefined;
          nextSelectionReason = `failure policy selected ${policy.resultingAction} after phase verification`;
        }
        command = this.core.reworkToReady(request.runId, command.stateVersion, `${request.runId}:phase-continue:${attempts}`, decision);
        continue;
      }

      let semanticReviewId: ReturnType<typeof asReviewId> | undefined;
      const semanticRequired = phase.verification.suspiciousSignals.some((signal) => !signal.blocksPass && signal.semanticReviewRequired);
      if (semanticRequired && this.semanticReviewer !== undefined && request.semanticReview !== undefined) {
        semanticReviewId = asReviewId(this.ids.next("review"));
        try {
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
      }
      command = this.core.completeTrustedPhaseValidation(request.runId, command.stateVersion, `${request.runId}:phase-close:${attempts}`, { validationId: phase.authoritative.bundle.validationId, ...(semanticReviewId === undefined ? {} : { semanticReviewId }) });
      return { verdict: command.to === "NEXT_PHASE" ? "PASS" : command.to === "REWORK" ? "REWORK" : command.to === "FAILED" ? "FAILED" : "HUMAN_GATE", intake, worktree, executorResult, verification: phase.verification, attempts, stateVersion: command.stateVersion };
    }
  }

  private assertRequest(request: Phase2LoopRequest): void {
    if (request.planningDecision.runId !== request.runId || request.planningDecision.taskId !== request.taskId) throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "planning decision IDs do not match the Phase 3 loop request");
    if (request.planningDecision.policyVersion === PHASE4_ROUTING_POLICY && request.routingDecision === undefined) {
      throw new KerbsFlowError("ROUTING_AUTHORITY_REQUIRED", "Phase 4 execution requires its trusted routing decision");
    }
    const routing = request.routingDecision === undefined ? undefined : assertTrustedRoutingDecision(request.routingDecision);
    if (routing !== undefined && (
      routing.runId !== request.runId
      || routing.taskId !== request.taskId
      || routing.planningDecisionId !== request.planningDecision.decisionId
      || routing.selected.adapter !== request.planningDecision.route.adapter
      || routing.selected.model !== request.planningDecision.route.model
      || routing.selected.reasoning !== request.planningDecision.route.reasoning
    )) {
      throw new KerbsFlowError("ROUTING_SCOPE_MISMATCH", "routing metadata does not match the Phase 4 loop request");
    }
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
