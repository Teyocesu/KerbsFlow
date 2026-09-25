import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorAdapter } from "../src/adapter.js";
import { FileArtifactStore } from "../src/artifacts.js";
import {
  CONTRACT_VERSIONS,
  asDecisionId,
  asGateId,
  asRunId,
  asTaskId,
  DEFAULT_HARD_INVARIANTS,
  DEFAULT_PROJECT_POLICY,
  DEFAULT_RUN_OVERRIDE,
  DEFAULT_USER_PREFERENCES,
  type ArtifactId,
  type ExecutorResult,
  type PlanningDecision,
  type RunId,
} from "../src/contracts.js";
import { KerbsFlowCore } from "../src/core.js";
import { FakeAdapter } from "../src/fake.js";
import { LocalApiServer, type ArtifactReader } from "../src/local-api.js";
import { StateStore } from "../src/persistence.js";
import { FixedClock, SequenceIdSource } from "../src/runtime.js";

interface ApiFixture {
  root: string;
  store: StateStore;
  artifacts: FileArtifactStore;
  core: KerbsFlowCore;
  close(): void;
}

interface ApiResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RequestOptions {
  method?: string;
  host?: string;
  includeHost?: boolean;
  origin?: string | string[];
  token?: string;
  includeOrigin?: boolean;
  includeToken?: boolean;
  lastEventId?: string;
  body?: string | Buffer;
  contentLength?: number;
  chunked?: boolean;
}

type LocalApiCore = Pick<KerbsFlowCore, "readModel" | "startRun" | "pause" | "resume" | "cancel" | "resolveGateScoped">;

interface RunningApi {
  fixture: ApiFixture;
  api: LocalApiServer;
  token: string;
}

interface SseEvent {
  id: number;
  data: { sequence: number; stateVersion: number; to: string; reasonCode: string };
}

interface SseConnection {
  request: ClientRequest;
  response: IncomingMessage;
  collector: SseCollector;
}

class SseCollector {
  private buffer = "";
  private readonly waiters = new Set<() => void>();

  append(chunk: string): void {
    this.buffer += chunk;
    for (const waiter of [...this.waiters]) waiter();
  }

  events(): SseEvent[] {
    const frames = this.buffer.split("\n\n");
    frames.pop();
    return frames.flatMap((frame) => {
      if (!frame.includes("event: state")) return [];
      const id = /^id: ([0-9]+)$/mu.exec(frame)?.[1];
      const data = /^data: (.+)$/mu.exec(frame)?.[1];
      if (id === undefined || data === undefined) return [];
      return [{ id: Number(id), data: JSON.parse(data) as SseEvent["data"] }];
    });
  }

  waitForEvents(count: number, timeoutMs = 2_000): Promise<SseEvent[]> {
    const current = this.events();
    if (current.length >= count) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const finish = () => {
        const events = this.events();
        if (events.length < count) return;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(events);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(finish);
        reject(new Error(`timed out waiting for ${count} SSE events`));
      }, timeoutMs);
      this.waiters.add(finish);
      finish();
    });
  }
}

function createFixture(): ApiFixture {
  const root = mkdtempSync(join(tmpdir(), "kerbsflow-local-api-"));
  const clock = new FixedClock("2026-09-25T12:00:00.000Z");
  const ids = new SequenceIdSource("local-api");
  const store = StateStore.open(join(root, "state.sqlite"), { clock, ids });
  const artifacts = new FileArtifactStore(join(root, "artifacts"), ids);
  const adapter = new FakeAdapter(clock, ids);
  const core = new KerbsFlowCore(store, adapter, artifacts, { clock, ids });
  return {
    root,
    store,
    artifacts,
    core,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function withApi(
  run: (context: RunningApi) => Promise<void>,
  options: { pollIntervalMs?: number; artifactReader?: (fixture: ApiFixture) => ArtifactReader; core?: (fixture: ApiFixture) => Partial<LocalApiCore> } = {},
): Promise<void> {
  const fixture = createFixture();
  const api = new LocalApiServer({
    core: localApiCore(fixture, options.core?.(fixture)),
    store: fixture.store,
    artifacts: options.artifactReader?.(fixture) ?? fixture.artifacts,
  }, options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs });
  try {
    await api.start();
    const bootstrap = await sendRequest(api, "/");
    assert.equal(bootstrap.status, 200);
    await run({ fixture, api, token: tokenFrom(bootstrap.body) });
  } finally {
    await api.close();
    fixture.close();
  }
}

function localApiCore(fixture: ApiFixture, overrides: Partial<LocalApiCore> = {}): LocalApiCore {
  return {
    readModel: (runId) => (overrides.readModel ?? fixture.core.readModel.bind(fixture.core))(runId),
    startRun: (...args) => (overrides.startRun ?? fixture.core.startRun.bind(fixture.core))(...args),
    pause: (...args) => (overrides.pause ?? fixture.core.pause.bind(fixture.core))(...args),
    resume: (...args) => (overrides.resume ?? fixture.core.resume.bind(fixture.core))(...args),
    cancel: (...args) => (overrides.cancel ?? fixture.core.cancel.bind(fixture.core))(...args),
    resolveGateScoped: (...args) => (overrides.resolveGateScoped ?? fixture.core.resolveGateScoped.bind(fixture.core))(...args),
  };
}

function sendRequest(api: LocalApiServer, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string | string[]> = {};
  if (options.includeHost !== false) headers.host = options.host ?? `127.0.0.1:${api.port()}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.token !== undefined) headers["X-KerbsFlow-Token"] = options.token;
  if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;
  if (options.contentLength !== undefined) headers["Content-Length"] = String(options.contentLength);
  if (options.chunked === true) headers["Transfer-Encoding"] = "chunked";
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: api.port(),
      path,
      method: options.method ?? "GET",
      headers,
      setHost: false,
      agent: false,
    }, (response) => {
      responseReceived = true;
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", (error) => { if (!responseReceived) reject(error); });
    if (options.body === undefined) request.end();
    else request.end(options.body);
  });
}

function mutationEnvelope(
  commandId: string,
  idempotencyKey: string,
  expectedStateVersion: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: "kerbsflow.local-command/v1",
    commandId,
    idempotencyKey,
    expectedStateVersion,
    payload,
  };
}

function postMutation(
  api: LocalApiServer,
  path: string,
  token: string,
  body: unknown,
  options: Partial<RequestOptions> = {},
): Promise<ApiResponse> {
  const serialized = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (serialized === undefined) return Promise.reject(new Error("mutation test body is not serializable"));
  return sendRequest(api, path, {
    method: "POST",
    ...(options.includeToken === false ? {} : { token }),
    ...(options.includeOrigin === false ? {} : { origin: `http://127.0.0.1:${api.port()}` }),
    body: serialized,
    ...options,
  });
}

