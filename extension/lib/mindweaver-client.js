const DEFAULT_API_BASES = ["http://127.0.0.1:3001", "http://localhost:3001"];
const API_BASE_STORAGE_KEYS = ["mindweaverApiBase", "mindweaverApiBases"];

function normalizeBase(base) {
  return String(base ?? "").trim().replace(/\/+$/, "");
}

function dedupeBases(bases) {
  return [...new Set(
    bases
      .map((base) => normalizeBase(base))
      .filter(Boolean)
  )];
}

function isRetryableBaseError(error) {
  if (!error) return false;
  if (typeof error.status === "number") return error.status >= 500;
  const message = String(error.message ?? "");
  return /failed to fetch|fetch failed|networkerror|load failed|refused|abort/i.test(message);
}

async function readConfiguredApiBases(storageArea, defaultApiBases = DEFAULT_API_BASES) {
  if (!storageArea?.get) return dedupeBases(defaultApiBases);

  const stored = await storageArea.get(API_BASE_STORAGE_KEYS);
  return dedupeBases([
    ...(Array.isArray(stored.mindweaverApiBases) ? stored.mindweaverApiBases : []),
    stored.mindweaverApiBase,
    ...defaultApiBases
  ]);
}

function buildBaseError(error, bases) {
  const message = error?.message || "Could not reach the local MindWeaver server.";
  const enriched = new Error(`${message} Tried: ${bases.join(", ")}`);
  if (error?.status) enriched.status = error.status;
  if (error?.payload) enriched.payload = error.payload;
  if (error?.base) enriched.base = error.base;
  return enriched;
}

function buildWebAppCandidates(apiBase, path = "") {
  const normalizedPath = path
    ? (String(path).startsWith("/") ? String(path) : `/${String(path)}`)
    : "/";
  const parsed = new URL(apiBase);
  return dedupeBases([
    `${parsed.origin}${normalizedPath}`,
    `http://${parsed.hostname}:5197${normalizedPath}`
  ]);
}

function isHtmlLikeContentType(contentType) {
  return !contentType || /text\/html|application\/xhtml\+xml/i.test(String(contentType));
}

function createMindWeaverClient({
  fetchImpl = (...args) => fetch(...args),
  storageArea = null,
  defaultApiBases = DEFAULT_API_BASES
} = {}) {
  let preferredBase = null;

  async function getApiBases() {
    const configuredBases = await readConfiguredApiBases(storageArea, defaultApiBases);
    return preferredBase ? dedupeBases([preferredBase, ...configuredBases]) : configuredBases;
  }

  async function request(path, options = {}) {
    const bases = await getApiBases();
    let lastError = null;

    for (const base of bases) {
      try {
        const response = await fetchImpl(`${base}${path}`, { cache: "no-store", ...options });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          const error = new Error(payload.error || payload.reason || `Request failed with status ${response.status}`);
          error.status = response.status;
          error.payload = payload;
          error.base = base;
          throw error;
        }

        preferredBase = base;
        return {
          base,
          payload,
          status: response.status
        };
      } catch (error) {
        lastError = error;
        if (!isRetryableBaseError(error) || base === bases[bases.length - 1]) {
          throw buildBaseError(error, bases);
        }
      }
    }

    throw buildBaseError(lastError, bases);
  }

  async function fetchJson(path, options = {}) {
    const { payload } = await request(path, options);
    return payload;
  }

  async function getPreferredBase() {
    if (preferredBase) return preferredBase;
    const { base } = await request("/api/health", { method: "GET", cache: "no-store" });
    return base;
  }

  async function canOpenWebUrl(url) {
    try {
      const response = await fetchImpl(url, { method: "GET", cache: "no-store" });
      if (!response?.ok) return false;

      const headerContentType = typeof response.headers?.get === "function"
        ? response.headers.get("content-type")
        : response.headers?.["content-type"];
      return isHtmlLikeContentType(headerContentType);
    } catch {
      return false;
    }
  }

  async function pickWebUrl(path = "") {
    const apiBase = await getPreferredBase().catch(() => defaultApiBases[0]);
    const candidates = buildWebAppCandidates(apiBase, path);

    for (const candidate of candidates) {
      if (await canOpenWebUrl(candidate)) return candidate;
    }

    return candidates[candidates.length - 1] ?? buildWebAppCandidates(defaultApiBases[0], path)[0];
  }

  return {
    fetchJson,
    getApiBases,
    getPreferredBase,
    pickWebUrl,
    request
  };
}

export {
  API_BASE_STORAGE_KEYS,
  DEFAULT_API_BASES,
  buildWebAppCandidates,
  createMindWeaverClient,
  dedupeBases,
  isRetryableBaseError,
  normalizeBase,
  readConfiguredApiBases
};
