import test from "node:test";
import assert from "node:assert/strict";

import { detectAntiGreenwashing, type AntiGreenwashingCode } from "../src/anti-greenwashing.js";

const mutations: Array<{ name: string; path: string; body: string; expected: AntiGreenwashingCode }> = [
  { name: "deleted test", path: "test/example.test.ts", body: "deleted file mode 100644\n@@ -1,1 +0,0 @@\n-assert.equal(value, true);", expected: "test_deleted" },
  { name: "focused test", path: "test/example.test.ts", body: "@@ -1,1 +1,1 @@\n-test('works', fn);\n+test.only('works', fn);", expected: "test_skip_or_focus" },
  { name: "removed assertion", path: "test/example.test.ts", body: "@@ -1,1 +1,0 @@\n-assert.equal(value, true);", expected: "assertion_removed" },
  { name: "disabled typecheck", path: "tsconfig.json", body: "@@ -1,1 +1,1 @@\n-\"noEmit\": true\n+\"noEmit\": false", expected: "validation_disabled" },
  { name: "removed validation command", path: "package.json", body: "@@ -1,1 +1,0 @@\n-\"typecheck\": \"tsc --noEmit\"", expected: "validation_command_removed" },
  { name: "coverage threshold change", path: "coverage.config.js", body: "@@ -1,1 +1,1 @@\n-branches: 90\n+branches: 40", expected: "coverage_threshold_reduced" },
  { name: "suppression", path: "src/example.ts", body: "@@ -1,0 +1,1 @@\n+// @ts-ignore", expected: "suppression_introduced" },
  { name: "broad exclude", path: "tsconfig.json", body: "@@ -1,0 +1,1 @@\n+\"exclude\": [\"src/**\"]", expected: "ignore_or_exclude_expanded" },
  { name: "empty catch", path: "src/example.ts", body: "@@ -1,0 +1,1 @@\n+try { work(); } catch {}", expected: "empty_catch" },
  { name: "silent fallback", path: "src/example.ts", body: "@@ -1,0 +1,1 @@\n+try { work(); } catch { return false; }", expected: "silent_fallback" },
  { name: "error swallowing", path: "src/example.ts", body: "@@ -1,0 +1,1 @@\n+try { work(); } catch (error) { console.log(error); }", expected: "error_swallowing" },
  { name: "stub", path: "src/example.ts", body: "@@ -1,0 +1,1 @@\n+throw new Error('not implemented');", expected: "stub_or_noop" },
  { name: "forced success fixture", path: "test/fixtures/result.ts", body: "@@ -1,0 +1,1 @@\n+export const outcome = 'passed';", expected: "generated_success_fixture" },
  { name: "narrowed test config", path: "jest.config.ts", body: "@@ -1,0 +1,1 @@\n+export const testMatch = ['only-one.test.ts'];", expected: "test_configuration_narrowed" },
  { name: "removed CI check", path: ".github/workflows/ci.yml", body: "@@ -1,1 +1,0 @@\n-      run: npm test", expected: "ci_check_removed" },
];

for (const mutation of mutations) {
  test(`anti-greenwashing mutation detects ${mutation.name}`, () => {
    const diff = `diff --git a/${mutation.path} b/${mutation.path}\n--- a/${mutation.path}\n+++ b/${mutation.path}\n${mutation.body}\n`;
    const signals = detectAntiGreenwashing(diff, [mutation.path]);
    const signal = signals.find((candidate) => candidate.code === mutation.expected);
    assert.ok(signal, `expected ${mutation.expected}, got ${signals.map((candidate) => candidate.code).join(", ")}`);
    assert.equal(signal.classification, "inspected");
    assert.equal(typeof signal.blocksPass, "boolean");
    assert.equal(typeof signal.semanticReviewRequired, "boolean");
    assert.equal(signal.path, mutation.path);
    if (mutation.expected === "test_deleted") {
      assert.equal(signal.code, "test_deleted");
      assert.equal(signal.blocksPass, false);
      assert.equal(signal.semanticReviewRequired, true);
    }
  });
}

test("clean production addition has no anti-greenwashing signal", () => {
  const diff = "diff --git a/src/value.ts b/src/value.ts\n--- /dev/null\n+++ b/src/value.ts\n@@ -0,0 +1,1 @@\n+export const value = 1;\n";
  assert.deepEqual(detectAntiGreenwashing(diff, ["src/value.ts"]), []);
});
