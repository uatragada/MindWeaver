import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const extensionDir = resolve(rootDir, "extension");
const configDir = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, "MindWeaver")
  : resolve(homedir(), ".mindweaver");
const chromePathFile = resolve(configDir, "chrome-path.txt");
const chromeProfileDir = resolve(configDir, "chrome-extension-profile");

function trimQuotes(value) {
  return value.trim().replace(/^"(.*)"$/, "$1");
}

function ensureConfigDir() {
  mkdirSync(configDir, { recursive: true });
}

function getConfiguredChromePath() {
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

function detectChromePath() {
  const configuredPath = getConfiguredChromePath();
  if (configuredPath) {
    return configuredPath;
  }

  return getDefaultChromeCandidates().find((candidate) => existsSync(candidate)) ?? "";
}

function saveChromePath(chromePath) {
  ensureConfigDir();
  writeFileSync(chromePathFile, `${trimQuotes(chromePath)}\n`, "utf8");
}

function launchChromeWithExtension({ chromePath, urls = ["chrome://extensions/"] }) {
  const resolvedChromePath = trimQuotes(chromePath);

  if (!resolvedChromePath || !existsSync(resolvedChromePath)) {
    return false;
  }

  if (process.env.MINDWEAVER_SKIP_CHROME_LAUNCH === "1") {
    return true;
  }

  ensureConfigDir();

  const child = spawn(
    resolvedChromePath,
    [
      `--user-data-dir=${chromeProfileDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
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
  chromePathFile,
  chromeProfileDir,
  configDir,
  detectChromePath,
  extensionDir,
  getConfiguredChromePath,
  getDefaultChromeCandidates,
  launchChromeWithExtension,
  rootDir,
  saveChromePath,
  trimQuotes
};