function openSse(api: LocalApiServer, runId: RunId, token: string, lastEventId?: string): Promise<SseConnection> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${api.port()}`,
    "X-KerbsFlow-Token": token,
  };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
  return new Promise((resolve, reject) => {
    let receivedResponse = false;
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: api.port(),
      path: `/v1/runs/${runId}/events`,
      method: "GET",
      headers,
      setHost: false,
      agent: false,
    });
    request.on("error", (error) => { if (!receivedResponse) reject(error); });
    request.on("response", (response) => {
      receivedResponse = true;
      response.setEncoding("utf8");
      const collector = new SseCollector();
      response.on("data", (chunk: string) => collector.append(chunk));
      resolve({ request, response, collector });
    });
    request.end();
  });
}

async function closeSse(connection: SseConnection): Promise<void> {
  const closed = connection.response.destroyed
    ? Promise.resolve()
    : new Promise<void>((resolve) => connection.response.once("close", () => resolve()));
  connection.request.destroy();
  await closed;
}

function tokenFrom(html: string): string {
  const token = /<meta name="kerbsflow-token" content="([A-Za-z0-9_-]+)">/u.exec(html)?.[1];
  assert.ok(token);
  return token;
}

function planFor(runId: RunId, suffix: string, adapter: "fake" | "codex" = "fake"): PlanningDecision {
  return {
    schemaVersion: CONTRACT_VERSIONS.planningDecision,
    decisionId: asDecisionId(`decision_${suffix}`),
    runId,
    taskId: asTaskId(`task_${suffix}`),
    action: {
      kind: "implementation",
      summary: "synthetic local API task",
      acceptance: ["bounded local snapshot is readable"],
      validationLevel: "focused",
      positiveScope: ["src"],
      negativeScope: ["production providers"],
    },
    route: { adapter, model: adapter === "fake" ? "fake" : "openai/sol-current" },
    requiredCapabilities: ["simulated_execution"],
    selectedSkills: ["test"],
    canonicalContextHash: "synthetic-local-api-context",
    policyVersion: "local-api-test-policy",
  };
}

function startRun(fixture: ApiFixture, runId: RunId): void {
  fixture.core.startRun(runId, "synthetic local API objective", `start:${runId}`);
}

async function createArtifact(fixture: ApiFixture, runId: RunId, suffix: string): Promise<ArtifactId> {
  const decision = planFor(runId, suffix);
  startRun(fixture, runId);
  fixture.core.completeIntake(runId, 1, `${suffix}:intake`);
  fixture.core.plan(runId, 2, `${suffix}:plan`, decision);
  const prepared = fixture.core.prepareExecution(runId, 3, `${suffix}:prepare`);
  const model = fixture.core.readModel(runId);
  const attemptId = model?.run.activeAttemptId;
  assert.ok(attemptId);
  const result: ExecutorResult = {
    schemaVersion: CONTRACT_VERSIONS.executorResult,
    runId,
    taskId: decision.taskId,
    attemptId,
    executor: { adapter: "fake", adapterVersion: "phase1", provider: "synthetic", model: "fake" },
    outcome: "succeeded",
    failureClass: null,
    scopeClaim: "within_scope",
    summary: "synthetic persisted artifact fixture",
    filesChanged: [],
    checks: [],
    evidence: [],
    invariantViolations: [],
    risks: [],
    warnings: [],
    artifacts: [],
    humanGate: null,
    recommendedNext: "verify_focused",
    exit: { kind: "normal", code: 0 },
  };
  await fixture.core.completeFakeAttempt(runId, prepared.stateVersion, `${suffix}:complete`, result);
  const record = fixture.store.listArtifactRecords(runId, 1)[0];
  assert.ok(record);
  return record.artifactId;
}

test("listener binds ephemeral IPv4 loopback and close leaves run state unchanged", async () => {
  await withApi(async ({ fixture, api }) => {
    const runId = asRunId("run_local_api_listener");
    startRun(fixture, runId);
    const before = fixture.core.readModel(runId)?.run;
    const address = api.address();
    assert.equal(address.address, "127.0.0.1");
    assert.ok(address.port > 0);
    assert.equal(api.port(), address.port);
    await api.close();
    const after = fixture.core.readModel(runId)?.run;
    assert.deepEqual(after, before);
  });
});

test("bootstrap enforces Host and returns a same-launch inert token with security headers", async () => {
  await withApi(async ({ api, token }) => {
    const port = api.port();
    const missingHost = await sendRequest(api, "/", { includeHost: false });
    assert.ok(missingHost.status >= 400 && missingHost.status < 500, "a missing Host request must fail closed");
    for (const host of [`localhost:${port}`, `127.0.0.1:${port + 1}`, "foreign.example"]) {
      const response = await sendRequest(api, "/", { host });
      assert.equal(response.status, 403);
    }
    const root = await sendRequest(api, "/");
    assert.equal(tokenFrom(root.body), token);
    assert.equal(tokenFrom((await sendRequest(api, "/")).body), token);
    assert.match(root.body, /<meta name="kerbsflow-token" content="[A-Za-z0-9_-]+">/u);
    assert.doesNotMatch(root.body, /<script\b|\?token=/iu);
    assert.equal(root.headers["cache-control"], "no-store");
    assert.equal(root.headers["referrer-policy"], "no-referrer");
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["x-frame-options"], "DENY");
    assert.equal(root.headers["content-security-policy"], "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(root.headers["access-control-allow-origin"], undefined);
    for (const origin of ["null", "https://foreign.example", [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]]) {
      assert.equal((await sendRequest(api, "/", { origin })).status, 403);
    }
  });
});

test("v1 reads allow omitted Origin but still require token and exact Host", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const runId = asRunId("run_local_api_auth");
    startRun(fixture, runId);
    const path = `/v1/runs/${runId}/snapshot`;
    const exactOrigin = `http://127.0.0.1:${api.port()}`;
    const valid = { origin: exactOrigin, token };
    assert.equal((await sendRequest(api, path, { token })).status, 200);
    assert.equal((await sendRequest(api, path)).status, 401);
    assert.equal((await sendRequest(api, path, { ...valid, token: "wrong-token" })).status, 401);
    const accepted = await sendRequest(api, path, valid);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["access-control-allow-origin"], undefined);
    for (const origin of ["null", `http://localhost:${api.port()}`, `http://127.0.0.1:${api.port() + 1}`, "https://foreign.example", [exactOrigin, exactOrigin]]) {
      const response = await sendRequest(api, path, { ...valid, origin });
      assert.equal(response.status, 403);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    assert.equal((await sendRequest(api, path, { ...valid, host: `localhost:${api.port()}` })).status, 403);
    assert.equal((await sendRequest(api, `${path}?token=${token}`, valid)).status, 400);

    const before = fixture.core.readModel(runId)?.run.stateVersion;
    assert.equal((await sendRequest(api, `/v1/runs/${runId}/cancel`, { token, method: "POST" })).status, 403);
    const emptyMutation = await sendRequest(api, `/v1/runs/${runId}/cancel`, { ...valid, method: "POST" });
    assert.equal(emptyMutation.status, 400);
    assert.equal(fixture.core.readModel(runId)?.run.stateVersion, before);
    assert.equal((await sendRequest(api, path, { ...valid, method: "POST" })).status, 405);
  });
});

