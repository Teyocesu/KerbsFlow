import { createHash } from "node:crypto";

import type { ExecutorResult, PlanningDecision, ValidationBundle, ValidationCheck, ValidationEvidence } from "./contracts.js";
import { CONTRACT_VERSIONS, asValidationId } from "./contracts.js";
import { GitWorktreeManager, type RepositoryIntake, type RepositorySnapshot, type WorktreeInspection, type WorktreeRecord } from "./git.js";
import { ProcessSupervisor, codexEnvironment, type ProcessResult } from "./process.js";
import type { IdSource } from "./runtime.js";
import { detectAntiGreenwashing, type AntiGreenwashingSignal } from "./anti-greenwashing.js";
import { KerbsFlowError } from "./errors.js";

export interface FocusedCheckCommand {
  name: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface PhaseCheckCommand extends FocusedCheckCommand {
  level: "phase";
  commandId: string;
}

export interface FocusedVerificationResult {
  bundle: ValidationBundle;
  preCheckInspection: WorktreeInspection;
  inspection: ReturnType<GitWorktreeManager["inspect"]>;
  checkResult: ProcessResult;
  suspiciousSignals: AntiGreenwashingSignal[];
  scopeViolations: string[];
  executorDisagreements: string[];
  verifierMutations: string[];
}

export interface PhaseValidationBinding {
  worktreePath: string;
  worktreeGitDirectory: string;
  baseOid: string;
  diffHash: string;
  changedPathsHash: string;
  changedPaths: string[];
  commandId: string;
  commandHash: string;
}

const PHASE_AUTHORITY = Symbol("kerbsflow.phase-verifier-authority");
const AUTHORITATIVE_PHASE_RECORDS = new WeakSet<object>();

export type AuthoritativePhaseValidation = {
  bundle: ValidationBundle;
  binding: PhaseValidationBinding;
  readonly [PHASE_AUTHORITY]: true;
};

export function assertAuthoritativePhaseValidation(value: unknown): asserts value is AuthoritativePhaseValidation {
  if (value === null || typeof value !== "object" || !AUTHORITATIVE_PHASE_RECORDS.has(value)) {
    throw new Error("phase validation was not produced by the independent phase verifier");
  }
}

export class FocusedVerifier {
  constructor(
    private readonly git: GitWorktreeManager,
    private readonly supervisor: ProcessSupervisor,
    private readonly ids: IdSource,
  ) {}

  async verify(
    intake: RepositoryIntake,
    worktree: WorktreeRecord,
    decision: PlanningDecision,
    executorResult: ExecutorResult,
    command: FocusedCheckCommand,
  ): Promise<FocusedVerificationResult> {
    return this.verifyAtLevel("focused", intake, worktree, decision, executorResult, command);
  }

  async verifyPhase(
    intake: RepositoryIntake,
    worktree: WorktreeRecord,
    decision: PlanningDecision,
    executorResult: ExecutorResult,
    command: PhaseCheckCommand,
  ): Promise<{ verification: FocusedVerificationResult; authoritative: AuthoritativePhaseValidation }> {
    if (command.level !== "phase" || typeof command.commandId !== "string" || command.commandId.trim().length === 0) {
      throw new KerbsFlowError("PHASE_CHECK_AUTHORITY_REQUIRED", "phase verification requires an explicit phase command identity; focused check configuration cannot be promoted");
    }
    const verification = await this.verifyAtLevel("phase", intake, worktree, decision, executorResult, command);
    const authoritative = deepFreeze({
      bundle: verification.bundle,
      binding: phaseBindingFor(worktree, verification.inspection, command),
      [PHASE_AUTHORITY]: true,
    }) as AuthoritativePhaseValidation;
    AUTHORITATIVE_PHASE_RECORDS.add(authoritative);
    return { verification, authoritative };
  }

