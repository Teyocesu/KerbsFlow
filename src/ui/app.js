const tokenElement = document.querySelector('meta[name="kerbsflow-token"]');
const apiToken = tokenElement instanceof HTMLMetaElement ? tokenElement.content : "";

const elements = {
  connection: document.getElementById("connection-status"),
  form: document.getElementById("run-form"),
  runInput: document.getElementById("run-id"),
  startForm: document.getElementById("start-form"),
  startRunInput: document.getElementById("start-run-id"),
  startObjective: document.getElementById("start-objective"),
  startButton: document.getElementById("start-run"),
  runSwitcher: document.getElementById("run-switcher"),
  newRun: document.getElementById("new-run"),
  selectedRunId: document.getElementById("selected-run-id"),
  switchRun: document.getElementById("switch-run"),
  cancelRunSelection: document.getElementById("cancel-run-selection"),
  emptyForm: document.getElementById("empty-run-form"),
  emptyRunInput: document.getElementById("empty-run-id"),
  emptyView: document.getElementById("empty-view"),
  runContent: document.getElementById("run-content"),
  pageStatus: document.getElementById("page-status"),
  taskSummary: document.getElementById("snapshot-task-summary"),
  runState: document.getElementById("snapshot-state"),
  runMeta: document.getElementById("snapshot-run-meta"),
  context: document.getElementById("execution-context"),
  tabList: document.getElementById("view-tabs"),
  tabs: [...document.querySelectorAll('[role="tab"]')],
  views: [...document.querySelectorAll('[role="tabpanel"]')],
  currentWork: document.getElementById("current-work-content"),
  pauseControl: document.getElementById("pause-control"),
  resumeControl: document.getElementById("resume-control"),
  steerForm: document.getElementById("steer-form"),
  steerText: document.getElementById("steer-text"),
  steerByteCount: document.getElementById("steer-byte-count"),
  steerSubmit: document.getElementById("steer-submit"),
  cancelForm: document.getElementById("cancel-form"),
  cancelReason: document.getElementById("cancel-reason"),
  cancelSubmit: document.getElementById("cancel-submit"),
  pendingSteer: document.getElementById("pending-steer-status"),
  validation: document.getElementById("validation-content"),
  gateSection: document.getElementById("human-gate"),
  gateTitle: document.getElementById("human-gate-title"),
  humanGate: document.getElementById("human-gate-content"),
  positiveScope: document.getElementById("positive-scope"),
  negativeScope: document.getElementById("negative-scope"),
  artifactHead: document.getElementById("artifact-head"),
  artifacts: document.getElementById("artifact-list"),
  activity: document.getElementById("activity-list"),
};

let currentSession;
let startInFlight = false;
let pageSessionInvalid = false;
const invalidSessionMessage = "The local session is invalid. Reload this page to start a new session.";

class MutationIdentityError extends Error {
  constructor() {
    super("secure random command identity unavailable");
    this.name = "MutationIdentityError";
  }
}

function isCurrent(session) {
  return !pageSessionInvalid && currentSession === session && !session.controller.signal.aborted;
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
  if (pageSessionInvalid) {
    message = "Session invalid";
    state = "error";
  }
  setText(elements.connection, message);
  elements.connection.dataset.state = state;
}

function setPageStatus(message, state) {
  if (pageSessionInvalid) {
    message = invalidSessionMessage;
    state = "error";
  }
  setText(elements.pageStatus, message);
  elements.pageStatus.dataset.state = state;
  elements.pageStatus.hidden = false;
}

function clearPageStatus() {
  if (pageSessionInvalid) {
    setPageStatus(invalidSessionMessage, "error");
    return;
  }
  if (currentSession?.notice !== undefined) {
    setPageStatus(currentSession.notice.message, currentSession.notice.state);
    return;
  }
  if (currentSession?.reconnecting === true) {
    setPageStatus("The event connection was lost. Reconnecting; the displayed snapshot may be stale.", "warning");
    return;
  }
  if (elements.pageStatus.hidden) return;
  elements.pageStatus.hidden = true;
  elements.pageStatus.dataset.state = "";
  setText(elements.pageStatus, "");
}

function setSessionNotice(session, message, state = "error") {
  if (pageSessionInvalid) return;
  session.notice = { message, state };
  if (isCurrent(session)) setPageStatus(message, state);
}

function clearSessionNotice(session) {
  delete session.notice;
  if (isCurrent(session)) clearPageStatus();
}

function invalidatePageSession() {
  if (pageSessionInvalid) return;
  pageSessionInvalid = true;
  currentSession?.controller.abort();
  currentSession?.snapshotController?.abort();
  for (const controller of currentSession?.artifactControllers ?? []) controller.abort();
  if (currentSession?.refreshTimer !== undefined) window.clearTimeout(currentSession.refreshTimer);
  for (const control of [
    elements.newRun, elements.switchRun,
    ...elements.startForm.querySelectorAll("input, textarea, button"),
    ...elements.form.querySelectorAll("input, button"),
    ...elements.emptyForm.querySelectorAll("input, button"),
  ]) control.disabled = true;
  if (currentSession !== undefined) updateMutationControls(currentSession);
  setConnection("Session invalid", "error");
  setPageStatus(invalidSessionMessage, "error");
}