test("POST mutations require exact Host, token, and same-origin Origin", async () => {
  await withApi(async ({ api, token }) => {
    const body = mutationEnvelope("command_http_security", "http:security", 0, {
      runId: "run_local_api_post_security",
      objective: "synthetic mutation security check",
    });
    const accepted = await postMutation(api, "/v1/runs", token, body);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(accepted.body).commandId, "command_http_security");

    assert.equal((await postMutation(api, "/v1/runs", token, body, { includeOrigin: false })).status, 403);
    assert.equal((await postMutation(api, "/v1/runs", token, body, { origin: "https://foreign.example" })).status, 403);
    assert.equal((await postMutation(api, "/v1/runs", token, body, { includeToken: false })).status, 401);
    assert.equal((await postMutation(api, "/v1/runs", token, body, { host: `localhost:${api.port()}` })).status, 403);
  });
});

test("mutation bodies reject malformed, non-object, unknown, and oversized input before core invocation", async () => {
  let startCalls = 0;
  await withApi(async ({ api, token }) => {
    const valid = mutationEnvelope("command_http_body", "http:body", 0, {
      runId: "run_local_api_body",
      objective: "synthetic mutation body check",
    });
    const unknownTopLevel = { ...valid, unexpected: true };
    const unknownPayload = { ...valid, payload: { ...(valid.payload as Record<string, unknown>), unexpected: true } };
    assert.equal((await postMutation(api, "/v1/runs", token, "{")).status, 400);
    assert.equal((await postMutation(api, "/v1/runs", token, "[]")).status, 400);
    assert.equal((await postMutation(api, "/v1/runs", token, unknownTopLevel)).status, 400);
    assert.equal((await postMutation(api, "/v1/runs", token, unknownPayload)).status, 400);

    const oversized = "x".repeat(64 * 1024 + 1);
    assert.equal((await postMutation(api, "/v1/runs", token, oversized, { contentLength: Buffer.byteLength(oversized) })).status, 413);
    assert.equal((await postMutation(api, "/v1/runs", token, oversized, { chunked: true })).status, 413);
    assert.equal(startCalls, 0);
  }, {
    core: (fixture) => ({
      startRun(...args) {
        startCalls += 1;
        return fixture.core.startRun(...args);
      },
    }),
  });
});

