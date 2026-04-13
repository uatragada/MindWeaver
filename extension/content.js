(async () => {
  const MAX_EXCERPT_CHARS = 280;
  const DEFAULT_MAX_CONTENT_CHARS = 16000;
  const ALLOW_LOCAL_CAPTURE_STORAGE_KEY = "mindweaverAllowLocalPageCapture";
  const MAX_CONTENT_CHARS_STORAGE_KEY = "mindweaverCaptureContentLimitChars";
  const SKIPPED_HOST_PARTS = [
    "localhost",
    "127.0.0.1",
    "mail.",
    "accounts.",
    "login.",
    "paypal.com",
    "stripe.com",
    "bank",
    "chase.com",
    "wellsfargo.com",
    "capitalone.com"
  ];
  const CONTENT_BLOCK_SELECTORS = ["h1", "h2", "h3", "p", "li", "blockquote", "dt", "dd"];
  const REMOVABLE_CONTENT_SELECTORS = [
    "script",
    "style",
    "noscript",
    "nav",
    "aside",
    "header",
    "footer",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "[role=\"navigation\"]",
    "[aria-hidden=\"true\"]",
    "#toc",
    ".toc",
    ".vector-toc",
    ".vector-page-toolbar",
    ".vector-sticky-pinned-container",
    ".mw-editsection",
    ".navbox",
    ".metadata",
    ".reflist",
    ".infobox",
    ".sidebar",
    ".page-actions",
    ".breadcrumbs",
    ".language-list",
    "sup.reference"
  ];

  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el?.getAttribute("content") || "";
  }

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  async function getAllowLocalCapture() {
    try {
      const stored = await chrome.storage.local.get([ALLOW_LOCAL_CAPTURE_STORAGE_KEY]);
      return stored[ALLOW_LOCAL_CAPTURE_STORAGE_KEY] === true;
    } catch {
      return false;
    }
  }

  async function getMaxContentChars() {
    try {
      const stored = await chrome.storage.local.get([MAX_CONTENT_CHARS_STORAGE_KEY]);
      const value = Number(stored[MAX_CONTENT_CHARS_STORAGE_KEY]);
      if (Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
    } catch {
      // Fall back to the default capture limit when storage is unavailable.
    }

    return DEFAULT_MAX_CONTENT_CHARS;
  }

  function getSkipReason({ allowLocalCapture }) {
    const host = location.hostname.toLowerCase();
    if (!["http:", "https:"].includes(location.protocol)) return "MindWeaver only saves normal web pages.";
    if (!allowLocalCapture && SKIPPED_HOST_PARTS.some((part) => host.includes(part))) {
      return "Skipped this page because it looks private, local, financial, or account-related.";
    }
    if (document.querySelector('input[type="password"]')) return "Skipped this page because it contains a password field.";
    return "";
  }

  function extractKeywords() {
    const kw = getMeta("keywords");
    if (!kw) return [];
    return kw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  function removeNoisyContent(root) {
    for (const node of root.querySelectorAll(REMOVABLE_CONTENT_SELECTORS.join(","))) {
      node.remove();
    }
  }

  function isMeaningfulContentBlock(tagName, text) {
    if (!text) return false;
    if (/^h[1-3]$/i.test(tagName)) return text.length <= 180;
    return text.length >= 35;
  }

  function extractReadableTextFromRoot(root) {
    if (!root) return "";

    const clone = root.cloneNode(true);
    removeNoisyContent(clone);

    const blocks = [];
    const seen = new Set();

    for (const node of clone.querySelectorAll(CONTENT_BLOCK_SELECTORS.join(","))) {
      const tagName = node.tagName.toLowerCase();
      const text = normalizeText(node.innerText || node.textContent);
      if (!isMeaningfulContentBlock(tagName, text)) continue;

      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(text);
    }

    const blockText = normalizeText(blocks.join(" "));
    if (blockText.length >= 500) return blockText;

    const fallbackText = normalizeText(clone.innerText || clone.textContent || "");
    return fallbackText.length >= 500 ? fallbackText : "";
  }

  function getReadableText() {
    const preferredText = [
      document.querySelector("article"),
      document.querySelector("main article"),
      document.querySelector('[role="main"] article'),
      document.querySelector("main"),
      document.querySelector('[role="main"]')
    ]
      .map((node) => extractReadableTextFromRoot(node))
      .find((text) => text.length > 500);

    if (preferredText) return preferredText;
    return extractReadableTextFromRoot(document.body) || normalizeText(document.body?.innerText || "");
  }

  function extractExcerpt(readableText) {
    const desc = getMeta("description");
    if (desc) return desc.slice(0, MAX_EXCERPT_CHARS);
    return readableText.slice(0, MAX_EXCERPT_CHARS);
  }

  const skipReason = getSkipReason({
    allowLocalCapture: await getAllowLocalCapture()
  });
  if (skipReason) {
    return {
      ok: false,
      reason: skipReason,
      title: document.title || location.href,
      url: location.href
    };
  }

  const readableText = getReadableText();
  const maxContentChars = await getMaxContentChars();
  return {
    ok: true,
    payload: {
      sourceType: "page",
      url: location.href,
      title: document.title || "",
      keywords: extractKeywords(),
      excerpt: extractExcerpt(readableText),
      content: readableText.slice(0, maxContentChars)
    }
  };
})();
