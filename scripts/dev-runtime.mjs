import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizePath(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function uniqueByPid(processes) {
  return Array.from(new Map(processes.map((processInfo) => [processInfo.pid, processInfo])).values());
}

async function runPowerShell(command) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true }
  );

  return stdout.trim();
}

async function readListeningProcesses(ports) {
  const portList = ports.map((port) => Number(port)).join(", ");
  const rawOutput = await runPowerShell(`
    $ports = @(${portList})
    $connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports }
    if (-not $connections) { return }

    $connections |
      ForEach-Object {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue
        [pscustomobject]@{
          port = $_.LocalPort
          pid = $_.OwningProcess
          commandLine = $processInfo.CommandLine
          executablePath = $processInfo.ExecutablePath
        }
      } |
      ConvertTo-Json -Compress
  `);

  if (!rawOutput) return [];

  const parsed = JSON.parse(rawOutput);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function killProcessTree(pid) {
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`.toLowerCase();
    if (output.includes("not found") || output.includes("no running instance")) {
      return;
    }
    throw error;
  }
}

function belongsToWorkspace(processInfo, rootDir) {
  const normalizedRoot = normalizePath(rootDir);
  const haystack = normalizePath(`${processInfo.commandLine || ""}\n${processInfo.executablePath || ""}`);
  return haystack.includes(normalizedRoot);
}

async function isMindWeaverService(processInfo, rootDir) {
  if (belongsToWorkspace(processInfo, rootDir)) return true;

  if (processInfo.port === 3001) {
    try {
      const response = await fetch("http://127.0.0.1:3001/api/health");
      const payload = await response.json().catch(() => null);
      return response.ok && payload?.app === "MindWeaver";
    } catch {
      return false;
    }
  }

  const commandLine = normalizePath(processInfo.commandLine || "");
  if (processInfo.port === 5197 && commandLine.includes("vite\\bin\\vite.js")) {
    return true;
  }

  return false;
}

export async function ensureMindWeaverDevPortsAvailable({
  rootDir,
  ports = [3001, 5197],
  timeoutMs = 8000
} = {}) {
  if (process.platform !== "win32") {
    return { clearedProcesses: [], blockingProcesses: [] };
  }

  const resolvedRoot = resolve(rootDir || ".");
  const listeners = uniqueByPid(await readListeningProcesses(ports));
  if (!listeners.length) {
    return { clearedProcesses: [], blockingProcesses: [] };
  }

  const ownership = await Promise.all(
    listeners.map(async (processInfo) => ({
      processInfo,
      isMindWeaver: await isMindWeaverService(processInfo, resolvedRoot)
    }))
  );
  const workspaceProcesses = ownership.filter((entry) => entry.isMindWeaver).map((entry) => entry.processInfo);
  const foreignProcesses = ownership.filter((entry) => !entry.isMindWeaver).map((entry) => entry.processInfo);

  if (foreignProcesses.length) {
    const description = foreignProcesses
      .map((processInfo) => `port ${processInfo.port} (PID ${processInfo.pid})`)
      .join(", ");
    throw new Error(`Required dev ports are in use by another app: ${description}. Close those processes and try again.`);
  }

  for (const processInfo of workspaceProcesses) {
    await killProcessTree(processInfo.pid);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = uniqueByPid(await readListeningProcesses(ports));
    if (!remaining.length) {
      return { clearedProcesses: workspaceProcesses, blockingProcesses: [] };
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  const remaining = uniqueByPid(await readListeningProcesses(ports));
  if (remaining.length) {
    const description = remaining
      .map((processInfo) => `port ${processInfo.port} (PID ${processInfo.pid})`)
      .join(", ");
    throw new Error(`MindWeaver could not clear stale dev ports: ${description}.`);
  }

  return { clearedProcesses: workspaceProcesses, blockingProcesses: [] };
}
