export type AntiGreenwashingCode =
  | "test_deleted"
  | "test_skip_or_focus"
  | "assertion_removed"
  | "expectation_weakened"
  | "validation_disabled"
  | "validation_command_removed"
  | "coverage_threshold_reduced"
  | "suppression_introduced"
  | "ignore_or_exclude_expanded"
  | "empty_catch"
  | "silent_fallback"
  | "error_swallowing"
  | "stub_or_noop"
  | "generated_success_fixture"
  | "test_configuration_narrowed"
  | "ci_check_removed";

export interface AntiGreenwashingSignal {
  code: AntiGreenwashingCode;
  path?: string;
  line?: number;
  classification: "inspected";
  explanation: string;
  blocksPass: boolean;
  semanticReviewRequired: boolean;
}

interface DiffLine {
  path?: string;
  line?: number;
  text: string;
}

export function detectAntiGreenwashing(diff: string, changedPaths: readonly string[]): AntiGreenwashingSignal[] {
  const { added, removed, deletedPaths } = parseUnifiedDiff(diff);
  const signals: AntiGreenwashingSignal[] = [];
  const add = (
    code: AntiGreenwashingCode,
    source: DiffLine | undefined,
    explanation: string,
    blocksPass: boolean,
    semanticReviewRequired: boolean,
  ): void => {
    if (signals.some((signal) => signal.code === code && signal.path === source?.path && signal.line === source?.line)) {
      return;
    }
    signals.push({
      code,
      ...(source?.path === undefined ? {} : { path: source.path }),
      ...(source?.line === undefined ? {} : { line: source.line }),
      classification: "inspected",
      explanation,
      blocksPass,
      semanticReviewRequired,
    });
  };

  for (const path of deletedPaths) {
    if (isTestPath(path)) {
      add("test_deleted", { path, text: "" }, "a test file was deleted", true, false);
    }
    if (isCiPath(path)) {
      add("ci_check_removed", { path, text: "" }, "a CI/check definition was deleted", true, false);
    }
  }

  for (const line of added) {
    if (/\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(/u.test(line.text)) {
      add("test_skip_or_focus", line, "a test skip or focus marker was introduced", true, false);
    }
    if (/@ts-ignore|@ts-nocheck|eslint-disable|noqa|type:\s*ignore|coverage\s+ignore/iu.test(line.text)) {
      add("suppression_introduced", line, "a static-analysis or coverage suppression was introduced", true, false);
    }
    if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/u.test(line.text)) {
      add("empty_catch", line, "an empty catch block was introduced", true, false);
    }
    if (/catch[^\n]*\{[^\n]*(?:return\s+(?:undefined|null|false|true|\[\]|\{\})|continue\s*;)/u.test(line.text)) {
      add("silent_fallback", line, "a catch path now converts an error into an apparently successful fallback", false, true);
    }
    if (/catch[^\n]*\{[^\n]*(?:console\.(?:debug|log)|void\s+\w+|return\s*;)/u.test(line.text)) {
      add("error_swallowing", line, "a catch path may swallow an error without propagating failure", false, true);
    }
    if (/"noEmit"\s*:\s*false|"skipLibCheck"\s*:\s*true|--no-check|--forceExit\b|passWithNoTests/iu.test(line.text)) {
      add("validation_disabled", line, "typecheck or validation behavior was disabled or weakened", true, false);
    }
    if (/"(?:exclude|ignorePatterns|testPathIgnorePatterns|coveragePathIgnorePatterns)"\s*:/u.test(line.text)) {
      add("ignore_or_exclude_expanded", line, "an ignore or exclude boundary was expanded", false, true);
    }
    if (/\b(?:TODO|FIXME)\b[^\n]*(?:stub|implement)|throw\s+new\s+Error\(["']not implemented|return\s+(?:undefined|null|false|true|\[\]|\{\})\s*;?\s*(?:\/\/.*)?$/iu.test(line.text)) {
      add("stub_or_noop", line, "production behavior may have been replaced by a stub or no-op", false, true);
    }
    if (/fixture|mock|stub/iu.test(line.path ?? "") && /(?:always|force).*(?:pass|success)|outcome\s*[:=]\s*["']passed["']/iu.test(line.text)) {
      add("generated_success_fixture", line, "a generated fixture appears to force a successful result", false, true);
    }
    if (/\b(?:testMatch|testRegex|include)\b/u.test(line.text) && isTestConfigPath(line.path)) {
      add("test_configuration_narrowed", line, "test selection configuration changed and may narrow coverage", false, true);
    }
  }

  for (const line of removed) {
    if (/\b(?:assert(?:\.\w+)?|expect|assertThat)\s*\(/u.test(line.text)) {
      add("assertion_removed", line, "an assertion was removed", false, true);
    }
    if (/"(?:test|typecheck|lint|build|check)"\s*:/u.test(line.text)) {
      add("validation_command_removed", line, "a validation command was removed", true, false);
    }
    if (/\b(?:branches|functions|lines|statements)\s*:\s*\d+/u.test(line.text)) {
      add("coverage_threshold_reduced", line, "a coverage threshold changed and requires comparison", false, true);
    }
    if (/\.(?:toEqual|toStrictEqual|toBe|deepEqual|strictEqual)\s*\(/u.test(line.text)) {
      add("expectation_weakened", line, "a strong expectation was removed or may have been weakened", false, true);
    }
    if (isCiPath(line.path) && /(?:run:|uses:|script:|npm\s+(?:test|run\s+\w+))/u.test(line.text)) {
      add("ci_check_removed", line, "a CI/check step was removed", true, false);
    }
  }

  for (const path of changedPaths) {
    if (isTestPath(path) && !deletedPaths.has(path) && !added.some((line) => line.path === path) && removed.some((line) => line.path === path)) {
      add("test_configuration_narrowed", { path, text: "" }, "test content was only removed and may narrow coverage", false, true);
    }
  }

  return signals;
}

function parseUnifiedDiff(diff: string): { added: DiffLine[]; removed: DiffLine[]; deletedPaths: Set<string> } {
  const added: DiffLine[] = [];
  const removed: DiffLine[] = [];
  const deletedPaths = new Set<string>();
  let path: string | undefined;
  let addedLine = 0;
  let removedLine = 0;
  for (const raw of diff.split("\n")) {
    const header = raw.match(/^diff --git a\/(.+) b\/(.+)$/u);
    if (header !== null) {
      path = header[2];
      continue;
    }
    const untracked = raw.match(/^diff --kerbsflow-untracked "?([^"\n]+)"?$/u);
    if (untracked !== null) {
      path = untracked[1];
      continue;
    }
    if (raw.startsWith("deleted file mode") && path !== undefined) {
      deletedPaths.add(path);
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk !== null) {
      removedLine = Number(hunk[1]);
      addedLine = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      added.push({ ...(path === undefined ? {} : { path }), line: addedLine, text: raw.slice(1) });
      addedLine += 1;
      continue;
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      removed.push({ ...(path === undefined ? {} : { path }), line: removedLine, text: raw.slice(1) });
      removedLine += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      addedLine += 1;
      removedLine += 1;
    }
  }
  return { added, removed, deletedPaths };
}

function isTestPath(path: string): boolean {
  return /(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

function isCiPath(path: string | undefined): boolean {
  return path !== undefined && /(^|\/)\.github\/workflows\/|(^|\/)(?:ci|pipeline)(?:\/|\.|$)/iu.test(path);
}

function isTestConfigPath(path: string | undefined): boolean {
  return path !== undefined && /(?:jest|vitest|mocha|ava|playwright|package\.json|tsconfig)/iu.test(path);
}
