import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

function getDefaultDataRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA || resolve(homedir(), "AppData", "Roaming");
  }

  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support");
  }

  return process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
}

export function resolveMindWeaverDataFile(explicitPath = process.env.MINDWEAVER_DATA_FILE || "") {
  const safeExplicitPath = String(explicitPath ?? "").trim();
  if (safeExplicitPath) {
    return resolve(safeExplicitPath);
  }

  return resolve(getDefaultDataRoot(), "MindWeaver", "mindweaver-data.json");
}

export function resolveMindWeaverDataDir(explicitPath = process.env.MINDWEAVER_DATA_FILE || "") {
  return dirname(resolveMindWeaverDataFile(explicitPath));
}
