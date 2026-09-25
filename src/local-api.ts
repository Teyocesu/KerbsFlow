import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  asArtifactId,
  asCommandId,
  asGateId,
  asRunId,
  ContractValidationError,
  type ArtifactId,
  type CommandId,
  type RunId,
} from "./contracts.js";
import type { KerbsFlowCore } from "./core.js";
import { IdempotencyConflictError, KerbsFlowError, NotFoundError, StateVersionConflictError } from "./errors.js";
import { containsLikelySecret, redactDiagnostic } from "./secrets.js";
import { StateStore, type ReadModel, type StoredArtifact, type StoredTransition } from "./persistence.js";
import { StateMachineError } from "./state-machine.js";

export interface ArtifactReader {
  get(artifactId: ArtifactId): string;
}

export interface LocalApiServerOptions {
  pollIntervalMs?: number;
}

export interface LocalApiServerDependencies {
  core: Pick<KerbsFlowCore, "readModel" | "startRun" | "pause" | "resume" | "cancel" | "resolveGateScoped">;
  store: StateStore;
  artifacts: ArtifactReader;
}

interface HeaderValue {
  value?: string;
  duplicate: boolean;
}

interface LocalApiErrorShape {
  status: number;
  code: string;
  message: string;
}

const MAX_TRANSITIONS = 50;
const MAX_ARTIFACTS = 50;
const MAX_POLL_ROWS = 100;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MUTATION_SCHEMA_VERSION = "kerbsflow.local-command/v1";

export class LocalApiServer {
  private readonly token = randomBytes(32).toString("base64url");
  private readonly server: Server;
  private readonly activeSseClosers = new Set<() => void>();
  private readonly pollIntervalMs: number;
  private lifecycle: "new" | "starting" | "listening" | "closing" | "closed" = "new";
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private boundAddress: AddressInfo | undefined;

