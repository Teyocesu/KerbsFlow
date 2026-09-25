const tokenElement = document.querySelector('meta[name="kerbsflow-token"]');
const apiToken = tokenElement instanceof HTMLMetaElement ? tokenElement.content : "";

const elements = {
  connection: document.getElementById("connection-status"),
  form: document.getElementById("run-form"),
  runInput: document.getElementById("run-id"),
  pageStatus: document.getElementById("page-status"),
  runSummary: document.getElementById("run-summary"),
  runId: document.getElementById("snapshot-run-id"),
  runState: document.getElementById("snapshot-state"),
  runVersion: document.getElementById("snapshot-state-version"),
  dashboard: document.getElementById("dashboard-grid"),
  currentWork: document.getElementById("current-work-content"),
  validation: document.getElementById("validation-content"),
  humanGate: document.getElementById("human-gate-content"),
  positiveScope: document.getElementById("positive-scope"),
  negativeScope: document.getElementById("negative-scope"),
  artifacts: document.getElementById("artifact-list"),
  activity: document.getElementById("activity-list"),
};

let currentSession;

function isCurrent(session) {
  return currentSession === session && !session.controller.signal.aborted;
}

function valueText(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "—";
}

function setText(element, value) {
  element.textContent = valueText(value);
}

function setConnection(message, state) {
  setText(elements.connection, message);
  elements.connection.dataset.state = state;
}

function setPageStatus(message, state) {
  setText(elements.pageStatus, message);
  elements.pageStatus.dataset.state = state;
  elements.pageStatus.hidden = false;
}

function clearPageStatus() {
  elements.pageStatus.hidden = true;
  elements.pageStatus.dataset.state = "";
  setText(elements.pageStatus, "");
}

function makeText(tagName, value, className) {
  const element = document.createElement(tagName);
  if (className !== undefined) element.className = className;
  setText(element, value);
  return element;
}

function addDetail(list, label, value, identifier) {
  const group = document.createElement("div");
  const term = makeText("dt", label);
  const description = makeText("dd", value, identifier ? "identifier" : undefined);
  group.append(term, description);
  list.append(group);
}

function addEmpty(list, message, tagName) {
  const row = makeText(tagName, message, "empty-state");
  list.append(row);
}

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function renderCurrentWork(snapshot) {
  const task = asObject(snapshot.currentTask);
  const action = asObject(task.action);
  const route = asObject(task.route);
  const attempt = asObject(snapshot.activeAttempt);
  elements.currentWork.replaceChildren();
  addDetail(elements.currentWork, "Task summary", action.summary);
  addDetail(elements.currentWork, "Task status", task.status);
  addDetail(elements.currentWork, "Adapter", attempt.adapter ?? route.adapter);
  addDetail(elements.currentWork, "Model", attempt.model ?? route.model);
  addDetail(elements.currentWork, "Active attempt", attempt.attemptId, true);
  addDetail(elements.currentWork, "Attempt lifecycle", attempt.lifecycle);
}

function renderEvidence(snapshot) {
  elements.validation.replaceChildren();
  const validation = snapshot.latestValidation;
  if (validation === null || validation === undefined) {
    const block = document.createElement("section");
    block.className = "evidence-block";
    block.append(makeText("h3", "Latest validation"));
    block.append(makeText("p", "No validation recorded.", "empty-state"));
    elements.validation.append(block);
  } else {
    const item = asObject(validation);
    const block = document.createElement("section");
    block.className = "evidence-block";
    block.append(makeText("h3", "Latest validation"));
    block.append(makeText("p", "Level: " + valueText(item.level) + " · Outcome: " + valueText(item.outcome)));
    block.append(makeText("p", item.summary));
    elements.validation.append(block);
  }

  const review = snapshot.latestReview;
  if (review === null || review === undefined) {
    const block = document.createElement("section");
    block.className = "evidence-block";
    block.append(makeText("h3", "Latest review"));
    block.append(makeText("p", "No review recorded.", "empty-state"));
    elements.validation.append(block);
  } else {
    const item = asObject(review);
    const block = document.createElement("section");
    block.className = "evidence-block";
    block.append(makeText("h3", "Latest review"));
    block.append(makeText("p", "Outcome: " + valueText(item.outcome)));
    block.append(makeText("p", item.summary));
    elements.validation.append(block);
  }
}

