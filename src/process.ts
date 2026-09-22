import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { KerbsFlowError } from "./errors.js";
import { redactDiagnostic, sanitizeDiagnosticValue } from "./secrets.js";

export interface SupervisedProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  gracePeriodMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxEventBytes?: number;
}

export interface RawProcessEvent {
  sequence: number;
  observedAt: string;
  line: string;
  value?: unknown;
  malformed: boolean;
}

export interface ProcessIdentity {
  supervisorId: string;
  pid: number;
  startedAt: string;
  cwd: string;
  executable: string;
  processGroup: "owned_posix_group" | "single_process_only";
}

export interface ProcessResult {
  identity: ProcessIdentity;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitKind: "normal" | "signal" | "spawn_error" | "timeout" | "unknown";
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytesObserved: number;
  stderrBytesObserved: number;
  events: RawProcessEvent[];
  eventsTruncated: boolean;
  eventBytesObserved: number;
  endedAt: string;
  cancellationRequested: boolean;
  gracefulSignalSent: boolean;
  forcedSignalSent: boolean;
  processTreeEvidence: "group_absent_after_exit" | "group_signal_sent" | "single_process_signal_sent" | "not_signalled";
  spawnError?: string;
}

export interface SupervisorCancelResult {
  outcome: "signal_sent" | "already_terminal" | "unknown";
  summary: string;
  processTreeEvidence: ProcessResult["processTreeEvidence"];
}

export class SupervisedProcess {
  readonly identity: ProcessIdentity;
  readonly completion: Promise<ProcessResult>;

