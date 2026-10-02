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
      configuration: fixture.core.configuration,
    },
    coordinator: {
      start: () => { throw new Error("unexpected UI asset test Start call"); },
      pause: async () => { throw new Error("unexpected UI asset test Pause call"); },
      resume: async () => { throw new Error("unexpected UI asset test Resume call"); },
      cancel: async () => { throw new Error("unexpected UI asset test Cancel call"); },
      resolveGate: async () => { throw new Error("unexpected UI asset test gate call"); },
      getActionableGateOptionIds: () => [],
      getControlAvailability: () => ({ pause: false, resume: false }),
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

function dashboardContext(fetch: (...args: unknown[]) => unknown = () => { throw new Error("unexpected request"); }, initialHash = "") {
  class Element {
    constructor(readonly id = "", readonly tagName = "element") {}
    private ownText = "";
    children: Element[] = [];
    get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.ownText = value; this.children = []; }
    dataset: Record<string, string> = {};
    hidden = false;
    disabled = false;
    value = "";
    title = "";
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
      this.listeners.set(name, listener);
    }
    append(...children: Element[]) { this.children.push(...children); }
    querySelectorAll() {
      const formControls: Record<string, string[]> = {
        "start-form": ["start-run-id", "start-objective", "start-run"],
        "run-form": ["run-id"],
        "empty-run-form": ["empty-run-id"],
      };
      return (formControls[this.id] ?? []).map((id) => document.getElementById(id));
    }
    replaceChildren(...children: Element[]) { this.ownText = ""; this.children = [...children]; }
    setAttribute() {}
    removeAttribute() {}
    focus() {}
  }
  class MetaElement extends Element { content = "test-token"; }
  const nodes = new Map<string, Element>();
  const createdTags: string[] = [];
  const document = {
    querySelector: () => new MetaElement(),
    querySelectorAll: () => [],
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, new Element(id));
      return nodes.get(id);
    },
    createElement(tagName: string) { createdTags.push(tagName); return new Element("", tagName); },
    createTextNode(value: string) { const node = new Element("", "#text"); node.textContent = value; return node; },
  };
  const location = { hash: initialHash, pathname: "/", search: "" };
  const context = createContext({
    document, HTMLMetaElement: MetaElement, fetch, AbortController, TextEncoder, TextDecoder,
    URLSearchParams,
    window: { location, history: { replaceState(_state: unknown, _title: string, url: string) { location.hash = url.startsWith("#") ? url : ""; } }, setTimeout: (callback: () => void) => setTimeout(callback, 0), clearTimeout },
  });
  runInContext(readFileSync(new URL("../../src/ui/app.js", import.meta.url), "utf8"), context);
  return { context, node: (id: string) => document.getElementById(id)!, createdTags, location };
}

test("dashboard reload restores only the selected run through a snapshot read, never a mutation", async () => {
  const requests: string[] = [];
  const { node } = dashboardContext(async (path) => {
    requests.push(String(path));
    return { status: 401 };
  }, "#run=run_reload");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ["/v1/runs/run_reload/snapshot"]);
  assert.equal(node("run-id").value, "run_reload");
  assert.equal(node("connection-status").textContent, "Session invalid");

  for (const runId of ["run_selected", "run_" + "a".repeat(116)]) {
    for (const entry of ["load", "open", "switch"]) {
      const openRequests: string[] = [];
      const selection = dashboardContext((path) => { openRequests.push(String(path)); return new Promise(() => {}); });
      if (entry === "load") void runInContext(`loadRun(${JSON.stringify(runId)})`, selection.context);
      else {
        selection.node(entry === "open" ? "empty-run-id" : "run-id").value = runId;
        selection.node(entry === "open" ? "empty-run-form" : "run-form").listeners.get("submit")!({ preventDefault() {} });
      }
      assert.equal(selection.location.hash, "#run=" + runId);
      assert.deepEqual(openRequests, ["/v1/runs/" + runId + "/snapshot"]);
      await runInContext('loadRun("")', selection.context);
      assert.equal(selection.location.hash, "");
    }
  }
});