  private async verifyAtLevel(
    level: "focused" | "phase",
    intake: RepositoryIntake,
    worktree: WorktreeRecord,
    decision: PlanningDecision,
    executorResult: ExecutorResult,
    command: FocusedCheckCommand,
  ): Promise<FocusedVerificationResult> {
    const originalBefore = this.git.snapshot(intake.repositoryPath);
    const preCheckInspection = this.git.inspect(worktree);
    const process = this.supervisor.start({
      executable: command.executable,
      args: command.args,
      cwd: worktree.path,
      environment: checkEnvironment(),
      timeoutMs: command.timeoutMs,
      gracePeriodMs: 1000,
    });
    const checkResult = await process.completion;
    const originalAfter = this.git.snapshot(intake.repositoryPath);
    const inspection = this.git.inspect(worktree);
    const originalUnchanged = originalMatchesIntake(originalAfter, intake);
    const scopeViolations = inspection.changedPaths.filter((path) => !isWithinPositiveScope(path, decision.action.positiveScope) || isWithinNegativeScope(path, decision.action.negativeScope));
    const suspiciousSignals = detectAntiGreenwashing(inspection.diff, inspection.changedPaths);
    const blockingSignals = suspiciousSignals.filter((signal) => signal.blocksPass);
    const executorDisagreements = compareExecutorClaims(executorResult, preCheckInspection.changedPaths, checkResult);
    const verifierMutations = compareVerificationSnapshots(originalBefore, originalAfter, preCheckInspection, inspection);
    const checkPassed = checkResult.exitKind === "normal" && checkResult.exitCode === 0;
    const passed = originalUnchanged
      && inspection.baseOid === intake.baseOid
      && checkPassed
      && scopeViolations.length === 0
      && blockingSignals.length === 0
      && executorDisagreements.length === 0
      && verifierMutations.length === 0;
    const evidence: ValidationEvidence[] = [
      this.evidence("diff", "inspected", `Git independently reported ${inspection.changedPaths.length} changed path(s) from base ${intake.baseOid}`),
      this.evidence("command", "automatically_tested", `${level === "phase" ? `${(command as PhaseCheckCommand).commandId}: ` : ""}${command.name} exited as ${checkResult.exitKind} code ${String(checkResult.exitCode)}`),
      this.evidence("review", "inspected", suspiciousSignals.length === 0 ? "anti-greenwashing scan found no suspicious signal" : `anti-greenwashing signals: ${suspiciousSignals.map((signal) => signal.code).join("; ")}`),
      this.evidence("other", "inspected", originalUnchanged ? "original checkout remains clean at the recorded base" : "original checkout no longer matches the clean recorded base"),
      this.evidence("other", "inspected", verifierMutations.length === 0 ? "focused check did not mutate managed Git evidence" : `focused-check mutations: ${verifierMutations.join("; ")}`),
    ];
    const checks: ValidationCheck[] = [
      { name: "original checkout invariant", outcome: originalUnchanged ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [], evidenceIds: [evidence[3]!.id] },
      { name: "Git base and scope", outcome: inspection.baseOid === intake.baseOid && scopeViolations.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [], evidenceIds: [evidence[0]!.id] },
      { name: level === "phase" ? `${(command as PhaseCheckCommand).commandId}: ${command.name}` : command.name, outcome: checkPassed ? "passed" : "failed", evidenceClass: "automatically_tested", evidenceRefs: [], evidenceIds: [evidence[1]!.id] },
      { name: "anti-greenwashing deterministic blockers", outcome: blockingSignals.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [], evidenceIds: [evidence[2]!.id] },
      { name: "executor claim comparison", outcome: executorDisagreements.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [], evidenceIds: [evidence[0]!.id] },
      { name: "focused-check evidence integrity", outcome: verifierMutations.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [], evidenceIds: [evidence[4]!.id] },
    ];
    const bundle: ValidationBundle = {
      schemaVersion: CONTRACT_VERSIONS.validation,
      validationId: asValidationId(this.ids.next("validation")),
      runId: decision.runId,
      taskId: decision.taskId,
      attemptId: executorResult.attemptId,
      level,
      outcome: passed ? "passed" : "failed",
      summary: passed
        ? "independent Git, scope, anti-greenwashing, and focused-check evidence passed"
        : `independent verification failed: ${[
          ...(originalUnchanged ? [] : ["original checkout changed"]),
          ...scopeViolations.map((path) => `scope:${path}`),
          ...suspiciousSignals.map((signal) => signal.code),
          ...executorDisagreements,
          ...verifierMutations,
          ...(checkPassed ? [] : [`${command.name} failed`]),
        ].join("; ")}`,
      checks,
      evidence,
    };
    return { bundle, preCheckInspection, inspection, checkResult, suspiciousSignals, scopeViolations, executorDisagreements, verifierMutations };
  }

