import { syntheticReleaseDossier, withSyntheticTechnicalExclusion } from "./release-evidence-helpers.js";
import { parseReleaseEvidenceDossier, type ReleaseEvidenceDossier } from "../src/contracts.js";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_VERSIONS,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  asRunId,
  mergeConfiguration,
  parseCommand,
  parseExecutorResult,
  parseHumanGate,
  parsePauseContract,
} from "../src/contracts.js";
import { ContractValidationError } from "../src/contracts.js";

test("runtime validators fail closed on unknown contract versions", () => {
  assert.throws(() => parseExecutorResult({ schemaVersion: "kerbsflow.executor-result/v2" }), ContractValidationError);
  assert.throws(() => parseCommand({ schemaVersion: "kerbsflow.command/v2" }), ContractValidationError);
});

test("pause contract validation rejects a tampered target inconsistent with its durable boundary", () => {
  assert.throws(() => parsePauseContract({
    schemaVersion: CONTRACT_VERSIONS.pause,
    originState: "PLAN",
    durableBoundary: "quiescent",
    resumeTarget: "RECOVERY",
  }), ContractValidationError);
});

test("resume commands cannot carry a UI-selected target", () => {
  assert.throws(() => parseCommand({
    schemaVersion: CONTRACT_VERSIONS.command,
    commandId: "command_resume",
    idempotencyKey: "resume",
    runId: "run_resume",
    expectedStateVersion: 1,
    kind: "resume",
    target: "EXECUTE",
  }), ContractValidationError);
});

test("Cancel command reasons are bounded by UTF-8 bytes", () => {
  const base = {
    schemaVersion: CONTRACT_VERSIONS.command,
    commandId: "command_cancel_bytes",
    idempotencyKey: "cancel-bytes",
    runId: "run_cancel_bytes",
    expectedStateVersion: 1,
    kind: "cancel",
  };
  const maximum = `${"€".repeat(341)}a`;
  assert.equal(Buffer.byteLength(maximum, "utf8"), 1024);
  assert.equal(parseCommand({ ...base, reason: maximum }).kind, "cancel");
  assert.throws(() => parseCommand({ ...base, reason: "€".repeat(1000) }), ContractValidationError);
});

test("human gates require two or more explicit options", () => {
  assert.throws(() => parseHumanGate({
    schemaVersion: CONTRACT_VERSIONS.humanGate,
    gateId: "gate_one",
    runId: "run_one",
    reasonCode: "unknown",
    summary: "needs a decision",
    evidenceRefs: [],
    options: [{ id: "fail", label: "Fail", consequence: "stop", target: "FAILED" }],
    status: "open",
  }), ContractValidationError);
});

test("configuration precedence rejects lower-layer hard-invariant relaxation", () => {
  assert.throws(() => mergeConfiguration({
    hardInvariants: DEFAULT_HARD_INVARIANTS,
    projectPolicy: { ...DEFAULT_PROJECT_POLICY, maxImplementationAttempts: 1 },
    userPreferences: DEFAULT_USER_PREFERENCES,
    runOverride: { ...DEFAULT_RUN_OVERRIDE, maxImplementationAttempts: 2 },
  }), ContractValidationError);

  assert.throws(() => mergeConfiguration({
    hardInvariants: DEFAULT_HARD_INVARIANTS,
    projectPolicy: { ...DEFAULT_PROJECT_POLICY, validationLevel: "phase" },
    userPreferences: DEFAULT_USER_PREFERENCES,
    runOverride: { ...DEFAULT_RUN_OVERRIDE, validationLevel: "focused" },
  }), ContractValidationError);
});

test("validated configuration retains its policy when caller-owned layers mutate", () => {
  const layers = {
    hardInvariants: { ...DEFAULT_HARD_INVARIANTS },
    projectPolicy: { ...DEFAULT_PROJECT_POLICY, allowedAdapters: ["fake"] },
    userPreferences: { ...DEFAULT_USER_PREFERENCES },
    runOverride: { ...DEFAULT_RUN_OVERRIDE },
  };
  const configuration = mergeConfiguration(layers);
  layers.projectPolicy.allowedAdapters.push("codex");
  layers.projectPolicy.validationLevel = "full";
  layers.projectPolicy.maxImplementationAttempts = 1;
  assert.deepEqual(configuration.projectPolicy.allowedAdapters, ["fake"]);
  assert.equal(configuration.projectPolicy.validationLevel, "focused");
  assert.equal(configuration.projectPolicy.maxImplementationAttempts, 2);
  assert.throws(() => configuration.projectPolicy.allowedAdapters.push("codex"), TypeError);
  assert.throws(() => { configuration.effectiveMaxImplementationAttempts = 1; }, TypeError);
});

