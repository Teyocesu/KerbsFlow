import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createGitRepository(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-git-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "KerbsFlow Test"]);
  git(root, ["config", "user.email", "kerbsflow@example.invalid"]);
  writeFileSync(join(root, "README.md"), "synthetic repository\n", "utf8");
  writeFileSync(join(root, "check.mjs"), "import { readFileSync } from 'node:fs';\nif (readFileSync('result.txt', 'utf8') !== 'done\\n') process.exit(1);\n", "utf8");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/example.test.ts"), "assert.equal(value, true);\n", "utf8");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "AGENTS.md"), "synthetic agent policy\n", "utf8");
  writeFileSync(join(root, "docs/SPEC-v0.1.0.md"), "synthetic frozen spec\n", "utf8");
  writeFileSync(join(root, "docs/PLAN-v0.1.0.md"), "synthetic plan\n", "utf8");
  writeFileSync(join(root, "docs/HANDOFF.md"), "synthetic handoff\n", "utf8");
  git(root, ["add", "README.md", "check.mjs", "AGENTS.md", "docs", "test"]);
  git(root, ["commit", "--quiet", "-m", "initial"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]) };
}

export function createFakeCodex(root: string): string {
  const path = join(root, "fake-codex.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.155.0-fixture");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using synthetic provider-owned auth");
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) {
  console.log("--json --output-schema --output-last-message --model --cd --config --ignore-user-config --ignore-rules --strict-config --ephemeral resume");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "resume" && args.includes("--help")) {
  console.log("resume a session");
  process.exit(0);
}
if (args[0] === "sandbox" && args.includes("--help")) {
  console.log("--permission-profile --cd --config");
  process.exit(0);
}
if (args[0] === "sandbox") {
  process.exit(args.includes("KERBSFLOW_DENY_PROBE") ? 1 : 0);
}