function renderHumanGate(snapshot) {
  elements.humanGate.replaceChildren();
  const gate = snapshot.currentGate;
  if (gate === null || gate === undefined) {
    addEmpty(elements.humanGate, "No human gate is open.", "p");
    return;
  }

  const item = asObject(gate);
  const summary = document.createElement("section");
  summary.className = "gate-summary";
  summary.append(makeText("h3", item.reasonCode));
  summary.append(makeText("p", item.summary));
  summary.append(makeText("p", "Status: " + valueText(item.status)));
  elements.humanGate.append(summary);

  const options = asArray(item.options);
  if (options.length === 0) {
    addEmpty(elements.humanGate, "No options are recorded.", "p");
    return;
  }
  for (const optionValue of options) {
    const option = asObject(optionValue);
    const row = document.createElement("div");
    row.className = "gate-option";
    row.append(makeText("strong", option.label));
    row.append(makeText("p", option.consequence));
    row.append(makeText("p", "Target: " + valueText(option.target)));
    elements.humanGate.append(row);
  }
}

function renderScope(snapshot) {
  const action = asObject(asObject(snapshot.currentTask).action);
  renderTextList(elements.positiveScope, action.positiveScope, "No positive scope recorded.");
  renderTextList(elements.negativeScope, action.negativeScope, "No negative scope recorded.");
}

function renderTextList(list, values, emptyMessage) {
  list.replaceChildren();
  const strings = asArray(values).filter((value) => typeof value === "string");
  if (strings.length === 0) {
    addEmpty(list, emptyMessage, "li");
    return;
  }
  for (const value of strings) list.append(makeText("li", value));
}

function safeFilePart(value) {
  const part = valueText(value).replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 100);
  return part === "" || part === "—" ? "artifact" : part;
}

async function downloadArtifact(session, artifactValue) {
  const artifact = asObject(artifactValue);
  const artifactId = valueText(artifact.artifactId);
  if (artifactId === "—" || !isCurrent(session)) return;

  const controller = new AbortController();
  session.artifactControllers.add(controller);
  try {
    const path = "/v1/runs/" + encodeURIComponent(session.runId)
      + "/artifacts/" + encodeURIComponent(artifactId);
    const response = await fetch(path, {
      headers: { "X-KerbsFlow-Token": apiToken },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) setPageStatus("This artifact is unavailable for the selected run.", "error");
      else showApiFailure(response.status, session, true);
      return;
    }

    const file = await response.blob();
    if (!isCurrent(session)) return;
    const objectUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = safeFilePart(artifact.artifactId) + "-" + safeFilePart(artifact.kind) + ".bin";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    if (isCurrent(session) && !controller.signal.aborted) {
      setPageStatus("The artifact could not be downloaded from the local API.", "error");
    }
  } finally {
    session.artifactControllers.delete(controller);
  }
}

function renderArtifacts(snapshot, session) {
  elements.artifacts.replaceChildren();
  const artifacts = asArray(snapshot.artifacts);
  if (artifacts.length === 0) {
    addEmpty(elements.artifacts, "No artifacts recorded.", "li");
    return;
  }

  for (const artifactValue of artifacts) {
    const artifact = asObject(artifactValue);
    const row = document.createElement("li");
    row.className = "artifact-item";
    const metadata = document.createElement("div");
    metadata.className = "artifact-meta";
    metadata.append(makeText("strong", artifact.artifactId, "identifier"));
    metadata.append(makeText(
      "span",
      valueText(artifact.kind) + " · " + valueText(artifact.sizeBytes) + " bytes · "
        + valueText(artifact.redactionState) + " · " + valueText(artifact.createdAt),
    ));
    const link = document.createElement("a");
    link.className = "artifact-download";
    link.href = "/v1/runs/" + encodeURIComponent(session.runId)
      + "/artifacts/" + encodeURIComponent(valueText(artifact.artifactId));
    link.textContent = "Download";
    link.setAttribute("aria-label", "Download artifact " + valueText(artifact.artifactId));
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void downloadArtifact(session, artifact);
    });
    row.append(metadata, link);
    elements.artifacts.append(row);
  }
}

function renderActivity(snapshot) {
  elements.activity.replaceChildren();
  const transitions = asArray(snapshot.recentTransitions)
    .map(asObject)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (transitions.length === 0) {
    addEmpty(elements.activity, "No transitions recorded.", "li");
    return;
  }

  for (const transition of transitions) {
    const row = document.createElement("li");
    row.className = "activity-item";
    row.append(makeText(
      "p",
      valueText(transition.from) + " → " + valueText(transition.to),
      "activity-transition",
    ));
    row.append(makeText("p", "Reason: " + valueText(transition.reasonCode)));
    row.append(makeText("p", "Actor: " + valueText(transition.actor)));
    row.append(makeText("p", "State version: " + valueText(transition.stateVersionAfter)));
    row.append(makeText("p", "Created: " + valueText(transition.createdAt)));
    elements.activity.append(row);
  }
}

