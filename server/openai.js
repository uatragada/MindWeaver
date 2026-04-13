import Ajv from "ajv";

const DEFAULT_TIMEOUT_MS = 15000;
const OLLAMA_STATUS_TIMEOUT_MS = 2500;
const structuredOutputAjv = new Ajv({ allErrors: true, strict: false });
const structuredOutputValidators = new WeakMap();

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_LOCAL_MODEL = "qwen3.5:4b";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const STRUCTURED_JSON_ONLY_INSTRUCTION = "Return only valid JSON that strictly matches the provided schema. Do not add markdown fences or any extra commentary.";

export const LOCAL_MODEL_OPTIONS = [
  { value: DEFAULT_LOCAL_MODEL, label: "Qwen3.5 4B" }
];

function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS, label = "LLM request") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function createUnavailableError(message) {
  const error = new Error(message);
  error.code = "LLM_UNAVAILABLE";
  return error;
}

function normalizeBaseUrl(baseUrl = DEFAULT_OLLAMA_BASE_URL) {
  return String(baseUrl || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_OLLAMA_BASE_URL;
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

function buildOllamaOptions({ temperature, max_completion_tokens }) {
  const options = {};

  if (Number.isFinite(temperature)) {
    options.temperature = temperature;
  }

  if (Number.isFinite(max_completion_tokens)) {
    options.num_predict = Math.max(1, Math.floor(max_completion_tokens));
  }

  return Object.keys(options).length ? options : undefined;
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  return schema;
}

function createStructuredOutputError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function getStructuredOutputValidator(schema) {
  const normalizedSchema = normalizeJsonSchema(schema);
  if (!normalizedSchema) return null;

  let validator = structuredOutputValidators.get(normalizedSchema);
  if (validator) return validator;

  validator = structuredOutputAjv.compile(normalizedSchema);
  structuredOutputValidators.set(normalizedSchema, validator);
  return validator;
}

function decodeJsonPointerSegment(segment) {
  return String(segment ?? "")
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
}

function formatJsonPointer(instancePath = "") {
  if (!instancePath) return "$";

  return `$${instancePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const decoded = decodeJsonPointerSegment(segment);
      return /^\d+$/.test(decoded) ? `[${decoded}]` : `.${decoded}`;
    })
    .join("")}`;
}

function formatStructuredValidationErrors(errors = []) {
  return errors
    .slice(0, 3)
    .map((error) => {
      const path = formatJsonPointer(error?.instancePath);

      if (error?.keyword === "additionalProperties" && error?.params?.additionalProperty) {
        return `${path} has unsupported property "${error.params.additionalProperty}"`;
      }

      if (error?.keyword === "required" && error?.params?.missingProperty) {
        return `${path} is missing required property "${error.params.missingProperty}"`;
      }

      return `${path} ${error?.message ?? "failed validation"}`;
    })
    .join("; ");
}

function validateStructuredJsonPayload(payload, schema, label = "Structured output") {
  const validator = getStructuredOutputValidator(schema);
  if (!validator) return payload;
  if (validator(payload)) return payload;

  const details = formatStructuredValidationErrors(validator.errors);
  throw createStructuredOutputError(
    `${label} did not match the expected schema${details ? `: ${details}` : "."}`,
    "LLM_SCHEMA_INVALID",
    { validationErrors: validator.errors ?? [] }
  );
}

function normalizeStructuredJsonPayload(payload, normalizeResult) {
  if (typeof normalizeResult !== "function") return payload;
  const normalized = normalizeResult(payload);
  return normalized === undefined ? payload : normalized;
}

function parseStructuredJsonResponse(text, schema, label = "Structured output", { normalizeResult = null } = {}) {
  const parsed = extractStructuredJson(text);
  if (parsed === null) {
    throw createStructuredOutputError(`${label} did not contain valid JSON.`, "LLM_INVALID_JSON");
  }

  const normalizedPayload = normalizeStructuredJsonPayload(parsed, normalizeResult);
  return validateStructuredJsonPayload(normalizedPayload, schema, label);
}

function getLocalModelLabel(modelName) {
  const normalizedModel = String(modelName ?? "").trim();
  if (!normalizedModel) return LOCAL_MODEL_OPTIONS[0]?.label ?? DEFAULT_LOCAL_MODEL;
  return LOCAL_MODEL_OPTIONS.find((option) => option.value === normalizedModel)?.label ?? normalizedModel;
}

function normalizeResponseContent(content) {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "output_text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function buildSchemaName(label = "structured-output") {
  return String(label ?? "structured-output")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "structured_output";
}

function buildOpenAiResponseFormat(schema, label) {
  const normalizedSchema = normalizeJsonSchema(schema);
  if (!normalizedSchema) return undefined;

  return {
    type: "json_schema",
    json_schema: {
      name: buildSchemaName(label),
      strict: true,
      schema: normalizedSchema
    }
  };
}

function buildOllamaMessages(messages, schema) {
  const safeMessages = Array.isArray(messages)
    ? messages
      .filter((message) => message && typeof message === "object")
      .map((message) => ({
        ...message,
        role: typeof message.role === "string" ? message.role : "user",
        content: typeof message.content === "string" ? message.content : String(message.content ?? "")
      }))
    : [];

  if (!schema) return safeMessages;
  if (!safeMessages.length) {
    return [{ role: "system", content: STRUCTURED_JSON_ONLY_INSTRUCTION }];
  }

  const [firstMessage, ...rest] = safeMessages;
  if (firstMessage.role === "system") {
    return [{
      ...firstMessage,
      content: `${firstMessage.content}\n\n${STRUCTURED_JSON_ONLY_INSTRUCTION}`.trim()
    }, ...rest];
  }

  return [{ role: "system", content: STRUCTURED_JSON_ONLY_INSTRUCTION }, ...safeMessages];
}

function compareLocalModels(left, right) {
  if (left.value === DEFAULT_LOCAL_MODEL && right.value !== DEFAULT_LOCAL_MODEL) return -1;
  if (right.value === DEFAULT_LOCAL_MODEL && left.value !== DEFAULT_LOCAL_MODEL) return 1;
  return left.label.localeCompare(right.label);
}

async function requestOpenAiText({ openaiClient, options }) {
  if (!openaiClient) {
    throw createUnavailableError("OpenAI is not configured on the local MindWeaver server.");
  }

  const requestOptions = { ...(options ?? {}) };
  const timeoutMs = requestOptions.timeoutMs;
  const label = requestOptions.label;
  const schema = requestOptions.schema;
  delete requestOptions.timeoutMs;
  delete requestOptions.label;
  delete requestOptions.schema;
  delete requestOptions.normalizeResult;
  const responseFormat = buildOpenAiResponseFormat(schema, label);
  const response = await withTimeout(
    openaiClient.chat.completions.create({
      ...requestOptions,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      model: requestOptions.model || DEFAULT_OPENAI_MODEL
    }),
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label ?? "OpenAI request"
  );

  return normalizeResponseContent(response?.choices?.[0]?.message?.content);
}

async function requestOllamaText({ ollamaBaseUrl, options }) {
  const normalizedBaseUrl = normalizeBaseUrl(ollamaBaseUrl);
  const model = String(options.model ?? DEFAULT_LOCAL_MODEL).trim() || DEFAULT_LOCAL_MODEL;
  const { timeoutMs, label, messages, schema } = options;
  const normalizedSchema = normalizeJsonSchema(schema);

  const body = {
    model,
    messages: buildOllamaMessages(messages, normalizedSchema),
    stream: false,
    think: false,
    options: buildOllamaOptions(options)
  };

  if (normalizedSchema) {
    body.format = normalizedSchema;
  }

  try {
    const payload = await withTimeout(
      fetch(`${normalizedBaseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(body)
      }).then(async (response) => {
        const responseText = await response.text();
        const parsed = parseJsonCandidate(responseText) ?? {};

        if (!response.ok) {
          throw createUnavailableError(parsed?.error || `Ollama request failed with status ${response.status}.`);
        }

        return parsed;
      }),
      timeoutMs ?? DEFAULT_TIMEOUT_MS,
      label ?? "Ollama request"
    );

    return normalizeResponseContent(payload?.message?.content);
  } catch (error) {
    if (error?.code === "LLM_UNAVAILABLE") throw error;
    throw createUnavailableError(`Ollama is unavailable at ${normalizedBaseUrl}. ${error.message}`);
  }
}

async function requestModelText(runtime, options) {
  const llmProvider = normalizeLlmSelection(runtime?.llmProvider);

  if (llmProvider.provider === "local") {
    return requestOllamaText({
      ollamaBaseUrl: runtime?.ollamaBaseUrl,
      options: {
        ...options,
        model: llmProvider.model
      }
    });
  }

  return requestOpenAiText({
    openaiClient: runtime?.openaiClient,
    options: {
      ...options,
      model: llmProvider.model || DEFAULT_OPENAI_MODEL
    }
  });
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

export function normalizeLlmSelection(rawSelection = {}) {
  const requestedProvider = String(rawSelection?.provider ?? "").trim().toLowerCase();
  const provider = requestedProvider === "local" ? "local" : "openai";
  const requestedModel = String(rawSelection?.model ?? "").trim();

  if (provider === "local") {
    return {
      provider,
      model: requestedModel || DEFAULT_LOCAL_MODEL
    };
  }

  return {
    provider,
    model: requestedModel || DEFAULT_OPENAI_MODEL
  };
}

export function getLlmProviderLabel(rawSelection = {}) {
  const selection = normalizeLlmSelection(rawSelection);

  if (selection.provider === "local") {
    const modelLabel = getLocalModelLabel(selection.model);
    return `Local (${modelLabel} via Ollama)`;
  }

  return "OpenAI";
}

export async function getOllamaStatus({ baseUrl = DEFAULT_OLLAMA_BASE_URL } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  try {
    const response = await withTimeout(
      fetch(`${normalizedBaseUrl}/api/tags`, {
        method: "GET",
        headers: { Accept: "application/json" }
      }),
      OLLAMA_STATUS_TIMEOUT_MS,
      "Ollama health check"
    );
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        available: false,
        baseUrl: normalizedBaseUrl,
        error: payload?.error || `Ollama returned status ${response.status}.`,
        models: []
      };
    }

    const discoveredModels = Array.isArray(payload?.models) ? payload.models : [];
    const dynamicModels = Array.from(new Set(
      discoveredModels.map((model) => String(model?.name ?? "").trim()).filter(Boolean)
    ))
      .map((name) => ({
        value: name,
        label: getLocalModelLabel(name),
        installed: true
      }))
      .sort(compareLocalModels);

    return {
      available: true,
      baseUrl: normalizedBaseUrl,
      error: null,
      models: dynamicModels
    };
  } catch (error) {
    return {
      available: false,
      baseUrl: normalizedBaseUrl,
      error: error.message,
      models: []
    };
  }
}

export async function requestStructuredJson(runtime, options) {
  const llmProvider = normalizeLlmSelection(runtime?.llmProvider);
  const schema = normalizeJsonSchema(options?.schema);
  const label = options?.label ?? "Structured output";
  const normalizeResult = typeof options?.normalizeResult === "function" ? options.normalizeResult : null;

  if (llmProvider.provider === "local") {
    const content = await requestOllamaText({
      ollamaBaseUrl: runtime?.ollamaBaseUrl,
      options: {
        ...options,
        model: llmProvider.model,
        schema
      }
    });

    return parseStructuredJsonResponse(content, schema, label, { normalizeResult });
  }

  const content = await requestOpenAiText({
    openaiClient: runtime?.openaiClient,
    options: {
      ...options,
      model: llmProvider.model || DEFAULT_OPENAI_MODEL
    }
  });

  return parseStructuredJsonResponse(content, schema, label, { normalizeResult });
}

export async function requestText(runtime, options) {
  return requestModelText(runtime, options);
}
