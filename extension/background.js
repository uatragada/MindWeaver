async function sendToMindWeaver(payload) {
  const { sessionId, isOn } = await chrome.storage.local.get(["sessionId", "isOn"]);
  if (!isOn || !sessionId) return { skipped: true };

  const endpoint = payload.sourceType && payload.sourceType !== "page" ? "import" : "ingest";
  const response = await fetch(`http://localhost:3001/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload })
  });
  const body = await response.json().catch(() => ({}));

  await chrome.storage.local.set({
    lastCaptureAt: Date.now(),
    lastCaptureTitle: payload.title || payload.url,
    lastCaptureStatus: response.ok ? (body.deduped ? "deduped" : "captured") : "skipped",
    lastCaptureMessage: response.ok ? "" : (body.reason || body.error || "Source was not accepted")
  });

  return { response, body };
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
    await chrome.storage.local.set({
      lastCaptureAt: Date.now(),
      lastCaptureStatus: "error",
      lastCaptureMessage: "Could not save the selected highlight"
    });
  }
});

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg?.type !== "PAGE_EXTRACTED") return;

  try {
    await sendToMindWeaver(msg.payload);
  } catch (e) {
    await chrome.storage.local.set({
      lastCaptureAt: Date.now(),
      lastCaptureStatus: "error",
      lastCaptureMessage: "Could not reach the local MindWeaver server"
    });
  }
});
