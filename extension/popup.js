import { buildMindWeaverProtocolUrl, createMindWeaverClient } from "./lib/mindweaver-client.js";

const AUTO_CAPTURE_ENABLED_STORAGE_KEY = "mindweaverAutoCaptureEnabled";
const statusEl = document.getElementById("status");
const workspaceEl = document.getElementById("workspace");
const targetEl = document.getElementById("target");
const createBtn = document.getElementById("create");
const autoCaptureBtn = document.getElementById("autoCapture");
const captureBtn = document.getElementById("capture");
const goalEl = document.getElementById("goal");
const openBtn = document.getElementById("open");
const lastCaptureEl = document.getElementById("lastCapture");
let currentTargetState = null;
let isAppUnavailable = false;
const client = createMindWeaverClient({ storageArea: chrome.storage?.local });

function getMapName(session, fallback = "Untitled map") {
  return String(session?.goal ?? "").trim() || fallback;
}

function titleCaseStatus(value) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getCaptureErrorMessage(error) {
  const message = String(error?.message ?? "").trim();
  if (/receiving end does not exist|message port closed|extension context invalidated|could not establish connection/i.test(message)) {
    return "The MindWeaver extension background worker did not respond. Reload the unpacked extension in chrome://extensions, then try again.";
  }
  return message || "Could not save this page. Make sure the local MindWeaver server is running.";
}

function isConnectionError(error) {
  const message = String(error?.message ?? "");
  return /could not reach|failed to fetch|fetch failed|networkerror|load failed|refused|tried:/i.test(message);
}

async function getCaptureState() {
  return await chrome.storage.local.get([
    AUTO_CAPTURE_ENABLED_STORAGE_KEY,
    "lastCaptureAt",
    "lastCaptureTitle",
    "lastCaptureStatus",
    "lastCaptureMessage",
    "lastCaptureTarget",
    "lastCaptureTargetId"
  ]);
}

async function clearDeletedCaptureTarget() {
  await chrome.storage.local.set({
    lastCaptureTarget: "",
    lastCaptureTargetId: ""
  });
}

async function setAutoCaptureEnabled(enabled) {
  await chrome.storage.local.set({
    [AUTO_CAPTURE_ENABLED_STORAGE_KEY]: Boolean(enabled)
  });
}

function renderAutoCaptureButton(enabled) {
  autoCaptureBtn.textContent = `Continuous Save: ${enabled ? "On" : "Off"}`;
  autoCaptureBtn.classList.toggle("toggle-on", enabled);
  autoCaptureBtn.classList.toggle("toggle-off", !enabled);
  autoCaptureBtn.setAttribute("aria-pressed", String(enabled));
}

function renderTargetOptions(targetState) {
  const sessions = targetState.tabSessions ?? targetState.sessions ?? [];
  const activeSessionId = targetState.activeSessionId ?? "";
  targetEl.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = sessions.length ? "No active destination map" : "Create a map first";
  targetEl.append(placeholder);

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = `${getMapName(session)}${session.endedAt ? " (ended)" : ""}`;
    targetEl.append(option);
  }

  targetEl.value = activeSessionId;
}

async function refreshUI() {
  const [targetState, captureState] = await Promise.all([
    client.fetchJson("/api/session-target?limit=24"),
    getCaptureState()
  ]);
  currentTargetState = targetState;
  isAppUnavailable = false;

  renderTargetOptions(targetState);
  const visibleSessions = targetState.tabSessions ?? targetState.sessions ?? [];
  const workspaceName = targetState.workspaces?.[0]?.name || "Personal Learning";
  const activeLabel = getMapName(targetState.activeSession, "No active map selected");
  const lastLabel = getMapName(targetState.lastSession, "None yet");
  const validSessionIds = new Set(visibleSessions.map((session) => session.id));
  if (targetState.activeSessionId) validSessionIds.add(targetState.activeSessionId);
  if (targetState.lastSessionId) validSessionIds.add(targetState.lastSessionId);
  const captureTargetStillExists = captureState.lastCaptureTargetId
    ? validSessionIds.has(captureState.lastCaptureTargetId)
    : (captureState.lastCaptureTarget
      ? visibleSessions.some((session) => getMapName(session) === captureState.lastCaptureTarget)
      : true);

  if (!captureTargetStillExists && (captureState.lastCaptureTarget || captureState.lastCaptureTargetId)) {
    await clearDeletedCaptureTarget();
    captureState.lastCaptureTarget = "";
    captureState.lastCaptureTargetId = "";
  }

  statusEl.textContent = activeLabel;
  workspaceEl.textContent = `${workspaceName} • Last used ${lastLabel}${captureState[AUTO_CAPTURE_ENABLED_STORAGE_KEY] ? " • Continuous save on" : ""}`;
  captureBtn.disabled = false;
  createBtn.disabled = false;
  autoCaptureBtn.disabled = false;
  targetEl.disabled = false;
  goalEl.disabled = false;
  openBtn.textContent = "Open MindWeaver";
  renderAutoCaptureButton(Boolean(captureState[AUTO_CAPTURE_ENABLED_STORAGE_KEY]));
  lastCaptureEl.textContent = captureState.lastCaptureAt
    ? `${titleCaseStatus(captureState.lastCaptureStatus || "saved")} • ${captureState.lastCaptureTitle || captureState.lastCaptureMessage || new Date(captureState.lastCaptureAt).toLocaleTimeString()}${captureState.lastCaptureTarget ? ` (${captureState.lastCaptureTarget})` : ""}`
    : "None yet";

  return targetState;
}

