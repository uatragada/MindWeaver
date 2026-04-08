const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle");
const captureBtn = document.getElementById("capture");
const goalEl = document.getElementById("goal");
const openBtn = document.getElementById("open");
const lastCaptureEl = document.getElementById("lastCapture");

async function getState() {
  return await chrome.storage.local.get(["sessionId", "isOn", "goal", "lastCaptureAt", "lastCaptureTitle", "lastCaptureStatus", "lastCaptureMessage"]);
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

async function pickWebUrl() {
  const candidates = ["http://localhost:5197", "http://localhost:3001"];

  for (const candidate of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 700);
      await fetch(candidate, { method: "GET", cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);
      return candidate;
    } catch {
      // Try the next local app URL.
    }
  }

  return candidates[0];
}

async function refreshUI() {
  const { sessionId, isOn, goal, lastCaptureAt, lastCaptureTitle, lastCaptureStatus, lastCaptureMessage } = await getState();
  goalEl.value = goal || "";
  statusEl.textContent = `Map: ${isOn ? "active" : "not active"}${sessionId ? ` (session ${sessionId})` : ""}`;
  toggleBtn.textContent = isOn ? "End Current Map" : "Start New Map";
  captureBtn.disabled = false;
  lastCaptureEl.textContent = lastCaptureAt
    ? `Last save: ${lastCaptureStatus} - ${lastCaptureTitle || lastCaptureMessage || new Date(lastCaptureAt).toLocaleTimeString()}`
    : "Last save: none yet";
}

async function createSessionIfNeeded() {
  const { sessionId, isOn } = await getState();
  if (isOn && sessionId) return sessionId;

  const goal = goalEl.value.trim();
  const r = await fetch("http://localhost:3001/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: goal || null })
  });

  if (!r.ok) throw new Error("Could not create a MindWeaver session.");
  const s = await r.json();
  await setState({ sessionId: s.id, isOn: true, goal: goal || null });
  return s.id;
}

toggleBtn.addEventListener("click", async () => {
  try {
    const { sessionId, isOn } = await getState();

    if (!isOn) {
      try {
        await createSessionIfNeeded();
      } catch (err) {
        console.error("Failed to create session:", err);
        alert("Could not connect to server. Make sure http://localhost:3001 is running.");
      }
    } else {
      if (sessionId) {
        try {
          await fetch(`http://localhost:3001/api/sessions/${sessionId}/end`, { method: "POST" });
        } catch (err) {
          console.error("Failed to end session:", err);
        }
      }
      await setState({ isOn: false });
    }

    await refreshUI();
  } catch (err) {
    console.error("Click handler error:", err);
  }
});

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  captureBtn.textContent = "Saving Page...";

  try {
    await createSessionIfNeeded();
    const result = await chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" });
    if (!result?.ok && !result?.skipped) {
      alert(result?.error || "Could not save this page. Make sure the local server is running.");
    }
    await refreshUI();
  } catch (err) {
    console.error("Capture handler error:", err);
    alert("Could not save this page. Make sure http://localhost:3001 is running.");
  } finally {
    captureBtn.disabled = false;
    captureBtn.textContent = "Save Current Page";
  }
});

openBtn.addEventListener("click", async () => {
  const { sessionId } = await getState();
  const path = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const webUrl = await pickWebUrl();
  chrome.tabs.create({ url: `${webUrl}/${path}` });
});

refreshUI();
