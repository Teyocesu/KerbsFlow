import {
  CONTRACT_VERSIONS,
  type ExecutorResult,
  type PlanningDecision,
  type ReviewDecision,
  type RunId,
  type TaskId,
  asReviewId,
  parseExecutorResult,
} from "./contracts.js";
import { KerbsFlowCore } from "./core.js";
import { KerbsFlowError } from "./errors.js";
import { GitWorktreeManager, type RepositoryIntake, type WorktreeRecord } from "./git.js";
import { buildCodexPrompt } from "./planning.js";
import { StateStore } from "./persistence.js";
import type { IdSource } from "./runtime.js";
import { FocusedVerifier, type FocusedCheckCommand, type FocusedVerificationResult } from "./verifier.js";

export interface Phase2LoopRequest {
  runId: RunId;
  taskId: TaskId;
  objective: string;
  repositoryPath: string;
  expectedBaseOid?: string;
  planningDecision: PlanningDecision;
  focusedCheck: FocusedCheckCommand;
  executionTimeoutMs: number;
}

export interface Phase2LoopResult {
  verdict: "PASS" | "REWORK" | "HUMAN_GATE" | "RECOVERY";
  intake: RepositoryIntake;
  worktree: WorktreeRecord;
  executorResult?: ExecutorResult;
  verification?: FocusedVerificationResult;
  stateVersion: number;
}

export class Phase2Loop {
  constructor(
    private readonly core: KerbsFlowCore,
    private readonly store: StateStore,
    private readonly git: GitWorktreeManager,
    private readonly verifier: FocusedVerifier,
    private readonly ids: IdSource,
  ) {}

  async run(request: Phase2LoopRequest): Promise<Phase2LoopResult> {
    if (request.planningDecision.runId !== request.runId || request.planningDecision.taskId !== request.taskId) {
      throw new KerbsFlowError("COMMAND_SCOPE_MISMATCH", "planning decision IDs do not match the Phase 2 loop request");
    }
    if (request.planningDecision.route.adapter !== "codex") {
      throw new KerbsFlowError("ROUTE_NOT_ALLOWED", "Phase 2 real loop accepts only the Codex adapter");
    }
    const intake = this.git.intake(request.repositoryPath, {
      ...(request.expectedBaseOid === undefined ? {} : { expectedBaseOid: request.expectedBaseOid }),
    });
    let command = this.core.startRun(request.runId, request.objective, `${request.runId}:start`);
    command = this.core.completeIntake(request.runId, command.stateVersion, `${request.runId}:intake`);
    const worktree = this.git.create(intake, request.runId);
    this.store.recordWorktree({
      runId: request.runId,
      repositoryPath: worktree.repositoryPath,
      gitCommonDirectory: worktree.gitCommonDirectory,
      worktreeGitDirectory: worktree.worktreeGitDirectory,
      baseOid: worktree.baseOid,
      branch: worktree.branch,
      worktreePath: worktree.path,
      markerPath: worktree.markerPath,
      createdAt: worktree.createdAt,
    });
    command = this.core.plan(request.runId, command.stateVersion, `${request.runId}:plan`, request.planningDecision);
    command = this.core.prepareExecution(request.runId, command.stateVersion, `${request.runId}:prepare`);
    command = await this.core.beginAttempt(
      request.runId,
      command.stateVersion,
      `${request.runId}:begin`,
      worktree.path,
      { prompt: buildCodexPrompt(request.planningDecision), timeoutMs: request.executionTimeoutMs },
    );
    command = await this.core.completeAttempt(request.runId, command.stateVersion, `${request.runId}:complete`);
    const afterExecution = this.store.readModel(request.runId);
    if (afterExecution === undefined) {
      throw new KerbsFlowError("RUN_NOT_FOUND", `run ${request.runId} disappeared`);
    }
    if (afterExecution.run.state === "HUMAN_GATE") {
      return { verdict: "HUMAN_GATE", intake, worktree, stateVersion: afterExecution.run.stateVersion };
    }
    if (afterExecution.run.state === "RECOVERY") {
      return { verdict: "RECOVERY", intake, worktree, stateVersion: afterExecution.run.stateVersion };
    }
    if (afterExecution.run.state !== "VERIFY_FOCUSED" || afterExecution.activeAttempt?.outcomeJson === null || afterExecution.activeAttempt === undefined) {
      throw new KerbsFlowError("PHASE2_BOUNDARY_INVALID", `executor completed at unexpected state ${afterExecution.run.state}`);
    }
    const executorResult = parseExecutorResult(JSON.parse(afterExecution.activeAttempt.outcomeJson));
    const verification = await this.verifier.verify(intake, worktree, request.planningDecision, executorResult, request.focusedCheck);
    command = this.core.recordFocusedValidation(request.runId, command.stateVersion, `${request.runId}:verify`, verification.bundle);
    const passed = verification.bundle.outcome === "passed";
    const review: ReviewDecision = {
      schemaVersion: CONTRACT_VERSIONS.reviewDecision,
      reviewId: asReviewId(this.ids.next("review")),
      runId: request.runId,
      taskId: request.taskId,
      outcome: passed ? "verify_phase" : "rework",
      ...(passed ? {} : { failureClass: verification.scopeViolations.length > 0 ? "scope_violation" : "validation_failure" }),
      summary: passed ? "independent focused verification passed" : verification.bundle.summary,
      evidenceRefs: [],
      reasonCode: passed ? "phase2_focused_pass" : "phase2_focused_rework",
    };
    command = this.core.review(request.runId, command.stateVersion, `${request.runId}:review`, review);
    return {
      verdict: passed ? "PASS" : "REWORK",
      intake,
      worktree,
      executorResult,
      verification,
      stateVersion: command.stateVersion,
    };
  }
}