  private evidence(kind: ValidationEvidence["kind"], classification: ValidationEvidence["classification"], summary: string): ValidationEvidence {
    return {
      schemaVersion: CONTRACT_VERSIONS.validation,
      id: asValidationId(this.ids.next("validation")),
      kind,
      classification,
      summary,
    };
  }
}

export function bindingFor(worktree: WorktreeRecord, inspection: WorktreeInspection): Omit<PhaseValidationBinding, "commandId" | "commandHash"> {
  return {
    worktreePath: worktree.path,
    worktreeGitDirectory: worktree.worktreeGitDirectory,
    baseOid: worktree.baseOid,
    diffHash: createHash("sha256").update(inspection.diff).digest("hex"),
    changedPathsHash: createHash("sha256").update(JSON.stringify(inspection.changedPaths)).digest("hex"),
    changedPaths: inspection.changedPaths,
  };
}

function phaseBindingFor(worktree: WorktreeRecord, inspection: WorktreeInspection, command: PhaseCheckCommand): PhaseValidationBinding {
  return {
    ...bindingFor(worktree, inspection),
    commandId: command.commandId,
    commandHash: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function originalMatchesIntake(snapshot: RepositorySnapshot, intake: RepositoryIntake): boolean {
  return snapshot.repositoryPath === intake.repositoryPath
    && snapshot.headOid === intake.baseOid
    && snapshot.status.length === 0;
}

function compareVerificationSnapshots(
  originalBefore: RepositorySnapshot,
  originalAfter: RepositorySnapshot,
  worktreeBefore: WorktreeInspection,
  worktreeAfter: WorktreeInspection,
): string[] {
  const mutations: string[] = [];
  if (JSON.stringify(originalBefore) !== JSON.stringify(originalAfter)) {
    mutations.push("focused check mutated the original human-owned checkout");
  }
  if (
    worktreeBefore.headOid !== worktreeAfter.headOid
    || JSON.stringify(worktreeBefore.status) !== JSON.stringify(worktreeAfter.status)
    || JSON.stringify(worktreeBefore.changedPaths) !== JSON.stringify(worktreeAfter.changedPaths)
    || worktreeBefore.diff !== worktreeAfter.diff
  ) {
    mutations.push("focused check mutated managed worktree source evidence");
  }
  return mutations;
}

function compareExecutorClaims(result: ExecutorResult, actualPaths: string[], checkResult: ProcessResult): string[] {
  const claimed = [...new Set(result.filesChanged.map((entry) => entry.path))].sort();
  const actual = [...new Set(actualPaths)].sort();
  const disagreements: string[] = [];
  if (JSON.stringify(claimed) !== JSON.stringify(actual)) {
    disagreements.push(`executor changed-path claim ${JSON.stringify(claimed)} differs from Git ${JSON.stringify(actual)}`);
  }
  const claimedPassed = result.checks.some((check) => check.outcome === "passed");
  if (claimedPassed && (checkResult.exitKind !== "normal" || checkResult.exitCode !== 0)) {
    disagreements.push("executor claimed a passing check but the independent focused command failed");
  }
  return disagreements;
}

function isWithinPositiveScope(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => matchesScope(path, scope));
}

function isWithinNegativeScope(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => matchesScope(path, scope));
}

function matchesScope(path: string, scope: string): boolean {
  const normalized = scope.replace(/^\.\//u, "").replace(/\*\*?$/u, "").replace(/\/$/u, "");
  if (normalized === "." || normalized === "") {
    return true;
  }
  return path === normalized || path.startsWith(`${normalized}/`);
}

function checkEnvironment(): NodeJS.ProcessEnv {
  const environment = codexEnvironment();
  delete environment.CODEX_HOME;
  return environment;
}
