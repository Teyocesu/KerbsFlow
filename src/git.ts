import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { KerbsFlowError } from "./errors.js";
import { atomicWritePrivateFile, ensurePrivateDirectory, pathIsWithin, readPrivateFileWithin } from "./paths.js";
import { redactDiagnostic } from "./secrets.js";

export interface RepositoryIntake {
  repositoryPath: string;
  gitCommonDirectory: string;
  baseOid: string;
  branch: string | null;
  headRef: string;
  status: GitStatusEntry[];
}

export interface RepositorySnapshot {
  repositoryPath: string;
  headOid: string;
  status: GitStatusEntry[];
}

export interface GitStatusEntry {
  code: string;
  path: string;
}

export interface WorktreeRecord {
  schemaVersion: "kerbsflow.worktree/v1";
  runKey: string;
  repositoryPath: string;
  gitCommonDirectory: string;
  worktreeGitDirectory: string;
  baseOid: string;
  branch: string;
  path: string;
  markerPath: string;
  createdAt: string;
}

interface WorktreeCreationIntent {
  schemaVersion: "kerbsflow.worktree-intent/v1";
  runKey: string;
  repositoryPath: string;
  gitCommonDirectory: string;
  baseOid: string;
  branch: string;
  path: string;
  markerPath: string;
  createdAt: string;
}

interface WorktreeCleanupIntent {
  schemaVersion: "kerbsflow.worktree-cleanup-intent/v1";
  record: WorktreeRecord;
  preparedAt: string;
}

interface WorktreeCleanupComplete {
  schemaVersion: "kerbsflow.worktree-cleanup-complete/v1";
  record: WorktreeRecord;
  completedAt: string;
}

export type WorktreeRetentionReason = "failed" | "recovery" | "cancelled" | "dirty";

export type WorktreeCleanupOutcome =
  | { outcome: "cleanup_prepared"; record: WorktreeRecord }
  | { outcome: "cleaned"; record: WorktreeRecord }
  | { outcome: "retained"; record: WorktreeRecord; reason: WorktreeRetentionReason }
  | { outcome: "human_gate"; record: WorktreeRecord; reason: string };

export interface WorktreeInspection {
  baseOid: string;
  headOid: string;
  status: GitStatusEntry[];
  changedPaths: string[];
  diff: string;
  dirty: boolean;
}

export interface IntakeOptions {
  expectedBaseOid?: string;
  allowUntracked?: boolean;
}

export class GitWorktreeManager {
  readonly runtimeRoot: string;

  constructor(runtimeRoot: string) {
    if (!isAbsolute(runtimeRoot)) {
      throw new KerbsFlowError("RUNTIME_ROOT_INVALID", "runtime root must be absolute");
    }
    this.runtimeRoot = ensurePrivateDirectory(runtimeRoot);
  }