function randomHex() {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("secure browser randomness is unavailable");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function postMutation(path, runId, expectedStateVersion, payload) {
  if (pageSessionInvalid) throw new Error("local session invalid");
  let identity;
  try {
    identity = {
      commandId: "command_" + randomHex(),
      idempotencyKey: "local-ui:" + randomHex(),
      runId,
    };
  } catch {
    throw new MutationIdentityError();
  }
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-KerbsFlow-Token": apiToken,
    },
    body: JSON.stringify({
      schemaVersion: "kerbsflow.local-command/v1",
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      expectedStateVersion,
      payload,
    }),
  });
  return { response, identity };
}

function parseMutationResult(value, identity) {
  const result = asObject(value);
  if (result.accepted !== true || result.commandId !== identity.commandId
    || result.idempotencyKey !== identity.idempotencyKey || result.runId !== identity.runId
    || typeof result.to !== "string" || !Number.isSafeInteger(result.stateVersion)) {
    throw new Error("mutation response is not authoritative");
  }
  return result;
}

async function safeMutationError(response) {
  let code = "";
  try {
    const body = asObject(await response.json());
    code = valueText(asObject(body.error).code);
  } catch {
    // The response body is untrusted; status still maps to a safe message.
  }
  const messages = {
    ACTIVE_RUN_CONFLICT: "Another run owns the local coordinator. Open the active run before starting a different one.",
    RUN_CONTINUATION_UNAVAILABLE: "This run has no proven live drive to continue. Refresh its snapshot and inspect its state.",
    STATE_VERSION_CONFLICT: "The run changed before this command was accepted. Review the latest run state before trying again.",
    IDEMPOTENCY_CONFLICT: "This command conflicts with an earlier command. Review the current run state before trying again.",
    COMMAND_ID_CONFLICT: "This command identity conflicts with an earlier command. Review the current run state before trying again.",
    CONTROL_COMMAND_IN_PROGRESS: "Another control command already owns this run. Review the latest state and wait before acting again.",
    PAUSE_SUPERSEDED: "The pause was superseded before it could be committed. Review the latest run state.",
    CANCEL_COMMAND_INCOMPLETE: "This cancellation identity has an incomplete result and cannot be replaced. Review the latest run state.",
    CANCELLATION_COMMAND_CONFLICT: "This attempt already belongs to a different cancellation request. Review the latest run state.",
    STEER_PENDING_EXISTS: "A Steer instruction is already waiting for the next safe planning boundary.",
    STEER_SECRET_REJECTED: "Steer was rejected because it may contain a secret. Remove the sensitive value and try again.",
    STEER_TERMINAL: "A terminal run cannot accept Steer.",
    GATE_NOT_OPEN: "This human gate is already resolved or no longer open. Review its latest state.",
    GATE_OPTION_INVALID: "That gate option is no longer available. Review its latest state.",
    GATE_SCOPE_MISMATCH: "That gate no longer belongs to this run. Review the latest run state.",
    PAUSE_NOT_ALLOWED: "The run cannot be paused from its current state.",
    PAUSE_REQUIRES_QUIESCENT_RUN: "The active operation has not reached a safe pause boundary.",
    RUN_DRIVE_NOT_PAUSABLE: "The coordinator has no live drive that can be safely paused.",
    RUN_DRIVE_NOT_RESUMABLE: "The coordinator cannot prove a safe continuation point for this run.",
    RUN_NOT_OWNED: "This process does not own the run's coordinator drive.",
    RUN_EXISTS: "That run ID is already in use. Open the existing run or choose a new ID.",
    RESUME_NOT_PAUSED: "The run is no longer paused. Review its latest state.",
    RESUME_REQUIRES_RECOVERY: "The run requires Recovery before it can resume.",
    CANCEL_ALREADY_CLAIMED: "Another cancellation already owns this run's control boundary.",
    CANCEL_NOT_ALLOWED: "The run cannot be cancelled from its current state.",
    REAL_CANCEL_REQUIRES_DURABLE_INTENT: "Cancellation could not be safely coordinated. Inspect the latest run state.",
  };
  if (Object.hasOwn(messages, code)) return { code, message: messages[code] };
  if (response.status === 401) return { code, message: "The local session is invalid. Reload this page to start a new session." };
  if (response.status === 403) return { code, message: "The local API rejected this request origin." };
  if (response.status === 404) return { code, message: "The run or human gate is no longer available. Check the ID and refresh the dashboard." };
  if (response.status === 409) return { code, message: "The requested action was not confirmed because the run or gate state conflicts with it. Review the current state before trying again." };
  if (response.status === 413) return { code, message: "The request exceeds the local API size limit." };
  if (response.status === 400) return { code, message: "The local API rejected the request as invalid." };
  return { code, message: "The local API could not confirm this command. Its outcome may be unknown; inspect the latest snapshot before trying again." };
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
  const currentTask = asObject(snapshot.currentTask);
  const action = asObject(currentTask.action);
  const route = asObject(currentTask.route);
  const attempt = asObject(snapshot.activeAttempt);
  elements.currentWork.replaceChildren();
  const metadata = document.createElement("dl");
  metadata.className = "task-metadata";
  addDetail(metadata, "Action", action.kind === undefined ? undefined : displayLabel(action.kind));
  addDetail(metadata, "Required validation", action.validationLevel === undefined ? undefined : displayLabel(action.validationLevel));
  addDetail(metadata, "Acceptance", asArray(action.acceptance).join(" · "));
  addDetail(metadata, "Adapter", attempt.adapter ?? route.adapter);
  addDetail(metadata, "Model", attempt.model ?? route.model);
  addDetail(metadata, "Attempt", attempt.attemptId, true);
  addDetail(metadata, "Lifecycle", attempt.lifecycle === undefined ? undefined : displayLabel(attempt.lifecycle));
  elements.currentWork.append(metadata);
}

