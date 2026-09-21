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
