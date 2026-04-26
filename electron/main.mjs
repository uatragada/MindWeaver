import { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage, dialog } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMindWeaverServer } from "../server/runtime.js";
import { resolveMindWeaverDataFile } from "../server/data-file.js";
import { getDefaultCodexConfigPath, installMindWeaverCodexConfig } from "../server/codex-config.js";
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
  upsertEnvValue,
  writeDesktopMcpLauncher
} from "./desktop-setup.mjs";
import { extractImportFile } from "./import-extractors.mjs";
import { buildProtocolWindowParams, extractProtocolUrl } from "./protocol-utils.mjs";
import { makeQuickNoteSubmitter } from "./quick-note-actions.mjs";
import { trayMenuLabels } from "./tray-menu-model.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || "";
const appIconPath = resolve(__dirname, "assets", "icon.png");
const trayIconPath = resolve(__dirname, "assets", "icon-tray.png");
let mainWindow = null;
let runtime = null;
let shuttingDown = false;
let desktopSetup = null;
let agentAccess = null;
let pendingProtocolUrl = null;
let tray = null;
let isQuitting = false;
let quickNoteWindow = null;
let quickNotePrefill = {};

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

function buildAppUrl(params = {}) {
  const targetUrl = new URL(getWindowUrl());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      targetUrl.searchParams.set(key, String(value));
    }
  }
  return targetUrl.href;
}

