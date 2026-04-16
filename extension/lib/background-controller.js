import { createMindWeaverClient } from "./mindweaver-client.js";

const CAPTURE_CONTENT_LIMIT_STORAGE_KEY = "mindweaverCaptureContentLimitChars";
const AUTO_CAPTURE_ENABLED_STORAGE_KEY = "mindweaverAutoCaptureEnabled";
const DEFAULT_CAPTURE_CONTENT_LIMIT = 16000;
const AUTO_CAPTURE_HISTORY_SETTLE_MS = 700;

function createBackgroundController({
  chromeApi = chrome,
  client = createMindWeaverClient({ storageArea: chromeApi?.storage?.local }),
  now = () => Date.now()
} = {}) {
  const pendingAutoCaptures = new Set();
  const scheduledHistoryCaptures = new Map();
  const lastAutoCapturedUrlByTabId = new Map();
  const queuedCaptureRequests = [];
  let isProcessingQueuedCaptures = false;

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

  async function getTargetState() {
    return await client.fetchJson("/api/session-target?limit=24");
  }

  async function sendToMindWeaver(payload, { targetState = null } = {}) {
    const resolvedTargetState = targetState ?? await getTargetState();
    const targetStatePayload = resolvedTargetState ?? {};
    const sessionId = targetStatePayload.activeSessionId;
    const targetLabel = String(targetStatePayload.activeSession?.goal ?? "").trim() || "Untitled map";

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

    return { ok: true, status, body, target: targetStatePayload.activeSession };
  }

  async function processQueuedCaptures() {
    if (isProcessingQueuedCaptures) return;
    isProcessingQueuedCaptures = true;

    while (queuedCaptureRequests.length) {
      const nextRequest = queuedCaptureRequests.shift();
      if (!nextRequest) continue;

      try {
        const result = await sendToMindWeaver(nextRequest.payload, { targetState: nextRequest.targetState });
        nextRequest.resolve(result);
      } catch (error) {
        await setCaptureStatus({
          status: "error",
          title: nextRequest.payload?.title || nextRequest.payload?.url,
          message: "Could not save a queued page."
        });
        nextRequest.reject(error);
      }
    }

    isProcessingQueuedCaptures = false;
  }

  async function queueCaptureRequest(payload, { targetState = null, queuedReason = "" } = {}) {
    const resolvedTargetState = targetState ?? await getTargetState();
    if (!resolvedTargetState?.activeSessionId) {
      return await sendToMindWeaver(payload, { targetState: resolvedTargetState });
    }

    const targetLabel = String(resolvedTargetState?.activeSession?.goal ?? "").trim() || "Untitled map";
    const targetId = String(resolvedTargetState?.activeSessionId ?? "").trim();
    const queueDepth = queuedCaptureRequests.length + (isProcessingQueuedCaptures ? 1 : 0) + 1;

    await setCaptureStatus({
      status: "queued",
      title: payload.title || payload.url,
      message: queuedReason || `Queued for ${targetLabel}. ${queueDepth > 1 ? `${queueDepth} saves waiting.` : "Waiting to send."}`,
      targetLabel,
      targetId
    });

    return await new Promise((resolve, reject) => {
      queuedCaptureRequests.push({
        payload,
        targetState: resolvedTargetState,
        resolve,
        reject
      });
      void processQueuedCaptures();
    });
  }

  async function extractTabPayload(tabId = null, { fallbackTab = null } = {}) {
    const tab = fallbackTab ?? await resolveTab(tabId);
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

    return {
      ok: true,
      tab,
      payload: extracted.payload
    };
  }

  async function resolveTab(tabId = null) {
    if (Number.isInteger(tabId) && tabId > 0 && typeof chromeApi.tabs.get === "function") {
      return await chromeApi.tabs.get(tabId);
    }

    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  }

  async function captureTab(tabId = null) {
    const extraction = await extractTabPayload(tabId);
    if (!extraction.ok) return extraction;
    return await queueCaptureRequest(extraction.payload, {
      queuedReason: "Queued for save to the active map."
    });
  }

  async function maybeAutoCaptureTab(tab, { queuedReason = "" } = {}) {
    if (!isAutomaticallyCapturableTab(tab)) return { ok: false, skipped: true, reason: "Tab is not auto-capturable." };
    if (!await isAutoCaptureEnabled()) return { ok: false, skipped: true, reason: "Auto-save is disabled." };

    const navigationKey = `${tab.id}|${tab.url}`;
    if (pendingAutoCaptures.has(navigationKey) || lastAutoCapturedUrlByTabId.get(tab.id) === tab.url) {
      return { ok: false, skipped: true, reason: "Already captured for this navigation." };
    }

    pendingAutoCaptures.add(navigationKey);
    try {
      const extraction = await extractTabPayload(tab.id, { fallbackTab: tab });
      if (!extraction.ok) {
        if (extraction.skipped) {
          lastAutoCapturedUrlByTabId.set(tab.id, tab.url);
        }
        return extraction;
      }

      lastAutoCapturedUrlByTabId.set(tab.id, tab.url);
      const targetState = await getTargetState();
      const result = await queueCaptureRequest(extraction.payload, {
        targetState,
        queuedReason: queuedReason || "Queued automatically after page navigation."
      });
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

  function scheduleHistoryStateCapture(tabId, url) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;

    const existingTimer = scheduledHistoryCaptures.get(numericTabId);
    if (existingTimer) clearTimeout(existingTimer);

    const timerId = setTimeout(() => {
      scheduledHistoryCaptures.delete(numericTabId);
      resolveTab(numericTabId)
        .then((tab) => maybeAutoCaptureTab(tab ? { ...tab, url: url || tab.url } : null, {
          queuedReason: "Queued automatically after in-app navigation."
        }))
        .catch(() => undefined);
    }, AUTO_CAPTURE_HISTORY_SETTLE_MS);

    scheduledHistoryCaptures.set(numericTabId, timerId);
  }

  function handleHistoryStateUpdated(details) {
    if (Number(details?.frameId) !== 0) return;
    scheduleHistoryStateCapture(details?.tabId, details?.url);
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
    chromeApi.webNavigation?.onHistoryStateUpdated?.addListener(handleHistoryStateUpdated);
  }

  return {
    captureActiveTab: () => captureTab(),
    captureTab,
    extractTabPayload,
    handleContextMenuClick,
    handleHistoryStateUpdated,
    handleRuntimeMessage,
    handleTabActivated,
    handleTabUpdated,
    maybeAutoCaptureTab,
    queueCaptureRequest,
    register,
    sendToMindWeaver,
    setCaptureStatus
  };
}

export { createBackgroundController };