function renderEvidence(snapshot) {
  elements.validation.replaceChildren();
  for (const [label, value, empty] of [
    ["Validation", snapshot.latestValidation, "No validation recorded"],
    ["Review", snapshot.latestReview, "No review recorded"],
  ]) {
    const row = document.createElement("section");
    row.className = "evidence-row";
    const heading = document.createElement("div");
    heading.className = "evidence-heading";
    heading.append(makeText("h2", label));
    row.append(heading);
    if (value === null || value === undefined) {
      row.append(makeText("p", empty, "empty-state"));
    } else {
      const item = asObject(value);
      const outcome = makeText("span", displayLabel(item.outcome), "evidence-outcome");
      outcome.dataset.outcome = valueText(item.outcome);
      heading.append(outcome);
      if (label === "Validation") row.append(makeText("p", displayLabel(item.level), "evidence-level"));
      row.append(makeText("p", item.summary, "evidence-summary"));
    }
    elements.validation.append(row);
  }
}

function renderHumanGate(snapshot, session) {
  elements.humanGate.replaceChildren();
  const gate = snapshot.currentGate;
  if (gate === null || gate === undefined) {
    elements.gateSection.dataset.open = "false";
    setText(elements.gateTitle, "Human gate");
    addEmpty(elements.humanGate, "No decision required", "p");
    return;
  }

  elements.gateSection.dataset.open = "true";
  setText(elements.gateTitle, "Human decision required");
  const item = asObject(gate);
  const summary = document.createElement("div");
  summary.className = "gate-summary";
  summary.append(makeText("h3", displayLabel(item.reasonCode)));
  summary.append(makeText("code", item.reasonCode, "gate-reason identifier"));
  summary.append(makeText("p", item.summary, "gate-description"));
  elements.humanGate.append(summary);

  const supporting = document.createElement("div");
  supporting.className = "gate-evidence";
  supporting.append(makeText("h3", "Gate supporting evidence"));
  for (const value of asArray(item.evidence)) {
    const evidence = asObject(value);
    supporting.append(makeText("p", `${displayLabel(evidence.classification)}: ${evidence.summary ?? "Unknown support"}`));
    if (typeof evidence.artifactId === "string") supporting.append(makeText("code", evidence.artifactId));
  }
  for (const ref of asArray(item.evidenceRefs)) supporting.append(makeText("code", ref));
  if (item.missingSupport) supporting.append(makeText("p", item.missingSupport));
  elements.humanGate.append(supporting);

  const evidenceRows = [];
  if (snapshot.latestValidation !== null && snapshot.latestValidation !== undefined) {
    const validation = asObject(snapshot.latestValidation);
    const values = [validation.outcome, validation.level]
      .filter((value) => typeof value === "string")
      .map(displayLabel);
    if (values.length > 0) evidenceRows.push(["Validation", values.join(" · ")]);
  }
  if (snapshot.latestReview !== null && snapshot.latestReview !== undefined) {
    const review = asObject(snapshot.latestReview);
    if (typeof review.outcome === "string") evidenceRows.push(["Review", displayLabel(review.outcome)]);
  }
  if (evidenceRows.length > 0) {
    const evidence = document.createElement("div");
    evidence.className = "gate-evidence";
    evidence.append(makeText("h3", "Evidence"));
    for (const [label, value] of evidenceRows) {
      const row = document.createElement("p");
      row.className = "gate-evidence-row";
      row.append(makeText("span", label), makeText("span", value));
      evidence.append(row);
    }
    elements.humanGate.append(evidence);
  }

  if (item.correctionsRequested === true) elements.humanGate.append(makeText("p", "Corrections request recorded for a separately approved run. This gate remains open."));
  const options = asArray(item.options);
  if (options.length === 0) {
    addEmpty(elements.humanGate, asObject(snapshot.run).state === "PAUSED" && asObject(snapshot.controls).resume === true
      ? "Resume the paused run to make its human gate actions available."
      : "No human gate actions are currently available.", "p");
    return;
  }
  const noteLabel = makeText("label", "Optional note", "gate-note-label");
  const note = document.createElement("textarea");
  note.id = "gate-resolution-note";
  note.rows = 2;
  note.maxLength = 2_000;
  note.setAttribute("aria-label", "Optional note for this human gate resolution");
  note.className = "gate-resolution-note";
  noteLabel.htmlFor = note.id;
  elements.humanGate.append(noteLabel, note);
  const optionList = document.createElement("ul");
  optionList.className = "gate-options";
  for (const optionValue of options) {
    const option = asObject(optionValue);
    const row = document.createElement("li");
    row.className = "gate-option";
    row.append(makeText("strong", option.label));
    row.append(makeText("p", option.consequence));
    const target = makeText("p", "Target: ", "gate-target");
    target.append(makeText("code", option.target, "identifier"));
    row.append(target);
    if (typeof option.id === "string") {
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "gate-action";
      choose.dataset.mutation = "gate";
      choose.setAttribute("aria-label", "Choose gate option " + valueText(option.label));
      choose.textContent = "Choose this option";
      choose.disabled = pageSessionInvalid || session.mutationInFlight === true;
      choose.addEventListener("click", () => {
        void resolveGate(session, valueText(item.gateId), option.id, note.value);
      });
      row.append(choose);
    }
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
    addArtifactField(row, "Size", makeText("span", valueText(artifact.sizeBytes) + " B", "artifact-size-value"));
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

function renderExecutionContext(snapshot) {
  elements.context.replaceChildren();
  const run = asObject(snapshot.run);
  const project = asObject(snapshot.project);
  const supervision = asObject(snapshot.supervision);
  const canonical = asObject(supervision.canonical);
  const invariants = asObject(supervision.invariants);
  const enforcedPolicy = asObject(invariants.enforcedPolicy);
  const scope = asObject(supervision.scopeCheck);
  const observedChecks = asObject(invariants.observedChecks);
  const retryEscalation = asObject(supervision.retryEscalation);
  const counts = asObject(retryEscalation.policyDecisionCounts);
  const pauseContract = asObject(run.pauseContract);
  addDetail(elements.context, "Project", project.status === "available" ? project.name : "Unavailable");
  addDetail(elements.context, "Lifecycle phase", valueText(run.phase) + " (persisted run state)");
  addDetail(elements.context, "Canonical snapshot", canonical.status === "captured" ? "Captured; current files not checked" : "Not captured");
  addDetail(elements.context, "Canonical capture time", canonical.capturedAt);
  addDetail(elements.context, "SPEC captured", canonical.specCaptured === true ? "Yes" : "No");
  addDetail(elements.context, "Git base and scope", displayLabel(scope.status) + (scope.evidenceClass ? " (" + displayLabel(scope.evidenceClass) + ")" : ""));
  addDetail(elements.context, "Observed checks", [observedChecks.originalCheckout, observedChecks.focusedCheckEvidenceIntegrity]
    .map((checkValue) => {
      const check = asObject(checkValue);
      return valueText(check.name) + ": " + displayLabel(check.status) + (check.evidenceClass ? " (" + displayLabel(check.evidenceClass) + ")" : "");
    }).join(" · "));
  addDetail(elements.context, "Enforced policy", "Legal transitions " + valueText(enforcedPolicy.legalTransitions)
    + " · Single active executor " + valueText(enforcedPolicy.singleActiveExecutor)
    + " · Independent evidence " + valueText(enforcedPolicy.independentEvidence)
    + " · Secrets absent from persistence " + valueText(enforcedPolicy.secretsAbsentFromPersistence)
    + " · High impact human gates " + valueText(enforcedPolicy.highImpactHumanGates)
    + " · Automatic release actions " + valueText(enforcedPolicy.automaticReleaseActions)
    + " · Ambiguous replay " + valueText(enforcedPolicy.ambiguousReplay)
    + " · Executor cannot verify " + valueText(enforcedPolicy.executorCannotVerify)
    + " · Max implementation attempts " + valueText(enforcedPolicy.maxImplementationAttempts));
  addDetail(elements.context, "Effective attempt limit", invariants.effectiveMaxImplementationAttempts);
  addDetail(elements.context, "Policy interpretation", invariants.interpretation);
  addDetail(elements.context, "Failure policy decisions", (retryEscalation.taskStatus === "available" ? "Current task · " : "No current task · ")
    + "Retry same route " + valueText(counts.retry_same_route)
    + " · Rework " + valueText(counts.rework) + " · Escalate " + valueText(counts.escalate));
  addDetail(elements.context, "Recorded attempts", retryEscalation.taskStatus === "available" ? retryEscalation.recordedAttempts : "Unavailable");
  const latestDecision = retryEscalation.latestDecision;
  if (latestDecision !== null && latestDecision !== undefined) {
    const decision = asObject(latestDecision);
    addDetail(elements.context, "Latest policy decision", displayLabel(decision.action) + " · " + valueText(decision.reasonCode)
      + (decision.escalationReason ? " · " + valueText(decision.escalationReason) : ""));
  }
  if (pauseContract.originState !== undefined) addDetail(elements.context, "Pause origin", pauseContract.originState);
  if (pauseContract.durableBoundary !== undefined) addDetail(elements.context, "Pause durable boundary", pauseContract.durableBoundary);
  if (pauseContract.resumeTarget !== undefined) addDetail(elements.context, "Resume target", pauseContract.resumeTarget);
  addDetail(elements.context, "Recovery required", run.recoveryRequired === true ? "Yes" : "No");
  if (run.recoveryReason !== null && run.recoveryReason !== undefined) addDetail(elements.context, "Recovery reason", run.recoveryReason);
  const latest = sortedTransitions(snapshot).at(-1);
  if (latest === undefined) {
    addDetail(elements.context, "Latest transition", "No transitions recorded");
    return;
  }
  addDetail(elements.context, "Latest transition", displayLabel(latest.from) + " → " + displayLabel(latest.to));
  const recorded = document.createElement("div");
  const time = document.createElement("dd");
  time.append(makeTime(latest.createdAt));
  recorded.append(makeText("dt", "Recorded"), time);
  elements.context.append(recorded);
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
    row.append(makeText("p", displayLabel(transition.reasonCode), "activity-reason"));
    const stateChange = makeText("p", displayLabel(transition.from) + " → " + displayLabel(transition.to), "activity-transition");
    stateChange.title = valueText(transition.from) + " → " + valueText(transition.to);
    row.append(stateChange);
    row.append(makeText("code", transition.reasonCode, "activity-code identifier"));
    const metadata = document.createElement("p");
    metadata.className = "activity-meta";
    metadata.append(
      makeText("span", displayLabel(transition.actor)),
      document.createTextNode(" · "),
      makeText("span", "State v" + valueText(transition.stateVersionAfter), "identifier"),
      document.createTextNode(" · "),
      makeTime(transition.createdAt),
    );
    row.append(metadata);
    elements.activity.append(row);
  }
}

function updateSteerByteCount() {
  const bytes = new TextEncoder().encode(elements.steerText.value).length;
  setText(elements.steerByteCount, bytes + " / 4096 bytes");
  elements.steerByteCount.dataset.state = bytes > 4096 ? "error" : "";
  return bytes;
}

function updateMutationControls(session) {
  const invalid = pageSessionInvalid;
  const state = session.currentState;
  const terminal = invalid || state === "IDLE" || state === "FAILED" || state === "CANCELLED" || state === "DONE";
  const busy = invalid || session.mutationInFlight === true;
  const steerBytes = updateSteerByteCount();
  const cancelBytes = new TextEncoder().encode(elements.cancelReason.value).length;
  const availability = asObject(asObject(session.snapshot).controls);
  elements.pauseControl.disabled = busy || terminal || state === "PAUSED" || availability.pause !== true;
  elements.resumeControl.disabled = busy || state !== "PAUSED" || availability.resume !== true;
  elements.steerText.disabled = busy || terminal;
  elements.steerSubmit.disabled = busy || terminal || elements.steerText.value.length === 0 || steerBytes > 4096;
  elements.cancelReason.disabled = busy || terminal;
  elements.cancelSubmit.disabled = busy || terminal || elements.cancelReason.value.trim() === "" || cancelBytes > 1024;
  const gateOpen = session.currentGateStatus === "open";
  for (const note of elements.humanGate.querySelectorAll(".gate-resolution-note")) note.disabled = busy || !gateOpen;
  for (const button of elements.humanGate.querySelectorAll('[data-mutation="gate"]')) {
    button.disabled = busy || !gateOpen;
  }

  const pending = asObject(asObject(session.snapshot).pendingSteer);
  if (pending.pending === true && typeof pending.instructionId === "string") {
    setText(elements.pendingSteer, "Steer queued for a safe planning boundary · " + pending.instructionId);
    elements.pendingSteer.title = valueText(pending.createdAt);
  } else {
    setText(elements.pendingSteer, "");
    elements.pendingSteer.removeAttribute("title");
  }
}

function renderSnapshot(snapshot, session) {
  const run = asObject(snapshot.run);
  const task = asObject(snapshot.currentTask);
  const action = asObject(task.action);
  setText(elements.taskSummary, typeof action.summary === "string" && action.summary !== "" ? action.summary : "No task recorded");
  setText(elements.runState, displayLabel(run.state));
  elements.runState.dataset.state = valueText(run.state);
  elements.runState.title = valueText(run.state);
  session.currentState = valueText(run.state);
  session.stateVersion = run.stateVersion;
  session.currentGateId = asObject(snapshot.currentGate).gateId;
  session.currentGateStatus = asObject(snapshot.currentGate).status;
  session.correctionsRequested = asObject(snapshot.currentGate).correctionsRequested === true;
  session.snapshot = snapshot;
  elements.runMeta.replaceChildren(
    makeText("code", session.runId, "run-meta-id identifier"),
    document.createTextNode(" · State v" + valueText(run.stateVersion)),
  );
  setText(elements.selectedRunId, session.runId);
  elements.selectedRunId.title = session.runId;
  renderExecutionContext(snapshot);
  renderCurrentWork(snapshot);
  renderEvidence(snapshot);
  renderHumanGate(snapshot, session);
  updateMutationControls(session);
  renderScope(snapshot);
  renderArtifacts(snapshot, session);
  renderActivity(snapshot);
  elements.emptyView.hidden = true;
  elements.runContent.hidden = false;
  elements.tabList.hidden = false;
  elements.runSwitcher.hidden = false;
  elements.runContent.setAttribute("aria-busy", "false");
  if (!session.hasSnapshot) elements.tabs[0].focus();
}

function showApiFailure(status, session, keepConnection) {
  if (status === 401) {
    invalidatePageSession();
    return;
  }
  if (status === 404) {
    session.runUnavailable = true;
    if (!keepConnection) setConnection("Not connected", "error");
    setPageStatus("Run not found. Check the run ID and load it again.", "error");
    return;
  }
  if (session.reconnecting === true) {
    clearPageStatus();
    return;
  }
  if (!keepConnection) setConnection("Not connected", "error");
  setPageStatus("The local API returned an error (HTTP " + status + ").", "error");
}

async function refreshAfterMutationFailure(session, response) {
  if (response.status === 401) {
    invalidatePageSession();
    return;
  }
  const failure = await safeMutationError(response);
  if (!isCurrent(session)) return;
  setSessionNotice(session, failure.message);
  if (response.status === 404 || response.status === 409 || response.status >= 500) {
    const refreshed = await refreshSnapshot(session);
    if (isCurrent(session)) {
      const message = refreshed
        ? failure.message
        : failure.message + " The authoritative snapshot could not be refreshed; the current state is unknown.";
      setSessionNotice(session, message, refreshed ? "error" : "warning");
    }
  }
}

async function refreshAfterAmbiguousMutation(session, message) {
  if (!isCurrent(session)) return;
  setSessionNotice(session, message, "warning");
  const refreshed = await refreshSnapshot(session);
  if (isCurrent(session) && !refreshed) {
    setSessionNotice(session, message + " The snapshot refresh also failed.", "warning");
  }
}

function commandPath(session, command) {
  return "/v1/runs/" + encodeURIComponent(session.runId) + "/" + command;
}

async function submitRunMutation(session, command, payload, kind, gateId) {
  if (!isCurrent(session) || session.mutationInFlight) return;
  if (!Number.isSafeInteger(session.stateVersion)) {
    setSessionNotice(session, "A current snapshot is required before sending a command.");
    return;
  }

  clearSessionNotice(session);
  session.mutationInFlight = true;
  updateMutationControls(session);
  const pendingMessages = {
    pause: "Requesting Pause; waiting for a safe boundary. The run is not yet confirmed paused.",
    resume: "Requesting Resume; continuation is not yet confirmed.",
    cancel: "Requesting cancellation; terminal cancellation is not yet confirmed.",
    steer: "Queuing Steer; acceptance is not yet confirmed.",
    gate: "Submitting the human gate choice; resolution is not yet confirmed.",
  };
  setSessionNotice(session, pendingMessages[kind], "warning");
  try {
    let sent;
    try {
      sent = await postMutation(commandPath(session, command), session.runId, session.stateVersion, payload);
    } catch (error) {
      if (error instanceof MutationIdentityError) {
        setSessionNotice(session, "Secure random command IDs are unavailable, so the command was not sent.");
        return;
      }
      await refreshAfterAmbiguousMutation(
        session,
        "No response was received. The command outcome is unknown; no automatic retry was sent.",
      );
      return;
    }

    if (!sent.response.ok) {
      await refreshAfterMutationFailure(session, sent.response);
      return;
    }

    let result;
    try {
      result = parseMutationResult(await sent.response.json(), sent.identity);
    } catch {
      await refreshAfterAmbiguousMutation(
        session,
        "The command response could not be confirmed. Its outcome may be unknown; no automatic retry was sent.",
      );
      return;
    }

    if (kind === "steer") elements.steerText.value = "";
    if (kind === "cancel") elements.cancelReason.value = "";
    const refreshed = await refreshSnapshot(session);
    if (!isCurrent(session)) return;
    if (!refreshed) {
      setSessionNotice(session, "The API accepted the command, but a fresh snapshot is unavailable. Review the run before taking another action.", "warning");
      return;
    }

    if (kind === "pause") {
      if (session.currentState === "PAUSED" && session.stateVersion >= result.stateVersion) {
        setSessionNotice(session, "Run is paused.", "success");
      } else {
        setSessionNotice(session, "Pause returned, but the fresh snapshot shows " + valueText(session.currentState) + "; PAUSED was not confirmed.", "warning");
      }
    } else if (kind === "resume") {
      if (session.currentState === result.to && session.stateVersion >= result.stateVersion) {
        setSessionNotice(session, "Run resumed to " + displayLabel(result.to) + ".", "success");
      } else {
        setSessionNotice(session, "Resume returned, but the fresh snapshot shows " + valueText(session.currentState) + "; the response state was not confirmed.", "warning");
      }
    } else if (kind === "cancel") {
      if (session.currentState === "CANCELLED") {
        setSessionNotice(session, "Run cancelled.", "success");
      } else if (session.currentState === "RECOVERY") {
        setSessionNotice(session, "Cancellation left the run in Recovery. Review its persisted recovery state.", "warning");
      } else {
        setSessionNotice(session, "Cancel returned, but the fresh snapshot shows " + valueText(session.currentState) + "; cancellation is not confirmed.", "warning");
      }
    } else if (kind === "steer") {
      setSessionNotice(session, "Steer accepted for the next safe planning boundary.", "success");
    } else if (kind === "gate") {
      if (session.currentGateId === gateId && session.correctionsRequested && asObject(result.details).disposition === "corrections_requested_for_separately_approved_run") {
        setSessionNotice(session, "Corrections request recorded. This gate remains open for a readiness decision.", "success");
      } else if (session.currentGateId !== gateId || session.currentGateStatus !== "open") {
        setSessionNotice(session, "The human gate resolution is recorded in the fresh snapshot.", "success");
      } else {
        setSessionNotice(session, "The response arrived, but the fresh snapshot still shows this gate open.", "warning");
      }
    }
  } finally {
    session.mutationInFlight = false;
    if (isCurrent(session)) updateMutationControls(session);
  }
}

function utf8Length(value) {
  return new TextEncoder().encode(value).length;
}

async function resolveGate(session, gateId, optionId, note) {
  if (typeof gateId !== "string" || typeof optionId !== "string") return;
  if (utf8Length(note) > 4096) {
    setSessionNotice(session, "The optional gate note exceeds 4096 UTF-8 bytes.");
    return;
  }
  await submitRunMutation(
    session,
    "gates/" + encodeURIComponent(gateId) + "/resolve",
    { optionId, ...(note === "" ? {} : { note }) },
    "gate",
    gateId,
  );
}

async function startRun(event) {
  event.preventDefault();
  if (pageSessionInvalid || startInFlight) return;
  const objective = elements.startObjective.value;
  if (objective.trim() === "") {
    elements.startObjective.focus();
    setPageStatus("Enter an objective before starting a run.", "error");
    return;
  }

  let runId = elements.startRunInput.value;
  try {
    if (runId === "") runId = "run_" + randomHex();
  } catch {
    setPageStatus("Secure random IDs are unavailable, so Start was not sent.", "error");
    return;
  }
  if (!rememberRunSelection(runId)) {
    showInvalidRunSelection();
    elements.startRunInput.focus();
    return;
  }
  elements.startRunInput.value = runId;
  startInFlight = true;
  elements.startButton.disabled = true;
  clearPageStatus();
  setPageStatus("Requesting Start; coordinator acceptance is not yet confirmed.", "warning");
  try {
    let sent;
    try {
      sent = await postMutation("/v1/runs", runId, 0, { runId, objective });
    } catch (error) {
      if (error instanceof MutationIdentityError) {
        setPageStatus("Secure random command IDs are unavailable, so Start was not sent.", "error");
        return;
      }
      const session = await loadRun(runId);
      const message = session?.hasSnapshot
        ? "Start received no response. The latest snapshot is loaded, but coordinator acceptance cannot be inferred; no automatic retry was sent."
        : session?.runUnavailable
          ? "Start received no response and the latest snapshot reports this run unavailable. Coordinator acceptance remains unknown; no automatic retry was sent."
          : "Start received no response and the latest snapshot could not be loaded. Coordinator acceptance is unknown; no automatic retry was sent.";
      if (session !== undefined) setSessionNotice(session, message, "warning");
      else setPageStatus(message, "warning");
      return;
    }

    if (!sent.response.ok) {
      if (sent.response.status === 401) {
        invalidatePageSession();
        return;
      }
      const failure = await safeMutationError(sent.response);
      if (sent.response.status === 409 && [
        "RUN_CONTINUATION_UNAVAILABLE",
        "RUN_EXISTS",
        "STATE_VERSION_CONFLICT",
        "IDEMPOTENCY_CONFLICT",
        "COMMAND_ID_CONFLICT",
      ].includes(failure.code)) {
        const session = await loadRun(runId);
        if (session !== undefined) {
          const message = session.hasSnapshot
            ? failure.message
            : failure.message + " The requested run snapshot is unavailable.";
          setSessionNotice(session, message, session.hasSnapshot ? "error" : "warning");
        }
        else setPageStatus(failure.message, "error");
      } else {
        setPageStatus(failure.message, "error");
      }
      return;
    }

    let result;
    try {
      result = parseMutationResult(await sent.response.json(), sent.identity);
      if (result.to !== "INTAKE") throw new Error("Start response did not confirm INTAKE");
    } catch {
      const session = await loadRun(runId);
      const message = session?.hasSnapshot
        ? "The Start response could not confirm coordinator acceptance. The latest snapshot is loaded, but acceptance remains unknown; no automatic retry was sent."
        : "The Start response could not confirm coordinator acceptance, and the latest snapshot is unavailable. Acceptance remains unknown; no automatic retry was sent.";
      if (session !== undefined) setSessionNotice(session, message, "warning");
      else setPageStatus(message, "warning");
      return;
    }

    elements.startObjective.value = "";
    elements.startRunInput.value = "";
    const session = await loadRun(runId, { message: "Start accepted by the local coordinator.", state: "success" });
    if (session !== undefined && !session.hasSnapshot) {
      setSessionNotice(session, "Start was accepted by the local coordinator, but the latest snapshot is unavailable.", "warning");
    }
  } finally {
    startInFlight = false;
    elements.startButton.disabled = pageSessionInvalid;
  }
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
    if (response.status === 401) {
      invalidatePageSession();
      return false;
    }
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
      if (!session.hasSnapshot) setConnection("Not connected", "error");
      if (session.reconnecting === true) clearPageStatus();
      else setPageStatus("The local API is unavailable or returned an invalid snapshot.", "error");
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
  let repairRefreshRequired = false;
  while (isCurrent(session) && !session.runUnavailable) {
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
      if (response.status === 401) {
        invalidatePageSession();
        return;
      }
      if (!isCurrent(session)) return;
      if (response.status === 404) {
        showApiFailure(response.status, session, false);
        return;
      }
      if (!response.ok || response.body === null
        || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("event stream unavailable");
      }

      if (repairRefreshRequired) {
        const refreshed = await refreshSnapshot(session);
        if (!isCurrent(session) || session.runUnavailable) return;
        if (!refreshed) throw new Error("snapshot refresh failed");
        repairRefreshRequired = false;
      }
      connectedAt = Date.now();
      session.reconnecting = false;
      setConnection("Connected", "connected");
      clearPageStatus();
      await consumeEvents(response, session);
      if (!isCurrent(session)) return;
      throw new Error("event stream ended");
    } catch {
      if (!isCurrent(session) || session.runUnavailable) return;
      repairRefreshRequired = true;
      session.reconnecting = true;
      if (connectedAt !== undefined && Date.now() - connectedAt >= 30_000) failedConnections = 0;
      setConnection("Reconnecting", "reconnecting");
      clearPageStatus();
      await refreshSnapshot(session);
      if (!isCurrent(session) || session.runUnavailable) return;
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
  elements.tabList.hidden = true;
  elements.runSwitcher.hidden = true;
  elements.form.hidden = true;
  elements.switchRun.setAttribute("aria-expanded", "false");
  selectView("overview");
  elements.runContent.setAttribute("aria-busy", "false");
  setText(elements.taskSummary, "No task recorded");
  setText(elements.runState, "—");
  elements.runState.dataset.state = "idle";
  elements.runMeta.replaceChildren();
  setText(elements.selectedRunId, "—");
  elements.context.replaceChildren();
  elements.gateSection.dataset.open = "false";
  elements.currentWork.replaceChildren();
  elements.validation.replaceChildren();
  elements.humanGate.replaceChildren();
  elements.steerText.value = "";
  elements.cancelReason.value = "";
  setText(elements.pendingSteer, "");
  updateSteerByteCount();
  elements.positiveScope.replaceChildren();
  elements.negativeScope.replaceChildren();
  elements.artifactHead.hidden = true;
  elements.artifacts.replaceChildren();
  elements.activity.replaceChildren();
}

function isValidRunId(runId) {
  return typeof runId === "string" && /^run_[A-Za-z0-9][A-Za-z0-9_-]{0,115}$/u.test(runId);
}

function showInvalidRunSelection() {
  const message = "Enter a valid run ID: run_ followed by a letter or number, then only letters, numbers, underscores or hyphens; at most 120 characters total.";
  if (currentSession !== undefined) setSessionNotice(currentSession, message, "error");
  else setPageStatus(message, "error");
}

function rememberRunSelection(runId) {
  if (runId !== "" && !isValidRunId(runId)) return false;
  window.history.replaceState(null, "", runId === "" ? window.location.pathname + window.location.search : "#run=" + encodeURIComponent(runId));
  return true;
}

async function loadRun(runId, notice) {
  if (pageSessionInvalid) return currentSession;
  if (!rememberRunSelection(runId)) {
    showInvalidRunSelection();
    return currentSession;
  }
  stopSession();
  resetDashboard();
  elements.runInput.value = runId;
  elements.emptyRunInput.value = runId;

  if (runId === "") {
    setConnection("Not connected", "idle");
    clearPageStatus();
    return undefined;
  }

  const session = {
    runId,
    cursor: 0,
    controller: new AbortController(),
    artifactControllers: new Set(),
    hasSnapshot: false,
    refreshPending: false,
    ...(notice === undefined ? {} : { notice }),
  };
  currentSession = session;
  elements.runContent.setAttribute("aria-busy", "true");
  setConnection("Loading snapshot", "loading");
  setPageStatus("Loading the authoritative run snapshot.", "");

  const loaded = await refreshSnapshot(session);
  if (!isCurrent(session) || !loaded || session.runUnavailable) return session;
  setConnection("Connecting event stream", "loading");
  void runEventStream(session);
  return session;
}

function selectView(name) {
  for (const tab of elements.tabs) {
    const selected = tab.dataset.view === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const view of elements.views) view.hidden = view.id !== "view-" + name;
}

for (const [index, tab] of elements.tabs.entries()) {
  tab.addEventListener("click", () => selectView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % elements.tabs.length;
    else if (event.key === "ArrowLeft") next = (index + elements.tabs.length - 1) % elements.tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = elements.tabs.length - 1;
    else return;
    event.preventDefault();
    selectView(elements.tabs[next].dataset.view);
    elements.tabs[next].focus();
  });
}

function closeRunSelector() {
  elements.form.hidden = true;
  elements.switchRun.setAttribute("aria-expanded", "false");
  elements.switchRun.focus();
}

elements.switchRun.addEventListener("click", () => {
  if (pageSessionInvalid) return;
  if (!elements.form.hidden) {
    closeRunSelector();
    return;
  }
  elements.form.hidden = false;
  elements.switchRun.setAttribute("aria-expanded", "true");
  elements.runInput.focus();
  elements.runInput.select();
});
elements.newRun.addEventListener("click", () => {
  if (pageSessionInvalid) return;
  elements.startRunInput.value = "";
  void loadRun("").then(() => elements.startObjective.focus());
});
elements.cancelRunSelection.addEventListener("click", closeRunSelector);
elements.form.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeRunSelector();
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadRun(elements.runInput.value);
});

