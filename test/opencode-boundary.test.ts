import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function fixture(mode: string, root: string): Promise<string> {
  const env = {
    PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  };
  const args = [join(process.cwd(), "test/fixtures/opencode-boundary.mjs"), mode, root];
  const command = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : process.execPath;
  const result = await execute(command, process.platform === "darwin" ? ["-p", "(version 1) (allow default) (deny network*)", process.execPath, ...args] : args, { env, timeout: 30_000, maxBuffer: 128 * 1024 });
  return result.stdout.trim().split("\n").at(-1)!;
}

test("production OpenCode factory excludes disk/WellKnown extensions and MCP while preserving provider-owned auth and metadata", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-boundary-"));
  try {
    assert.match(await fixture("provision", root), /"provisioned":true/);
    assert.match(await fixture("control", root), /"authPreserved":true/);
    assert.match(await fixture("boundary", root), /"mcpCount":0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production OpenCode bridge owns stream abort, iterator return, host close and request cancellation", { timeout: 40_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-lifetime-"));
  try { assert.match(await fixture("lifecycle", root), /"mode":"lifecycle"/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("production OpenCode bridge preserves a normal-completion finalizer failure without abort", { timeout: 40_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-finalizer-"));
  try {
    const result = JSON.parse(await fixture("failed-normal-stream-finalizer", root));
    assert.equal(result.next.status, "rejected", JSON.stringify(result));
    assert.match(result.next.message, /synthetic normal-completion finalizer failure/);
    assert.equal(result.streamScopeReleased, 1);
    assert.equal(result.close.status, "rejected", JSON.stringify(result));
    assert.equal(result.close.code, "OPENCODE_STREAM_CLOSE_FAILED");
    assert.equal(result.closeSame, true);
    assert.equal(result.hostScopeReleased, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ["normal", "muse", "custom", "model", "catalog", "cohere", "perplexity", "installed", "file", "git", "unknown", "changed", "inherited"]) {
  test(`production OpenCode host enforces native-only provider execution: ${kind}`, { timeout: 40_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-provider-"));
    try {
      const result = JSON.parse(await fixture(`provider-runtime:${kind}`, root));
      assert.equal(result.outcome, kind === "normal" || kind === "muse" ? "succeeded" : "failed");
      for (const key of ["npmCalls", "pacoteLoads", "pacoteCalls", "fetchLoads", "fetchCalls", "cacheLoads", "cacheConstructs", "clients", "legacyHandlers", "externalModules"]) assert.equal(result[key], 0, key);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["failed-create", "stalled-close", "failed-stream-close", "drift:create", "drift:effect", "drift:source", "drift:mcp", "drift:host", "drift:result"]) {
  test(`production OpenCode bridge fails closed and releases resources: ${mode}`, { timeout: 40_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "kerbsflow-opencode-drift-"));
    try { assert.match(await fixture(mode, root), /"listeners":0/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
}
