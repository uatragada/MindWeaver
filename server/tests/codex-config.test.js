import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import {
  buildMindWeaverCodexToml,
  installMindWeaverCodexConfig,
  upsertMindWeaverCodexConfigToml
} from "../codex-config.js";

const codexConfig = {
  mcpServers: {
    mindweaver: {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat"],
      env: {
        MINDWEAVER_DATA_FILE: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json"
      }
    }
  }
};

test("buildMindWeaverCodexToml converts MindWeaver JSON config to Codex TOML", () => {
  const toml = buildMindWeaverCodexToml(codexConfig);

  assert.match(toml, /\[mcp_servers\.mindweaver]/);
  assert.match(toml, /command = "cmd\.exe"/);
  assert.match(toml, /args = \["\/d", "\/s", "\/c", "C:\\\\Users\\\\Example\\\\AppData\\\\Roaming\\\\MindWeaver\\\\start-mindweaver-mcp\.bat"]/);
  assert.match(toml, /\[mcp_servers\.mindweaver\.env]/);
  assert.match(toml, /MINDWEAVER_DATA_FILE = "C:\\\\Users\\\\Example\\\\AppData\\\\Roaming\\\\MindWeaver\\\\mindweaver-data\.json"/);
});

test("upsertMindWeaverCodexConfigToml appends without disturbing existing settings", () => {
  const existing = [
    'model = "gpt-5.5"',
    "",
    "[features]",
    "multi_agent = true",
    "",
    "[projects.'G:\\Projects\\MindWeaver']",
    'trust_level = "trusted"'
  ].join("\n");

  const updated = upsertMindWeaverCodexConfigToml(existing, codexConfig);

  assert.match(updated, /^model = "gpt-5\.5"/m);
  assert.match(updated, /^\[features]$/m);
  assert.match(updated, /^\[projects\.'G:\\Projects\\MindWeaver']$/m);
  assert.equal((updated.match(/\[mcp_servers\.mindweaver]/g) ?? []).length, 1);
  assert.ok(updated.trimEnd().endsWith('MINDWEAVER_DATA_FILE = "C:\\\\Users\\\\Example\\\\AppData\\\\Roaming\\\\MindWeaver\\\\mindweaver-data.json"'));
});

test("upsertMindWeaverCodexConfigToml replaces only an existing MindWeaver MCP block", () => {
  const existing = [
    "[mcp_servers.other]",
    'command = "node"',
    "",
    "[mcp_servers.mindweaver]",
    'command = "old"',
    'args = ["old.bat"]',
    "",
    "[mcp_servers.mindweaver.env]",
    'MINDWEAVER_DATA_FILE = "old.json"',
    "",
    "[profiles.ollama-launch]",
    'model_provider = "ollama-launch"'
  ].join("\n");

  const updated = upsertMindWeaverCodexConfigToml(existing, codexConfig);

  assert.match(updated, /^\[mcp_servers\.other]$/m);
  assert.match(updated, /^\[profiles\.ollama-launch]$/m);
  assert.doesNotMatch(updated, /old\.bat|old\.json|command = "old"/);
  assert.equal((updated.match(/\[mcp_servers\.mindweaver]/g) ?? []).length, 1);
  assert.equal((updated.match(/\[mcp_servers\.mindweaver\.env]/g) ?? []).length, 1);
});

test("installMindWeaverCodexConfig writes an idempotent config file", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-codex-config-"));
  const configPath = join(tempDir, ".codex", "config.toml");

  try {
    await writeFile(configPath, "", "utf8").catch(async () => {});
    installMindWeaverCodexConfig({ codexConfig, configPath });
    installMindWeaverCodexConfig({ codexConfig, configPath });
    const contents = await readFile(configPath, "utf8");

    assert.equal((contents.match(/\[mcp_servers\.mindweaver]/g) ?? []).length, 1);
    assert.equal((contents.match(/MindWeaver MCP server \(managed by MindWeaver\)/g) ?? []).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
