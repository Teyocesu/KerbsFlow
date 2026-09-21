import type { ExecutorResult, PlanningDecision, ValidationBundle, ValidationCheck, ValidationEvidence } from "./contracts.js";
import { CONTRACT_VERSIONS, asValidationId } from "./contracts.js";
import { GitWorktreeManager, type RepositoryIntake, type WorktreeRecord } from "./git.js";
import { ProcessSupervisor, codexEnvironment, type ProcessResult } from "./process.js";
import type { IdSource } from "./runtime.js";

export interface FocusedCheckCommand {
  name: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface FocusedVerificationResult {
  bundle: ValidationBundle;
  inspection: ReturnType<GitWorktreeManager["inspect"]>;
  checkResult: ProcessResult;
  suspiciousSignals: string[];
  scopeViolations: string[];
  executorDisagreements: string[];
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
    let originalUnchanged = true;
    try {
      this.git.intake(intake.repositoryPath, { expectedBaseOid: intake.baseOid });
    } catch {
      originalUnchanged = false;
    }
    const inspection = this.git.inspect(worktree);
    const scopeViolations = inspection.changedPaths.filter((path) => !isWithinPositiveScope(path, decision.action.positiveScope) || isWithinNegativeScope(path, decision.action.negativeScope));
    const suspiciousSignals = antiGreenwashingSignals(inspection.diff, inspection.changedPaths);
    const process = this.supervisor.start({
      executable: command.executable,
      args: command.args,
      cwd: worktree.path,
      environment: checkEnvironment(),
      timeoutMs: command.timeoutMs,
      gracePeriodMs: 1000,
    });
    const checkResult = await process.completion;
    const executorDisagreements = compareExecutorClaims(executorResult, inspection.changedPaths, checkResult);
    const checkPassed = checkResult.exitKind === "normal" && checkResult.exitCode === 0;
    const passed = originalUnchanged
      && inspection.baseOid === intake.baseOid
      && checkPassed
      && scopeViolations.length === 0
      && suspiciousSignals.length === 0
      && executorDisagreements.length === 0;
    const evidence: ValidationEvidence[] = [
      this.evidence("diff", "inspected", `Git independently reported ${inspection.changedPaths.length} changed path(s) from base ${intake.baseOid}`),
      this.evidence("check", "automatically_tested", `${command.name} exited as ${checkResult.exitKind} code ${String(checkResult.exitCode)}`),
      this.evidence("review", "inspected", suspiciousSignals.length === 0 ? "basic anti-greenwashing scan found no suspicious signal" : `anti-greenwashing signals: ${suspiciousSignals.join("; ")}`),
      this.evidence("other", "inspected", originalUnchanged ? "original checkout remains clean at the recorded base" : "original checkout no longer matches the clean recorded base"),
    ];
    const checks: ValidationCheck[] = [
      { name: "original checkout invariant", outcome: originalUnchanged ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [] },
      { name: "Git base and scope", outcome: inspection.baseOid === intake.baseOid && scopeViolations.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [] },
      { name: command.name, outcome: checkPassed ? "passed" : "failed", evidenceClass: "automatically_tested", evidenceRefs: [] },
      { name: "anti-greenwashing heuristic", outcome: suspiciousSignals.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [] },
      { name: "executor claim comparison", outcome: executorDisagreements.length === 0 ? "passed" : "failed", evidenceClass: "inspected", evidenceRefs: [] },
    ];
    const bundle: ValidationBundle = {
      schemaVersion: CONTRACT_VERSIONS.validation,
      validationId: asValidationId(this.ids.next("validation")),
      runId: decision.runId,
      taskId: decision.taskId,
      attemptId: executorResult.attemptId,
      level: "focused",
      outcome: passed ? "passed" : "failed",
      summary: passed
        ? "independent Git, scope, anti-greenwashing, and focused-check evidence passed"
        : `independent verification failed: ${[
          ...(originalUnchanged ? [] : ["original checkout changed"]),
          ...scopeViolations.map((path) => `scope:${path}`),
          ...suspiciousSignals,
          ...executorDisagreements,
          ...(checkPassed ? [] : [`${command.name} failed`]),
        ].join("; ")}`,
      checks,
      evidence,
    };
    return { bundle, inspection, checkResult, suspiciousSignals, scopeViolations, executorDisagreements };
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

function antiGreenwashingSignals(diff: string, changedPaths: string[]): string[] {
  const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removed = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const signals: string[] = [];
  if (changedPaths.some((path) => /(^|\/)(test|tests|__tests__)\//u.test(path)) && diff.includes("deleted file mode")) {
    signals.push("test file deleted");
  }
  if (added.some((line) => /\.(skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(/u.test(line))) {
    signals.push("test skip/focus marker introduced");
  }
  if (removed.some((line) => /\b(assert|expect)\s*\(/u.test(line))) {
    signals.push("assertion removed; semantic review required");
  }
  if (added.some((line) => /@ts-ignore|eslint-disable|noqa|type:\s*ignore|coverage\s+ignore/iu.test(line))) {
    signals.push("suppression introduced");
  }
  if (added.some((line) => /catch\s*(?:\([^)]*\))?\s*\{\s*\}/u.test(line))) {
    signals.push("empty catch introduced");
  }
  if (added.some((line) => /catch[^\n]*\{[^\n]*(?:return\s+(?:undefined|null|false|\[\]|\{\})|continue;)/u.test(line))) {
    signals.push("possible silent fallback introduced");
  }
  if (removed.some((line) => /"(?:test|typecheck|lint)"\s*:/u.test(line)) || added.some((line) => /"noEmit"\s*:\s*false/u.test(line))) {
    signals.push("validation configuration weakened or removed");
  }
  return signals;
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