test("start persists the supplied command ID and retains idempotent replay", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const runId = asRunId("run_local_api_post_start");
    const path = "/v1/runs";
    const invalidVersion = mutationEnvelope("command_http_start_bad_version", "http:start:bad-version", 1, {
      runId: "run_local_api_bad_version",
      objective: "synthetic objective",
    });
    assert.equal((await postMutation(api, path, token, invalidVersion)).status, 400);
    assert.equal(fixture.core.readModel(asRunId("run_local_api_bad_version")), undefined);

    const body = mutationEnvelope("command_http_start", "http:start", 0, {
      runId,
      objective: "synthetic HTTP start objective",
    });
    const started = await postMutation(api, path, token, body);
    assert.equal(started.status, 200);
    const result = JSON.parse(started.body) as { commandId: string; replayed: boolean; stateVersion: number };
    assert.equal(result.commandId, "command_http_start");
    assert.equal(result.replayed, false);
    assert.equal(result.stateVersion, 1);
    const transition = fixture.store.listTransitions(runId)[0];
    assert.equal(transition?.commandId, result.commandId);

    const replayed = await postMutation(api, path, token, body);
    assert.equal(replayed.status, 200);
    assert.equal(JSON.parse(replayed.body).replayed, true);
    assert.equal(fixture.store.listTransitions(runId).length, 1);

    const newCommandIdSameSemantics = mutationEnvelope("command_http_start_semantic_replay", "http:start", 0, {
      runId,
      objective: "synthetic HTTP start objective",
    });
    const semanticReplay = await postMutation(api, path, token, newCommandIdSameSemantics);
    assert.equal(semanticReplay.status, 200);
    assert.equal(JSON.parse(semanticReplay.body).replayed, true);
    assert.equal(fixture.store.listTransitions(runId).length, 1);

    const sameCommandChanged = mutationEnvelope("command_http_start", "http:start", 0, {
      runId,
      objective: "changed semantic objective with same command ID",
    });
    assert.equal((await postMutation(api, path, token, sameCommandChanged)).status, 409);

    const changed = mutationEnvelope("command_http_start_changed", "http:start", 0, {
      runId,
      objective: "changed semantic objective",
    });
    assert.equal((await postMutation(api, path, token, changed)).status, 409);
    assert.equal(fixture.store.listTransitions(runId).length, 1);
  });
});

test("command ID collision rejects cancel before Core or adapter cancellation", async () => {
  let coreCancelCalls = 0;
  let adapterCancelCalls = 0;
  await withApi(async ({ fixture, api, token }) => {
    const clock = new FixedClock("2026-09-25T12:00:00.000Z");
    const ids = new SequenceIdSource("local-api-command-collision");
    const fake = new FakeAdapter(clock, ids);
    const adapter: ExecutorAdapter = {
      probe: () => fake.probe(),
      start: (request) => fake.start(request),
      events: (handle) => fake.events(handle),
      wait: (handle) => fake.wait(handle),
      cancel: (handle, reason) => {
        adapterCancelCalls += 1;
        return fake.cancel(handle, reason);
      },
      reconcile: (identity) => fake.reconcile(identity),
    };
    fixture.core = new KerbsFlowCore(fixture.store, adapter, fixture.artifacts, { clock, ids });

    const runId = asRunId("run_local_api_command_collision");
    const commandId = "command_http_collision";
    const created = await postMutation(api, "/v1/runs", token, mutationEnvelope(commandId, "collision:first", 0, {
      runId,
      objective: "synthetic command ID collision objective",
    }));
    assert.equal(created.status, 200);

    let command = fixture.core.completeIntake(runId, 1, "collision:intake");
    command = fixture.core.plan(runId, command.stateVersion, "collision:plan", planFor(runId, "api_command_collision"));
    command = fixture.core.prepareExecution(runId, command.stateVersion, "collision:prepare");
    await fixture.core.beginFakeAttempt(runId, command.stateVersion, "collision:begin");
    const before = fixture.core.readModel(runId);
    assert.ok(before?.activeAttempt);
    assert.equal(before.run.state, "EXECUTE");
    assert.equal(before.activeAttempt.lifecycle, "RUNNING");
    const transitionsBefore = fixture.store.listTransitions(runId);

    const collision = await postMutation(api, `/v1/runs/${runId}/cancel`, token, mutationEnvelope(commandId, "collision:cancel", before.run.stateVersion, {
      reason: "this command ID is already owned by another idempotency key",
    }));
    assert.equal(collision.status, 409);
    assert.deepEqual(JSON.parse(collision.body), {
      error: {
        code: "COMMAND_ID_CONFLICT",
        message: "command identifier conflicts with an earlier command",
      },
    });
    assert.equal(coreCancelCalls, 0);
    assert.equal(adapterCancelCalls, 0);
    const after = fixture.core.readModel(runId);
    assert.equal(after?.run.state, before.run.state);
    assert.equal(after?.run.stateVersion, before.run.stateVersion);
    assert.equal(after?.activeAttempt?.lifecycle, before.activeAttempt.lifecycle);
    assert.deepEqual(fixture.store.listTransitions(runId), transitionsBefore);
  }, {
    core: (fixture) => ({
      cancel(...args) {
        coreCancelCalls += 1;
        return fixture.core.cancel(...args);
      },
    }),
  });
});

