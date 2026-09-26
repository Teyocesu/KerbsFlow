const tokenElement = document.querySelector('meta[name="kerbsflow-token"]');
const apiToken = tokenElement instanceof HTMLMetaElement ? tokenElement.content : "";

const elements = {
  connection: document.getElementById("connection-status"),
  mobileConnection: document.getElementById("mobile-connection-status"),
  form: document.getElementById("run-form"),
  runInput: document.getElementById("run-id"),
  emptyForm: document.getElementById("empty-run-form"),
  emptyRunInput: document.getElementById("empty-run-id"),
  emptyView: document.getElementById("empty-view"),
  runContent: document.getElementById("run-content"),
  pageStatus: document.getElementById("page-status"),
  runId: document.getElementById("snapshot-run-id"),
  runState: document.getElementById("snapshot-state"),
  runMeta: document.getElementById("snapshot-run-meta"),
  runTaskPreview: document.getElementById("snapshot-task-preview"),
  sidebarRunId: document.getElementById("sidebar-run-id"),
  sidebarRunState: document.getElementById("sidebar-run-state"),
  sidebarRunVersion: document.getElementById("sidebar-run-version"),
  statePath: document.getElementById("state-path"),
  dashboard: document.getElementById("dashboard-grid"),
  currentWork: document.getElementById("current-work-content"),
  validation: document.getElementById("validation-content"),
  gateSection: document.getElementById("human-gate"),
  humanGate: document.getElementById("human-gate-content"),
  positiveScope: document.getElementById("positive-scope"),
  negativeScope: document.getElementById("negative-scope"),
  artifactHead: document.getElementById("artifact-head"),
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
  for (const element of [elements.connection, elements.mobileConnection]) {
    setText(element, message);
    element.dataset.state = state;
  }
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

function displayLabel(value) {
  const text = valueText(value).replaceAll(/[_-]/gu, " ").toLowerCase();
  return text === "—" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function makeTime(value) {
  const raw = valueText(value);
  const time = document.createElement("time");
  const date = new Date(raw);
  setText(time, Number.isNaN(date.getTime()) ? raw : dateFormatter.format(date));
  time.title = raw;
  if (!Number.isNaN(date.getTime())) time.dateTime = raw;
  return time;
}

function renderCurrentWork(snapshot) {
  const task = asObject(snapshot.currentTask);
  const action = asObject(task.action);
  const route = asObject(task.route);
  const attempt = asObject(snapshot.activeAttempt);
  elements.currentWork.replaceChildren();
  const lead = document.createElement("div");
  lead.className = "task-lead";
  lead.append(makeText("p", action.summary ?? "No task recorded", "task-description"));
  if (task.status !== undefined) lead.append(makeText("span", displayLabel(task.status), "task-status"));
  const metadata = document.createElement("dl");
  metadata.className = "task-metadata";
  addDetail(metadata, "Adapter", attempt.adapter ?? route.adapter);
  addDetail(metadata, "Model", attempt.model ?? route.model);
  addDetail(metadata, "Attempt", attempt.attemptId, true);
  addDetail(metadata, "Lifecycle", attempt.lifecycle === undefined ? undefined : displayLabel(attempt.lifecycle));
  elements.currentWork.append(lead, metadata);
}

function renderEvidence(snapshot) {
  elements.validation.replaceChildren();
  for (const [label, value, empty] of [
    ["Validation", snapshot.latestValidation, "No validation recorded"],
    ["Review", snapshot.latestReview, "No review recorded"],
  ]) {
    const row = document.createElement("div");
    row.className = "evidence-row";
    row.append(makeText("h3", label));
    if (value === null || value === undefined) {
      row.append(makeText("p", empty, "empty-state"));
    } else {
      const item = asObject(value);
      const result = document.createElement("div");
      result.className = "evidence-result";
      const badge = makeText("span", displayLabel(item.outcome), "outcome-badge");
      badge.dataset.outcome = valueText(item.outcome);
      result.append(badge);
      if (label === "Validation") result.append(makeText("span", displayLabel(item.level), "evidence-level"));
      row.append(result, makeText("p", item.summary, "evidence-summary"));
    }
    elements.validation.append(row);
  }
}

function renderHumanGate(snapshot) {
  elements.humanGate.replaceChildren();
  const gate = snapshot.currentGate;
  if (gate === null || gate === undefined) {
    elements.gateSection.dataset.open = "false";
    addEmpty(elements.humanGate, "No decision required", "p");
    return;
  }

  elements.gateSection.dataset.open = "true";
  const item = asObject(gate);
  const summary = document.createElement("div");
  summary.className = "gate-summary";
  const heading = document.createElement("div");
  heading.className = "gate-heading";
  heading.append(makeText("h3", displayLabel(item.reasonCode)));
  heading.append(makeText("span", displayLabel(item.status), "gate-status"));
  summary.append(heading);
  summary.append(makeText("code", item.reasonCode, "gate-reason identifier"));
  summary.append(makeText("p", item.summary, "gate-description"));
  elements.humanGate.append(summary);

  const options = asArray(item.options);
  if (options.length === 0) {
    addEmpty(elements.humanGate, "No options are recorded.", "p");
    return;
  }
  const optionList = document.createElement("ul");
  optionList.className = "gate-options";
  for (const optionValue of options) {
    const option = asObject(optionValue);
    const row = document.createElement("li");
    row.className = "gate-option";
    row.append(makeText("strong", option.label));
    row.append(makeText("p", option.consequence));
    row.append(makeText("span", "Target: " + valueText(option.target), "gate-target identifier"));
    optionList.append(row);
  }
  elements.humanGate.append(optionList);
}

function renderScope(snapshot) {
  const action = asObject(asObject(snapshot.currentTask).action);
  renderTextList(elements.positiveScope, action.positiveScope, "No scope recorded");
  renderTextList(elements.negativeScope, action.negativeScope, "No exclusions recorded");
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
  elements.artifactHead.hidden = artifacts.length === 0;
  if (artifacts.length === 0) {
    addEmpty(elements.artifacts, "No persisted artifacts", "li");
    return;
  }

  for (const artifactValue of artifacts) {
    const artifact = asObject(artifactValue);
    const row = document.createElement("li");
    row.className = "artifact-item";
    addArtifactField(row, "Artifact ID", makeText("code", artifact.artifactId, "identifier"));
    addArtifactField(row, "Kind", makeText("span", displayLabel(artifact.kind)));
    addArtifactField(row, "Size", makeText("span", valueText(artifact.sizeBytes) + " B"));
    addArtifactField(row, "Redaction", makeText("span", displayLabel(artifact.redactionState)));
    addArtifactField(row, "Created", makeTime(artifact.createdAt));
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
    addArtifactField(row, "Download", link);
    elements.artifacts.append(row);
  }
}

function addArtifactField(row, label, value) {
  const field = document.createElement("div");
  field.className = "artifact-field";
  field.append(makeText("span", label, "artifact-field-label"), value);
  row.append(field);
}

function sortedTransitions(snapshot) {
  return asArray(snapshot.recentTransitions)
    .map(asObject)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function renderStatePath(snapshot, currentState) {
  elements.statePath.replaceChildren();
  const states = [];
  const appendState = (state) => {
    if (typeof state === "string" && state !== "" && states.at(-1) !== state) states.push(state);
  };
  for (const transition of sortedTransitions(snapshot)) {
    appendState(transition.from);
    appendState(transition.to);
  }
  appendState(currentState);
  for (const [index, state] of states.entries()) {
    const step = makeText("li", state, "state-step");
    if (index === states.length - 1 && state === currentState) step.setAttribute("aria-current", "step");
    elements.statePath.append(step);
  }
}

function renderActivity(snapshot) {
  elements.activity.replaceChildren();
  const transitions = sortedTransitions(snapshot).reverse();
  if (transitions.length === 0) {
    addEmpty(elements.activity, "No transitions recorded.", "li");
    return;
  }

  for (const transition of transitions) {
    const row = document.createElement("li");
    row.className = "activity-item";
    row.append(makeText("p", valueText(transition.from) + " → " + valueText(transition.to), "activity-transition"));
    row.append(makeText("p", displayLabel(transition.reasonCode), "activity-reason"));
    row.append(makeText("code", transition.reasonCode, "activity-code identifier"));
    const metadata = document.createElement("p");
    metadata.className = "activity-meta";
    metadata.append(makeText("span", displayLabel(transition.actor)));
    metadata.append(makeText("span", "State v" + valueText(transition.stateVersionAfter), "identifier"));
    metadata.append(makeTime(transition.createdAt));
    row.append(metadata);
    elements.activity.append(row);
  }
}

function renderSnapshot(snapshot, session) {
  const run = asObject(snapshot.run);
  const task = asObject(asObject(snapshot.currentTask).action);
  const previousState = elements.runState.dataset.state;
  setText(elements.runId, session.runId);
  setText(elements.runState, displayLabel(run.state));
  elements.runState.dataset.state = valueText(run.state);
  setText(elements.runMeta, "State v" + valueText(run.stateVersion));
  setText(elements.runTaskPreview, task.summary ?? "No task recorded");
  setText(elements.sidebarRunId, session.runId);
  elements.sidebarRunId.classList.add("identifier");
  setText(elements.sidebarRunState, displayLabel(run.state));
  setText(elements.sidebarRunVersion, "State v" + valueText(run.stateVersion));
  renderStatePath(snapshot, run.state);
  renderCurrentWork(snapshot);
  renderEvidence(snapshot);
  renderHumanGate(snapshot);
  renderScope(snapshot);
  renderArtifacts(snapshot, session);
  renderActivity(snapshot);
  elements.emptyView.hidden = true;
  elements.runContent.hidden = false;
  document.body.dataset.view = "loaded";
  if (previousState !== run.state) {
    elements.statePath.parentElement.scrollLeft = elements.statePath.parentElement.scrollWidth;
  }
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
  elements.emptyView.hidden = false;
  elements.runContent.hidden = true;
  document.body.dataset.view = "empty";
  elements.dashboard.setAttribute("aria-busy", "false");
  setText(elements.runId, "—");
  setText(elements.runState, "—");
  elements.runState.dataset.state = "idle";
  setText(elements.runMeta, "State v—");
  setText(elements.runTaskPreview, "—");
  setText(elements.sidebarRunId, "No run selected");
  elements.sidebarRunId.classList.remove("identifier");
  setText(elements.sidebarRunState, "—");
  setText(elements.sidebarRunVersion, "—");
  elements.statePath.replaceChildren();
  elements.gateSection.dataset.open = "false";
  elements.currentWork.replaceChildren();
  elements.validation.replaceChildren();
  elements.humanGate.replaceChildren();
  elements.positiveScope.replaceChildren();
  elements.negativeScope.replaceChildren();
  elements.artifactHead.hidden = true;
  elements.artifacts.replaceChildren();
  elements.activity.replaceChildren();
}

async function loadRun(runId) {
  stopSession();
  resetDashboard();
  elements.runInput.value = runId;
  elements.emptyRunInput.value = runId;

  if (runId === "") {
    setConnection("Not connected", "idle");
    clearPageStatus();
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

elements.emptyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadRun(elements.emptyRunInput.value.trim());
});

if (apiToken === "") {
  setConnection("Session invalid", "error");
  setPageStatus("The local session token is unavailable. Reload this page.", "error");
} else {
  setConnection("Not connected", "idle");
  clearPageStatus();
}
