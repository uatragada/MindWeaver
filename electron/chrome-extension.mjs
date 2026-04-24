import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultExtensionDir = resolve(rootDir, "extension");

function getConfigDir(customConfigDir = null) {
  if (customConfigDir) return resolve(customConfigDir);
  return process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, "MindWeaver")
    : resolve(homedir(), ".mindweaver");
}

function getChromePathFile(customConfigDir = null) {
  return resolve(getConfigDir(customConfigDir), "chrome-path.txt");
}

function getChromeProfileDir(customConfigDir = null) {
  return resolve(getConfigDir(customConfigDir), "chrome-extension-profile");
}

function trimQuotes(value) {
  return String(value ?? "").trim().replace(/^"(.*)"$/, "$1");
}

function ensureConfigDir(customConfigDir = null) {
  mkdirSync(getConfigDir(customConfigDir), { recursive: true });
}

function getConfiguredChromePath({ configDir = null } = {}) {
  const chromePathFile = getChromePathFile(configDir);
  if (!existsSync(chromePathFile)) {
    return "";
  }

  const savedPath = trimQuotes(readFileSync(chromePathFile, "utf8"));
  return savedPath && existsSync(savedPath) ? savedPath : "";
}

function getDefaultChromeCandidates() {
  const candidates = [];

  if (process.env.ProgramFiles) {
    candidates.push(resolve(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"));
  }

  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(resolve(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"));
  }

  if (process.env.LOCALAPPDATA) {
    candidates.push(resolve(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
  }

  return candidates.filter((candidate, index, allCandidates) => candidate && allCandidates.indexOf(candidate) === index);
}

function detectChromePath({ configDir = null } = {}) {
  const configuredPath = getConfiguredChromePath({ configDir });
  if (configuredPath) {
    return configuredPath;
  }

  return getDefaultChromeCandidates().find((candidate) => existsSync(candidate)) ?? "";
}

function saveChromePath(chromePath, { configDir = null } = {}) {
  ensureConfigDir(configDir);
  writeFileSync(getChromePathFile(configDir), `${trimQuotes(chromePath)}\n`, "utf8");
}

function launchChromeWithExtension({
  chromePath,
  urls = ["chrome://extensions/"],
  extensionDir = defaultExtensionDir,
  configDir = null
}) {
  const resolvedChromePath = trimQuotes(chromePath);
  const resolvedExtensionDir = resolve(extensionDir);

  if (!resolvedChromePath || !existsSync(resolvedChromePath)) {
    return false;
  }

  if (!existsSync(resolvedExtensionDir)) {
    return false;
  }

  if (process.env.MINDWEAVER_SKIP_CHROME_LAUNCH === "1") {
    return true;
  }

  ensureConfigDir(configDir);

  const child = spawn(
    resolvedChromePath,
    [
      `--user-data-dir=${getChromeProfileDir(configDir)}`,
      `--disable-extensions-except=${resolvedExtensionDir}`,
      `--load-extension=${resolvedExtensionDir}`,
      "--new-window",
      ...urls
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );

  child.unref();
  return true;
}

export {
  defaultExtensionDir,
  detectChromePath,
  getChromePathFile,
  getChromeProfileDir,
  getConfigDir,
  getConfiguredChromePath,
  getDefaultChromeCandidates,
  launchChromeWithExtension,
  rootDir,
  saveChromePath,
  trimQuotes
};