test("pause and resume mutations use Core state versions and the persisted resume target", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const runId = asRunId("run_local_api_post_pause");
    const start = await postMutation(api, "/v1/runs", token, mutationEnvelope("command_http_pause_start", "http:pause:start", 0, {
      runId,
      objective: "synthetic pause and resume objective",
    }));
    assert.equal(start.status, 200);

    const pauseBody = mutationEnvelope("command_http_pause", "http:pause", 1, {});
    const paused = await postMutation(api, `/v1/runs/${runId}/pause`, token, pauseBody);
    assert.equal(paused.status, 200);
    const pauseResult = JSON.parse(paused.body) as { commandId: string; replayed: boolean; to: string; stateVersion: number; details?: { resumeTarget?: string } };
    assert.equal(pauseResult.to, "PAUSED");
    assert.equal(pauseResult.details?.resumeTarget, "INTAKE");
    assert.equal(pauseResult.replayed, false);
    assert.equal(fixture.store.listTransitions(runId).at(-1)?.commandId, "command_http_pause");

    const pauseReplay = await postMutation(api, `/v1/runs/${runId}/pause`, token, pauseBody);
    assert.equal(pauseReplay.status, 200);
    assert.equal(JSON.parse(pauseReplay.body).replayed, true);
    assert.equal(fixture.store.listTransitions(runId).length, 2);

    assert.equal((await postMutation(api, `/v1/runs/${runId}/pause`, token, mutationEnvelope("command_http_pause_stale", "http:pause:stale", 1, {}))).status, 409);
    const resumed = await postMutation(api, `/v1/runs/${runId}/resume`, token, mutationEnvelope("command_http_resume", "http:resume", pauseResult.stateVersion, {}));
    assert.equal(resumed.status, 200);
    assert.equal(JSON.parse(resumed.body).to, "INTAKE");
    assert.equal(fixture.store.listTransitions(runId).at(-1)?.commandId, "command_http_resume");
    assert.equal(fixture.core.readModel(runId)?.run.state, "INTAKE");

    const illegalRunId = asRunId("run_local_api_post_resume_illegal");
    assert.equal((await postMutation(api, "/v1/runs", token, mutationEnvelope("command_http_resume_start", "http:resume:start", 0, {
      runId: illegalRunId,
      objective: "synthetic illegal resume objective",
    }))).status, 200);
    const illegalResume = await postMutation(api, `/v1/runs/${illegalRunId}/resume`, token, mutationEnvelope("command_http_resume_illegal", "http:resume:illegal", 1, {}));
    assert.equal(illegalResume.status, 409);
    assert.equal(fixture.core.readModel(illegalRunId)?.run.state, "INTAKE");
    assert.equal((await postMutation(api, "/v1/runs/run_local_api_missing/pause", token, mutationEnvelope("command_http_pause_missing", "http:pause:missing", 0, {}))).status, 404);
  });
});

test("gate resolution is run-scoped, versioned, replayable, and persists the supplied command ID", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const runId = asRunId("run_local_api_post_gate");
    assert.equal((await postMutation(api, "/v1/runs", token, mutationEnvelope("command_http_gate_start", "http:gate:start", 0, {
      runId,
      objective: "synthetic gate objective",
    }))).status, 200);
    fixture.core.gateIntake(runId, 1, "http:gate:create", "synthetic_human_gate", "Synthetic local API gate");
    const gateId = fixture.core.readModel(runId)?.currentGate?.gateId;
    assert.ok(gateId);
    const path = `/v1/runs/${runId}/gates/${gateId}/resolve`;

    assert.equal((await postMutation(api, `/v1/runs/${runId}/gates/not-a-gate/resolve`, token, mutationEnvelope("command_http_gate_invalid_id", "http:gate:invalid-id", 2, { optionId: "fail" }))).status, 400);
    assert.equal((await postMutation(api, `/v1/runs/${runId}/gates/${asGateId("gate_unknown")}/resolve`, token, mutationEnvelope("command_http_gate_unknown", "http:gate:unknown", 2, { optionId: "fail" }))).status, 404);
    const otherRunId = asRunId("run_local_api_post_gate_other");
    fixture.core.startRun(otherRunId, "synthetic other gate objective", "http:gate:other:start");
    fixture.core.gateIntake(otherRunId, 1, "http:gate:other:create", "synthetic_other_human_gate", "Synthetic other run gate");
    const otherGateId = fixture.core.readModel(otherRunId)?.currentGate?.gateId;
    assert.ok(otherGateId);
    assert.equal((await postMutation(api, `/v1/runs/${runId}/gates/${otherGateId}/resolve`, token, mutationEnvelope("command_http_gate_wrong_scope", "http:gate:wrong-scope", 2, { optionId: "fail" }))).status, 409);
    assert.equal((await postMutation(api, path, token, mutationEnvelope("command_http_gate_stale", "http:gate:stale", 1, { optionId: "fail" }))).status, 409);
    const maximumNote = `${"€".repeat(1_365)}a`;
    assert.equal(Buffer.byteLength(maximumNote, "utf8"), 4_096);
    assert.equal((await postMutation(api, path, token, mutationEnvelope("command_http_gate_note_too_long", "http:gate:long-note", 2, { optionId: "fail", note: "€".repeat(1_366) }))).status, 400);

    const body = mutationEnvelope("command_http_gate_resolve", "http:gate:resolve", 2, { optionId: "fail", note: maximumNote });
    const resolved = await postMutation(api, path, token, body);
    assert.equal(resolved.status, 200);
    const result = JSON.parse(resolved.body) as { commandId: string; replayed: boolean; to: string };
    assert.equal(result.commandId, "command_http_gate_resolve");
    assert.equal(result.replayed, false);
    assert.equal(result.to, "FAILED");
    assert.equal(fixture.store.listTransitions(runId).at(-1)?.commandId, result.commandId);
    assert.equal(fixture.store.getGate(gateId)?.gate.resolution?.note, maximumNote);

    const replayed = await postMutation(api, path, token, body);
    assert.equal(replayed.status, 200);
    assert.equal(JSON.parse(replayed.body).replayed, true);
    assert.equal(fixture.store.listTransitions(runId).length, 3);
  });
});