function renderUnavailableState(error) {
  isAppUnavailable = true;
  currentTargetState = null;
  targetEl.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "MindWeaver is not running";
  targetEl.append(option);
  statusEl.textContent = "MindWeaver is closed";
  workspaceEl.textContent = "Click Open MindWeaver, then retry capture.";
  lastCaptureEl.textContent = isConnectionError(error)
    ? "Local app unavailable"
    : (error?.message || "Unavailable");
  captureBtn.disabled = true;
  createBtn.disabled = true;
  autoCaptureBtn.disabled = true;
  targetEl.disabled = true;
  goalEl.disabled = true;
  openBtn.textContent = "Open MindWeaver";
  renderAutoCaptureButton(false);
}

async function waitForMindWeaver(retries = 16, intervalMs = 600) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await client.fetchJson("/api/health");
      await refreshUI();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return false;
}

async function setActiveTarget(sessionId) {
  return await client.fetchJson("/api/session-target", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, limit: 24 })
  });
}

async function createSession() {
  const goal = goalEl.value.trim();
  const session = await client.fetchJson("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: goal || null })
  });
  goalEl.value = "";
  return session;
}

async function ensureActiveTarget() {
  const targetState = await client.fetchJson("/api/session-target?limit=24");
  if (targetState.activeSessionId) return targetState;
  if (!goalEl.value.trim()) {
    throw new Error("Choose an existing map or enter a map name to create one before saving.");
  }

  await createSession();
  return await client.fetchJson("/api/session-target?limit=24");
}

targetEl.addEventListener("change", async () => {
  try {
    await setActiveTarget(targetEl.value || null);
    await refreshUI();
  } catch (error) {
    console.error("Failed to update target map:", error);
    alert(`Could not switch the destination map. ${error.message}`);
  }
});

createBtn.addEventListener("click", async () => {
  createBtn.disabled = true;
  createBtn.textContent = "Creating...";

  try {
    await createSession();
    await refreshUI();
  } catch (error) {
    console.error("Failed to create session:", error);
    alert(`Could not create a map. ${error.message}`);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = "Create New Map";
  }
});

autoCaptureBtn.addEventListener("click", async () => {
  autoCaptureBtn.disabled = true;

  try {
    const captureState = await getCaptureState();
    const nextEnabled = !captureState[AUTO_CAPTURE_ENABLED_STORAGE_KEY];
    if (nextEnabled) {
      await ensureActiveTarget();
    }
    await setAutoCaptureEnabled(nextEnabled);
    await refreshUI();
  } catch (error) {
    console.error("Failed to update continuous save:", error);
    alert(`Could not update continuous save. ${error.message}`);
  } finally {
    autoCaptureBtn.disabled = false;
  }
});

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = "Saving Page...";

  try {
    await ensureActiveTarget();
    const result = await chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" });
    if (!result) {
      alert("The MindWeaver extension background worker did not respond. Reload the unpacked extension in chrome://extensions, then try again.");
      return;
    }
    if (!result?.ok && !result?.skipped) {
      alert(result?.error || "Could not save this page. Make sure the local MindWeaver server is running.");
    }
    await refreshUI();
  } catch (error) {
    console.error("Capture handler error:", error);
    alert(getCaptureErrorMessage(error));
  } finally {
    captureBtn.disabled = false;
    captureBtn.textContent = "Save Current Page";
  }
});

openBtn.addEventListener("click", async () => {
  if (isAppUnavailable) {
    openBtn.disabled = true;
    openBtn.textContent = "Opening...";
    try {
      await chrome.tabs.create({ url: buildMindWeaverProtocolUrl() });
      const connected = await waitForMindWeaver();
      if (!connected) {
        workspaceEl.textContent = "MindWeaver was opened. If setup is still visible, finish it and reopen this popup.";
      }
    } catch (error) {
      console.error("Failed to open MindWeaver protocol:", error);
      alert(`Could not open MindWeaver. ${error.message}`);
    } finally {
      openBtn.disabled = false;
      openBtn.textContent = "Open MindWeaver";
    }
    return;
  }

  const sessionId = currentTargetState?.activeSessionId || currentTargetState?.lastSessionId || "";
  const path = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const webUrl = await client.pickWebUrl(path);
  chrome.tabs.create({ url: webUrl });
});

refreshUI().catch((error) => {
  console.error("Failed to load popup state:", error);
  renderUnavailableState(error);
});
