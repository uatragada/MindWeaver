const DEFAULT_TIMEOUT_MS = 15000;

function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS, label = "OpenAI request") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function parseJsonCandidate(candidate) {
  if (!candidate) return null;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function findBalancedJson(text) {
  const start = text.search(/[\[{]/);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return null;
}

export function extractStructuredJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidates = [fencedMatch?.[1], raw, findBalancedJson(raw)];

  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

export async function requestStructuredJson(openaiClient, options) {
  if (!openaiClient) return null;
  const { timeoutMs, label, ...requestOptions } = options;

  const response = await withTimeout(
    openaiClient.chat.completions.create(requestOptions),
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label ?? "OpenAI JSON request"
  );

  const content = response?.choices?.[0]?.message?.content ?? "";
  return extractStructuredJson(content);
}

export async function requestText(openaiClient, options) {
  if (!openaiClient) return null;
  const { timeoutMs, label, ...requestOptions } = options;

  const response = await withTimeout(
    openaiClient.chat.completions.create(requestOptions),
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label ?? "OpenAI text request"
  );

  return response?.choices?.[0]?.message?.content?.trim() ?? null;
}