test("cancel delegates to Core and blocks real-adapter cancellation before any adapter signal", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const fakeRunId = asRunId("run_local_api_post_cancel_fake");
    assert.equal((await postMutation(api, "/v1/runs", token, mutationEnvelope("command_http_cancel_start", "http:cancel:start", 0, {
      runId: fakeRunId,
      objective: "synthetic fake cancellation objective",
    }))).status, 200);
    const cancelBody = mutationEnvelope("command_http_cancel", "http:cancel", 1, { reason: "synthetic cancellation request" });
    const cancelled = await postMutation(api, `/v1/runs/${fakeRunId}/cancel`, token, cancelBody);
    assert.equal(cancelled.status, 200);
    assert.equal(JSON.parse(cancelled.body).to, "CANCELLED");
    assert.equal(fixture.store.listTransitions(fakeRunId).at(-1)?.commandId, "command_http_cancel");
    const replayed = await postMutation(api, `/v1/runs/${fakeRunId}/cancel`, token, cancelBody);
    assert.equal(replayed.status, 200);
    assert.equal(JSON.parse(replayed.body).replayed, true);
    assert.equal(fixture.store.listTransitions(fakeRunId).length, 2);

    let adapterCancelCalls = 0;
    const fake = new FakeAdapter(new FixedClock("2026-09-25T12:00:00.000Z"), new SequenceIdSource("local-api-real-cancel"));
    const adapter: ExecutorAdapter = {
      probe: () => {
        const descriptor = fake.probe();
        return {
          ...descriptor,
          adapter: "codex",
          provider: "openai",
          capabilities: { ...descriptor.capabilities, cancellation: "process_only" },
        };
      },
      start: (request) => fake.start(request),
      events: (handle) => fake.events(handle),
      wait: (handle) => fake.wait(handle),
      cancel: (handle, reason) => {
        adapterCancelCalls += 1;
        return fake.cancel(handle, reason);
      },
      reconcile: (identity) => fake.reconcile(identity),
    };
    fixture.core = new KerbsFlowCore(fixture.store, adapter, fixture.artifacts, {
      configuration: {
        hardInvariants: DEFAULT_HARD_INVARIANTS,
        projectPolicy: { ...DEFAULT_PROJECT_POLICY, allowedAdapters: ["fake", "codex"] },
        userPreferences: DEFAULT_USER_PREFERENCES,
        runOverride: DEFAULT_RUN_OVERRIDE,
      },
    });
    const realRunId = asRunId("run_local_api_post_cancel_real");
    let command = fixture.core.startRun(realRunId, "synthetic real-adapter cancellation objective", "http:cancel:real:start");
    command = fixture.core.completeIntake(realRunId, command.stateVersion, "http:cancel:real:intake");
    command = fixture.core.plan(realRunId, command.stateVersion, "http:cancel:real:plan", planFor(realRunId, "api_cancel_real", "codex"));
    command = fixture.core.prepareExecution(realRunId, command.stateVersion, "http:cancel:real:prepare");
    const activeDescriptorJson = fixture.store.readModel(realRunId)?.activeAttempt?.adapterDescriptorJson;
    assert.ok(activeDescriptorJson);
    assert.equal(JSON.parse(activeDescriptorJson).adapter, "codex");
    const realCancel = await postMutation(api, `/v1/runs/${realRunId}/cancel`, token, mutationEnvelope("command_http_cancel_real", "http:cancel:real", command.stateVersion, { reason: "must use durable cancellation" }));
    assert.equal(realCancel.status, 409);
    assert.deepEqual(JSON.parse(realCancel.body), { error: { code: "REAL_CANCEL_REQUIRES_DURABLE_INTENT", message: "command conflicts with the current state" } });
    assert.equal(adapterCancelCalls, 0);
    assert.equal(fixture.core.readModel(realRunId)?.run.state, "EXECUTE");
  });
});

