import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import os from "node:os";

const managedComment = "# MindWeaver MCP server (managed by MindWeaver)";

function getDefaultCodexConfigPath({ homeDir = os.homedir() } = {}) {
  return resolve(homeDir, ".codex", "config.toml");
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function tomlArray(values = []) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function getMindWeaverServerConfig(codexConfig = {}) {
  return codexConfig?.mcpServers?.mindweaver ?? codexConfig?.mcp_servers?.mindweaver ?? null;
}

function buildMindWeaverCodexToml(codexConfig = {}) {
  const serverConfig = getMindWeaverServerConfig(codexConfig);
  if (!serverConfig?.command) {
    throw new Error("MindWeaver Codex config is missing a launch command.");
  }

  const lines = [
    managedComment,
    "[mcp_servers.mindweaver]",
    `command = ${tomlString(serverConfig.command)}`,
    `args = ${tomlArray(serverConfig.args ?? [])}`
  ];

  const cwd = serverConfig.cwd ?? serverConfig.workingDirectory;
  if (cwd) {
    lines.push(`cwd = ${tomlString(cwd)}`);
  }

  const env = serverConfig.env && typeof serverConfig.env === "object" ? serverConfig.env : {};
  if (Object.keys(env).length) {
    lines.push("", "[mcp_servers.mindweaver.env]");
    for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Codex env var ${key} is not a valid TOML key.`);
      }
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function isMindWeaverCodexSection(line) {
  return /^\s*\[mcp_servers\.mindweaver(?:\.env)?]\s*$/.test(line);
}

function isTomlSection(line) {
  return /^\s*\[[^\]]+]\s*$/.test(line);
}

function upsertMindWeaverCodexConfigToml(contents, codexConfig) {
  const normalized = String(contents ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const keptLines = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.trim() === managedComment) {
      index += 1;
      continue;
    }

    if (isMindWeaverCodexSection(line)) {
      index += 1;
      while (index < lines.length && !isTomlSection(lines[index])) {
        index += 1;
      }
      continue;
    }

    keptLines.push(line);
    index += 1;
  }

  const base = keptLines.join("\n").trimEnd();
  const block = buildMindWeaverCodexToml(codexConfig).trimEnd();
  return `${base ? `${base}\n\n` : ""}${block}\n`;
}

function installMindWeaverCodexConfig({
  codexConfig,
  configPath = getDefaultCodexConfigPath()
} = {}) {
  const existingContents = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const nextContents = upsertMindWeaverCodexConfigToml(existingContents, codexConfig);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, nextContents, "utf8");
  return {
    ok: true,
    configPath,
    message: "MindWeaver was added to Codex config. Restart Codex to load the MCP server."
  };
}

export {
  buildMindWeaverCodexToml,
  getDefaultCodexConfigPath,
  installMindWeaverCodexConfig,
  upsertMindWeaverCodexConfigToml
};
