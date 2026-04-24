import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const openAiPlaceholder = "your_openai_api_key_here";

function normalizeEnvContents(contents) {
  return String(contents ?? "").replace(/\r\n/g, "\n");
}

function ensureTrailingNewline(contents) {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureEnvLocalFile({ envLocalPath, envExamplePath }) {
  if (existsSync(envLocalPath)) {
    return;
  }

  if (envExamplePath && existsSync(envExamplePath)) {
    const exampleContents = normalizeEnvContents(readFileSync(envExamplePath, "utf8"));
    const sanitizedContents = exampleContents.replace(/^OPENAI_API_KEY\s*=.*$/m, "OPENAI_API_KEY=");
    writeFileSync(envLocalPath, ensureTrailingNewline(sanitizedContents), "utf8");
    return;
  }

  writeFileSync(envLocalPath, "OPENAI_API_KEY=\nOLLAMA_BASE_URL=http://127.0.0.1:11434\n", "utf8");
}

function readEnvValue(contents, key) {
  const match = normalizeEnvContents(contents).match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`, "m"));
  if (!match) {
    return "";
  }

  const value = match[1].trim();
  return value === openAiPlaceholder ? "" : value;
}

function upsertEnvValue(contents, key, value) {
  const normalizedContents = normalizeEnvContents(contents);
  const entry = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");

  if (pattern.test(normalizedContents)) {
    return ensureTrailingNewline(normalizedContents.replace(pattern, entry));
  }

  if (!normalizedContents.trim()) {
    return `${entry}\n`;
  }

  return `${ensureTrailingNewline(normalizedContents)}${entry}\n`;
}

function getDesktopSetupPaths({ appPath, userDataPath, resourcesPath, isPackaged }) {
  return {
    envLocalPath: resolve(userDataPath, ".env.local"),
    envExamplePath: resolve(appPath, "server", ".env.example"),
    setupStatePath: resolve(userDataPath, "desktop-setup.json"),
    extensionDir: isPackaged
      ? resolve(resourcesPath, "extension")
      : resolve(appPath, "extension")
  };
}

function hasCompletedDesktopSetup(setupStatePath) {
  if (!existsSync(setupStatePath)) return false;

  try {
    const setupState = JSON.parse(readFileSync(setupStatePath, "utf8"));
    return Boolean(setupState?.completedAt);
  } catch {
    return false;
  }
}

function markDesktopSetupComplete(setupStatePath) {
  writeFileSync(setupStatePath, JSON.stringify({ completedAt: Date.now() }, null, 2), "utf8");
}

export {
  ensureEnvLocalFile,
  getDesktopSetupPaths,
  hasCompletedDesktopSetup,
  markDesktopSetupComplete,
  readEnvValue,
  upsertEnvValue
};
