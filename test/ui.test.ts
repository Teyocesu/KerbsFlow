import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createContext, runInContext } from "node:vm";

import { LocalApiServer } from "../src/local-api.js";
import { createFixture } from "./helpers.js";

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(
  api: LocalApiServer,
  path: string,
  host = "127.0.0.1:" + api.port(),
  origin?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: api.port(),
      path,
      method: "GET",
      headers: origin === undefined ? { host } : { host, origin },
      setHost: false,
      agent: false,
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("LocalApiServer serves fixed dashboard assets with the bootstrap and security boundary", async () => {
  const fixture = createFixture();
  const api = new LocalApiServer({
    core: {
      readModel: () => undefined,
      steer: () => { throw new Error("unexpected UI asset test Steer call"); },
      resolveGateScoped: () => { throw new Error("unexpected UI asset test gate call"); },
    },
    coordinator: {
      start: () => { throw new Error("unexpected UI asset test Start call"); },
      pause: async () => { throw new Error("unexpected UI asset test Pause call"); },
      resume: async () => { throw new Error("unexpected UI asset test Resume call"); },
      cancel: async () => { throw new Error("unexpected UI asset test Cancel call"); },
    },
    store: fixture.store,
    artifacts: {
      get(artifactId) {
        const content = fixture.artifacts.get(artifactId);
        if (content === undefined) throw new Error("artifact fixture content is unavailable");
        return content;
      },
    },
  });
  try {
    await api.start();
    const root = await get(api, "/");
    assert.equal(root.status, 200);
    assert.match(root.headers["content-type"] ?? "", /^text\/html; charset=utf-8/u);
    assert.match(root.body, /<meta name="kerbsflow-token" content="[A-Za-z0-9_-]+">/u);
    assert.doesNotMatch(root.body, /__KERBSFLOW_TOKEN__/u);
    assert.match(root.body, /<script type="module" src="\/app\.js"><\/script>/u);
    assert.match(root.body, /<link rel="stylesheet" href="\/styles\.css">/u);
    assert.doesNotMatch(root.body, /<script\b(?![^>]*\bsrc=)[^>]*>/iu);
    assert.equal(root.headers["cache-control"], "no-store");
    assert.equal(root.headers["referrer-policy"], "no-referrer");
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["x-frame-options"], "DENY");
    assert.equal(
      root.headers["content-security-policy"],
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );

    const script = await get(api, "/app.js");
    assert.equal(script.status, 200);
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(script.headers["cache-control"], "no-store");
    assert.equal(script.body, readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8"));
    const exactOriginScript = await get(
      api,
      "/app.js",
      "127.0.0.1:" + api.port(),
      "http://127.0.0.1:" + api.port(),
    );
    assert.equal(exactOriginScript.status, 200);
    const foreignOriginScript = await get(
      api,
      "/app.js",
      "127.0.0.1:" + api.port(),
      "https://foreign.example",
    );
    assert.equal(foreignOriginScript.status, 403);

    const stylesheet = await get(api, "/styles.css");
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(stylesheet.headers["cache-control"], "no-store");
    assert.equal(stylesheet.body, readFileSync(new URL("../../src/ui/styles.css", import.meta.url), "utf8"));

    const unknown = await get(api, "/unknown.js");
    assert.equal(unknown.status, 404);
    const traversal = await get(api, "/%2e%2e/src/persistence.ts");
    assert.ok(traversal.status === 400 || traversal.status === 404);
    assert.match(traversal.headers["content-type"] ?? "", /^application\/json/u);
    assert.doesNotMatch(traversal.body, /CREATE TABLE|MIGRATIONS/u);

    const wrongHost = await get(api, "/app.js", "localhost:" + api.port());
    assert.equal(wrongHost.status, 403);
    assert.equal(wrongHost.headers["x-content-type-options"], "nosniff");
    assert.equal(wrongHost.headers["access-control-allow-origin"], undefined);
  } finally {
    await api.close();
    fixture.close();
  }
});

test("dashboard keeps untrusted text inert and does not persist browser state", () => {
  const html = readFileSync(new URL("../../src/ui/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../src/ui/styles.css", import.meta.url), "utf8");
  const forbiddenSinks = ["innerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"];
  for (const sink of forbiddenSinks) assert.equal(app.includes(sink), false, "forbidden rendering sink: " + sink);
  assert.match(app, /function setText\(element, value\) \{[\s\S]*?element\.textContent = valueText\(value\);/u);
  assert.doesNotMatch(app, /\b(?:localStorage|sessionStorage)\b/u);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(html, /<style\b|style=/iu);
  assert.doesNotMatch(styles, /https?:\/\/|@import\b|@font-face\b/iu);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/u);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/u);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/iu);
});