  intake(repositoryPath: string, options: IntakeOptions = {}): RepositoryIntake {
    const canonical = canonicalExistingDirectory(repositoryPath);
    this.assertRuntimeOutsideRepository(canonical);
    const inside = git(canonical, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      throw new KerbsFlowError("NOT_GIT_REPOSITORY", `${canonical} is not a Git worktree`);
    }
    const baseOid = git(canonical, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (options.expectedBaseOid !== undefined && baseOid !== options.expectedBaseOid) {
      throw new KerbsFlowError("BASE_OID_MISMATCH", `expected ${options.expectedBaseOid}, found ${baseOid}`);
    }
    const status = parsePorcelain(gitBuffer(canonical, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    const blocking = status.filter((entry) => options.allowUntracked === true && entry.code === "??" ? false : true);
    if (blocking.length > 0) {
      throw new KerbsFlowError("ORIGINAL_CHECKOUT_DIRTY", `original checkout has ${blocking.length} blocking status entr${blocking.length === 1 ? "y" : "ies"}`);
    }
    const branchText = gitOptional(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return {
      repositoryPath: canonical,
      gitCommonDirectory: canonicalGitPath(canonical, git(canonical, ["rev-parse", "--git-common-dir"])),
      baseOid,
      branch: branchText === "" ? null : branchText,
      headRef: branchText === "" ? baseOid : branchText,
      status,
    };
  }

  snapshot(repositoryPath: string): RepositorySnapshot {
    const canonical = canonicalExistingDirectory(repositoryPath);
    const inside = git(canonical, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      throw new KerbsFlowError("NOT_GIT_REPOSITORY", `${canonical} is not a Git worktree`);
    }
    return {
      repositoryPath: canonical,
      headOid: git(canonical, ["rev-parse", "--verify", "HEAD^{commit}"]),
      status: parsePorcelain(gitBuffer(canonical, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])),
    };
  }

  create(intake: RepositoryIntake, runId: string, now = new Date().toISOString()): WorktreeRecord {
    const runKey = safeRunKey(runId);
    const branch = `kerbsflow/run-${runKey.slice(0, 24)}`;
    const worktreesRoot = ensurePrivateDirectory(join(this.runtimeRoot, "worktrees"));
    const recordsRoot = ensurePrivateDirectory(join(this.runtimeRoot, "worktree-records"));
    const path = resolve(worktreesRoot, runKey);
    const markerPath = resolve(recordsRoot, `${runKey}.json`);
    if (existsSync(path) || existsSync(markerPath)) {
      throw new KerbsFlowError("WORKTREE_COLLISION", `worktree identity ${runKey} already exists`);
    }
    if (gitOptional(intake.repositoryPath, ["show-ref", "--verify", `refs/heads/${branch}`]) !== "") {
      throw new KerbsFlowError("WORKTREE_BRANCH_COLLISION", `branch ${branch} already exists`);
    }
    const intent: WorktreeCreationIntent = {
      schemaVersion: "kerbsflow.worktree-intent/v1",
      runKey,
      repositoryPath: intake.repositoryPath,
      gitCommonDirectory: intake.gitCommonDirectory,
      baseOid: intake.baseOid,
      branch,
      path,
      markerPath,
      createdAt: now,
    };
    atomicWritePrivateFile(recordsRoot, basename(markerPath), `${JSON.stringify(intent)}\n`);
    git(intake.repositoryPath, ["worktree", "add", "--lock", "--reason", `kerbsflow run ${runKey}`, "-b", branch, path, intake.baseOid]);
    const record: WorktreeRecord = {
      schemaVersion: "kerbsflow.worktree/v1",
      runKey,
      repositoryPath: intake.repositoryPath,
      gitCommonDirectory: intake.gitCommonDirectory,
      worktreeGitDirectory: canonicalGitPath(path, git(path, ["rev-parse", "--git-dir"])),
      baseOid: intake.baseOid,
      branch,
      path: realpathSync(path),
      markerPath,
      createdAt: now,
    };
    atomicWritePrivateFile(recordsRoot, basename(markerPath), `${JSON.stringify(record)}\n`, true);
    return record;
  }

  discover(runId: string): WorktreeRecord | undefined {
    const markerPath = join(this.runtimeRoot, "worktree-records", `${safeRunKey(runId)}.json`);
    if (!existsSync(markerPath)) {
      return undefined;
    }
    const raw = readMarker(this.runtimeRoot, markerPath);
    if (raw.schemaVersion === "kerbsflow.worktree-cleanup-complete/v1") {
      assertCleanupScope(parseCleanupRecord(raw, "completed"), markerPath, runId);
      return undefined;
    }
    if (raw.schemaVersion === "kerbsflow.worktree-cleanup-intent/v1") {
      assertCleanupScope(parseCleanupRecord(raw, "intent"), markerPath, runId);
      throw new KerbsFlowError("WORKTREE_CLEANUP_UNCERTAIN", `worktree cleanup for ${runId} must be reconciled before use`);
    }
    if (raw.schemaVersion === "kerbsflow.worktree-intent/v1") {
      throw new KerbsFlowError("WORKTREE_CREATION_UNCERTAIN", `worktree creation for ${String(raw.runKey ?? runId)} did not reach its durable completed marker`);
    }
    const record = parseWorktreeRecord(raw);
    assertCleanupScope(record, markerPath, runId);
    return this.proveRecord(record, markerPath);
  }

  inspect(record: WorktreeRecord, maxDiffBytes = 2_000_000): WorktreeInspection {
    const discovered = this.discover(record.runKey);
    if (discovered === undefined || discovered.baseOid !== record.baseOid || discovered.path !== record.path) {
      throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "worktree ownership record is absent or inconsistent");
    }
    return this.inspectProven(record, maxDiffBytes);
  }

  prepareCleanup(record: WorktreeRecord, disposition: "terminal_clean" | "failed" | "recovery" | "cancelled", now = new Date().toISOString()): WorktreeCleanupOutcome {
    const owned = this.discover(record.runKey);
    if (owned === undefined || owned.path !== record.path || owned.worktreeGitDirectory !== record.worktreeGitDirectory) {
      throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "cleanup requires the exact persisted owned worktree identity");
    }
    if (disposition !== "terminal_clean") return { outcome: "retained", record: owned, reason: disposition };
    if (this.inspectProven(owned).dirty) return { outcome: "retained", record: owned, reason: "dirty" };
    const intent: WorktreeCleanupIntent = { schemaVersion: "kerbsflow.worktree-cleanup-intent/v1", record: owned, preparedAt: now };
    atomicWritePrivateFile(join(this.runtimeRoot, "worktree-records"), basename(owned.markerPath), `${JSON.stringify(intent)}\n`, true);
    return { outcome: "cleanup_prepared", record: owned };
  }

  reconcileCleanup(runId: string, now = new Date().toISOString()): WorktreeCleanupOutcome {
    const markerPath = join(this.runtimeRoot, "worktree-records", `${safeRunKey(runId)}.json`);
    if (!existsSync(markerPath)) throw new KerbsFlowError("WORKTREE_RECORD_INVALID", "cleanup marker is missing");
    const raw = readMarker(this.runtimeRoot, markerPath);
    if (raw.schemaVersion === "kerbsflow.worktree-cleanup-complete/v1") {
      const completeRecord = parseCleanupRecord(raw, "completed");
      assertCleanupScope(completeRecord, markerPath, runId);
      return { outcome: "cleaned", record: completeRecord };
    }
    if (raw.schemaVersion !== "kerbsflow.worktree-cleanup-intent/v1") {
      throw new KerbsFlowError("WORKTREE_CLEANUP_INTENT_REQUIRED", "cleanup must start from a durable cleanup intent");
    }
    const record = parseCleanupRecord(raw, "intent");
    assertCleanupScope(record, markerPath, runId);
    try {
      this.proveRepository(record);
    } catch (error) {
      return { outcome: "human_gate", record, reason: `repository identity cannot be proven: ${error instanceof Error ? redactDiagnostic(error.message) : "unknown mismatch"}` };
    }
    if (existsSync(record.path)) {
      try {
        this.proveRecord(record, markerPath, true);
      } catch (error) {
        return { outcome: "human_gate", record, reason: `worktree ownership cannot be proven: ${error instanceof Error ? redactDiagnostic(error.message) : "unknown mismatch"}` };
      }
      if (this.inspectProven(record).dirty) {
        atomicWritePrivateFile(join(this.runtimeRoot, "worktree-records"), basename(markerPath), `${JSON.stringify(record)}\n`, true);
        return { outcome: "retained", record, reason: "dirty" };
      }
      gitOptional(record.repositoryPath, ["worktree", "unlock", record.path]);
      git(record.repositoryPath, ["worktree", "remove", record.path]);
    }
    const registration = worktreeRegistration(record.repositoryPath, record);
    if (registration !== undefined) {
      return { outcome: "human_gate", record, reason: `Git still registers the owned branch at ${registration}; automatic prune is prohibited` };
    }
    if (gitOptional(record.repositoryPath, ["show-ref", "--verify", `refs/heads/${record.branch}`]) !== "") {
      const branchOid = git(record.repositoryPath, ["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`]);
      if (branchOid !== record.baseOid) {
        return { outcome: "human_gate", record, reason: "owned branch moved after cleanup intent; automatic branch deletion is prohibited" };
      }
      git(record.repositoryPath, ["branch", "-d", record.branch]);
    }
    const complete: WorktreeCleanupComplete = { schemaVersion: "kerbsflow.worktree-cleanup-complete/v1", record, completedAt: now };
    atomicWritePrivateFile(join(this.runtimeRoot, "worktree-records"), basename(markerPath), `${JSON.stringify(complete)}\n`, true);
    return { outcome: "cleaned", record };
  }

  private inspectProven(record: WorktreeRecord, maxDiffBytes = 2_000_000): WorktreeInspection {
    const headOid = git(record.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const status = parsePorcelain(gitBuffer(record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    const trackedDiff = gitBuffer(record.path, ["diff", "--no-ext-diff", "--no-renames", "--binary", record.baseOid, "--"]);
    const untrackedDiff = renderUntrackedDiff(record.path, status, maxDiffBytes - trackedDiff.byteLength);
    const diffBuffer = Buffer.concat([trackedDiff, untrackedDiff]);
    if (diffBuffer.byteLength > maxDiffBytes) {
      throw new KerbsFlowError("DIFF_TOO_LARGE", `worktree diff exceeds ${maxDiffBytes} bytes`);
    }
    const tracked = splitNul(gitBuffer(record.path, ["diff", "--no-renames", "--name-only", "-z", record.baseOid, "--"]));
    const changedPaths = [...new Set([...tracked, ...status.map((entry) => entry.path)])].sort();
    return {
      baseOid: record.baseOid,
      headOid,
      status,
      changedPaths,
      diff: diffBuffer.toString("utf8"),
      dirty: status.length > 0 || headOid !== record.baseOid,
    };
  }

  private proveRecord(record: WorktreeRecord, markerPath: string, markerMayBeCleanupIntent = false): WorktreeRecord {
    if (record.markerPath !== markerPath || !existsSync(record.path)) {
      throw new KerbsFlowError("WORKTREE_RECORD_INVALID", "worktree marker does not match an existing owned worktree");
    }
    if (!markerMayBeCleanupIntent) {
      const marker = readMarker(this.runtimeRoot, markerPath);
      if (marker.schemaVersion !== "kerbsflow.worktree/v1") throw new KerbsFlowError("WORKTREE_RECORD_INVALID", "worktree marker is not an active ownership record");
    }
    this.proveRepository(record);
    const actual = realpathSync(record.path);
    if (actual !== record.path || !pathIsWithin(realpathSync(join(this.runtimeRoot, "worktrees")), actual)) {
      throw new KerbsFlowError("WORKTREE_PATH_ESCAPE", "recorded worktree escapes the owned runtime root");
    }
    if (actual === record.repositoryPath) throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "owned worktree aliases the human checkout");
    if (
      canonicalGitPath(actual, git(actual, ["rev-parse", "--git-common-dir"])) !== record.gitCommonDirectory
      || canonicalGitPath(actual, git(actual, ["rev-parse", "--git-dir"])) !== record.worktreeGitDirectory
    ) {
      throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "recorded Git administrative identity does not match the worktree");
    }
    return record;
  }

  private proveRepository(record: WorktreeRecord): void {
    const repository = canonicalExistingDirectory(record.repositoryPath);
    if (repository !== record.repositoryPath || repository === record.path) {
      throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "recorded repository path is not the exact canonical human checkout");
    }
    if (git(repository, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
      throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "recorded repository path is no longer a Git worktree");
    }
    if (canonicalGitPath(repository, git(repository, ["rev-parse", "--git-common-dir"])) !== record.gitCommonDirectory) {
      throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "recorded repository Git identity no longer matches the owned worktree");
    }
  }

  private assertRuntimeOutsideRepository(repositoryPath: string): void {
    if (pathIsWithin(repositoryPath, this.runtimeRoot) || pathIsWithin(this.runtimeRoot, repositoryPath)) {
      throw new KerbsFlowError("RUNTIME_ROOT_UNSAFE", "runtime root must be outside the human-owned repository, and neither path may contain or alias the other");
    }
  }
}

function renderUntrackedDiff(worktreePath: string, status: GitStatusEntry[], remainingBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let used = 0;
  for (const entry of status) {
    if (entry.code !== "??") {
      continue;
    }
    const candidate = resolve(worktreePath, entry.path);
    if (!pathIsWithin(worktreePath, candidate) || candidate === worktreePath) {
      throw new KerbsFlowError("WORKTREE_PATH_ESCAPE", `untracked path escapes the worktree: ${entry.path}`);
    }
    const metadata = lstatSync(candidate);
    let rendered: string;
    if (metadata.isSymbolicLink()) {
      rendered = `diff --kerbsflow-untracked ${JSON.stringify(entry.path)}\nnew symlink\n`;
    } else if (!metadata.isFile()) {
      rendered = `diff --kerbsflow-untracked ${JSON.stringify(entry.path)}\nnew non-regular file\n`;
    } else {
      if (metadata.size > remainingBytes - used) {
        throw new KerbsFlowError("DIFF_TOO_LARGE", `untracked file ${entry.path} exceeds the remaining diff bound`);
      }
      const content = readFileSync(candidate);
      rendered = content.includes(0)
        ? `diff --kerbsflow-untracked ${JSON.stringify(entry.path)}\nnew binary file (${content.byteLength} bytes)\n`
        : `diff --kerbsflow-untracked ${JSON.stringify(entry.path)}\n--- /dev/null\n+++ b/${entry.path}\n${content.toString("utf8").split("\n").map((line) => `+${line}`).join("\n")}\n`;
    }
    const chunk = Buffer.from(rendered);
    used += chunk.byteLength;
    if (used > remainingBytes) {
      throw new KerbsFlowError("DIFF_TOO_LARGE", `untracked diff exceeds the configured bound`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 }).trim();
  } catch (error) {
    const detail = error instanceof Error ? redactDiagnostic(error.message) : "Git command failed";
    throw new KerbsFlowError("GIT_COMMAND_FAILED", `git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

function gitOptional(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, { cwd, env: gitEnvironment(), encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? redactDiagnostic(error.message) : "Git command failed";
    throw new KerbsFlowError("GIT_COMMAND_FAILED", `git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;
  const environment: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined && !value.includes("\0")) environment[name] = value;
  }
  return environment;
}

function parsePorcelain(buffer: Buffer): GitStatusEntry[] {
  const records = splitNul(buffer);
  const result: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) {
      continue;
    }
    const code = record.slice(0, 2);
    const path = record.slice(3);
    result.push({ code, path });
    if (code.includes("R") || code.includes("C")) {
      index += 1;
    }
  }
  return result;
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter((value) => value.length > 0);
}

