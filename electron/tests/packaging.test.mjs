import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("package metadata ships the desktop app, MCP batch launcher, bundled extension, and installer hook", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.main, "electron/main.mjs");
  assert.ok(packageJson.scripts["test:desktop"].includes("electron/tests"));
  assert.ok(packageJson.scripts.check.includes("test:desktop"));
  assert.ok(packageJson.build.files.includes("start-mcp.bat"));
  assert.ok(packageJson.build.files.includes("server/**/*"));
  assert.ok(packageJson.build.extraResources.some((resource) => resource.from === "extension" && resource.to === "extension"));
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.deepEqual(packageJson.build.protocols[0].schemes, ["mindweaver"]);
});

test("desktop package includes server runtime dependencies needed from app.asar", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const serverPackageJson = JSON.parse(await readFile("server/package.json", "utf8"));

  for (const dependencyName of Object.keys(serverPackageJson.dependencies ?? {})) {
    assert.ok(
      packageJson.dependencies?.[dependencyName],
      `${dependencyName} must be a root dependency so the packaged Electron app can import server modules`
    );
  }
});

test("Windows installer registers and removes the mindweaver protocol handler", async () => {
  const installerScript = await readFile("build/installer.nsh", "utf8");

  assert.match(installerScript, /WriteRegStr HKCU "Software\\Classes\\mindweaver" "" "URL:MindWeaver"/);
  assert.match(installerScript, /WriteRegStr HKCU "Software\\Classes\\mindweaver" "URL Protocol" ""/);
  assert.match(installerScript, /WriteRegStr HKCU "Software\\Classes\\mindweaver\\shell\\open\\command"/);
  assert.match(installerScript, /DeleteRegKey HKCU "Software\\Classes\\mindweaver"/);
});

test("user-facing docs cover onboarding, tray, extension launch, and MCP setup", async () => {
  const docs = [
    await readFile("README.md", "utf8"),
    await readFile("docs/DESKTOP.md", "utf8"),
    await readFile("docs/MCP.md", "utf8"),
    await readFile("extension/README.md", "utf8")
  ].join("\n\n");

  for (const requiredText of [
    "Connect Coding Agent",
    "Copy Codex Config",
    "Add to Codex Config",
    "Copy Claude Code Config",
    "Open Config Help",
    "Test Agent Launcher",
    "Copy Chrome Extension Folder",
    "Open Chrome Setup",
    "post-install checklist",
    "mindweaver://open",
    "Create Note",
    "Paste Clipboard Text",
    "Import PDF / Office / Text"
  ]) {
    assert.match(docs, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});