test("dashboard keeps stale-session, repair-ordering, and notice-survival guards", () => {
  const app = readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8");
  assert.match(
    app,
    /function clearPageStatus\(\) \{[\s\S]*?if \(currentSession\?\.notice !== undefined\) \{[\s\S]*?setPageStatus\(currentSession\.notice\.message, currentSession\.notice\.state\);/u,
    "a stale/conflict notice must survive successful snapshot repair",
  );
  assert.match(app, /repairRefreshRequired = true;/u, "a failed event connection must require snapshot repair");
  assert.match(
    app,
    /async function runEventStream\(session\) \{[\s\S]*?if \(repairRefreshRequired\) \{[\s\S]*?refreshSnapshot\(session\)[\s\S]*?\}[\s\S]*?setConnection\("Connected", "connected"\)/u,
    "reconnect must repair the authoritative snapshot before reporting Connected",
  );
  assert.match(
    app,
    /async function fetchSnapshot\(session\) \{[\s\S]*?if \(!isCurrent\(session\)\) return false;/u,
    "a late snapshot from a superseded session must not render",
  );
  assert.match(
    app,
    /while \(isCurrent\(session\)\) \{[\s\S]*?reader\.read\(\)/u,
    "a superseded session must stop consuming events",
  );
});

function dashboardContext(fetch: (...args: unknown[]) => unknown = () => { throw new Error("unexpected request"); }) {
  class Element {
    constructor(readonly id = "") {}
    textContent = "";
    dataset: Record<string, string> = {};
    hidden = false;
    disabled = false;
    value = "";
    title = "";
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
      this.listeners.set(name, listener);
    }
    querySelectorAll() {
      const formControls: Record<string, string[]> = {
        "start-form": ["start-run-id", "start-objective", "start-run"],
        "run-form": ["run-id"],
        "empty-run-form": ["empty-run-id"],
      };
      return (formControls[this.id] ?? []).map((id) => document.getElementById(id));
    }
    replaceChildren() {}
    setAttribute() {}
    removeAttribute() {}
    focus() {}
  }
  class MetaElement extends Element { content = "test-token"; }
  const nodes = new Map<string, Element>();
  const document = {
    querySelector: () => new MetaElement(),
    querySelectorAll: () => [],
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, new Element(id));
      return nodes.get(id);
    },
  };
  const context = createContext({
    document, HTMLMetaElement: MetaElement, fetch, AbortController, TextEncoder, TextDecoder,
    window: { setTimeout: (callback: () => void) => setTimeout(callback, 0), clearTimeout },
  });
  runInContext(readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8"), context);
  return { context, node: (id: string) => document.getElementById(id)! };
}

test("runtime 401 locks the page through New run and blocks later Start and load requests", async () => {
  let requests = 0;
  const { context, node } = dashboardContext(() => { requests++; throw new Error("unexpected request"); });
  runInContext(`currentSession = {
    runId: "run_existing", controller: new AbortController(), artifactControllers: new Set(),
    hasSnapshot: true, currentState: "EXECUTE", stateVersion: 1, snapshot: {},
  }; showApiFailure(401, currentSession, false);`, context);
  node("new-run").listeners.get("click")!({ preventDefault() {} });
  await runInContext(`loadRun("")`, context);
  await runInContext(`startRun({ preventDefault() {} })`, context);
  await runInContext(`submitRunMutation(currentSession, "pause", {}, "pause")`, context);
  await runInContext(`loadRun("run_other")`, context);
  assert.equal(requests, 0);
  assert.equal(node("connection-status").textContent, "Session invalid");
  assert.match(node("page-status").textContent, /Reload this page/u);
  assert.equal(node("page-status").hidden, false);
  for (const id of ["new-run", "switch-run", "start-run", "pause-control", "resume-control", "steer-submit", "cancel-submit"]) {
    assert.equal(node(id).disabled, true, id + " must stay disabled");
  }
});

test("reconnect warning survives snapshot repair until the stream returns, with mutation notice precedence", async () => {
  for (const notice of [undefined, { message: "Command outcome is unknown.", state: "warning" }]) {
    let eventRequests = 0;
    let snapshotRequests = 0;
    let beginSecondRepair!: () => void;
    const secondRepairStarted = new Promise<void>((resolve) => { beginSecondRepair = resolve; });
    let finishSecondRepair!: (value: unknown) => void;
    const secondRepair = new Promise((resolve) => { finishSecondRepair = resolve; });
    let connected!: () => void;
    const connectedRead = new Promise<void>((resolve) => { connected = resolve; });
    const snapshot = { run: { runId: "run_existing", state: "EXECUTE", stateVersion: 1 }, transitionCursor: 0 };
    const { context, node } = dashboardContext((path: unknown) => {
      if (String(path).endsWith("/events")) {
        eventRequests++;
        if (eventRequests === 1) throw new Error("SSE lost");
        return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: {
          getReader: () => ({ read: () => {
            connected();
            runInContext(`currentSession.controller.abort()`, context);
            return Promise.resolve({ done: true });
          } }),
        } };
      }
      snapshotRequests++;
      if (snapshotRequests === 2) {
        beginSecondRepair();
        return secondRepair;
      }
      if (notice) return { ok: false, status: 503 };
      return { ok: true, json: async () => snapshot };
    });
    runInContext(`renderSnapshot = () => {}; currentSession = {
      runId: "run_existing", controller: new AbortController(), artifactControllers: new Set(),
      hasSnapshot: true, cursor: 0, refreshPending: false, ${notice ? "notice: { message: 'Command outcome is unknown.', state: 'warning' }," : ""}
    };`, context);
    const stream = runInContext(`runEventStream(currentSession)`, context);
    await secondRepairStarted;
    assert.equal(node("connection-status").textContent, "Reconnecting");
    assert.equal(node("connection-status").dataset.state, "reconnecting");
    assert.equal(node("page-status").dataset.state, "warning");
    assert.match(node("page-status").textContent, notice ? /outcome is unknown/u : /may be stale/u);
    finishSecondRepair({ ok: true, json: async () => snapshot });
    await connectedRead;
    assert.equal(node("connection-status").textContent, "Connected");
    assert.equal(node("page-status").hidden, notice === undefined);
    if (notice) assert.match(node("page-status").textContent, /outcome is unknown/u);
    await stream;
    assert.equal(snapshotRequests, 2);
  }
});
