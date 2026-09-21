import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/codex.js";
import {
  CONTRACT_VERSIONS,
  type ExecutionRequest,
  asAttemptId,
  asRunId,
  asTaskId,
  parseExecutorResult,
} from "../src/contracts.js";
import { createFakeCodex } from "./phase2-helpers.js";

test("Codex probe reports the fixture's required real-execution capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(root), runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    const descriptor = adapter.probe();
    assert.equal(descriptor.adapter, "codex");
    assert.equal(descriptor.capabilities.eventTransport, "jsonl");
    assert.equal(descriptor.capabilities.finalJsonSchema, true);
    assert.equal(descriptor.capabilities.network.providerControlPlane, "provider_owned");
    assert.equal(descriptor.capabilities.network.workload, "enforced");
    assert.equal(descriptor.capabilities.authentication.owner, "provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter normalizes valid and unknown JSONL and accepts only a scoped structured result", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(root), runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    adapter.probe();
    const request = executionRequest(root, "unknown-event", "attempt_valid");
    const handle = adapter.start(request);
    const events = [];
    for await (const event of adapter.events(handle)) {
      events.push(event);
    }
    assert.equal(events[0]?.kind, "started");
    assert.ok(events.some((event) => event.kind === "warning" && event.summary.includes("Unknown Codex event")));
    const result = parseExecutorResult(await adapter.wait(handle));
    assert.equal(result.attemptId, request.attemptId);
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.executor.model, request.model);
    assert.match(result.executor.adapterVersion, /codex-cli 0\.155\.0-fixture/);
    assert.deepEqual(result.exit, { kind: "normal", code: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of ["malformed-jsonl", "missing-result", "malformed-result", "wrong-schema", "id-mismatch", "nonzero"] as const) {
  test(`Codex adapter rejects ${scenario} as a successful terminal contract`, async () => {
    const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
    try {
      const adapter = new CodexAdapter({ cliPath: createFakeCodex(root), runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
      adapter.probe();
      const handle = adapter.start(executionRequest(root, scenario, `attempt_${scenario.replaceAll("-", "_")}`));
      for await (const _event of adapter.events(handle)) {
        // Drain the provider protocol before terminal ingestion.
      }
      const raw = await adapter.wait(handle);
      assert.throws(() => parseExecutorResult(raw), /schemaVersion|expected|unknown contract/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Codex adapter timeout is classified as invalid, not exit-code success", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(root), runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    adapter.probe();
    const handle = adapter.start({ ...executionRequest(root, "timeout", "attempt_timeout"), timeoutMs: 30 });
    for await (const _event of adapter.events(handle)) {
      // Drain.
    }
    const raw = await adapter.wait(handle);
    assert.throws(() => parseExecutorResult(raw));
    assert.equal((await adapter.processEvidence(handle.attemptId))?.exitKind, "timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart reconciliation refuses a result while the recorded process group may still be alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const adapter = new CodexAdapter({ cliPath: createFakeCodex(root), runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    adapter.probe();
    const request = executionRequest(root, "cancel-output", "attempt_live_recovery");
    const handle = adapter.start(request);
    writeFileSync(join(root, "codex-attempts", request.attemptId, "executor-result.json"), `${JSON.stringify(validResult(request))}\n`, "utf8");

    const restarted = new CodexAdapter({ cliPath: createFakeCodex(root), runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    const reconciliation = await restarted.reconcile(request);
    assert.equal(reconciliation.outcome, "unknown");
    assert.match(reconciliation.summary, /may still exist/i);

    adapter.cancel(handle, "test cleanup");
    await adapter.processEvidence(handle.attemptId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function validResult(request: ExecutionRequest): Record<string, unknown> {
  return {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId: request.runId,
    taskId: request.taskId,
    attemptId: request.attemptId,
    executor: { adapter: "codex", adapterVersion: "untrusted", provider: "openai", model: request.model },
    outcome: "succeeded",
    failureClass: null,
    scopeClaim: "within_scope",
    summary: "synthetic persisted result",
    filesChanged: [],
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
}

export function executionRequest(cwd: string, scenario: string, attempt: string): ExecutionRequest {
  return {
    schemaVersion: CONTRACT_VERSIONS.executionRequest,
    runId: asRunId("run_codex"),
    taskId: asTaskId("task_codex"),
    attemptId: asAttemptId(attempt),
    role: "implementation",
    workingDirectory: cwd,
    promptSummary: `SCENARIO=${scenario}\nExpected result identity:\n- runId: run_codex\n- taskId: task_codex\n- attemptId: ${attempt}`,
    model: "fixture-model",
    reasoning: "medium",
    permissionPolicy: { filesystem: "worktree_only", network: "denied" },
    timeoutMs: 5000,
    expectedResultSchema: CONTRACT_VERSIONS.executorResult,
  };
}
