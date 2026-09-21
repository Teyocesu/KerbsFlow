import test from "node:test";
import assert from "node:assert/strict";

import { allLegalTransitions, assertLegalTransition, choosePauseContract, isLegalTransition, StateMachineError } from "../src/state-machine.js";

test("every frozen legal transition is accepted", () => {
  for (const [from, to] of allLegalTransitions()) {
    assert.equal(isLegalTransition(from, to), true, `${from} -> ${to}`);
    assert.doesNotThrow(() => assertLegalTransition(from, to), `${from} -> ${to}`);
  }
});

test("representative illegal and terminal transitions are rejected", () => {
  assert.throws(() => assertLegalTransition("PLAN", "EXECUTE"), StateMachineError);
  assert.throws(() => assertLegalTransition("EXECUTE", "DONE"), StateMachineError);
  assert.throws(() => assertLegalTransition("DONE", "PLAN"), StateMachineError);
});

test("pause selection is deterministic and never targets EXECUTE", () => {
  assert.deepEqual(choosePauseContract("PLAN", false), { resumeTarget: "PLAN", durableBoundary: "quiescent" });
  assert.deepEqual(choosePauseContract("EXECUTE", false), { resumeTarget: "RECOVERY", durableBoundary: "uncertain_activity" });
  assert.deepEqual(choosePauseContract("REVIEW", true), { resumeTarget: "RECOVERY", durableBoundary: "uncertain_activity" });
  assert.throws(() => choosePauseContract("IDLE", false), StateMachineError);
});
