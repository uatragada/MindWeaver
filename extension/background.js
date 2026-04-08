async function setCaptureStatus({ status, title = "", message = "" }) {
  await chrome.storage.local.set({
    lastCaptureAt: Date.now(),
    lastCaptureTitle: title,
    lastCaptureStatus: status,
    lastCaptureMessage: message
  });
}

async function sendToMindWeaver(payload) {
  const { sessionId, isOn } = await chrome.storage.local.get(["sessionId", "isOn"]);
  if (!isOn || !sessionId) {
    await setCaptureStatus({
      status: "skipped",
      title: payload.title || payload.url,
      message: "Start or create a map before saving evidence."
    });
    return { ok: false, skipped: true, reason: "No active map." };
  }

  const endpoint = payload.sourceType && payload.sourceType !== "page" ? "import" : "ingest";
  const response = await fetch(`http://localhost:3001/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload })
  });
  const body = await response.json().catch(() => ({}));

  await setCaptureStatus({
    status: response.ok ? (body.deduped ? "deduped" : "captured") : "skipped",
    title: payload.title || payload.url,
    message: response.ok ? "" : (body.reason || body.error || "Source was not accepted")
  });

  return { ok: response.ok, status: response.status, body };
}

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await setCaptureStatus({ status: "error", message: "No active tab found." });
    return { ok: false, error: "No active tab found." };
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });
  const extracted = injection?.result;

  if (!extracted?.ok) {
    await setCaptureStatus({
      status: "skipped",
      title: extracted?.title || tab.title || tab.url,
      message: extracted?.reason || "MindWeaver could not read this page."
    });
    return { ok: false, skipped: true, reason: extracted?.reason || "MindWeaver could not read this page." };
  }

  return await sendToMindWeaver(extracted.payload);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "mindweaver-save-highlight",
    title: "Save selection to MindWeaver",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "mindweaver-save-highlight" || !info.selectionText?.trim()) return;

  try {
    await sendToMindWeaver({
      sourceType: "highlight",
      url: tab?.url,
      title: `Highlight: ${tab?.title || "Untitled page"}`,
      excerpt: info.selectionText.trim().slice(0, 280),
      content: info.selectionText.trim()
    });
  } catch {
    await setCaptureStatus({
      status: "error",
      message: "Could not save the selected highlight."
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "CAPTURE_ACTIVE_TAB") return false;

  captureActiveTab()
    .then((result) => sendResponse(result))
    .catch(async (error) => {
      await setCaptureStatus({
        status: "error",
        message: "Could not save the current page."
      });
      sendResponse({ ok: false, error: error?.message || "Could not save the current page." });
    });

  return true;
});
