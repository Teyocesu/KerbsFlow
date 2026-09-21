import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter, codexPermissionArguments } from "../src/codex.js";
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

test("Codex executor permission configuration is workspace-only and disables external tools", () => {
  const args = codexPermissionArguments();
  const values = args.filter((_, index) => index % 2 === 1);
  assert.equal(args.includes("--sandbox"), false);
  assert.ok(values.includes("web_search=\"disabled\""));
  assert.ok(values.includes("mcp_servers={}"));
  assert.ok(values.includes("features.apps=false"));
  assert.ok(values.includes("features.browser_use=false"));
  assert.ok(values.includes("features.computer_use=false"));
  assert.ok(values.includes("features.plugins=false"));
  assert.ok(values.includes("features.multi_agent=false"));
  assert.ok(values.includes("permissions.kerbsflow-worktree.network.enabled=false"));
  const filesystem = values.find((value) => value.startsWith("permissions.kerbsflow-worktree.filesystem="));
  assert.match(filesystem ?? "", /":root"="deny"/);
  assert.match(filesystem ?? "", /":minimal"="read"/);
  assert.match(filesystem ?? "", /"\/System\/Library\/OpenSSL"="read"/);
  assert.match(filesystem ?? "", /":tmpdir"="deny"/);
  assert.match(filesystem ?? "", /":slash_tmp"="deny"/);
  assert.match(filesystem ?? "", /"\/private\/tmp"="deny"/);
  assert.match(filesystem ?? "", /"\.git"="read"/);
  assert.match(filesystem ?? "", /"\.codex"="read"/);
  assert.match(filesystem ?? "", /"\.env"="deny"/);
  assert.match(filesystem ?? "", /"\.env\.\*"="deny"/);
  assert.match(filesystem ?? "", /"\*\*\/\.env"="deny"/);
  assert.match(filesystem ?? "", /"\."="write"/);
});

