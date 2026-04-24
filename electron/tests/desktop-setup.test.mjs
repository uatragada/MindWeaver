import test from "node:test";
import assert from "node:assert/strict";
import {
  getDesktopSetupPaths,
  readEnvValue,
  upsertEnvValue
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
});