test("bounded persistence reads validate IDs, limits, cursors, and chronological ordering", async () => {
  await withApi(async ({ fixture }) => {
    const runId = asRunId("run_local_api_bounds");
    startRun(fixture, runId);
    let version = 1;
    for (let index = 0; index < 26; index += 1) {
      version = fixture.core.pause(runId, version, `pause:${index}`).stateVersion;
      version = fixture.core.resume(runId, version, `resume:${index}`).stateVersion;
    }
    const all = fixture.store.listTransitions(runId);
    const recent = fixture.store.listRecentTransitions(runId, 50);
    assert.equal(recent.length, 50);
    assert.deepEqual(recent.map((transition) => transition.sequence), all.slice(-50).map((transition) => transition.sequence));
    assert.deepEqual(
      fixture.store.listTransitionsAfter(runId, recent[0]!.sequence, 3).map((transition) => transition.sequence),
      all.filter((transition) => transition.sequence > recent[0]!.sequence).slice(0, 3).map((transition) => transition.sequence),
    );
    assert.throws(() => fixture.store.listRecentTransitions(runId, 101), /limit/i);
    assert.throws(() => fixture.store.listRecentTransitions(runId, 1.5), /limit/i);
    assert.throws(() => fixture.store.listTransitionsAfter(runId, -1, 1), /cursor/i);
    assert.throws(() => fixture.store.listTransitionsAfter(runId, Number.MAX_SAFE_INTEGER + 1, 1), /cursor/i);
    assert.throws(() => fixture.store.listArtifactRecords(runId, 101), /limit/i);
    assert.throws(() => fixture.store.getArtifactRecord("artifact_../escape" as ArtifactId));
    assert.throws(() => fixture.store.listRecentTransitions("run_../escape" as RunId, 1));
  });
});

test("snapshot returns a bounded persisted projection and omits artifact paths", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const runId = asRunId("run_local_api_snapshot");
    const artifactId = await createArtifact(fixture, runId, "api_snapshot");
    let version = fixture.core.readModel(runId)!.run.stateVersion;
    for (let index = 0; index < 26; index += 1) {
      version = fixture.core.pause(runId, version, `snapshot:pause:${index}`).stateVersion;
      version = fixture.core.resume(runId, version, `snapshot:resume:${index}`).stateVersion;
    }
    const response = await sendRequest(api, `/v1/runs/${runId}/snapshot`, { origin: `http://127.0.0.1:${api.port()}`, token });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    const snapshot = JSON.parse(response.body) as Record<string, unknown> & {
      run: { runId: string; stateVersion: number };
      currentTask: { action: { positiveScope: string[] }; route: { adapter: string; model: string } };
      activeAttempt: { adapter: string; model: string };
      recentTransitions: Array<{ sequence: number }>;
      artifacts: Array<Record<string, unknown>>;
      transitionCursor: number;
    };
    assert.deepEqual(Object.keys(snapshot).sort(), ["activeAttempt", "artifacts", "currentGate", "currentTask", "latestReview", "latestValidation", "recentTransitions", "run", "schemaVersion", "transitionCursor"].sort());
    assert.equal(snapshot.schemaVersion, "kerbsflow.local-snapshot/v1");
    assert.equal(snapshot.run.runId, runId);
    assert.equal(snapshot.run.stateVersion, fixture.core.readModel(runId)?.run.stateVersion);
    assert.equal(snapshot.currentTask.route.adapter, "[redacted]");
    assert.equal(snapshot.currentTask.route.model, "[path redacted]");
    assert.deepEqual(snapshot.currentTask.action.positiveScope, []);
    assert.equal(snapshot.activeAttempt.adapter, "[redacted]");
    assert.equal(snapshot.activeAttempt.model, "[path redacted]");
    assert.equal(snapshot.transitionCursor, fixture.store.listRecentTransitions(runId, 1)[0]?.sequence);
    assert.equal(snapshot.recentTransitions.length, 50);
    assert.deepEqual(
      snapshot.recentTransitions.map((transition) => transition.sequence),
      fixture.store.listRecentTransitions(runId, 50).map((transition) => transition.sequence),
    );
    assert.equal(snapshot.artifacts.length, 1);
    assert.equal(snapshot.artifacts[0]?.artifactId, artifactId);
    assert.deepEqual(Object.keys(snapshot.artifacts[0] ?? {}).sort(), ["artifactId", "attemptId", "contentHash", "createdAt", "kind", "redactionState", "retentionCategory", "runId", "sizeBytes"].sort());
    assert.doesNotMatch(response.body, /relativePath|databasePath|worktreePath|providerIdentityJson|payloadJson|ghp_syntheticCredential123456|\/Users\/synthetic\/worktree/u);
    assert.equal((await sendRequest(api, "/v1/runs/run_local_api_missing/snapshot", { origin: `http://127.0.0.1:${api.port()}`, token })).status, 404);
  }, {
    core: (fixture) => ({
      readModel(runId) {
        const model = fixture.core.readModel(runId);
        if (model?.currentTask === undefined) return model;
        return {
          ...model,
          currentTask: {
            ...model.currentTask,
            decision: {
              ...model.currentTask.decision,
              action: {
                ...model.currentTask.decision.action,
                positiveScope: ["\\Users\\synthetic\\worktree"],
              },
              route: { adapter: "ghp_syntheticCredential123456", model: "/Users/synthetic/worktree/model" },
            },
          },
        };
      },
    }),
  });
});