test("invalid run selections never change the URL or current selection and never send requests", async () => {
  const maximumId = "run_" + "a".repeat(116);
  const invalidIds = ["/private/pqa/example", "../private", "run with spaces", "<img src=x>", "task_wrong", "run_", "run_" + "a".repeat(117), " run_selected ", "run_selected ", " run_selected", " ", "   ", " " + maximumId, maximumId + " "];
  const validationMessages = new Set<string>();
  for (const runId of invalidIds) {
    for (const selectedId of ["", "run_selected"]) {
      for (const entry of ["load", "open", "switch", "start"]) {
        const requests: string[] = [];
        const page = dashboardContext((path) => { requests.push(String(path)); return new Promise(() => {}); });
        let generatedIds = 0;
        page.context.crypto = { getRandomValues: (bytes: Uint8Array) => { generatedIds += 1; return bytes.fill(1); } };
        if (selectedId !== "") void runInContext(`loadRun(${JSON.stringify(selectedId)})`, page.context);
        requests.length = 0;
        const previousSession = runInContext("currentSession", page.context);
        if (entry === "load") void runInContext(`loadRun(${JSON.stringify(runId)})`, page.context);
        else if (entry === "start") {
          page.node("start-objective").value = "Synthetic objective";
          page.node("start-run-id").value = runId;
          void runInContext("startRun({ preventDefault() {} })", page.context);
        } else {
          const field = entry === "open" ? "empty-run-id" : "run-id";
          const form = entry === "open" ? "empty-run-form" : "run-form";
          page.node(field).value = runId;
          page.node(form).listeners.get("submit")!({ preventDefault() {} });
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(requests, [], entry + " must reject " + runId);
        assert.equal(page.location.hash, selectedId === "" ? "" : "#run=" + selectedId);
        assert.equal(runInContext("currentSession", page.context), previousSession);
        if (previousSession !== undefined) assert.equal(previousSession.controller.signal.aborted, false);
        assert.equal(generatedIds, 0, "invalid explicit input must not generate an ID");
        if (entry !== "load") assert.equal(page.node(entry === "start" ? "start-run-id" : entry === "open" ? "empty-run-id" : "run-id").value, runId, "exact input must be preserved");
        assert.match(page.node("page-status").textContent, /valid run ID/u);
        assert.equal(page.node("page-status").dataset.state, "error");
        validationMessages.add(page.node("page-status").textContent);
        assert.ok(page.node("page-status").textContent.length <= 180);
      }
    }
  }
  assert.equal(validationMessages.size, 1, "feedback is fixed text independent of invalid input");
});

test("bootstrap clears invalid remembered selections and restores only a bounded valid run ID", async () => {
  for (const hash of ["#run=%2Fprivate%2Fpqa%2Fexample", "#run=run_" + "a".repeat(117), "#arbitrary=private", "#run="]) {
    const requests: string[] = [];
    const page = dashboardContext((path) => { requests.push(String(path)); return new Promise(() => {}); }, hash);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, []);
    assert.equal(page.location.hash, "");
    assert.equal(runInContext("currentSession", page.context), undefined);
    assert.match(page.node("page-status").textContent, /valid run ID/u);
  }
  const runId = "run_" + "a".repeat(116);
  const requests: string[] = [];
  const page = dashboardContext((path) => { requests.push(String(path)); return new Promise(() => {}); }, "#run=" + runId + "&extra=private");
  assert.deepEqual(requests, ["/v1/runs/" + runId + "/snapshot"]);
  assert.equal(page.location.hash, "#run=" + runId, "only the valid selection is retained");
});

test("valid explicit and generated Start IDs remain remembered even on a rejected response, without retry", async () => {
  for (const explicitId of ["run_selected", "run_" + "a".repeat(116), ""]) {
    const requests: Array<{ path: string; runId: string }> = [];
    const page = dashboardContext(async (path, options) => {
      const body = JSON.parse((options as { body: string }).body);
      requests.push({ path: String(path), runId: body.payload.runId });
      return { status: 400, ok: false, json: async () => ({ error: { code: "INVALID_REQUEST" } }) };
    });
    page.context.crypto = { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) };
    page.node("start-run-id").value = explicitId;
    page.node("start-objective").value = "Synthetic objective";
    await runInContext("startRun({ preventDefault() {} })", page.context);
    const expectedId = explicitId || "run_" + "01".repeat(16);
    assert.deepEqual(requests, [{ path: "/v1/runs", runId: expectedId }]);
    assert.equal(page.location.hash, "#run=" + expectedId);
    assert.equal(runInContext("currentSession", page.context), undefined, "rejected Start does not invent a current run");
  }
});