  private childExited = false;
  private settled = false;
  private cancellationRequested = false;
  private gracefulSignalSent = false;
  private forcedSignalSent = false;
  private timedOut = false;
  private orphanAfterLeaderExit = false;
  private processTreeEvidence: ProcessResult["processTreeEvidence"] = "not_signalled";
  private forceTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly child: ChildProcessByStdio<null, Readable, Readable>,
    identity: ProcessIdentity,
    completion: Promise<ProcessResult>,
    private readonly gracePeriodMs: number,
    private readonly eventStream: AsyncEventBuffer<RawProcessEvent>,
  ) {
    this.identity = identity;
    this.completion = completion;
  }

  events(): AsyncIterable<RawProcessEvent> {
    return this.eventStream.values();
  }

  cancel(): SupervisorCancelResult {
    if (this.settled) {
      return { outcome: "already_terminal", summary: "process was already terminal", processTreeEvidence: this.processTreeEvidence };
    }
    this.cancellationRequested = true;
    if (!Number.isSafeInteger(this.identity.pid) || this.identity.pid <= 0) {
      return { outcome: "unknown", summary: "process has no valid positive PID to signal", processTreeEvidence: "not_signalled" };
    }
    try {
      const group = this.identity.processGroup === "owned_posix_group";
      const sent = group ? process.kill(-this.identity.pid, "SIGTERM") : this.child.kill("SIGTERM");
      this.gracefulSignalSent = sent;
      this.processTreeEvidence = sent ? (group ? "group_signal_sent" : "single_process_signal_sent") : "not_signalled";
      if (!sent) {
        return { outcome: "unknown", summary: "termination signal was not accepted", processTreeEvidence: this.processTreeEvidence };
      }
      this.forceTimer = setTimeout(() => this.force(), this.gracePeriodMs);
      this.forceTimer.unref();
      return { outcome: "signal_sent", summary: "graceful termination signal sent", processTreeEvidence: this.processTreeEvidence };
    } catch (error) {
      return { outcome: "unknown", summary: error instanceof Error ? redactDiagnostic(error.message) : "termination signal failed", processTreeEvidence: this.processTreeEvidence };
    }
  }

  markTimedOut(): SupervisorCancelResult {
    this.timedOut = true;
    return this.cancel();
  }

  async settleAfterChildExit(): Promise<void> {
    this.childExited = true;
    if (this.identity.processGroup !== "owned_posix_group") {
      this.finishSettlement();
      return;
    }
    if (!Number.isSafeInteger(this.identity.pid) || this.identity.pid <= 0) {
      this.finishSettlement();
      return;
    }
    if (!this.processGroupAbsent() && !this.gracefulSignalSent && !this.forcedSignalSent) {
      this.orphanAfterLeaderExit = true;
      try {
        this.gracefulSignalSent = process.kill(-this.identity.pid, "SIGTERM");
        if (this.gracefulSignalSent) this.processTreeEvidence = "group_signal_sent";
      } catch {
        // A raced group disappearance is checked below; uncertainty stays unknown.
      }
    }
    const graceDeadline = Date.now() + this.gracePeriodMs;
    while (!this.processGroupAbsent() && Date.now() < graceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!this.processGroupAbsent()) {
      this.force();
      const forceDeadline = Date.now() + 1000;
      while (!this.processGroupAbsent() && Date.now() < forceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (this.processGroupAbsent()) this.processTreeEvidence = "group_absent_after_exit";
    this.finishSettlement();
  }

  snapshotTermination(): Pick<ProcessResult, "cancellationRequested" | "gracefulSignalSent" | "forcedSignalSent" | "processTreeEvidence" | "exitKind"> {
    return {
      cancellationRequested: this.cancellationRequested,
      gracefulSignalSent: this.gracefulSignalSent,
      forcedSignalSent: this.forcedSignalSent,
      processTreeEvidence: this.processTreeEvidence,
      exitKind: this.identity.processGroup === "owned_posix_group" && this.processTreeEvidence !== "group_absent_after_exit"
        ? "unknown"
        : this.timedOut ? "timeout" : this.orphanAfterLeaderExit ? "unknown" : "normal",
    };
  }

  private force(): void {
    if (this.settled || (this.childExited && this.identity.processGroup !== "owned_posix_group")) {
      return;
    }
    try {
      const group = this.identity.processGroup === "owned_posix_group";
      this.forcedSignalSent = group ? process.kill(-this.identity.pid, "SIGKILL") : this.child.kill("SIGKILL");
      if (this.forcedSignalSent) {
        this.processTreeEvidence = group ? "group_signal_sent" : "single_process_signal_sent";
      }
    } catch {
      // The exit event is the authority; a racing ESRCH means the process may already be gone.
    }
  }

  private processGroupAbsent(): boolean {
    try {
      process.kill(-this.identity.pid, 0);
      return false;
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
    }
  }

  private finishSettlement(): void {
    this.settled = true;
    if (this.forceTimer !== undefined) clearTimeout(this.forceTimer);
  }
}

export class ProcessSupervisor {
  start(spec: SupervisedProcessSpec): SupervisedProcess {
    validateSpec(spec);
    const eventStream = new AsyncEventBuffer<RawProcessEvent>();
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const identity: ProcessIdentity = {
      supervisorId: randomUUID(),
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
      cwd: spec.cwd,
      executable: spec.executable,
      processGroup: process.platform === "win32" ? "single_process_only" : "owned_posix_group",
    };
    const stdout = new BoundedCapture(spec.maxStdoutBytes ?? 512 * 1024);
    const stderr = new BoundedCapture(spec.maxStderrBytes ?? 256 * 1024);
    const eventLimit = spec.maxEventBytes ?? 512 * 1024;
    const events: RawProcessEvent[] = [];
    let eventBytes = 0;
    let eventBytesObserved = 0;
    let eventsTruncated = false;
    let pending = "";
    let spawnError: string | undefined;
    let supervised!: SupervisedProcess;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      pending += chunk.toString("utf8");
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        const bytes = Buffer.byteLength(line);
        eventBytesObserved += bytes;
        if (eventBytes + bytes > eventLimit) {
          eventsTruncated = true;
          continue;
        }
        eventBytes += bytes;
        const event = parseEvent(line, events.length + 1);
        events.push(event);
        eventStream.push(event);
      }
      if (Buffer.byteLength(pending) > eventLimit) {
        eventBytesObserved += Buffer.byteLength(pending) - eventLimit;
        pending = Buffer.from(pending).subarray(0, eventLimit).toString("utf8");
        eventsTruncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    const completion = new Promise<ProcessResult>((resolve) => {
      const timeout = setTimeout(() => supervised.markTimedOut(), spec.timeoutMs);
      timeout.unref();
      child.once("error", (error) => {
        spawnError = redactMessage(error.message);
      });
      child.once("close", async (exitCode, signal) => {
        clearTimeout(timeout);
        await supervised.settleAfterChildExit();
        if (pending.length > 0 && eventBytes + Buffer.byteLength(pending) <= eventLimit) {
          eventBytesObserved += Buffer.byteLength(pending);
          const event = parseEvent(pending, events.length + 1);
          events.push(event);
          eventStream.push(event);
        } else if (pending.length > 0) {
          eventBytesObserved += Buffer.byteLength(pending);
          eventsTruncated = true;
        }
        const termination = supervised.snapshotTermination();
        const exitKind = spawnError !== undefined
          ? "spawn_error"
          : termination.exitKind === "unknown"
            ? "unknown"
            : termination.exitKind === "timeout"
            ? "timeout"
            : signal !== null
              ? "signal"
                : exitCode !== null
                ? "normal"
                : "unknown";
        const result: ProcessResult = {
          identity,
          exitCode,
          signal,
          exitKind,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          stdoutBytesObserved: stdout.totalBytes,
          stderrBytesObserved: stderr.totalBytes,
          events,
          eventsTruncated,
          eventBytesObserved,
          endedAt: new Date().toISOString(),
          cancellationRequested: termination.cancellationRequested,
          gracefulSignalSent: termination.gracefulSignalSent,
          forcedSignalSent: termination.forcedSignalSent,
          processTreeEvidence: termination.processTreeEvidence,
          ...(spawnError === undefined ? {} : { spawnError }),
        };
        eventStream.close();
        resolve(result);
      });
    });
    supervised = new SupervisedProcess(child, identity, completion, spec.gracePeriodMs ?? 2000, eventStream);
    return supervised;
  }
}

export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined && !value.includes("\0")) {
      result[name] = value;
    }
  }
  return result;
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  totalBytes = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    const kept = chunk.subarray(0, remaining);
    this.chunks.push(kept);
    this.size += kept.byteLength;
    if (kept.byteLength < chunk.byteLength) {
      this.truncated = true;
    }
  }

  text(): string {
    return redactMessage(Buffer.concat(this.chunks).toString("utf8"));
  }
}