test("Codex probe fails closed when the permission boundary cannot deny an outside read", () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const cliPath = createFakeCodex(root);
    const source = readFileSync(cliPath, "utf8").replace(
      'process.exit(args.includes("KERBSFLOW_DENY_PROBE") ? 1 : 0);',
      "process.exit(0);",
    );
    writeFileSync(cliPath, source, { encoding: "utf8", mode: 0o700 });
    const adapter = new CodexAdapter({ cliPath, runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    assert.throws(() => adapter.probe(), /unexpectedly permitted/i);
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

test("restart reconciliation accepts only matching durable normal-exit evidence", async () => {
  const fixture = await durableFixture("success", "attempt_recovery_normal");
  try {
    const restarted = new CodexAdapter({ cliPath: fixture.cliPath, runtimeRoot: fixture.root, environment: { PATH: process.env.PATH, HOME: fixture.root } });
    const result = await restarted.reconcile(fixture.request);
    assert.equal(result.outcome, "terminal");
    assert.equal(result.result?.outcome, "succeeded");
    assert.deepEqual(result.result?.exit, { kind: "normal", code: 0 });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of ["nonzero", "timeout"] as const) {
  test(`restart reconciliation does not upgrade a valid result after ${scenario}`, async () => {
    const fixture = await durableFixture(scenario, `attempt_recovery_${scenario}`);
    try {
      writeFileSync(fixture.resultPath, `${JSON.stringify(validResult(fixture.request))}\n`, "utf8");
      const restarted = new CodexAdapter({ cliPath: fixture.cliPath, runtimeRoot: fixture.root, environment: { PATH: process.env.PATH, HOME: fixture.root } });
      const result = await restarted.reconcile(fixture.request);
      assert.equal(result.outcome, "unknown");
      assert.match(result.summary, /does not prove normal exit 0/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("restart reconciliation preserves cancellation-specific signal proof without accepting executor success", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const cliPath = createFakeCodex(root);
    const adapter = new CodexAdapter({ cliPath, runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    adapter.probe();
    const request = executionRequest(root, "cancel-output", "attempt_recovery_signal");
    const handle = adapter.start(request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    adapter.cancel(handle, "synthetic durable cancellation");
    await adapter.processEvidence(handle.attemptId);
    const resultPath = join(root, "codex-attempts", request.attemptId, "executor-result.json");
    writeFileSync(resultPath, `${JSON.stringify(validResult(request))}\n`, "utf8");
    const restarted = new CodexAdapter({ cliPath, runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    const result = await restarted.reconcile(request);
    assert.equal(result.outcome, "terminal");
    assert.equal(result.result?.outcome, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart reconciliation does not accept a signal exit without cancellation-specific proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  try {
    const cliPath = createFakeCodex(root);
    const adapter = new CodexAdapter({ cliPath, runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    adapter.probe();
    const request = executionRequest(root, "cancel-output", "attempt_recovery_unproven_signal");
    const handle = adapter.start(request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    adapter.cancel(handle, "create signal-exit fixture");
    await adapter.processEvidence(handle.attemptId);
    const directory = join(root, "codex-attempts", request.attemptId);
    const processResultPath = join(directory, "process-result.json");
    const evidence = JSON.parse(readFileSync(processResultPath, "utf8")) as Record<string, unknown>;
    evidence.cancellationRequested = false;
    evidence.gracefulSignalSent = false;
    evidence.forcedSignalSent = false;
    writeFileSync(processResultPath, `${JSON.stringify(evidence)}\n`, "utf8");
    writeFileSync(join(directory, "executor-result.json"), `${JSON.stringify(validResult(request))}\n`, "utf8");
    const restarted = new CodexAdapter({ cliPath, runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
    const result = await restarted.reconcile(request);
    assert.equal(result.outcome, "unknown");
    assert.match(result.summary, /does not prove normal exit 0/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart reconciliation requires durable process-result evidence", async () => {
  const fixture = await durableFixture("success", "attempt_recovery_missing_process_result");
  try {
    rmSync(fixture.processResultPath);
    const restarted = new CodexAdapter({ cliPath: fixture.cliPath, runtimeRoot: fixture.root, environment: { PATH: process.env.PATH, HOME: fixture.root } });
    const result = await restarted.reconcile(fixture.request);
    assert.equal(result.outcome, "unknown");
    assert.match(result.summary, /process-result evidence is missing/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restart reconciliation rejects mismatched durable process identity", async () => {
  const fixture = await durableFixture("success", "attempt_recovery_identity_mismatch");
  try {
    const evidence = JSON.parse(readFileSync(fixture.processResultPath, "utf8")) as { identity: { supervisorId: string } };
    evidence.identity.supervisorId = "different-supervisor";
    writeFileSync(fixture.processResultPath, `${JSON.stringify(evidence)}\n`, "utf8");
    const restarted = new CodexAdapter({ cliPath: fixture.cliPath, runtimeRoot: fixture.root, environment: { PATH: process.env.PATH, HOME: fixture.root } });
    const result = await restarted.reconcile(fixture.request);
    assert.equal(result.outcome, "unknown");
    assert.match(result.summary, /identity does not match/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function durableFixture(scenario: string, attempt: string): Promise<{
  root: string;
  cliPath: string;
  request: ExecutionRequest;
  resultPath: string;
  processResultPath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-codex-"));
  const cliPath = createFakeCodex(root);
  const adapter = new CodexAdapter({ cliPath, runtimeRoot: root, environment: { PATH: process.env.PATH, HOME: root } });
  adapter.probe();
  const request = { ...executionRequest(root, scenario, attempt), ...(scenario === "timeout" ? { timeoutMs: 30 } : {}) };
  const handle = adapter.start(request);
  for await (const _event of adapter.events(handle)) {
    // Drain to terminal and persist process-result evidence.
  }
  await adapter.wait(handle);
  const directory = join(root, "codex-attempts", request.attemptId);
  return {
    root,
    cliPath,
    request,
    resultPath: join(directory, "executor-result.json"),
    processResultPath: join(directory, "process-result.json"),
  };
}

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