test("artifact reads require a valid owned ID before calling the integrity-checking reader", async () => {
  let reads = 0;
  await withApi(async ({ fixture, api, token }) => {
    const ownerRunId = asRunId("run_local_api_artifact_owner");
    const otherRunId = asRunId("run_local_api_artifact_other");
    const artifactId = await createArtifact(fixture, ownerRunId, "api_artifact_owner");
    startRun(fixture, otherRunId);
    const pathFor = (runId: RunId, id: string) => `/v1/runs/${runId}/artifacts/${id}`;
    const auth = { token };

    const good = await sendRequest(api, pathFor(ownerRunId, artifactId), auth);
    assert.equal(good.status, 200);
    assert.equal(good.body, fixture.artifacts.get(artifactId));
    assert.equal(good.headers["content-type"], "application/octet-stream");
    assert.equal(good.headers["content-disposition"], `attachment; filename="${artifactId}.json"`);
    assert.equal(good.headers["cache-control"], "no-store");
    assert.equal(good.headers["x-content-type-options"], "nosniff");
    assert.equal(reads, 1);

    assert.equal((await sendRequest(api, pathFor(ownerRunId, "artifact_unknown"), auth)).status, 404);
    assert.equal((await sendRequest(api, pathFor(otherRunId, artifactId), auth)).status, 404);
    assert.equal(reads, 1);
    assert.equal((await sendRequest(api, pathFor(ownerRunId, "../artifact_escape"), auth)).status, 400);
    assert.equal((await sendRequest(api, pathFor(ownerRunId, "artifact_bad/extra"), auth)).status, 400);
    assert.equal(reads, 1);

    const record = fixture.store.getArtifactRecord(artifactId);
    assert.ok(record);
    writeFileSync(join(fixture.artifacts.root, record.relativePath), "tampered synthetic artifact", "utf8");
    const corrupted = await sendRequest(api, pathFor(ownerRunId, artifactId), auth);
    assert.equal(corrupted.status, 500);
    assert.deepEqual(JSON.parse(corrupted.body), { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    assert.doesNotMatch(corrupted.body, /relativePath|state\.sqlite|Bearer|token|provider/iu);
    assert.equal(reads, 2);
  }, {
    artifactReader: (fixture) => ({
      get(artifactId) {
        reads += 1;
        return fixture.artifacts.get(artifactId);
      },
    }),
  });
});

test("SSE authenticates, streams persisted run sequences, reconnects, polls, and closes without mutation", async () => {
  await withApi(async ({ fixture, api, token }) => {
    const runId = asRunId("run_local_api_sse");
    const otherRunId = asRunId("run_local_api_sse_other");
    startRun(fixture, runId);
    startRun(fixture, otherRunId);
    fixture.core.completeIntake(runId, 1, "sse:intake-a");
    fixture.core.completeIntake(otherRunId, 1, "sse:intake-b");
    fixture.core.plan(runId, 2, "sse:plan", planFor(runId, "api_sse"));
    const persisted = fixture.store.listTransitions(runId);
    assert.equal(persisted.length, 3);
    assert.ok(persisted[1]!.sequence > persisted[0]!.sequence + 1);

    const unauthenticated = await sendRequest(api, `/v1/runs/${runId}/events`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await sendRequest(api, `/v1/runs/${runId}/events`, { token, lastEventId: "-1" })).status, 400);
    assert.equal((await sendRequest(api, `/v1/runs/${runId}/events`, { token, origin: "https://foreign.example" })).status, 403);
    assert.equal((await sendRequest(api, "/v1/runs/run_local_api_unknown/events", { token })).status, 404);

    const initial = await openSse(api, runId, token);
    assert.equal(initial.response.statusCode, 200);
    assert.equal(initial.response.headers["content-type"], "text/event-stream; charset=utf-8");
    const initialEvents = await initial.collector.waitForEvents(3);
    assert.deepEqual(initialEvents.map((event) => event.id), persisted.map((transition) => transition.sequence));
    assert.deepEqual(Object.keys(initialEvents[0]!.data).sort(), ["reasonCode", "sequence", "stateVersion", "to"]);
    const versionBeforeClose = fixture.core.readModel(runId)?.run.stateVersion;
    await closeSse(initial);
    assert.equal(fixture.core.readModel(runId)?.run.stateVersion, versionBeforeClose);

    const reconnect = await openSse(api, runId, token, String(persisted[1]!.sequence));
    try {
      const replay = await reconnect.collector.waitForEvents(1);
      assert.deepEqual(replay.map((event) => event.id), [persisted[2]!.sequence]);
      fixture.core.prepareExecution(runId, 3, "sse:prepared-after-connect");
      const withLaterTransition = await reconnect.collector.waitForEvents(2);
      assert.equal(withLaterTransition[1]?.id, fixture.store.listRecentTransitions(runId, 1)[0]?.sequence);
      assert.ok(withLaterTransition[1]!.id > withLaterTransition[0]!.id);
      const beforeClose = fixture.core.readModel(runId)?.run.stateVersion;
      await closeSse(reconnect);
      assert.equal(fixture.core.readModel(runId)?.run.stateVersion, beforeClose);
    } finally {
      if (!reconnect.response.destroyed) await closeSse(reconnect);
    }
  }, { pollIntervalMs: 5 });
});

test("unexpected local API errors return only a sanitized error envelope", async () => {
  await withApi(async ({ api, token }) => {
    const response = await sendRequest(api, "/v1/runs/run_local_api_failure/snapshot", { origin: `http://127.0.0.1:${api.port()}`, token });
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), { error: { code: "INTERNAL_ERROR", message: "internal server error" } });
    assert.doesNotMatch(response.body, /private|Bearer|synthetic-secret|provider diagnostic|token/iu);
  }, {
    core: () => ({ readModel: () => { throw new Error("Bearer synthetic-secret-value in /Users/juan/private/provider diagnostic"); } }),
  });
});
