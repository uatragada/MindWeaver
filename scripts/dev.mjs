import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMindWeaverDevPortsAvailable } from "./dev-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const spawnConfig =
  process.platform === "win32"
    ? {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", npmCommand, "run", "dev"]
      }
    : {
        command: npmCommand,
        args: ["run", "dev"]
      };

const processes = [
  { name: "server", cwd: resolve(rootDir, "server"), color: "\x1b[36m" },
  { name: "web", cwd: resolve(rootDir, "web"), color: "\x1b[35m" }
];

const children = [];

function pipeWithPrefix(stream, name, color) {
  const reader = createInterface({ input: stream });
  reader.on("line", (line) => {
    process.stdout.write(`${color}[${name}]\x1b[0m ${line}\n`);
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(code), 200);
}

try {
  const { clearedProcesses } = await ensureMindWeaverDevPortsAvailable({ rootDir });
  if (clearedProcesses.length) {
    const ports = clearedProcesses.map((processInfo) => processInfo.port).join(", ");
    process.stdout.write(`Cleared stale MindWeaver dev processes on port(s): ${ports}\n`);
  }

  for (const processConfig of processes) {
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: processConfig.cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"]
    });

    pipeWithPrefix(child.stdout, processConfig.name, processConfig.color);
    pipeWithPrefix(child.stderr, processConfig.name, processConfig.color);

    child.on("exit", (code) => {
      if (code && code !== 0) {
        process.stderr.write(`${processConfig.color}[${processConfig.name}]\x1b[0m exited with code ${code}\n`);
        shutdown(code);
      }
    });

    children.push(child);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
} catch (error) {
  process.stderr.write(`MindWeaver dev startup failed: ${error.message}\n`);
  process.exit(1);
}
