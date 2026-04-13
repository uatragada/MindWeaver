import { createMindWeaverClient } from "./mindweaver-client.js";

const CAPTURE_CONTENT_LIMIT_STORAGE_KEY = "mindweaverCaptureContentLimitChars";
const AUTO_CAPTURE_ENABLED_STORAGE_KEY = "mindweaverAutoCaptureEnabled";
const DEFAULT_CAPTURE_CONTENT_LIMIT = 16000;

function createBackgroundController({
  chromeApi = chrome,
  client = createMindWeaverClient({ storageArea: chromeApi?.storage?.local }),
  now = () => Date.now()
} = {}) {
  const pendingAutoCaptures = new Set();
  const lastAutoCapturedUrlByTabId = new Map();

  function normalizeCaptureContentLimit(healthPayload) {
    const limit = Number(healthPayload?.contentLimitChars);
    if (Number.isFinite(limit) && limit > 0) {
      return Math.floor(limit);
    }
    return DEFAULT_CAPTURE_CONTENT_LIMIT;
  }

  function isAutomaticallyCapturableTab(tab) {
    if (!tab?.active) return false;
    const rawUrl = String(tab?.url ?? "").trim();
    return /^https?:\/\//i.test(rawUrl);
  }

  async function isAutoCaptureEnabled() {
    const stored = await chromeApi.storage.local.get([AUTO_CAPTURE_ENABLED_STORAGE_KEY]);
    return Boolean(stored?.[AUTO_CAPTURE_ENABLED_STORAGE_KEY]);
  }

  async function syncCaptureContentLimit() {
    const healthPayload = await client.fetchJson("/api/health").catch(() => null);
    const captureContentLimit = normalizeCaptureContentLimit(healthPayload);
    await chromeApi.storage.local.set({
      [CAPTURE_CONTENT_LIMIT_STORAGE_KEY]: captureContentLimit
    });
    return captureContentLimit;
  }

  async function setCaptureStatus({ status, title = "", message = "", targetLabel = "", targetId = "" }) {
    await chromeApi.storage.local.set({
      lastCaptureAt: now(),
      lastCaptureTitle: title,
      lastCaptureStatus: status,
      lastCaptureMessage: message,
      lastCaptureTarget: targetLabel,
      lastCaptureTargetId: targetId
    });
  }

  async function sendToMindWeaver(payload) {
    const targetState = await client.fetchJson("/api/session-target?limit=24");
    const sessionId = targetState.activeSessionId;
    const targetLabel = String(targetState.activeSession?.goal ?? "").trim() || "Untitled map";

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
      targetLabel,
      targetId: sessionId
    });

    return { ok: true, status, body, target: targetState.activeSession };
  }

  async function resolveTab(tabId = null) {
    if (Number.isInteger(tabId) && tabId > 0 && typeof chromeApi.tabs.get === "function") {
      return await chromeApi.tabs.get(tabId);
    }

    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  }

  async function captureTab(tabId = null) {
    const tab = await resolveTab(tabId);
    if (!tab?.id) {
      await setCaptureStatus({ status: "error", message: "No active tab found." });
      return { ok: false, error: "No active tab found." };
    }

    await syncCaptureContentLimit();
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

  async function maybeAutoCaptureTab(tab) {
    if (!isAutomaticallyCapturableTab(tab)) return { ok: false, skipped: true, reason: "Tab is not auto-capturable." };
    if (!await isAutoCaptureEnabled()) return { ok: false, skipped: true, reason: "Auto-save is disabled." };

    const navigationKey = `${tab.id}|${tab.url}`;
    if (pendingAutoCaptures.has(navigationKey) || lastAutoCapturedUrlByTabId.get(tab.id) === tab.url) {
      return { ok: false, skipped: true, reason: "Already captured for this navigation." };
    }

    pendingAutoCaptures.add(navigationKey);
    try {
      const result = await captureTab(tab.id);
      if (result?.ok || result?.skipped) {
        lastAutoCapturedUrlByTabId.set(tab.id, tab.url);
      }
      return result;
    } catch (error) {
      await setCaptureStatus({
        status: "error",
        title: tab.title || tab.url,
        message: "Could not auto-save the current page."
      });
      return { ok: false, error: error?.message || "Could not auto-save the current page." };
    } finally {
      pendingAutoCaptures.delete(navigationKey);
    }
  }

  function handleTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo?.status !== "complete") return;
    void maybeAutoCaptureTab({ ...tab, id: tab?.id ?? tabId });
  }

  function handleTabActivated(activeInfo) {
    const tabId = Number(activeInfo?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return;

    resolveTab(tabId)
      .then((tab) => maybeAutoCaptureTab(tab))
      .catch(() => undefined);
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

    captureTab()
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
    chromeApi.tabs.onUpdated.addListener(handleTabUpdated);
    chromeApi.tabs.onActivated.addListener(handleTabActivated);
  }

  return {
    captureActiveTab: () => captureTab(),
    captureTab,
    handleContextMenuClick,
    handleRuntimeMessage,
    handleTabActivated,
    handleTabUpdated,
    maybeAutoCaptureTab,
    register,
    sendToMindWeaver,
    setCaptureStatus
  };
}

export { createBackgroundController };