test("configuration precedence permits only a policy-approved narrowing", () => {
  const configuration = mergeConfiguration({
    hardInvariants: DEFAULT_HARD_INVARIANTS,
    projectPolicy: { ...DEFAULT_PROJECT_POLICY, allowedAdapters: ["fake"] },
    userPreferences: { ...DEFAULT_USER_PREFERENCES, preferredAdapter: "fake" },
    runOverride: DEFAULT_RUN_OVERRIDE,
  });
  assert.equal(configuration.effectiveAdapter, "fake");
  assert.equal(configuration.effectiveMaxImplementationAttempts, 2);
  assert.equal(asRunId("run_contracts"), "run_contracts");
});

for (const [name, mutate] of [
  ["14 ACs", (d: ReleaseEvidenceDossier) => { d.acceptance.pop(); }],
  ["sparse AC array", (d: ReleaseEvidenceDossier) => { delete d.acceptance[7]; }],
  ["duplicate AC", (d: ReleaseEvidenceDossier) => { d.acceptance[1]!.id = "AC1"; }],
  ["non-PASS AC", (d: ReleaseEvidenceDossier) => { Object.assign(d.acceptance[0]!, { outcome: "unknown" }); }],
  ["empty AC refs", (d: ReleaseEvidenceDossier) => { d.acceptance[0]!.evidenceRefs = []; }],
  ["dangling ref", (d: ReleaseEvidenceDossier) => { d.acceptance[0]!.evidenceRefs = ["evidence_missing"]; }],
  ["duplicate evidence", (d: ReleaseEvidenceDossier) => { d.evidence.push({ ...d.evidence[0]! }); }],
  ["inferred-only AC", (d: ReleaseEvidenceDossier) => { d.evidence[0]!.classification = "inferred"; }],
  ["untested AC", (d: ReleaseEvidenceDossier) => { d.evidence[0]!.classification = "not_tested"; }],
  ["private path", (d: ReleaseEvidenceDossier) => { d.acceptance[0]!.summary = "/private/tmp/raw.log"; }],
  ...["log:/Users/fixture/private-review/raw.log", "trace(/private/tmp/raw.log)", "source:/tmp/evidence.txt", "file:///Users/fixture/raw.log", "log:C:\\Users\\fixture\\raw.log", "log:\\\\fixture\\private\\raw.log"].map(path =>
    [`embedded path ${path}`, (d: ReleaseEvidenceDossier) => { d.acceptance[0]!.summary = path; }] as const),
  ["AC15 typecheck-only", (d: ReleaseEvidenceDossier) => { d.acceptance[14]!.evidenceRefs = ["evidence_typecheck"]; }],
  ["AC15 unrelated fresh gate evidence", (d: ReleaseEvidenceDossier) => { d.acceptance[14]!.evidenceRefs = ["evidence_gate"]; }],
  ...["reused", "synthetic", "stale", "wrong hash"].map(variant =>
    [`AC15 ${variant} npm-test ref`, (d: ReleaseEvidenceDossier) => {
      const item = { ...d.evidence.find(e => e.id === "evidence_npm_test")!, id: "evidence_invalid_npm_test" };
      if (variant === "reused") item.origin = "reused";
      if (variant === "synthetic") item.boundary = "synthetic";
      if (variant === "stale") { item.origin = "reused"; item.candidateHead = "3".repeat(40); }
      if (variant === "wrong hash") item.hash = "3".repeat(64);
      d.evidence.push(item);
      d.deterministicGate.commands.find(cmd => cmd.command === "npm test")!.evidenceRefs.push(item.id);
      d.deterministicGate.evidenceRefs.push(item.id);
      d.acceptance[14]!.evidenceRefs = [item.id];
    }] as const),
  ["raw log", (d: ReleaseEvidenceDossier) => { d.acceptance[0]!.summary = "raw\nlog"; }],
  ["unknown field", (d: ReleaseEvidenceDossier) => { Object.assign(d.host, { environment: {} }); }],
  ["oversized dossier", (d: ReleaseEvidenceDossier) => { d.evidence = Array.from({ length: 200 }, (_, i) => ({ ...d.evidence[0]!, id: `evidence_${i}`, summary: "x".repeat(1000) })); }],
  ["secret dossier", (d: ReleaseEvidenceDossier) => { d.acceptance[0]!.summary = "sk-syntheticdossiercredential"; }],
  ["missing paired scenario", (d: ReleaseEvidenceDossier) => { d.scenarios.pop(); }],
  ["sparse scenario array", (d: ReleaseEvidenceDossier) => { delete d.scenarios[7]; }],
  ["duplicate scenario", (d: ReleaseEvidenceDossier) => { d.scenarios[1] = { ...d.scenarios[0]! }; }],
  ["incomplete discovery", (d: ReleaseEvidenceDossier) => { d.deterministicGate.suites.executed--; }],
  ["suite failures", (d: ReleaseEvidenceDossier) => { Object.assign(d.deterministicGate.suites, { failures: 1 }); }],
  ["no complete suite command", (d: ReleaseEvidenceDossier) => { d.deterministicGate.commands.pop(); }],
  ["reused final gate", (d: ReleaseEvidenceDossier) => { d.evidence[0]!.origin = "reused"; }],
  ["unavailable audit without decision", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.status = "unavailable"; d.dependencies.audit.advisories = null; }],
  ["untested evidence promoted by a tested section", (d: ReleaseEvidenceDossier) => {
    d.evidence.push({ ...d.evidence[0]!, id: "evidence_untested", classification: "not_tested" });
    d.liveProvider = { status: "tested", reason: "fixture claim", evidenceRefs: ["evidence_untested"] };
  }],
  ["untested completed audit", (d: ReleaseEvidenceDossier) => {
    d.evidence.push({ ...d.evidence[0]!, id: "evidence_untested", classification: "not_tested" });
    d.dependencies.audit.evidenceRefs = ["evidence_untested"];
  }],
  ["untested adapter readiness", (d: ReleaseEvidenceDossier) => {
    d.evidence.push({ ...d.evidence[0]!, id: "evidence_untested", classification: "not_tested" });
    d.adapters[0]!.evidenceRefs = ["evidence_untested"];
  }],
  ["known review blocker", (d: ReleaseEvidenceDossier) => { Object.assign(d.reviewHistory, { knownBlockers: 1 }); }],
  ["OpenCode OS claim", (d: ReleaseEvidenceDossier) => { d.adapters[1]!.workload = "os_enforced"; }],
  ["automatic release allowed", (d: ReleaseEvidenceDossier) => { d.prohibitedActions.pop(); }],
] as const) {
  test(`release dossier rejects ${name}`, () => {
    const dossier = syntheticReleaseDossier();
    mutate(dossier);
    assert.throws(() => parseReleaseEvidenceDossier(dossier), ContractValidationError);
  });
}