function canonicalExistingDirectory(path: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!existsSync(canonical)) {
      throw new Error("missing");
    }
    return canonical;
  } catch {
    throw new KerbsFlowError("REPOSITORY_PATH_INVALID", `repository path does not exist: ${path}`);
  }
}

function canonicalGitPath(repositoryPath: string, value: string): string {
  const candidate = value.startsWith("/") ? value : resolve(repositoryPath, value);
  return realpathSync(candidate);
}

function safeRunKey(runId: string): string {
  const key = runId.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (key.length < 1 || key.length > 100 || key === "." || key === "..") {
    throw new KerbsFlowError("RUN_ID_PATH_INVALID", "run ID cannot form a safe worktree identity");
  }
  return key;
}

function parseWorktreeRecord(value: unknown): WorktreeRecord {
  if (typeof value !== "object" || value === null) {
    throw new KerbsFlowError("WORKTREE_RECORD_INVALID", "worktree marker is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys: Array<keyof WorktreeRecord> = ["schemaVersion", "runKey", "repositoryPath", "gitCommonDirectory", "worktreeGitDirectory", "baseOid", "branch", "path", "markerPath", "createdAt"];
  for (const key of keys) {
    if (typeof record[key] !== "string") {
      throw new KerbsFlowError("WORKTREE_RECORD_INVALID", `worktree marker field ${key} is invalid`);
    }
  }
  if (record.schemaVersion !== "kerbsflow.worktree/v1" || basename(dirname(String(record.markerPath))) !== "worktree-records") {
    throw new KerbsFlowError("WORKTREE_RECORD_INVALID", "worktree marker version or location is invalid");
  }
  return record as unknown as WorktreeRecord;
}

function parseCleanupRecord(value: Record<string, unknown>, state: "intent" | "completed"): WorktreeRecord {
  const expected = state === "intent" ? "kerbsflow.worktree-cleanup-intent/v1" : "kerbsflow.worktree-cleanup-complete/v1";
  if (value.schemaVersion !== expected) throw new KerbsFlowError("WORKTREE_RECORD_INVALID", `worktree cleanup ${state} version is invalid`);
  return parseWorktreeRecord(value.record);
}

function assertCleanupScope(record: WorktreeRecord, markerPath: string, runId: string): void {
  if (record.markerPath !== markerPath || record.runKey !== safeRunKey(runId)) {
    throw new KerbsFlowError("WORKTREE_OWNERSHIP_UNPROVEN", "worktree marker does not match the requested run identity");
  }
}

function readMarker(runtimeRoot: string, markerPath: string): Record<string, unknown> {
  const recordsRoot = join(runtimeRoot, "worktree-records");
  const bytes = readPrivateFileWithin(recordsRoot, basename(markerPath), 64 * 1024);
  try {
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new KerbsFlowError("WORKTREE_RECORD_INVALID", "worktree marker is malformed");
  }
}

function worktreeRegistration(repositoryPath: string, record: WorktreeRecord): string | undefined {
  const fields = splitNul(gitBuffer(repositoryPath, ["worktree", "list", "--porcelain", "-z"]));
  let currentPath: string | undefined;
  for (const field of fields) {
    if (field.startsWith("worktree ")) currentPath = field.slice("worktree ".length);
    if (currentPath !== undefined && field === `branch refs/heads/${record.branch}`) return currentPath;
    if (currentPath === record.path) return currentPath;
  }
  return undefined;
}