function renderSnapshot(snapshot, session) {
  const run = asObject(snapshot.run);
  setText(elements.runId, session.runId);
  setText(elements.runState, run.state);
  setText(elements.runVersion, run.stateVersion);
  renderCurrentWork(snapshot);
  renderEvidence(snapshot);
  renderHumanGate(snapshot);
  renderScope(snapshot);
  renderArtifacts(snapshot, session);
  renderActivity(snapshot);
  elements.runSummary.hidden = false;
  elements.dashboard.hidden = false;
  elements.dashboard.setAttribute("aria-busy", "false");
}

function showApiFailure(status, session, keepConnection) {
  if (status === 401) {
    session.sessionInvalid = true;
    setConnection("Session invalid", "error");
    setPageStatus("The local session is invalid. Reload this page to start a new session.", "error");
    return;
  }
  if (status === 404) {
    session.runUnavailable = true;
    if (!keepConnection) setConnection("Run not found", "error");
    setPageStatus("Run not found. Check the run ID and load it again.", "error");
    return;
  }
  if (!keepConnection) setConnection("API error", "error");
  setPageStatus("The local API returned an error (HTTP " + status + ").", "error");
}

async function fetchSnapshot(session) {
  if (!isCurrent(session)) return false;
  const controller = new AbortController();
  session.snapshotController = controller;
  try {
    const path = "/v1/runs/" + encodeURIComponent(session.runId) + "/snapshot";
    const response = await fetch(path, {
      headers: { "X-KerbsFlow-Token": apiToken },
      signal: controller.signal,
    });
    if (!isCurrent(session)) return false;
    if (!response.ok) {
      showApiFailure(response.status, session, session.hasSnapshot);
      return false;
    }

    const snapshot = asObject(await response.json());
    if (!isCurrent(session)) return false;
    const run = asObject(snapshot.run);
    if (run.runId !== session.runId || typeof run.state !== "string"
      || !Number.isSafeInteger(run.stateVersion) || !Number.isSafeInteger(snapshot.transitionCursor)) {
      throw new Error("snapshot response is invalid");
    }
    const cursor = asObject(snapshot).transitionCursor;
    if (Number.isSafeInteger(cursor) && cursor >= session.cursor) session.cursor = cursor;
    renderSnapshot(asObject(snapshot), session);
    session.hasSnapshot = true;
    clearPageStatus();
    return true;
  } catch {
    if (isCurrent(session) && !controller.signal.aborted) {
      if (!session.hasSnapshot) setConnection("Disconnected", "error");
      setPageStatus("The local API is unavailable or returned an invalid snapshot.", "error");
    }
    return false;
  } finally {
    if (session.snapshotController === controller) session.snapshotController = undefined;
  }
}

async function refreshSnapshot(session) {
  if (!isCurrent(session)) return false;
  if (session.refreshFlight !== undefined) {
    session.refreshPending = true;
    return session.refreshFlight;
  }

  const flight = (async () => {
    let success = false;
    do {
      session.refreshPending = false;
      success = await fetchSnapshot(session);
    } while (session.refreshPending && isCurrent(session));
    return success;
  })();
  session.refreshFlight = flight;
  try {
    return await flight;
  } finally {
    if (session.refreshFlight === flight) session.refreshFlight = undefined;
  }
}

function scheduleSnapshotRefresh(session, immediate) {
  if (!isCurrent(session)) return;
  if (session.refreshTimer !== undefined) {
    if (!immediate) return;
    window.clearTimeout(session.refreshTimer);
  }
  session.refreshTimer = window.setTimeout(() => {
    session.refreshTimer = undefined;
    void refreshSnapshot(session);
  }, immediate ? 0 : 80);
}

function dispatchStateFrame(frame, session) {
  let eventName = "";
  let eventId;
  for (const line of frame.split(/\r\n|\r|\n/u)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") eventName = value;
    if (field === "id" && !value.includes("\0")) eventId = value;
  }
  if (eventName !== "state" || eventId === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(eventId)) return;
  const sequence = Number(eventId);
  if (!Number.isSafeInteger(sequence) || sequence <= session.cursor) return;
  const hasGap = sequence > session.cursor + 1;
  session.cursor = sequence;
  scheduleSnapshotRefresh(session, hasGap);
}