async function showMainWindow(params = {}) {
  if (!mainWindow) {
    await createMainWindow();
  }

  if (mainWindow) {
    if (Object.keys(params).length) {
      await mainWindow.loadURL(buildAppUrl(params));
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function registerProtocolHandler() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("mindweaver", process.execPath, [resolve(process.argv[1])]);
    return;
  }

  app.setAsDefaultProtocolClient("mindweaver");
}

function handleProtocolUrl(url) {
  pendingProtocolUrl = url || pendingProtocolUrl;
  const params = buildProtocolWindowParams(url);
  if (mainWindow) {
    void showMainWindow(params);
  }
}

function createTrayIcon() {
  const image = nativeImage.createFromPath(trayIconPath);
  return image.isEmpty() ? nativeImage.createFromPath(appIconPath).resize({ width: 32, height: 32 }) : image;
}

async function getActiveSessionTarget() {
  const response = await fetch(`${runtime.url}/api/session-target?limit=24`, { cache: "no-store" });
  if (!response.ok) throw new Error(`MindWeaver target lookup failed with status ${response.status}`);
  return await response.json();
}

async function loadQuickNoteState() {
  const target = await getActiveSessionTarget().catch(() => ({
    activeSessionId: null,
    sessions: [],
    tabSessions: []
  }));
  return {
    target,
    prefill: quickNotePrefill
  };
}

const submitQuickNote = makeQuickNoteSubmitter({
  getRuntimeUrl: () => runtime?.url
});

function registerQuickNoteHandlers() {
  ipcMain.handle("quick-note:load-state", async () => loadQuickNoteState());
  ipcMain.handle("quick-note:submit", async (_event, payload = {}) => submitQuickNote(payload));
}

async function showQuickNoteWindow(prefill = {}) {
  quickNotePrefill = prefill;
  if (quickNoteWindow) {
    quickNoteWindow.show();
    quickNoteWindow.focus();
    quickNoteWindow.webContents.send("quick-note:prefill", quickNotePrefill);
    return;
  }

  quickNoteWindow = new BrowserWindow({
    width: 680,
    height: 740,
    minWidth: 560,
    minHeight: 620,
    backgroundColor: "#050505",
    title: "Create MindWeaver Note",
    icon: appIconPath,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "quick-note-preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  quickNoteWindow.once("ready-to-show", () => quickNoteWindow?.show());
  quickNoteWindow.on("closed", () => {
    quickNoteWindow = null;
    quickNotePrefill = {};
  });
  await quickNoteWindow.loadFile(join(__dirname, "quick-note.html"));
}

async function importTextToActiveMap({ title, content, sourceType = "note" }) {
  if (!runtime?.url) throw new Error("MindWeaver is not ready yet.");
  const target = await getActiveSessionTarget();
  if (!target.activeSessionId) {
    await showMainWindow({ rightPanel: "import", sourceType });
    return {
      ok: false,
      message: "Open a map first, then import again."
    };
  }

  const response = await fetch(`${runtime.url}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: target.activeSessionId,
      sourceType,
      title,
      content
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Import failed with status ${response.status}`);
  return {
    ok: true,
    message: `Imported into ${target.activeSession?.goal || "the active map"}.`
  };
}

async function importClipboardText() {
  const text = clipboard.readText().trim();
  if (!text) {
    await dialog.showMessageBox({
      type: "info",
      message: "Clipboard is empty",
      detail: "Copy some text, then choose Paste Clipboard Text again."
    });
    return;
  }

  try {
    const result = await importTextToActiveMap({
      title: `Clipboard note - ${new Date().toLocaleString()}`,
      content: text,
      sourceType: "note"
    });
    if (result.ok) {
      await dialog.showMessageBox({ type: "info", message: "Clipboard text imported", detail: result.message });
    } else {
      await dialog.showMessageBox({ type: "info", message: "Choose a destination map", detail: result.message });
    }
  } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Could not import clipboard text", detail: error.message });
  }
}

async function importFilesFromTray() {
  const result = await dialog.showOpenDialog({
    title: "Import into MindWeaver",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Readable text", extensions: ["txt", "md", "markdown", "text"] },
      { name: "Documents to open in import workspace", extensions: ["pdf", "docx", "pptx", "doc", "ppt"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return;

  const imported = [];
  const failed = [];

  for (const filePath of result.filePaths) {
    try {
      const extracted = await extractImportFile(filePath);
      if (!extracted.content.trim()) throw new Error(`${extracted.title} did not contain extractable text.`);
      const importedResult = await importTextToActiveMap(extracted);
      if (!importedResult.ok) throw new Error(importedResult.message || `${extracted.title} was not imported.`);
      imported.push(extracted.title);
    } catch (error) {
      failed.push(error.message);
    }
  }

  if (failed.length) {
    await showMainWindow({ rightPanel: "import" });
    await dialog.showMessageBox({
      type: imported.length ? "warning" : "error",
      message: imported.length ? "Some files imported" : "Could not import files",
      detail: [
        imported.length ? `Imported: ${imported.join(", ")}` : "",
        failed.length ? `Needs attention: ${failed.join(" ")}` : ""
      ].filter(Boolean).join("\n\n")
    });
  } else if (imported.length) {
    await dialog.showMessageBox({
      type: "info",
      message: "Files imported into MindWeaver",
      detail: imported.join("\n")
    });
  }
}

function buildTrayMenu() {
  const [
    openLabel,
    createNoteLabel,
    pasteClipboardLabel,
    importFilesLabel,
    agentAccessLabel,
    extensionSetupLabel,
    quitLabel
  ] = trayMenuLabels;
  return Menu.buildFromTemplate([
    { label: openLabel, click: () => void showMainWindow() },
    { label: createNoteLabel, click: () => void showQuickNoteWindow() },
    { label: pasteClipboardLabel, click: () => void importClipboardText() },
    { label: importFilesLabel, click: () => void importFilesFromTray() },
    { type: "separator" },
    { label: agentAccessLabel, click: () => void showMainWindow({ rightPanel: "agents" }) },
    { label: extensionSetupLabel, click: () => void shell.openPath(getDesktopSetup().extensionDir) },
    { type: "separator" },
    {
      label: quitLabel,
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  if (tray) return tray;
  tray = new Tray(createTrayIcon());
  tray.setToolTip("MindWeaver");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => void showMainWindow());
  return tray;
}

function buildAgentAccess(dataFilePath) {
  const setup = getDesktopSetup();
  const mcpEntrypoint = resolve(app.getAppPath(), "server", "mcp.js");
  writeDesktopMcpLauncher({
    launcherPath: setup.mcpLauncherPath,
    dataFilePath,
    envLocalPath: setup.envLocalPath,
    mcpEntrypoint,
    executablePath: process.execPath,
    isPackaged: app.isPackaged
  });

  const command = "cmd.exe";
  const args = ["/d", "/s", "/c", setup.mcpLauncherPath];
  const env = {
    MINDWEAVER_DATA_FILE: dataFilePath
  };

  return {
    available: true,
    transport: "stdio",
    launcherPath: setup.mcpLauncherPath,
    dataFilePath,
    mcpEntrypoint,
    packaged: app.isPackaged,
    codexConfigPath: getDefaultCodexConfigPath(),
    codexConfig: {
      mcpServers: {
        mindweaver: {
          command,
          args,
          env
        }
      }
    },
    claudeCodeConfig: {
      mcpServers: {
        mindweaver: {
          command,
          args,
          env
        }
      }
    }
  };
}

function getAgentAccess() {
  if (!agentAccess) {
    agentAccess = buildAgentAccess(resolveMindWeaverDataFile());
  }

  return agentAccess;
}

async function testGeneratedAgentLauncher() {
  const access = getAgentAccess();
  const serverConfig = access.codexConfig?.mcpServers?.mindweaver;
  if (!serverConfig?.command) {
    return {
      ok: false,
      message: "The MindWeaver MCP launcher is not configured yet."
    };
  }

  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: {
      ...process.env,
      ...(serverConfig.env ?? {})
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "mindweaver-desktop-setup", version: "1.0.0" });

  try {
    await Promise.race([
      (async () => {
        await client.connect(transport);
        const tools = await client.listTools();
        const toolNames = tools.tools.map((tool) => tool.name);
        if (!toolNames.includes("mindweaver_get_graph")) {
          throw new Error("The MCP server started, but MindWeaver graph tools were not listed.");
        }
      })(),
      delay(12000).then(() => {
        throw new Error("Timed out while starting the MindWeaver MCP server.");
      })
    ]);

    return {
      ok: true,
      message: "Agent launcher works. MindWeaver MCP tools are visible."
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "MindWeaver could not verify the MCP launcher."
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runDesktopSetup() {
  const setup = getDesktopSetup();
  const setupAgentAccess = getAgentAccess();
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
    ipcMain.removeHandler("desktop-setup:copy-text");
    ipcMain.removeHandler("desktop-setup:add-codex-config");
    ipcMain.removeHandler("desktop-setup:test-agent-launcher");
  };

  ipcMain.handle("desktop-setup:load-state", async () => {
    const envContents = readDesktopEnvContents(setup.envLocalPath);
    return {
      openAiKey: readEnvValue(envContents, "OPENAI_API_KEY"),
      chromePath: detectChromePath({ configDir: setup.userDataPath }),
      extensionPath: setup.extensionDir,
      extensionAvailable: existsSync(setup.extensionDir),
      agentAccess: setupAgentAccess
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

  ipcMain.handle("desktop-setup:copy-text", async (_event, text = "") => {
    clipboard.writeText(String(text ?? ""));
    return {
      ok: true,
      message: "Copied."
    };
  });

  ipcMain.handle("desktop-setup:add-codex-config", async () => installMindWeaverCodexConfig({
    codexConfig: getAgentAccess().codexConfig
  }));

  ipcMain.handle("desktop-setup:test-agent-launcher", async () => testGeneratedAgentLauncher());

  setupWindow = new BrowserWindow({
    width: 920,
    height: 900,
    minWidth: 760,
    minHeight: 680,
    resizable: true,
    backgroundColor: "#050505",
    show: false,
    autoHideMenuBar: true,
    title: "MindWeaver Setup",
    icon: appIconPath,
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
    icon: appIconPath,
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

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

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
  if (process.platform !== "darwin" && isQuitting) {
    await shutdownRuntime();
    app.quit();
  }
});

app.on("before-quit", async () => {
  isQuitting = true;
  await shutdownRuntime();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    handleProtocolUrl(extractProtocolUrl(argv));
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

pendingProtocolUrl = extractProtocolUrl(process.argv);
registerProtocolHandler();

app.whenReady()
  .then(async () => {
    await runDesktopSetup();
    const setup = getDesktopSetup();
    const dataFile = resolveMindWeaverDataFile();
    agentAccess = getAgentAccess();
    runtime = await startMindWeaverServer({
      port: isDev ? 3001 : 0,
      staticDir: resolve(app.getAppPath(), "web/dist"),
      dataFile,
      envPaths: app.isPackaged ? [setup.envLocalPath] : [],
      agentAccess
    });
    registerQuickNoteHandlers();
    createTray();
    await createMainWindow();
    if (pendingProtocolUrl) handleProtocolUrl(pendingProtocolUrl);
  })
  .catch(async (error) => {
    console.error("Could not start MindWeaver desktop shell.", error);
    await shutdownRuntime();
    app.quit();
  });
