import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcessSupervisor, codexEnvironment } from "../src/process.js";

test("process supervisor uses explicit cwd/env and bounds output and JSONL", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-process-"));
  try {
    const process = new ProcessSupervisor().start({
      executable: processExecPath(),
      args: ["-e", "console.log(JSON.stringify({type:'ok',cwd:process.cwd(),visible:process.env.VISIBLE,secret:'sk-fixture123456'})); process.stdout.write('x'.repeat(5000)); process.stderr.write('ghp_synthetic123456 npm_synthetic123456 Cookie: session=synthetic-value postgres://user:pass@localhost/db ' + 'e'.repeat(5000));"],
      cwd: root,
      environment: { VISIBLE: "yes" },
      timeoutMs: 5000,
      maxStdoutBytes: 256,
      maxStderrBytes: 512,
      maxEventBytes: 256,
    });
    const result = await process.completion;
    assert.equal(result.exitKind, "normal");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.ok(result.stdoutBytesObserved > result.stdout.length);
    assert.ok(result.stderrBytesObserved > result.stderr.length);
    assert.ok(result.eventBytesObserved >= 5000);
    assert.equal((result.events[0]?.value as { cwd?: string }).cwd, realpathSync(root));
    assert.equal((result.events[0]?.value as { visible?: string }).visible, "yes");
    assert.equal((result.events[0]?.value as { secret?: string }).secret, "<redacted>");
    assert.equal(result.stdout.includes("sk-fixture123456"), false);
    assert.equal(result.stderr.includes("ghp_synthetic123456"), false);
    assert.equal(result.stderr.includes("npm_synthetic123456"), false);
    assert.equal(result.stderr.includes("session=synthetic-value"), false);
    assert.equal(result.stderr.includes("user:pass"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout and cancellation produce bounded signal evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-process-"));
  try {
    const supervisor = new ProcessSupervisor();
    const timed = supervisor.start({
      executable: processExecPath(),
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      environment: {},
      timeoutMs: 30,
      gracePeriodMs: 20,
    });
    const timedResult = await timed.completion;
    assert.equal(timedResult.exitKind, "timeout");
    assert.equal(timedResult.cancellationRequested, true);
    assert.equal(timedResult.processTreeEvidence, process.platform === "win32" ? "single_process_signal_sent" : "group_absent_after_exit");

    const cancelled = supervisor.start({
      executable: processExecPath(),
      args: ["-e", "setInterval(() => console.log(JSON.stringify({type:'tick'})), 10)"],
      cwd: root,
      environment: {},
      timeoutMs: 5000,
      gracePeriodMs: 20,
    });
    const cancelEvidence = cancelled.cancel();
    assert.equal(cancelEvidence.outcome, "signal_sent");
    const cancelledResult = await cancelled.completion;
    assert.equal(cancelledResult.cancellationRequested, true);
    assert.notEqual(cancelledResult.exitKind, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process events are observable before the supervised process becomes terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-process-"));
  try {
    const process = new ProcessSupervisor().start({
      executable: processExecPath(),
      args: ["-e", "console.log(JSON.stringify({type:'ready'})); setInterval(() => {}, 1000)"],
      cwd: root,
      environment: {},
      timeoutMs: 5000,
      gracePeriodMs: 20,
    });
    const iterator = process.events()[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal((first.value?.value as { type?: string }).type, "ready");
    assert.equal(process.cancel().outcome, "signal_sent");
    await process.completion;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation escalates to a forced process-group kill after the grace period", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-process-"));
  try {
    const process = new ProcessSupervisor().start({
      executable: processExecPath(),
      args: ["-e", "process.on('SIGTERM', () => {}); console.log(JSON.stringify({type:'ready'})); setInterval(() => {}, 1000)"],
      cwd: root,
      environment: {},
      timeoutMs: 5000,
      gracePeriodMs: 20,
    });
    const ready = await process.events()[Symbol.asyncIterator]().next();
    assert.equal(ready.done, false);
    assert.equal((ready.value?.value as { type?: string }).type, "ready");
    const cancelEvidence = process.cancel();
    assert.equal(cancelEvidence.outcome, "signal_sent");
    const result = await process.completion;
    assert.equal(result.exitKind, "signal");
    assert.equal(result.gracefulSignalSent, true);
    assert.equal(result.forcedSignalSent, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.processTreeEvidence, "group_absent_after_exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation terminates an owned grandchild even after the child exits", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-process-tree-"));
  try {
    const supervised = new ProcessSupervisor().start({
      executable: processExecPath(),
      args: ["-e", `
        const { spawn } = require('node:child_process');
        const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
        grandchild.stdout.once('data', () => console.log(JSON.stringify({type:'ready', grandchildPid: grandchild.pid})));
        setInterval(() => {}, 1000);
      `],
      cwd: root,
      environment: {},
      timeoutMs: 5000,
      gracePeriodMs: 30,
    });
    const ready = await supervised.events()[Symbol.asyncIterator]().next();
    const grandchildPid = Number((ready.value?.value as { grandchildPid?: number }).grandchildPid);
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    assert.equal(supervised.cancel().outcome, "signal_sent");
    const result = await supervised.completion;
    assert.equal(result.forcedSignalSent, true);
    assert.equal(result.processTreeEvidence, "group_absent_after_exit");
    assert.throws(() => process.kill(grandchildPid, 0), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex environment allowlist excludes common secret variables", () => {
  const environment = codexEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    OPENAI_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    CUSTOM_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    GITLAB_PRIVATE_TOKEN: "secret",
    NPM_TOKEN: "secret",
    DATABASE_URL: "postgres://credential",
    CI_JOB_JWT: "secret",
    SSH_PRIVATE_KEY: "secret",
  });
  assert.deepEqual(environment, { PATH: "/bin", HOME: "/tmp/home", CODEX_HOME: "/tmp/codex" });
});

function processExecPath(): string {
  return globalThis.process.execPath;
}
