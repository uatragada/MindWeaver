import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMindWeaverDevPortsAvailable } from "./dev-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronBinary = resolve(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron"
);

const spawnWithPrefix = (command, args, { cwd, env, color, name }) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"]
  });

  const pipe = (stream) => {
    const reader = createInterface({ input: stream });
    reader.on("line", (line) => {
      process.stdout.write(`${color}[${name}]\x1b[0m ${line}\n`);
    });
  };

  pipe(child.stdout);
  pipe(child.stderr);
  return child;
};

const children = [];

function shutdown(code = 0) {
  children.forEach((child) => {
    if (!child.killed) child.kill("SIGTERM");
  });

  setTimeout(() => process.exit(code), 250);
}

try {
  const { clearedProcesses } = await ensureMindWeaverDevPortsAvailable({ rootDir });
  if (clearedProcesses.length) {
    const ports = clearedProcesses.map((processInfo) => processInfo.port).join(", ");
    process.stdout.write(`Cleared stale MindWeaver dev processes on port(s): ${ports}\n`);
  }

  const webProcess =
    process.platform === "win32"
      ? spawnWithPrefix("cmd.exe", ["/d", "/s", "/c", npmCommand, "--prefix", "web", "run", "dev"], {
          cwd: rootDir,
          env: process.env,
          color: "\x1b[35m",
          name: "web"
        })
      : spawnWithPrefix(npmCommand, ["--prefix", "web", "run", "dev"], {
          cwd: rootDir,
          env: process.env,
          color: "\x1b[35m",
          name: "web"
        });

  children.push(webProcess);

  const electronProcess = spawnWithPrefix(electronBinary, ["."], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5197"
    },
    color: "\x1b[36m",
    name: "electron"
  });

  children.push(electronProcess);

  webProcess.on("exit", (code) => {
    if (code && code !== 0) {
      process.stderr.write(`\x1b[35m[web]\x1b[0m exited with code ${code}\n`);
      shutdown(code);
    }
  });

  electronProcess.on("exit", (code) => {
    shutdown(code ?? 0);
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
} catch (error) {
  process.stderr.write(`MindWeaver desktop startup failed: ${error.message}\n`);
  process.exit(1);
}