class AsyncEventBuffer<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.queued.push(value);
    } else {
      waiter({ done: false, value });
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async *values(): AsyncIterable<T> {
    while (true) {
      const queued = this.queued.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

function validateSpec(spec: SupervisedProcessSpec): void {
  if (spec.executable.length < 1 || spec.executable.includes("\0")) {
    throw new KerbsFlowError("PROCESS_SPEC_INVALID", "executable is empty or contains NUL");
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 24 * 60 * 60 * 1000) {
    throw new KerbsFlowError("PROCESS_SPEC_INVALID", "timeout must be between 1ms and 24h");
  }
  if (spec.args.some((argument) => argument.includes("\0"))) {
    throw new KerbsFlowError("PROCESS_SPEC_INVALID", "argument contains NUL");
  }
}

function parseEvent(line: string, sequence: number): RawProcessEvent {
  try {
    const value = sanitizeJson(JSON.parse(line));
    return { sequence, observedAt: new Date().toISOString(), line: JSON.stringify(value), value, malformed: false };
  } catch {
    return { sequence, observedAt: new Date().toISOString(), line: redactMessage(line), malformed: true };
  }
}

function redactMessage(message: string): string {
  return redactDiagnostic(message);
}

function sanitizeJson(value: unknown, key = ""): unknown {
  return sanitizeDiagnosticValue(value, key);
}
