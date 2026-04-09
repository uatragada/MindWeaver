import { createMindWeaverClient } from "./mindweaver-client.js";

function createBackgroundController({
  chromeApi = chrome,
  client = createMindWeaverClient({ storageArea: chromeApi?.storage?.local }),
  now = () => Date.now()
} = {}) {
  async function setCaptureStatus({ status, title = "", message = "", targetLabel = "" }) {
    await chromeApi.storage.local.set({
      lastCaptureAt: now(),
      lastCaptureTitle: title,
      lastCaptureStatus: status,
      lastCaptureMessage: message,
      lastCaptureTarget: targetLabel
    });
  }

  async function sendToMindWeaver(payload) {
    const targetState = await client.fetchJson("/api/session-target?limit=24");
    const sessionId = targetState.activeSessionId;
    const targetLabel = targetState.activeSession?.goal || "Untitled map";

    if (!sessionId) {
      await setCaptureStatus({
        status: "skipped",
        title: payload.title || payload.url,
        message: "Choose or create a destination map before saving evidence."
      });
      return { ok: false, skipped: true, reason: "No active map." };
    }

    const endpoint = payload.sourceType && payload.sourceType !== "page" ? "import" : "ingest";
    const { payload: body, status } = await client.request(`/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...payload })
    });

    await setCaptureStatus({
      status: body.deduped ? "deduped" : "captured",
      title: payload.title || payload.url,
      message: `Saved to ${targetLabel}.`,
      targetLabel
    });

    return { ok: true, status, body, target: targetState.activeSession };
  }

  async function captureActiveTab() {
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      await setCaptureStatus({ status: "error", message: "No active tab found." });
      return { ok: false, error: "No active tab found." };
    }

    const [injection] = await chromeApi.scripting.executeScript({
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

  async function handleContextMenuClick(info, tab) {
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
  }

  function handleRuntimeMessage(msg, sender, sendResponse) {
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
  }

  function register() {
    chromeApi.runtime.onInstalled.addListener(() => {
      chromeApi.contextMenus.create({
        id: "mindweaver-save-highlight",
        title: "Save selection to MindWeaver",
        contexts: ["selection"]
      });
    });

    chromeApi.contextMenus.onClicked.addListener(handleContextMenuClick);
    chromeApi.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  return {
    captureActiveTab,
    handleContextMenuClick,
    handleRuntimeMessage,
    register,
    sendToMindWeaver,
    setCaptureStatus
  };
}

export { createBackgroundController };