  constructor(
    private readonly dependencies: LocalApiServerDependencies,
    options: LocalApiServerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1 || this.pollIntervalMs > 60_000) {
      throw new Error("local API poll interval must be an integer from 1 through 60000 milliseconds");
    }
    this.server = createServer((request, response) => {
      this.setSecurityHeaders(response);
      void this.handleRequest(request, response).catch(() => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        this.sendError(response, { status: 500, code: "INTERNAL_ERROR", message: "internal server error" });
      });
    });
  }

  start(): Promise<void> {
    if (this.lifecycle === "listening") return Promise.resolve();
    if (this.lifecycle === "starting" && this.startPromise !== undefined) return this.startPromise;
    if (this.lifecycle !== "new") return Promise.reject(new Error("local API server instances can only be started once"));
    this.lifecycle = "starting";
    this.startPromise = new Promise<void>((resolve, reject) => {
      const onError = () => {
        this.server.off("listening", onListening);
        this.lifecycle = "closed";
        reject(new Error("local API server could not bind to loopback"));
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
          this.lifecycle = "closed";
          reject(new Error("local API server did not bind to IPv4 loopback"));
          return;
        }
        this.boundAddress = { address: address.address, family: address.family, port: address.port };
        this.lifecycle = "listening";
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    return this.startPromise;
  }

  address(): AddressInfo {
    if (this.lifecycle !== "listening" || this.boundAddress === undefined) {
      throw new Error("local API server is not listening");
    }
    return { ...this.boundAddress };
  }

  port(): number {
    return this.address().port;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.lifecycle === "closed") return Promise.resolve();
    if (this.lifecycle === "new") {
      this.lifecycle = "closed";
      return Promise.resolve();
    }
    if (this.lifecycle !== "listening") return Promise.reject(new Error("local API server cannot close while start is incomplete"));
    this.lifecycle = "closing";
    for (const closeSse of [...this.activeSseClosers]) closeSse();
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        this.lifecycle = "closed";
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    return this.closePromise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const expectedHost = `127.0.0.1:${this.port()}`;
    const host = singleRawHeader(request, "host");
    if (host.duplicate || host.value !== expectedHost) {
      this.sendError(response, { status: 403, code: "HOST_FORBIDDEN", message: "request host is not allowed" });
      return;
    }

    let segments: string[];
    try {
      segments = parseRequestPath(request.url);
    } catch {
      this.sendError(response, { status: 400, code: "INVALID_REQUEST", message: "request path is invalid" });
      return;
    }

    const origin = singleRawHeader(request, "origin");
    const expectedOrigin = `http://${expectedHost}`;
    const isRoot = segments.length === 0;
    const isSafeRead = request.method === "GET" || request.method === "HEAD";
    const originRequired = !isRoot && !isSafeRead;
    if (origin.duplicate || (originRequired
      ? origin.value !== expectedOrigin
      : origin.value !== undefined && origin.value !== expectedOrigin)) {
      this.sendError(response, { status: 403, code: "ORIGIN_FORBIDDEN", message: "request origin is not allowed" });
      return;
    }

    if (isRoot) {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        this.sendError(response, { status: 405, code: "METHOD_NOT_ALLOWED", message: "method is not allowed for this route" });
        return;
      }
      this.sendBootstrap(response);
      return;
    }

    if (segments[0] !== "v1") {
      this.sendError(response, { status: 404, code: "NOT_FOUND", message: "route not found" });
      return;
    }

    if (!this.authorizeToken(request)) {
      this.sendError(response, { status: 401, code: "UNAUTHORIZED", message: "request token is missing or invalid" });
      return;
    }

    try {
      await this.dispatchV1(request, response, segments);
    } catch (error) {
      const mapped = mapRequestError(error);
      this.sendError(response, mapped);
    }
  }

  private async dispatchV1(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const method = request.method ?? "";
    if (segments.length === 2 && segments[1] === "runs") {
      if (method !== "POST") return this.methodNotAllowed(response, "POST");
      const envelope = parseMutationEnvelope(await readMutationBody(request));
      assertExactKeys(envelope.payload, ["runId", "objective"]);
      const runId = asRunId(requiredMutationString(envelope.payload.runId, 120));
      const objective = requiredMutationString(envelope.payload.objective, 10_000);
      if (envelope.expectedStateVersion !== 0) throw invalidRequest("run creation requires expectedStateVersion zero");
      this.sendCommandResult(response, this.dependencies.core.startRun(runId, objective, envelope.idempotencyKey, envelope.commandId));
      return;
    }
    if (segments.length >= 3 && segments[1] === "runs") {
      const runId = parseRunId(segments[2]);
      if (segments.length === 4 && segments[3] === "snapshot") {
        if (method !== "GET") return this.methodNotAllowed(response, "GET");
        this.sendSnapshot(response, runId);
        return;
      }
      if (segments.length === 4 && segments[3] === "events") {
        if (method !== "GET") return this.methodNotAllowed(response, "GET");
        this.openEvents(request, response, runId);
        return;
      }
      if (segments.length === 5 && segments[3] === "artifacts") {
        if (method !== "GET") return this.methodNotAllowed(response, "GET");
        this.sendArtifact(response, runId, parseArtifactId(segments[4]));
        return;
      }
      if (segments.length === 4 && ["pause", "resume", "cancel"].includes(segments[3]!)) {
        if (method !== "POST") return this.methodNotAllowed(response, "POST");
        const envelope = parseMutationEnvelope(await readMutationBody(request));
        assertExactKeys(envelope.payload, segments[3] === "cancel" ? ["reason"] : []);
        const result = segments[3] === "pause"
          ? this.dependencies.core.pause(runId, envelope.expectedStateVersion, envelope.idempotencyKey, envelope.commandId)
          : segments[3] === "resume"
            ? this.dependencies.core.resume(runId, envelope.expectedStateVersion, envelope.idempotencyKey, envelope.commandId)
            : this.dependencies.core.cancel(
              runId,
              envelope.expectedStateVersion,
              envelope.idempotencyKey,
              requiredMutationString(envelope.payload.reason, 1_000),
              envelope.commandId,
            );
        this.sendCommandResult(response, result);
        return;
      }
      if (segments.length === 6 && segments[3] === "gates" && segments[5] === "resolve") {
        if (method !== "POST") return this.methodNotAllowed(response, "POST");
        const gateId = parseGateId(segments[4]);
        const envelope = parseMutationEnvelope(await readMutationBody(request));
        assertExactKeys(envelope.payload, ["optionId", "note"]);
        const optionId = requiredMutationString(envelope.payload.optionId, 100);
        const note = optionalMutationText(envelope.payload.note, 4_096);
        if (this.dependencies.store.getGate(gateId) === undefined) throw new NotFoundError("gate", gateId);
        const result = this.dependencies.core.resolveGateScoped(
          runId,
          envelope.expectedStateVersion,
          envelope.idempotencyKey,
          gateId,
          optionId,
          note,
          envelope.commandId,
        );
        this.sendCommandResult(response, result);
        return;
      }
      if (segments[3] === "artifacts" || ((segments[3] === "snapshot" || segments[3] === "events") && segments.length !== 4)) {
        throw invalidRequest("route is malformed");
      }
    }
    this.sendError(response, { status: 404, code: "NOT_FOUND", message: "route not found" });
  }

  private sendSnapshot(response: ServerResponse, runId: RunId): void {
    const model = this.dependencies.core.readModel(runId);
    if (model === undefined) {
      this.sendError(response, { status: 404, code: "NOT_FOUND", message: "run not found" });
      return;
    }
    const transitions = this.dependencies.store.listRecentTransitions(runId, MAX_TRANSITIONS);
    const artifacts = this.dependencies.store.listArtifactRecords(runId, MAX_ARTIFACTS);
    const snapshot = {
      schemaVersion: "kerbsflow.local-snapshot/v1",
      run: {
        runId: model.run.runId,
        state: model.run.state,
        stateVersion: model.run.stateVersion,
        recoveryRequired: model.run.recoveryRequired,
        recoveryReason: model.run.recoveryReason === null ? null : safeSnapshotText(model.run.recoveryReason, 500),
        pauseContract: model.run.pauseContract,
      },
      currentTask: snapshotTask(model.currentTask),
      activeAttempt: snapshotAttempt(model),
      currentGate: snapshotGate(model),
      latestValidation: snapshotValidation(model),
      latestReview: snapshotReview(model),
      recentTransitions: transitions.map(snapshotTransition),
      artifacts: artifacts.map(snapshotArtifact),
      transitionCursor: transitions.at(-1)?.sequence ?? 0,
    };
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(snapshot));
  }

  private sendArtifact(response: ServerResponse, runId: RunId, artifactId: ArtifactId): void {
    if (this.dependencies.core.readModel(runId) === undefined) {
      this.sendError(response, { status: 404, code: "NOT_FOUND", message: "artifact not found" });
      return;
    }
    const record = this.dependencies.store.getArtifactRecord(artifactId);
    if (record === undefined || record.runId !== runId) {
      this.sendError(response, { status: 404, code: "NOT_FOUND", message: "artifact not found" });
      return;
    }
    const content = this.dependencies.artifacts.get(artifactId);
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${artifactId}.json"`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(content);
  }

  private sendCommandResult(response: ServerResponse, result: ReturnType<KerbsFlowCore["startRun"]>): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(result));
  }

  private openEvents(request: IncomingMessage, response: ServerResponse, runId: RunId): void {
    if (this.dependencies.core.readModel(runId) === undefined) {
      this.sendError(response, { status: 404, code: "NOT_FOUND", message: "run not found" });
      return;
    }
    const lastEventId = singleRawHeader(request, "last-event-id");
    if (lastEventId.duplicate || (lastEventId.value !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(lastEventId.value))) {
      this.sendError(response, { status: 400, code: "INVALID_CURSOR", message: "Last-Event-ID must be a non-negative safe integer" });
      return;
    }
    const parsedCursor = lastEventId.value === undefined ? 0 : Number(lastEventId.value);
    if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) {
      this.sendError(response, { status: 400, code: "INVALID_CURSOR", message: "Last-Event-ID must be a non-negative safe integer" });
      return;
    }

    let cursor = parsedCursor;
    let polling = false;
    let closed = false;
    let lastWriteAt = Date.now();
    let pollTimer: NodeJS.Timeout;
    let heartbeatTimer: NodeJS.Timeout;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      request.off("aborted", cleanup);
      request.socket.off("close", cleanup);
      response.off("close", cleanup);
      this.activeSseClosers.delete(closeClient);
    };
    const closeClient = () => {
      cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
    };

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    this.activeSseClosers.add(closeClient);
    request.on("aborted", cleanup);
    request.socket.on("close", cleanup);
    response.on("close", cleanup);

    const poll = async () => {
      if (closed || polling || response.destroyed) return;
      polling = true;
      try {
        const transitions = this.dependencies.store.listTransitionsAfter(runId, cursor, MAX_POLL_ROWS);
        for (const transition of transitions) {
          if (closed || response.destroyed) break;
          response.write(serializeSseTransition(transition));
          cursor = transition.sequence;
          lastWriteAt = Date.now();
        }
      } catch {
        closeClient();
      } finally {
        polling = false;
      }
    };
    const heartbeat = () => {
      if (!closed && !response.destroyed && Date.now() - lastWriteAt >= HEARTBEAT_INTERVAL_MS) {
        response.write(": heartbeat\n\n");
        lastWriteAt = Date.now();
      }
    };
    pollTimer = setInterval(() => void poll(), this.pollIntervalMs);
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    void poll();
  }

  private authorizeToken(request: IncomingMessage): boolean {
    const header = singleRawHeader(request, "x-kerbsflow-token");
    if (header.duplicate || header.value === undefined) return false;
    const supplied = Buffer.from(header.value, "utf8");
    const expected = Buffer.from(this.token, "utf8");
    if (supplied.length !== expected.length) return false;
    return timingSafeEqual(supplied, expected);
  }

  private sendBootstrap(response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="kerbsflow-token" content="${this.token}"><title>KerbsFlow local API</title></head><body></body></html>`);
  }

  private methodNotAllowed(response: ServerResponse, allow: string): void {
    response.setHeader("Allow", allow);
    this.sendError(response, { status: 405, code: "METHOD_NOT_ALLOWED", message: "method is not allowed for this route" });
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }

  private sendError(response: ServerResponse, error: LocalApiErrorShape): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.statusCode = error.status;
    if (error.status === 413) {
      response.shouldKeepAlive = false;
      response.setHeader("Connection", "close");
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
  }
}

function parseRequestPath(requestTarget: string | undefined): string[] {
  if (requestTarget === undefined || !requestTarget.startsWith("/") || requestTarget.startsWith("//") || requestTarget.includes("?") || requestTarget.includes("#")) {
    throw invalidRequest("request target must be an origin-form path without a query");
  }
  if (requestTarget === "/") return [];
  try {
    const segments = requestTarget.slice(1).split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === "." || segment === "..")) throw invalidRequest("dot path segments are not allowed");
    return segments;
  } catch (error) {
    if (error instanceof LocalApiRequestError) throw error;
    throw invalidRequest("request path encoding is invalid");
  }
}

function parseRunId(value: string | undefined): RunId {
  try {
    if (value === undefined) throw new ContractValidationError("runId", "is required");
    return asRunId(value);
  } catch {
    throw invalidRequest("run identifier is invalid");
  }
}

function parseArtifactId(value: string | undefined): ArtifactId {
  try {
    if (value === undefined) throw new ContractValidationError("artifactId", "is required");
    return asArtifactId(value);
  } catch {
    throw invalidRequest("artifact identifier is invalid");
  }
}

function parseGateId(value: string | undefined): ReturnType<typeof asGateId> {
  try {
    if (value === undefined) throw new ContractValidationError("gateId", "is required");
    return asGateId(value);
  } catch {
    throw invalidRequest("gate identifier is invalid");
  }
}

interface MutationEnvelope {
  commandId: CommandId;
  idempotencyKey: string;
  expectedStateVersion: number;
  payload: Record<string, unknown>;
}

async function readMutationBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = singleRawHeader(request, "content-length");
  if (contentLength.duplicate) throw invalidRequest("request body length is invalid");
  if (contentLength.value !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength.value)) throw invalidRequest("request body length is invalid");
    if (BigInt(contentLength.value) > BigInt(MAX_REQUEST_BODY_BYTES)) throw bodyTooLarge();
  }

  const bytes = await readBoundedBody(request);
  if (bytes.length === 0) throw invalidRequest("request body is empty");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw invalidRequest("request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest("request body must be a JSON object");
  return value;
}

function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (byteLength + bytes.length > MAX_REQUEST_BODY_BYTES) {
        fail(bodyTooLarge());
        return;
      }
      chunks.push(bytes);
      byteLength += bytes.length;
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, byteLength));
    };
    const onAborted = () => fail(invalidRequest("request body was interrupted"));
    const onError = () => fail(invalidRequest("request body could not be read"));

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function parseMutationEnvelope(value: unknown): MutationEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest("request body must be a JSON object");
  const envelope = value as Record<string, unknown>;
  assertExactKeys(envelope, ["schemaVersion", "commandId", "idempotencyKey", "expectedStateVersion", "payload"]);
  if (envelope.schemaVersion !== MUTATION_SCHEMA_VERSION) throw invalidRequest("mutation schema version is invalid");
  if (typeof envelope.commandId !== "string") throw invalidRequest("command identifier is invalid");
  if (typeof envelope.idempotencyKey !== "string" || envelope.idempotencyKey.length === 0 || envelope.idempotencyKey.length > 200) {
    throw invalidRequest("idempotency key is invalid");
  }
  if (!Number.isSafeInteger(envelope.expectedStateVersion) || (envelope.expectedStateVersion as number) < 0) {
    throw invalidRequest("expected state version is invalid");
  }
  if (typeof envelope.payload !== "object" || envelope.payload === null || Array.isArray(envelope.payload)) {
    throw invalidRequest("mutation payload must be a JSON object");
  }
  return {
    commandId: asCommandId(envelope.commandId),
    idempotencyKey: envelope.idempotencyKey,
    expectedStateVersion: envelope.expectedStateVersion as number,
    payload: envelope.payload as Record<string, unknown>,
  };
}

function assertExactKeys(object: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw invalidRequest("request contains an unknown field");
  if (expected.some((key) => !(key in object) && key !== "note")) throw invalidRequest("request is missing a required field");
}

function requiredMutationString(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw invalidRequest("request text field is invalid");
  }
  return value;
}

function optionalMutationText(value: unknown, maximumBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2_000 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalidRequest("request text field is invalid");
  }
  return value;
}

function bodyTooLarge(): LocalApiRequestError {
  return new LocalApiRequestError({ status: 413, code: "BODY_TOO_LARGE", message: "request body exceeds the allowed size" });
}

function singleRawHeader(request: IncomingMessage, name: string): HeaderValue {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values.length === 1 ? { value: values[0]!, duplicate: false } : { duplicate: values.length > 1 };
}

function snapshotTask(task: ReadModel["currentTask"]): unknown {
  if (task === undefined) return null;
  const action = task.decision.action;
  return {
    taskId: task.taskId,
    status: safeSnapshotText(task.status, 100),
    action: {
      kind: action.kind,
      summary: safeSnapshotText(action.summary, 500),
      acceptance: safeTextList(action.acceptance, 20, 300),
      validationLevel: action.validationLevel,
      positiveScope: safeRelativeScope(action.positiveScope),
      negativeScope: safeRelativeScope(action.negativeScope),
    },
    route: {
      adapter: safeSnapshotText(task.decision.route.adapter, 100),
      model: safeSnapshotText(task.decision.route.model, 200),
    },
  };
}

function snapshotAttempt(model: ReadModel): unknown {
  const attempt = model.activeAttempt;
  if (attempt === undefined) return null;
  return {
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    lifecycle: attempt.lifecycle,
    adapter: model.currentTask === undefined ? null : safeSnapshotText(model.currentTask.decision.route.adapter, 100),
    model: model.currentTask === undefined ? null : safeSnapshotText(model.currentTask.decision.route.model, 200),
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
  };
}

function snapshotGate(model: ReadModel): unknown {
  const stored = model.currentGate;
  if (stored === undefined) return null;
  const gate = stored.gate;
  return {
    gateId: stored.gateId,
    status: stored.status,
    reasonCode: safeSnapshotText(gate.reasonCode, 120),
    summary: safeSnapshotText(gate.summary, 500),
    options: gate.options.slice(0, 10).map((option) => ({
      id: safeSnapshotText(option.id, 100),
      label: safeSnapshotText(option.label, 200),
      consequence: safeSnapshotText(option.consequence, 300),
      target: option.target,
    })),
  };
}

function snapshotValidation(model: ReadModel): unknown {
  const validation = model.latestValidation;
  if (validation === undefined) return null;
  return {
    validationId: validation.validationId,
    level: validation.level,
    outcome: validation.outcome,
    summary: safeSnapshotText(validation.bundle.summary, 500),
    checks: validation.bundle.checks.slice(0, 20).map((check) => ({
      name: safeSnapshotText(check.name, 200),
      outcome: check.outcome,
      evidenceClass: check.evidenceClass,
    })),
    createdAt: validation.createdAt,
  };
}

function snapshotReview(model: ReadModel): unknown {
  const review = model.latestReview;
  if (review === undefined) return null;
  return {
    reviewId: review.reviewId,
    outcome: review.outcome,
    reasonCode: safeSnapshotText(review.decision.reasonCode, 120),
    summary: safeSnapshotText(review.decision.summary, 500),
    createdAt: review.createdAt,
  };
}

function snapshotTransition(transition: StoredTransition): unknown {
  return {
    sequence: transition.sequence,
    from: transition.from,
    to: transition.to,
    reasonCode: safeSnapshotText(transition.reasonCode, 120),
    actor: transition.actor,
    stateVersionBefore: transition.stateVersionBefore,
    stateVersionAfter: transition.stateVersionAfter,
    createdAt: transition.createdAt,
  };
}

function snapshotArtifact(artifact: StoredArtifact): unknown {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    attemptId: artifact.attemptId,
    kind: artifact.kind,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
    redactionState: artifact.redactionState,
    retentionCategory: artifact.retentionCategory,
    createdAt: artifact.createdAt,
  };
}

function safeTextList(values: readonly string[], maximumCount: number, maximumLength: number): string[] {
  return values.slice(0, maximumCount).map((value) => safeSnapshotText(value, maximumLength));
}

function safeRelativeScope(values: readonly string[]): string[] {
  return values
    .filter((value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/u.test(value))
    .slice(0, 20)
    .map((value) => safeSnapshotText(value, 200));
}

function safeSnapshotText(value: string, maximumLength: number): string {
  if (containsLikelySecret(value)) return "[redacted]";
  return redactDiagnostic(value)
    .replace(/(^|[\s"'(=:])\/[^\s"'<>),;]*/gu, "$1[path redacted]")
    .replace(/(^|[\s"'(=:])[A-Za-z]:\\[^\s"'<>),;]*/gu, "$1[path redacted]")
    .slice(0, maximumLength);
}

function serializeSseTransition(transition: StoredTransition): string {
  const data = {
    sequence: transition.sequence,
    stateVersion: transition.stateVersionAfter,
    to: transition.to,
    reasonCode: safeSnapshotText(transition.reasonCode, 120),
  };
  return `id: ${transition.sequence}\nevent: state\ndata: ${JSON.stringify(data)}\n\n`;
}

function invalidRequest(message: string): LocalApiRequestError {
  return new LocalApiRequestError({ status: 400, code: "INVALID_REQUEST", message });
}

function mapRequestError(error: unknown): LocalApiErrorShape {
  if (error instanceof LocalApiRequestError) return error.shape;
  if (error instanceof ContractValidationError) return { status: 400, code: "INVALID_REQUEST", message: "request input is invalid" };
  if (error instanceof NotFoundError || (error instanceof KerbsFlowError && error.code === "NOT_FOUND")) {
    return { status: 404, code: "NOT_FOUND", message: "run or gate not found" };
  }
  if (error instanceof StateVersionConflictError) return { status: 409, code: "STATE_VERSION_CONFLICT", message: "run state changed; refresh before retrying" };
  if (error instanceof IdempotencyConflictError) return { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "idempotency key conflicts with an earlier command" };
  if (error instanceof StateMachineError) return { status: 409, code: error.code, message: "command conflicts with the current state" };
  if (error instanceof KerbsFlowError) {
    if (error.code === "PERSISTENCE_SECRET_REJECTED") {
      return { status: 400, code: "INVALID_REQUEST", message: "request input is invalid" };
    }
    if ([
      "RUN_EXISTS",
      "INVALID_COMMAND_STATE",
      "RESUME_NOT_PAUSED",
      "RESUME_REQUIRES_RECOVERY",
      "GATE_NOT_OPEN",
      "GATE_OPTION_INVALID",
      "GATE_SCOPE_MISMATCH",
      "REAL_CANCEL_REQUIRES_DURABLE_INTENT",
      "CANCEL_NOT_ALLOWED",
    ].includes(error.code)) {
      return { status: 409, code: error.code, message: "command conflicts with the current state" };
    }
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "internal server error" };
}

class LocalApiRequestError extends Error {
  constructor(readonly shape: LocalApiErrorShape) {
    super(shape.message);
  }
}
