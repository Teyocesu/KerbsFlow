import test from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_VERSIONS, type AdapterDescriptor } from "../src/contracts.js";
import { adapterOsCapability, isolationIssues } from "../src/isolation.js";

test("adapter and OS capability matrix keeps enforced and tool-policy boundaries distinct", () => {
  const codex = descriptor("codex", "enforced", "enforced");
  const opencode = descriptor("opencode", "tool_policy_only", "tool_policy_only");
  for (const platform of ["darwin", "linux"] as const) {
    assert.deepEqual(adapterOsCapability(codex, platform), {
      adapter: "codex",
      platform,
      supportedHost: true,
      filesystem: "enforced",
      workloadNetwork: "enforced",
      providerControlPlane: "provider_owned",
    });
    assert.equal(adapterOsCapability(opencode, platform).filesystem, "tool_policy_only");
    assert.equal(adapterOsCapability(opencode, platform).workloadNetwork, "tool_policy_only");
    assert.deepEqual(isolationIssues(opencode, { filesystem: "enforced", workloadNetwork: "enforced" }, platform).length, 2);
  }
  assert.equal(adapterOsCapability(codex, "win32").filesystem, "unavailable");
  assert.match(isolationIssues(codex, { filesystem: "tool_policy_only", workloadNetwork: "tool_policy_only" }, "win32")[0] ?? "", /outside.*support matrix/i);
});

function descriptor(adapter: string, filesystem: "enforced" | "tool_policy_only", workload: "enforced" | "tool_policy_only"): AdapterDescriptor {
  return {
    schemaVersion: CONTRACT_VERSIONS.adapterDescriptor,
    adapter,
    provider: "synthetic",
    adapterVersion: "fixture",
    capabilities: {
      eventTransport: adapter === "codex" ? "jsonl" : "async_iterable",
      finalJsonSchema: adapter === "codex",
      modelSelection: true,
      reasoningEffort: [],
      agentSelection: adapter === "opencode",
      filesystemEnforcement: filesystem,
      network: { providerControlPlane: "provider_owned", workload },
      cancellation: adapter === "codex" ? "process_only" : "native",
      resumableSession: true,
      authentication: { owner: "provider", mode: "synthetic" },
      healthProbe: true,
    },
  };
}
