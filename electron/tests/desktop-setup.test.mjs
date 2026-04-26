import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
  getDesktopSetupPaths,
  readEnvValue,
  upsertEnvValue,
  writeDesktopMcpLauncher
} from "../desktop-setup.mjs";

test("readEnvValue ignores the placeholder key and upsertEnvValue replaces entries", () => {
  const contents = [
    "OPENAI_API_KEY=your_openai_api_key_here",
    "OLLAMA_BASE_URL=http://127.0.0.1:11434"
  ].join("\n");

  assert.equal(readEnvValue(contents, "OPENAI_API_KEY"), "");

  const updated = upsertEnvValue(contents, "OPENAI_API_KEY", "sk-live");
  assert.match(updated, /^OPENAI_API_KEY=sk-live$/m);
  assert.match(updated, /^OLLAMA_BASE_URL=http:\/\/127\.0\.0\.1:11434$/m);
});

test("getDesktopSetupPaths switches extension location for packaged installs", () => {
  const devPaths = getDesktopSetupPaths({
    appPath: "G:\\Projects\\MindWeaver",
    userDataPath: "C:\\Users\\Test\\AppData\\Roaming\\MindWeaver",
    resourcesPath: "C:\\Program Files\\MindWeaver\\resources",
    isPackaged: false
  });
  const packagedPaths = getDesktopSetupPaths({
    appPath: "C:\\Program Files\\MindWeaver\\resources\\app.asar",
    userDataPath: "C:\\Users\\Test\\AppData\\Roaming\\MindWeaver",
    resourcesPath: "C:\\Program Files\\MindWeaver\\resources",
    isPackaged: true
  });

  assert.equal(devPaths.extensionDir, "G:\\Projects\\MindWeaver\\extension");
  assert.equal(packagedPaths.extensionDir, "C:\\Program Files\\MindWeaver\\resources\\extension");
  assert.equal(packagedPaths.envLocalPath, "C:\\Users\\Test\\AppData\\Roaming\\MindWeaver\\.env.local");
  assert.equal(packagedPaths.mcpLauncherPath, "C:\\Users\\Test\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat");
});

test("writeDesktopMcpLauncher creates a packaged Electron-as-Node MCP launcher", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-desktop-setup-"));
  const launcherPath = join(tempDir, "start-mindweaver-mcp.bat");

  try {
    writeDesktopMcpLauncher({
      launcherPath,
      dataFilePath: "C:\\Users\\Test\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json",
      envLocalPath: "C:\\Users\\Test\\AppData\\Roaming\\MindWeaver\\.env.local",
      mcpEntrypoint: "C:\\Program Files\\MindWeaver\\resources\\app.asar\\server\\mcp.js",
      executablePath: "C:\\Program Files\\MindWeaver\\MindWeaver.exe",
      isPackaged: true
    });

    const contents = await readFile(launcherPath, "utf8");
    assert.match(contents, /ELECTRON_RUN_AS_NODE=1/);
    assert.match(contents, /MINDWEAVER_DATA_FILE=C:\\Users\\Test\\AppData\\Roaming\\MindWeaver\\mindweaver-data\.json/);
    assert.match(contents, /"C:\\Program Files\\MindWeaver\\MindWeaver\.exe" "C:\\Program Files\\MindWeaver\\resources\\app\.asar\\server\\mcp\.js"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
