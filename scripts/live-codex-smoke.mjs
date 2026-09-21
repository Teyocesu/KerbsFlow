import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileArtifactStore } from "../dist/src/artifacts.js";
import { CodexAdapter } from "../dist/src/codex.js";
import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  asRunId,
  asTaskId,
} from "../dist/src/contracts.js";
import { KerbsFlowCore } from "../dist/src/core.js";
import { GitWorktreeManager } from "../dist/src/git.js";
import { Phase2Loop } from "../dist/src/phase2.js";
import { createPhase2PlanningDecision } from "../dist/src/planning.js";
import { StateStore } from "../dist/src/persistence.js";
import { ProcessSupervisor } from "../dist/src/process.js";
import { SequenceIdSource } from "../dist/src/runtime.js";
import { FocusedVerifier } from "../dist/src/verifier.js";

if (process.env.KERBSFLOW_LIVE_CODEX !== "1") {
  throw new Error("set KERBSFLOW_LIVE_CODEX=1 to acknowledge the opt-in live Codex smoke run");
}

const cliPath = process.env.CODEX_BIN;
if (cliPath === undefined || cliPath.length === 0) {
  throw new Error("CODEX_BIN must identify the installed Codex CLI executable");
}

const repository = mkdtempSync(join(tmpdir(), "kerbsflow-live-repo-"));
const runtime = mkdtempSync(join(tmpdir(), "kerbsflow-live-runtime-"));
const ids = new SequenceIdSource("live");
const store = StateStore.open(join(runtime, "state.sqlite"), { ids });

try {
  git(["init", "--quiet"]);
  git(["config", "user.name", "KerbsFlow Live Smoke"]);
  git(["config", "user.email", "kerbsflow@example.invalid"]);
  writeFileSync(join(repository, "README.md"), "Disposable KerbsFlow live smoke repository.\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "initial"]);
  const baseOid = git(["rev-parse", "HEAD"]);

  const adapter = new CodexAdapter({ cliPath, runtimeRoot: runtime });
  const descriptor = adapter.probe();
  const gitManager = new GitWorktreeManager(join(runtime, "owned"));
  const core = new KerbsFlowCore(store, adapter, new FileArtifactStore(join(runtime, "artifacts"), ids), {
    ids,
    configuration: {
      hardInvariants: DEFAULT_HARD_INVARIANTS,
      projectPolicy: {
        schemaVersion: CONTRACT_VERSIONS.config,
        allowedAdapters: ["codex"],
        maxImplementationAttempts: 1,
        validationLevel: "focused",
        workloadNetwork: "denied",
        automaticReleaseActions: false,
      },
      userPreferences: DEFAULT_USER_PREFERENCES,
      runOverride: DEFAULT_RUN_OVERRIDE,
    },
  });
  const runId = asRunId("run_live_smoke");
  const taskId = asTaskId("task_live_smoke");
  const decision = createPhase2PlanningDecision({
    decisionId: "decision_live_smoke",
    runId,
    taskId,
    objective: "Create hello.txt containing exactly: KerbsFlow live smoke (followed by one newline).",
    acceptance: ["hello.txt exists and has exactly the requested content"],
    positiveScope: ["hello.txt"],
    negativeScope: ["README.md", ".git"],
    model: process.env.KERBSFLOW_LIVE_MODEL ?? "gpt-5.6-luna",
    reasoning: "low",
    canonicalContext: "disposable synthetic live smoke",
  });
  const loop = new Phase2Loop(core, store, gitManager, new FocusedVerifier(gitManager, new ProcessSupervisor(), ids), ids);
  const result = await loop.run({
    runId,
    taskId,
    objective: "Disposable synthetic live Codex smoke",
    repositoryPath: repository,
    expectedBaseOid: baseOid,
    planningDecision: decision,
    focusedCheck: {
      name: "exact hello.txt content",
      executable: process.execPath,
      args: ["-e", "import {readFileSync} from 'node:fs'; if(readFileSync('hello.txt','utf8') !== 'KerbsFlow live smoke\\n') process.exit(1)"],
      timeoutMs: 10_000,
    },
    executionTimeoutMs: 180_000,
  });
  const model = store.readModel(runId);
  const processEvidence = model?.run.activeAttemptId === null || model?.run.activeAttemptId === undefined
    ? undefined
    : await adapter.processEvidence(model.run.activeAttemptId);
  const processSummary = processEvidence === undefined ? null : {
    exitKind: processEvidence.exitKind,
    exitCode: processEvidence.exitCode,
    signal: processEvidence.signal,
    stdoutBytesObserved: processEvidence.stdoutBytesObserved,
    stderrBytesObserved: processEvidence.stderrBytesObserved,
    eventCount: processEvidence.events.length,
    stdoutTruncated: processEvidence.stdoutTruncated,
    stderrTruncated: processEvidence.stderrTruncated,
    eventsTruncated: processEvidence.eventsTruncated,
    ...(result.verdict === "PASS" ? {} : {
      stderr: processEvidence.stderr.slice(0, 2000),
      events: processEvidence.events.slice(0, 5),
    }),
  };
  process.stdout.write(`${JSON.stringify({
    verdict: result.verdict,
    adapterVersion: descriptor.adapterVersion,
    baseOid,
    originalStatus: git(["status", "--porcelain"]),
    changedPaths: result.verification?.inspection.changedPaths ?? [],
    validation: result.verification?.bundle.outcome ?? null,
    recoveryReason: model?.run.recoveryReason ?? null,
    attemptOutcome: model?.activeAttempt?.outcomeJson === null || model?.activeAttempt?.outcomeJson === undefined
      ? null
      : JSON.parse(model.activeAttempt.outcomeJson),
    process: processSummary,
  }, null, 2)}\n`);
  if (result.verdict !== "PASS") {
    process.exitCode = 1;
  }
} finally {
  store.close();
  rmSync(runtime, { recursive: true, force: true });
  rmSync(repository, { recursive: true, force: true });
}

function git(args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