test("release dossier is copied and frozen; optional live inference remains explicitly untested", () => {
  const caller = syntheticReleaseDossier();
  const accepted = parseReleaseEvidenceDossier(caller);
  caller.acceptance[0]!.evidenceRefs.length = 0;
  caller.liveProvider.reason = "caller changed";
  assert.deepEqual(accepted.acceptance[0]!.evidenceRefs, ["evidence_gate"]);
  assert.deepEqual(accepted.liveProvider, { status: "not_tested", reason: "not opted in", evidenceRefs: [] });
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.acceptance[0]!.evidenceRefs));
  assert.ok(Object.isFrozen(accepted.deterministicGate.boundaries));
});

test("release dossier accepts direct fresh npm-test attribution and ordinary colon text", () => {
  const dossier = syntheticReleaseDossier();
  dossier.acceptance[14]!.evidenceRefs = ["evidence_npm_test"];
  dossier.acceptance[14]!.summary = "status:ok AC15:PASS npm:test model:opencode/muse relative:docs/PLAN.md";
  const accepted = parseReleaseEvidenceDossier(dossier);
  assert.deepEqual(accepted.acceptance[14]!.evidenceRefs, ["evidence_npm_test"]);
  assert.equal(accepted.acceptance[14]!.summary, dossier.acceptance[14]!.summary);
});