elements.emptyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadRun(elements.emptyRunInput.value);
});

elements.startForm.addEventListener("submit", (event) => {
  void startRun(event);
});

elements.pauseControl.addEventListener("click", () => {
  if (currentSession !== undefined) void submitRunMutation(currentSession, "pause", {}, "pause");
});

elements.resumeControl.addEventListener("click", () => {
  if (currentSession !== undefined) void submitRunMutation(currentSession, "resume", {}, "resume");
});

elements.steerText.addEventListener("input", () => {
  updateSteerByteCount();
  if (currentSession !== undefined) updateMutationControls(currentSession);
});

elements.steerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const session = currentSession;
  if (session === undefined) return;
  const bytes = updateSteerByteCount();
  if (bytes > 4096) {
    setSessionNotice(session, "Steer must be at most 4096 UTF-8 bytes.");
    elements.steerText.focus();
    return;
  }
  void submitRunMutation(session, "steer", { text: elements.steerText.value }, "steer");
});

elements.cancelReason.addEventListener("input", () => {
  if (currentSession !== undefined) updateMutationControls(currentSession);
});

elements.cancelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const session = currentSession;
  if (session === undefined) return;
  const reason = elements.cancelReason.value.trim();
  if (reason === "") {
    elements.cancelReason.focus();
    setSessionNotice(session, "Enter a brief reason before cancelling the run.");
    return;
  }
  if (new TextEncoder().encode(reason).length > 1024) {
    setSessionNotice(session, "Cancellation reason must be at most 1024 UTF-8 bytes.");
    elements.cancelReason.focus();
    return;
  }
  void submitRunMutation(session, "cancel", { reason }, "cancel");
});

const selectedRun = new URLSearchParams(window.location.hash.slice(1)).get("run");
const validRememberedSelection = isValidRunId(selectedRun);
const invalidRememberedSelection = window.location.hash !== "" && !validRememberedSelection;
if (window.location.hash !== "") rememberRunSelection(validRememberedSelection ? selectedRun : "");

if (apiToken === "") {
  invalidatePageSession();
} else {
  setConnection("Not connected", "idle");
  clearPageStatus();
  if (validRememberedSelection) void loadRun(selectedRun);
  else if (invalidRememberedSelection) showInvalidRunSelection();
}
