(() => {
  const MAX_EXCERPT_CHARS = 280;
  const MAX_CONTENT_CHARS = 16000;
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

  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el?.getAttribute("content") || "";
  }

  function getSkipReason() {
    const host = location.hostname.toLowerCase();
    if (!["http:", "https:"].includes(location.protocol)) return "MindWeaver only saves normal web pages.";
    if (SKIPPED_HOST_PARTS.some((part) => host.includes(part))) return "Skipped this page because it looks private, local, financial, or account-related.";
    if (document.querySelector('input[type="password"]')) return "Skipped this page because it contains a password field.";
    return "";
  }

  function extractKeywords() {
    const kw = getMeta("keywords");
    if (!kw) return [];
    return kw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  function getReadableText() {
    const preferredText = [
      document.querySelector("article"),
      document.querySelector("main"),
      document.querySelector('[role="main"]')
    ]
      .map((node) => node?.innerText || "")
      .map((text) => text.replace(/\s+/g, " ").trim())
      .find((text) => text.length > 500);

    if (preferredText) return preferredText;
    return (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  }

  function extractExcerpt(readableText) {
    const desc = getMeta("description");
    if (desc) return desc.slice(0, MAX_EXCERPT_CHARS);
    return readableText.slice(0, MAX_EXCERPT_CHARS);
  }

  const skipReason = getSkipReason();
  if (skipReason) {
    return {
      ok: false,
      reason: skipReason,
      title: document.title || location.href,
      url: location.href
    };
  }

  const readableText = getReadableText();
  return {
    ok: true,
    payload: {
      sourceType: "page",
      url: location.href,
      title: document.title || "",
      keywords: extractKeywords(),
      excerpt: extractExcerpt(readableText),
      content: readableText.slice(0, MAX_CONTENT_CHARS)
    }
  };
})();
