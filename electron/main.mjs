import { app, BrowserWindow, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMindWeaverServer } from "../server/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || "";
let mainWindow = null;
let runtime = null;
let shuttingDown = false;

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
    runtime = await startMindWeaverServer({
      port: isDev ? 3001 : 0,
      staticDir: resolve(app.getAppPath(), "web/dist"),
      dataFile: resolve(app.getPath("userData"), "mindweaver-data.json")
    });
    await createMainWindow();
  })
  .catch(async (error) => {
    console.error("Could not start MindWeaver desktop shell.", error);
    await shutdownRuntime();
    app.quit();
  });