for (const [name, mutate] of [
  ["nonzero audit without dispositions", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions = []; }],
  ["unreviewed assertion", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.riskDispositionRefs = []; }],
  ["inferred-only source", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_source")!.classification = "inferred"; }],
  ["dangling verification reference", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions[0]!.verificationRefs = ["evidence_missing"]; }],
  ["stale candidate proof even when reused", (d: ReleaseEvidenceDossier) => { Object.assign(d.evidence.find(e => e.id === "evidence_advisory_source")!, { origin: "reused", candidateHead: "7".repeat(40) }); }],
  ["stale fingerprint binding", (d: ReleaseEvidenceDossier) => { d.candidate.fingerprint = "7".repeat(64); }],
  ["stale lock binding", (d: ReleaseEvidenceDossier) => { d.candidate.hashes.lock = "7".repeat(64); }],
  ["stale launch profile binding", (d: ReleaseEvidenceDossier) => { d.candidate.hashes.profile = "7".repeat(64); }],
  ["changed runtime assumptions", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions[0]!.assumptions = ["Different host configuration"]; }],
  ["changed runtime identity", (d: ReleaseEvidenceDossier) => { d.host.node = "24.0.1"; }],
  ["changed adapter capability", (d: ReleaseEvidenceDossier) => { d.adapters[1]!.capabilityHash = "7".repeat(64); }],
  ["wrong dependency attribution", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions[0]!.packageName = "other-package"; }],
  ["wrong advisory attribution", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions[0]!.advisoryId = "GHSA-5555-6666-7777"; }],
  ["version range instead of exact installed version", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.roots[0]!.versions = ["^1.2.3"]; }],
  ["unknown advisory identifier", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.roots[0]!.advisoryId = "UNKNOWN"; }],
  ["missing boundary evidence", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions[0]!.verificationRefs = []; }],
  ["missing reviewer session", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_review")!.dependencyProof!.sessionId = ""; }],
  ["changed exact affected version", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.roots[0]!.versions = ["9.9.9"]; }],
  ["wrong vulnerable entry point", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.roots[0]!.entryPoint = "unrelatedFunction"; }],
  ["contradictory referenced evidence", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_source")!.dependencyProof!.conclusion = "contradicted"; }],
  ["installed reachable vulnerability claimed excluded", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_boundary")!.dependencyProof!.conclusion = "contradicted"; }],
  ["uncertain exclusion", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_boundary")!.dependencyProof!.conclusion = "uncertain"; }],
  ["contradictory evidence omitted from selected refs", (d: ReleaseEvidenceDossier) => { const e = structuredClone(d.evidence.find(e => e.id === "evidence_advisory_boundary")!); e.id = "evidence_counterexample"; e.dependencyProof!.conclusion = "contradicted"; d.evidence.push(e); }],
  ["unsupported extra advisory root", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.roots.push({ ...d.dependencies.audit.roots[0]!, advisoryId: "GHSA-5555-6666-7777" }); }],
  ["unknown advisory root disposition", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions.push({ ...d.dependencies.audit.technicalDispositions[0]!, advisoryId: "GHSA-5555-6666-7777" }); }],
  ["duplicate advisory root", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.roots.push(structuredClone(d.dependencies.audit.roots[0]!)); }],
  ["duplicate disposition", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions.push(structuredClone(d.dependencies.audit.technicalDispositions[0]!)); }],
  ["fabricated manual review label", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_review")!.classification = "manually_validated"; }],
  ["missing independent-review attribution", (d: ReleaseEvidenceDossier) => { delete d.evidence.find(e => e.id === "evidence_advisory_review")!.dependencyProof; }],
  ["same-session self approval", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_review")!.dependencyProof!.sessionId = d.dependencies.audit.technicalDispositions[0]!.authorSessionId; }],
  ["arbitrary inspected reference", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.technicalDispositions[0]!.sourceRefs = ["evidence_gate"]; }],
  ["wrong evidence role", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_review")!.dependencyProof!.role = "source_analysis"; }],
  ["simulated boundary substitute", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_boundary")!.boundary = "synthetic"; }],
  ["reused audit inventory", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_inventory")!.origin = "reused"; }],
  ["wrong audit inventory hash", (d: ReleaseEvidenceDossier) => { d.evidence.find(e => e.id === "evidence_advisory_inventory")!.dependencyProof!.claimHash = "7".repeat(64); }],
  ["hidden root by zero count", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.advisories = 0; }],
  ["legacy v1 human-label bypass", (d: ReleaseEvidenceDossier) => { Object.assign(d, { schemaVersion: "kerbsflow.release-evidence/v1" }); }],
  ["unavailable audit with manual label", (d: ReleaseEvidenceDossier) => { d.dependencies.audit.status = "unavailable"; d.dependencies.audit.advisories = null; d.evidence.find(e => e.id === "evidence_advisory_review")!.classification = "manually_validated"; }],
] as const) {
  test(`technical advisory disposition rejects ${name}`, () => {
    const dossier = withSyntheticTechnicalExclusion(syntheticReleaseDossier());
    mutate(dossier);
    assert.throws(() => parseReleaseEvidenceDossier(dossier), ContractValidationError);
  });
}

test("nonzero audit accepts bound independently reviewed exclusion without human observations", () => {
  const dossier = withSyntheticTechnicalExclusion(syntheticReleaseDossier());
  assert.equal(dossier.evidence.some(e => e.classification === "manually_validated"), false);
  const accepted = parseReleaseEvidenceDossier(dossier);
  assert.equal(accepted.dependencies.audit.advisories, 1);
  assert.deepEqual(accepted.dependencies.audit.technicalDispositions, dossier.dependencies.audit.technicalDispositions);
  assert.ok(Object.isFrozen(accepted.dependencies.audit.technicalDispositions[0]!.assumptions));
  assert.ok(Object.isFrozen(accepted.evidence.find(e => e.dependencyProof)?.dependencyProof));
  dossier.dependencies.audit.roots[0]!.versions[0] = "9.9.9";
  assert.deepEqual(accepted.dependencies.audit.roots[0]!.versions, ["1.2.3"]);
});
