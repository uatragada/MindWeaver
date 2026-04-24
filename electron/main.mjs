import { app, BrowserWindow, ipcMain, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMindWeaverServer } from "../server/runtime.js";
import {
  detectChromePath,
  launchChromeWithExtension,
  saveChromePath
} from "./chrome-extension.mjs";
import {
  ensureEnvLocalFile,
  getDesktopSetupPaths,
  hasCompletedDesktopSetup,
  markDesktopSetupComplete,
  readEnvValue,
  upsertEnvValue
} from "./desktop-setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || "";
let mainWindow = null;
let runtime = null;
let shuttingDown = false;
let desktopSetup = null;

async function waitForUrl(url, retries = 120, intervalMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return true;
    } catch {
      // Keep polling until the renderer is ready.
    }
    await delay(intervalMs);
  }

  return false;
}

function getWindowUrl() {
  if (rendererUrl) return rendererUrl;
  if (!runtime) throw new Error("MindWeaver server is not running yet.");
  return runtime.url;
}

function getDesktopSetup() {
  if (desktopSetup) {
    return desktopSetup;
  }

  desktopSetup = {
    userDataPath: app.getPath("userData"),
    ...getDesktopSetupPaths({
      appPath: app.getAppPath(),
      userDataPath: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged
    })
  };

  return desktopSetup;
}

function readDesktopEnvContents(envLocalPath) {
  return existsSync(envLocalPath) ? readFileSync(envLocalPath, "utf8") : "";
}

async function runDesktopSetup() {
  const setup = getDesktopSetup();
  ensureEnvLocalFile({
    envLocalPath: setup.envLocalPath,
    envExamplePath: setup.envExamplePath
  });

  if (!app.isPackaged || hasCompletedDesktopSetup(setup.setupStatePath)) {
    return;
  }

  let setupWindow = null;
  let completed = false;
  const cleanupHandlers = () => {
    ipcMain.removeHandler("desktop-setup:load-state");
    ipcMain.removeHandler("desktop-setup:submit");
    ipcMain.removeHandler("desktop-setup:launch-chrome");
    ipcMain.removeHandler("desktop-setup:open-extension-folder");
  };

  ipcMain.handle("desktop-setup:load-state", async () => {
    const envContents = readDesktopEnvContents(setup.envLocalPath);
    return {
      openAiKey: readEnvValue(envContents, "OPENAI_API_KEY"),
      chromePath: detectChromePath({ configDir: setup.userDataPath }),
      extensionPath: setup.extensionDir,
      extensionAvailable: existsSync(setup.extensionDir)
    };
  });

  ipcMain.handle("desktop-setup:submit", async (_event, payload = {}) => {
    const envContents = readDesktopEnvContents(setup.envLocalPath);
    const openAiKey = String(payload.openAiKey ?? "").trim();
    const updatedEnvContents = upsertEnvValue(envContents, "OPENAI_API_KEY", openAiKey);
    writeFileSync(setup.envLocalPath, updatedEnvContents, "utf8");
    markDesktopSetupComplete(setup.setupStatePath);
    completed = true;
    setupWindow?.close();
    return { ok: true };
  });

  ipcMain.handle("desktop-setup:launch-chrome", async (_event, payload = {}) => {
    const chromePath = String(payload.chromePath ?? "").trim() || detectChromePath({ configDir: setup.userDataPath });

    if (!chromePath) {
      return {
        ok: false,
        chromePath: "",
        message: "Chrome could not be found. Paste the full path to chrome.exe and try again."
      };
    }

    if (!existsSync(chromePath)) {
      return {
        ok: false,
        chromePath,
        message: "That Chrome path was not found."
      };
    }

    saveChromePath(chromePath, { configDir: setup.userDataPath });
    const launched = launchChromeWithExtension({
      chromePath,
      extensionDir: setup.extensionDir,
      configDir: setup.userDataPath,
      urls: ["chrome://extensions/"]
    });

    return launched
      ? {
          ok: true,
          chromePath,
          message: "Chrome launched with the MindWeaver extension loaded."
        }
      : {
          ok: false,
          chromePath,
          message: "MindWeaver could not launch Chrome with the packaged extension."
        };
  });

  ipcMain.handle("desktop-setup:open-extension-folder", async () => {
    if (!existsSync(setup.extensionDir)) {
      return {
        ok: false,
        message: "The packaged Chrome extension could not be found."
      };
    }

    const errorMessage = await shell.openPath(setup.extensionDir);
    return errorMessage
      ? {
          ok: false,
          message: errorMessage
        }
      : {
          ok: true,
          message: "Opened the packaged Chrome extension folder."
        };
  });

  setupWindow = new BrowserWindow({
    width: 860,
    height: 760,
    minWidth: 760,
    minHeight: 680,
    resizable: false,
    backgroundColor: "#050505",
    show: false,
    autoHideMenuBar: true,
    title: "MindWeaver Setup",
    webPreferences: {
      preload: join(__dirname, "setup-preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  setupWindow.once("ready-to-show", () => {
    setupWindow?.show();
  });

  const completion = new Promise((resolvePromise, rejectPromise) => {
    setupWindow.on("closed", () => {
      setupWindow = null;
      cleanupHandlers();
      if (completed) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error("MindWeaver setup was closed before completion."));
    });
  });

  await setupWindow.loadFile(join(__dirname, "setup.html"));
  await completion;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#050505",
    show: false,
    autoHideMenuBar: true,
    title: "MindWeaver",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentBaseUrl = new URL(getWindowUrl());
    const nextUrl = new URL(url);
    if (nextUrl.origin !== currentBaseUrl.origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const targetUrl = getWindowUrl();
  if (rendererUrl) {
    await waitForUrl(targetUrl);
  }
  await mainWindow.loadURL(targetUrl);

  if (isDev && rendererUrl) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function shutdownRuntime() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime?.close?.();
  } catch (error) {
    console.error("Failed to stop MindWeaver server cleanly.", error);
  } finally {
    runtime = null;
  }
}

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    await shutdownRuntime();
    app.quit();
  }
});

app.on("before-quit", async () => {
  await shutdownRuntime();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

app.whenReady()
  .then(async () => {
    await runDesktopSetup();
    const setup = getDesktopSetup();
    runtime = await startMindWeaverServer({
      port: isDev ? 3001 : 0,
      staticDir: resolve(app.getAppPath(), "web/dist"),
      dataFile: resolve(app.getPath("userData"), "mindweaver-data.json"),
      envPaths: app.isPackaged ? [setup.envLocalPath] : []
    });
    await createMainWindow();
  })
  .catch(async (error) => {
    console.error("Could not start MindWeaver desktop shell.", error);
    await shutdownRuntime();
    app.quit();
  });
