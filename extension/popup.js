import { createMindWeaverClient } from "./lib/mindweaver-client.js";

const statusEl = document.getElementById("status");
const workspaceEl = document.getElementById("workspace");
const targetEl = document.getElementById("target");
const createBtn = document.getElementById("create");
const endBtn = document.getElementById("end");
const captureBtn = document.getElementById("capture");
const goalEl = document.getElementById("goal");
const openBtn = document.getElementById("open");
const lastCaptureEl = document.getElementById("lastCapture");
let currentTargetState = null;
const client = createMindWeaverClient({ storageArea: chrome.storage?.local });

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

async function getCaptureState() {
  return await chrome.storage.local.get([
    "lastCaptureAt",
    "lastCaptureTitle",
    "lastCaptureStatus",
    "lastCaptureMessage",
    "lastCaptureTarget"
  ]);
}

function renderTargetOptions(targetState) {
  const sessions = targetState.sessions ?? [];
  const activeSessionId = targetState.activeSessionId ?? "";
  targetEl.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = sessions.length ? "No active destination map" : "Create a map first";
  targetEl.append(placeholder);

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = `${session.goal || "Untitled map"}${session.endedAt ? " (ended)" : ""}`;
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

  renderTargetOptions(targetState);
  const workspaceName = targetState.workspaces?.[0]?.name || "Personal Learning";
  const activeLabel = targetState.activeSession?.goal || "No active map selected";
  const lastLabel = targetState.lastSession?.goal || "None yet";

  statusEl.textContent = activeLabel;
  workspaceEl.textContent = `${workspaceName} • Last used ${lastLabel}`;
  endBtn.disabled = !targetState.activeSessionId;
  captureBtn.disabled = false;
  lastCaptureEl.textContent = captureState.lastCaptureAt
    ? `${titleCaseStatus(captureState.lastCaptureStatus || "saved")} • ${captureState.lastCaptureTitle || captureState.lastCaptureMessage || new Date(captureState.lastCaptureAt).toLocaleTimeString()}${captureState.lastCaptureTarget ? ` (${captureState.lastCaptureTarget})` : ""}`
    : "None yet";

  return targetState;
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
    throw new Error("Choose an existing map or enter a goal to create one before saving.");
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

endBtn.addEventListener("click", async () => {
  const activeSessionId = currentTargetState?.activeSessionId;
  if (!activeSessionId) return;

  endBtn.disabled = true;
  endBtn.textContent = "Ending...";

  try {
    await client.fetchJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/end`, { method: "POST" });
    await refreshUI();
  } catch (error) {
    console.error("Failed to end session:", error);
    alert(`Could not end the active map. ${error.message}`);
  } finally {
    endBtn.disabled = false;
    endBtn.textContent = "End Active Map";
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
  const sessionId = currentTargetState?.activeSessionId || currentTargetState?.lastSessionId || "";
  const path = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const webUrl = await client.pickWebUrl(path);
  chrome.tabs.create({ url: webUrl });
});

refreshUI().catch((error) => {
  console.error("Failed to load popup state:", error);
  statusEl.textContent = "Unavailable";
  workspaceEl.textContent = "Connect to the local MindWeaver server";
  lastCaptureEl.textContent = "Unavailable";
});