async function consumeEvents(response, session) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const boundary = /\r\n\r\n|\n\n|\r\r/u;
  while (isCurrent(session)) {
    const result = await reader.read();
    buffer += decoder.decode(result.value, { stream: !result.done });
    let match = boundary.exec(buffer);
    while (match !== null) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      dispatchStateFrame(frame, session);
      match = boundary.exec(buffer);
    }
    if (result.done) return;
  }
}

function waitForReconnect(session, milliseconds) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      session.controller.signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    session.controller.signal.addEventListener("abort", finish, { once: true });
  });
}

function eventPath(session) {
  return "/v1/runs/" + encodeURIComponent(session.runId) + "/events";
}

async function runEventStream(session) {
  let failedConnections = 0;
  while (isCurrent(session) && !session.sessionInvalid && !session.runUnavailable) {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    session.controller.signal.addEventListener("abort", abortAttempt, { once: true });
    let connectedAt;
    try {
      const response = await fetch(eventPath(session), {
        headers: {
          Accept: "text/event-stream",
          "X-KerbsFlow-Token": apiToken,
          "Last-Event-ID": String(session.cursor),
        },
        signal: attempt.signal,
      });
      if (!isCurrent(session)) return;
      if (response.status === 401 || response.status === 404) {
        showApiFailure(response.status, session, false);
        return;
      }
      if (!response.ok || response.body === null
        || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("event stream unavailable");
      }

      if (failedConnections > 0) {
        const refreshed = await refreshSnapshot(session);
        if (!isCurrent(session) || session.sessionInvalid || session.runUnavailable) return;
        if (!refreshed) throw new Error("snapshot refresh failed");
      }
      connectedAt = Date.now();
      setConnection("Connected", "connected");
      clearPageStatus();
      await consumeEvents(response, session);
      if (!isCurrent(session)) return;
      throw new Error("event stream ended");
    } catch {
      if (!isCurrent(session) || session.sessionInvalid || session.runUnavailable) return;
      if (connectedAt !== undefined && Date.now() - connectedAt >= 30_000) failedConnections = 0;
      setConnection("Disconnected · reconnecting", "reconnecting");
      setPageStatus("The event connection was lost. Reconnecting and refreshing the snapshot.", "error");
      await refreshSnapshot(session);
      if (!isCurrent(session) || session.sessionInvalid || session.runUnavailable) return;
      const delay = Math.min(500 * (2 ** failedConnections), 5000);
      failedConnections += 1;
      await waitForReconnect(session, delay);
    } finally {
      session.controller.signal.removeEventListener("abort", abortAttempt);
      attempt.abort();
    }
  }
}

function stopSession() {
  const previous = currentSession;
  currentSession = undefined;
  if (previous === undefined) return;
  previous.controller.abort();
  previous.snapshotController?.abort();
  for (const controller of previous.artifactControllers) controller.abort();
  if (previous.refreshTimer !== undefined) window.clearTimeout(previous.refreshTimer);
}

function resetDashboard() {
  elements.runSummary.hidden = true;
  elements.dashboard.hidden = true;
  elements.dashboard.setAttribute("aria-busy", "false");
  setText(elements.runId, "—");
  setText(elements.runState, "—");
  setText(elements.runVersion, "—");
  elements.currentWork.replaceChildren();
  elements.validation.replaceChildren();
  elements.humanGate.replaceChildren();
  elements.positiveScope.replaceChildren();
  elements.negativeScope.replaceChildren();
  elements.artifacts.replaceChildren();
  elements.activity.replaceChildren();
}

async function loadRun(runId) {
  stopSession();
  resetDashboard();
  elements.runInput.value = runId;

  if (runId === "") {
    setConnection("Not connected", "idle");
    setPageStatus("Enter a run ID to view its read-only snapshot.", "");
    return;
  }

  const session = {
    runId,
    cursor: 0,
    controller: new AbortController(),
    artifactControllers: new Set(),
    hasSnapshot: false,
    refreshPending: false,
  };
  currentSession = session;
  elements.dashboard.setAttribute("aria-busy", "true");
  setText(elements.runId, runId);
  setConnection("Loading snapshot", "loading");
  setPageStatus("Loading the authoritative run snapshot.", "");

  const loaded = await refreshSnapshot(session);
  if (!isCurrent(session) || !loaded || session.sessionInvalid || session.runUnavailable) return;
  setConnection("Connecting to activity", "loading");
  await runEventStream(session);
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadRun(elements.runInput.value.trim());
});

if (apiToken === "") {
  setConnection("Session invalid", "error");
  setPageStatus("The local session token is unavailable. Reload this page.", "error");
} else {
  setConnection("Not connected", "idle");
  setPageStatus("Enter a run ID to view its read-only snapshot.", "");
}