const valueAfter = (name) => args[args.indexOf(name) + 1];
const resultPath = valueAfter("--output-last-message");
const schemaPath = valueAfter("--output-schema");
const model = valueAfter("--model");
const prompt = args.at(-1) ?? "";
const match = (name) => prompt.match(new RegExp("- " + name + ": ([^\\n]+)"))?.[1] ?? "missing_" + name;
const runId = match("runId");
const taskId = match("taskId");
const attemptId = match("attemptId");
const scenario = prompt.match(/SCENARIO=([a-z0-9-]+)/)?.[1] ?? "success";
if (schemaPath.includes("semantic-review-result.schema.json")) {
  const reviewOutcome = prompt.match(/REVIEW_OUTCOME=([a-z_]+)/)?.[1] ?? "supports_continuation";
  const reviewIdentity = prompt.match(/Identity: run=(\S+) task=(\S+) attempt=(\S+) review=(\S+)/);
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: "kerbsflow.semantic-review-result/v1",
    reviewAttemptId: reviewIdentity?.[4] ?? match("reviewAttemptId"),
    runId: reviewIdentity?.[1] ?? runId,
    taskId: reviewIdentity?.[2] ?? taskId,
    attemptId: reviewIdentity?.[3] ?? attemptId,
    reviewer: { adapter: "codex", adapterVersion: "fixture", provider: "openai", model },
    outcome: reviewOutcome,
    summary: "synthetic independent review",
    findings: [],
    evidence: [{ schemaVersion: "kerbsflow.validation/v1", id: "validation_fixture_review", kind: "review", classification: "inspected", summary: "synthetic semantic inspection" }],
    scopeConcerns: [],
    invariantViolations: [],
  }));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-review-thread" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  process.exit(0);
}
const base = {
  schemaVersion: "kerbsflow.executor-result/v1",
  runId,
  taskId,
  attemptId,
  executor: { adapter: "codex", adapterVersion: "fixture", provider: "openai", model },
  outcome: "succeeded",
  failureClass: null,
  scopeClaim: "within_scope",
  summary: "synthetic Codex fixture completed",
  filesChanged: scenario === "success" ? [{ path: "result.txt", change: "added" }] : scenario === "semantic-review" || scenario === "deterministic-blocker" ? [{ path: "result.txt", change: "added" }, { path: "test/example.test.ts", change: "modified" }] : [],
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
console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }));
if (scenario === "unknown-event") console.log(JSON.stringify({ type: "future.event" }));
if (scenario === "malformed-jsonl") console.log("{not-json");
if (scenario === "timeout" || scenario === "cancel-output") {
  if (scenario === "cancel-output") writeFileSync("partial.txt", "retain me\\n");
  const timer = setInterval(() => console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution" } })), 20);
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(143); });
  setTimeout(() => { clearInterval(timer); process.exit(0); }, 60_000);
} else if (scenario === "missing-result") {
  process.exit(0);
} else if (scenario === "malformed-result") {
  writeFileSync(resultPath, "not json");
  process.exit(0);
} else if (scenario === "wrong-schema") {
  writeFileSync(resultPath, JSON.stringify({ ...base, schemaVersion: "kerbsflow.executor-result/v0" }));
  process.exit(0);
} else if (scenario === "id-mismatch") {
  writeFileSync(resultPath, JSON.stringify({ ...base, attemptId: "attempt_wrong" }));
  process.exit(0);
} else if (scenario === "nonzero") {
  writeFileSync(resultPath, JSON.stringify(base));
  process.exit(7);
} else if (scenario === "failure") {
  writeFileSync(resultPath, JSON.stringify({ ...base, outcome: "failed", failureClass: "implementation_failure", recommendedNext: "rework" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "transient-failure") {
  writeFileSync(resultPath, JSON.stringify({ ...base, outcome: "failed", failureClass: "executor_error", recommendedNext: "rework" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "invariant-failure") {
  writeFileSync(resultPath, JSON.stringify({ ...base, outcome: "failed", failureClass: "invariant_violation", invariantViolations: ["synthetic invariant"], recommendedNext: "escalate" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "architecture-ambiguity") {
  writeFileSync(resultPath, JSON.stringify({ ...base, outcome: "failed", failureClass: "requirement_or_architecture_ambiguity", recommendedNext: "human_gate" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "scope-violation") {
  writeFileSync("README.md", "out of scope\\n");
  writeFileSync(resultPath, JSON.stringify({ ...base, filesChanged: [{ path: "README.md", change: "modified" }], scopeClaim: "violated", outcome: "failed", failureClass: "scope_violation", recommendedNext: "human_gate" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "semantic-review") {
  writeFileSync("result.txt", "done\\n");
  writeFileSync("test/example.test.ts", "const value = true;\\n");
  writeFileSync(resultPath, JSON.stringify(base));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "deterministic-blocker") {
  writeFileSync("result.txt", "done\\n");
  writeFileSync("test/example.test.ts", "test.skip('disabled', () => {});\\n");
  writeFileSync(resultPath, JSON.stringify(base));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else if (scenario === "gate") {
  writeFileSync(resultPath, JSON.stringify({
    ...base,
    outcome: "blocked",
    failureClass: "security_or_privilege_gate",
    recommendedNext: "human_gate",
    humanGate: {
      schemaVersion: "kerbsflow.human-gate/v1",
      gateId: "gate_fixture",
      runId,
      taskId,
      attemptId,
      reasonCode: "security_or_privilege_gate",
      summary: "synthetic privilege gate",
      evidenceRefs: [],
      options: [
        { id: "rework", label: "Rework", consequence: "Return to bounded rework", target: "REWORK" },
        { id: "cancel", label: "Cancel", consequence: "Stop and retain evidence", target: "CANCELLED" },
      ],
      status: "open",
    },
  }));
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  writeFileSync("result.txt", "done\\n");
  writeFileSync(resultPath, JSON.stringify(base));
  console.log(JSON.stringify({ type: "turn.completed" }));
}
`, { encoding: "utf8", mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