test("pending Pause and Cancel explain the wait without projecting a terminal state or sending twice", () => {
  for (const kind of ["pause", "cancel"]) {
    let requests = 0;
    const { context, node } = dashboardContext(() => { requests++; return new Promise(() => {}); });
    context.crypto = { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) };
    runInContext(`currentSession = {
      runId: "run_pending", controller: new AbortController(), artifactControllers: new Set(),
      hasSnapshot: true, currentState: "EXECUTE", stateVersion: 5, snapshot: {},
    };`, context);
    void runInContext(`submitRunMutation(currentSession, "${kind}", {}, "${kind}")`, context);
    void runInContext(`submitRunMutation(currentSession, "${kind}", {}, "${kind}")`, context);
    assert.match(node("page-status").textContent, /not yet confirmed/u);
    assert.equal(runInContext("currentSession.currentState", context), "EXECUTE");
    assert.equal(requests, 1);
    assert.equal(node("pause-control").disabled, true);
  }
});

test("Pause and Resume require projected live coordinator authority, including after restart", () => {
  const { context, node } = dashboardContext();
  for (const state of ["EXECUTE", "HUMAN_GATE", "NEXT_PHASE", "PAUSED"]) {
    runInContext(`updateMutationControls({ currentState: "${state}", snapshot: { controls: { pause: false, resume: false } } })`, context);
    assert.equal(node("pause-control").disabled, true);
    assert.equal(node("resume-control").disabled, true);
  }
  runInContext('updateMutationControls({ currentState: "EXECUTE", snapshot: { controls: { pause: true, resume: false } } })', context);
  assert.equal(node("pause-control").disabled, false);
  runInContext('updateMutationControls({ currentState: "PAUSED", snapshot: { controls: { pause: false, resume: true } } })', context);
  assert.equal(node("resume-control").disabled, false);
});

test("dashboard renders added supervision facts as inert text in the existing Overview regions", () => {
  const { context, node, createdTags } = dashboardContext();
  const acceptance = "Keep this literal <img src=x onerror=alert(1)>";
  const snapshot = {
    run: {
      runId: "run_render", state: "RECOVERY", phase: "recovery", phaseSource: "run_state", stateVersion: 4,
      recoveryRequired: true, recoveryReason: "synthetic reconciliation required",
      pauseContract: { originState: "EXECUTE", durableBoundary: "uncertain_activity", resumeTarget: "RECOVERY" },
    },
    project: { status: "available", name: "kerbsflow" },
    currentTask: { action: { kind: "implementation", summary: "Render safely", acceptance: [acceptance], validationLevel: "focused", positiveScope: [], negativeScope: [] }, route: {} },
    activeAttempt: null,
    supervision: {
      canonical: { status: "captured", capturedAt: "2026-09-25T12:00:00.000Z", specCaptured: true },
      scopeCheck: { name: "Git base and scope", status: "not_checked", evidenceClass: null },
      invariants: { enforcedPolicy: { legalTransitions: true, singleActiveExecutor: true, independentEvidence: true, secretsAbsentFromPersistence: true, highImpactHumanGates: true, automaticReleaseActions: true, ambiguousReplay: true, executorCannotVerify: true, maxImplementationAttempts: 3 }, effectiveMaxImplementationAttempts: 3, interpretation: "enforced policy; not a run-wide validation pass", observedChecks: {} },
      retryEscalation: { taskStatus: "available", policyDecisionCounts: { retry_same_route: 1, rework: 0, escalate: 0 }, recordedAttempts: 1, latestDecision: null },
    },
    currentGate: null, pendingSteer: null, latestValidation: null, latestReview: null,
    recentTransitions: [], artifacts: [], transitionCursor: 0,
  };
  runInContext(`renderSnapshot(snapshotForRender, sessionForRender)`, Object.assign(context, {
    snapshotForRender: snapshot,
    sessionForRender: { runId: "run_render", currentState: "RECOVERY", stateVersion: 4, currentGateId: undefined, currentGateStatus: undefined, snapshot, hasSnapshot: true, mutationInFlight: false, controller: new AbortController(), artifactControllers: new Set() },
  }));
  assert.match(node("current-work-content").textContent, /Required validationFocused/u);
  assert.ok(node("current-work-content").textContent.includes(acceptance));
  assert.match(node("execution-context").textContent, /Captured; current files not checked/u);
  assert.match(node("execution-context").textContent, /Pause originEXECUTE/u);
  assert.match(node("execution-context").textContent, /Recovery requiredYes/u);
  assert.match(node("execution-context").textContent, /Recovery reasonsynthetic reconciliation required/u);
  assert.match(node("execution-context").textContent, /persisted run state/u);
  assert.equal(createdTags.includes("img"), false, "untrusted acceptance remains text, not a created element");
});

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
