import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileArtifactStore } from "../src/artifacts.js";
import {
  CONTRACT_VERSIONS,
  asDecisionId,
  asRunId,
  asTaskId,
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
  lastEventId?: string;
}

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
  options: { pollIntervalMs?: number; artifactReader?: (fixture: ApiFixture) => ArtifactReader; core?: (fixture: ApiFixture) => Pick<KerbsFlowCore, "readModel"> } = {},
): Promise<void> {
  const fixture = createFixture();
  const api = new LocalApiServer({
    core: options.core?.(fixture) ?? fixture.core,
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

function sendRequest(api: LocalApiServer, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string | string[]> = {};
  if (options.includeHost !== false) headers.host = options.host ?? `127.0.0.1:${api.port()}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.token !== undefined) headers["X-KerbsFlow-Token"] = options.token;
  if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: api.port(),
      path,
      method: options.method ?? "GET",
      headers,
      setHost: false,
      agent: false,
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
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

function planFor(runId: RunId, suffix: string): PlanningDecision {
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
    route: { adapter: "fake", model: "fake" },
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
    const unsupportedMutation = await sendRequest(api, `/v1/runs/${runId}/cancel`, { ...valid, method: "POST" });
    assert.equal(unsupportedMutation.status, 404);
    assert.equal(fixture.core.readModel(runId)?.run.stateVersion, before);
    assert.equal((await sendRequest(api, path, { ...valid, method: "POST" })).status, 405);
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
