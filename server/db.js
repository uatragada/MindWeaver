import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { resolveMindWeaverDataFile } from "./data-file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDefaultData() {
  return {
    sessions: [],
    goals: [],
    nodes: [],
    edges: [],
    verifications: [],
    artifacts: [],
    users: [],
    workspaces: [],
    reports: [],
    preferences: {
      activeSessionId: null,
      lastSessionId: null,
      llmProvider: "openai",
      localLlmModel: "qwen3.5:4b"
    }
  };
}

export function createDb(filePath = resolveMindWeaverDataFile()) {
  const resolvedFilePath = resolveMindWeaverDataFile(filePath);
  mkdirSync(dirname(resolvedFilePath), { recursive: true });
  return new Low(new JSONFile(resolvedFilePath), createDefaultData());
}

export const db = createDb();

function normalizeDbData(targetDb) {
  targetDb.data ||= createDefaultData();
  targetDb.data.sessions ||= [];
  targetDb.data.goals ||= [];
  targetDb.data.nodes ||= [];
  targetDb.data.edges ||= [];
  targetDb.data.verifications ||= [];
  targetDb.data.artifacts ||= [];
  targetDb.data.users ||= [];
  targetDb.data.workspaces ||= [];
  targetDb.data.reports ||= [];
  targetDb.data.preferences ||= {
    activeSessionId: null,
    lastSessionId: null,
    llmProvider: "openai",
    localLlmModel: "qwen3.5:4b"
  };
  targetDb.data.preferences.llmProvider = String(targetDb.data.preferences.llmProvider ?? "").trim().toLowerCase() === "local" ? "local" : "openai";
  targetDb.data.preferences.localLlmModel = String(targetDb.data.preferences.localLlmModel ?? "").trim() || "qwen3.5:4b";
}

export async function syncDbFromDisk(targetDb = db) {
  await targetDb.read();
  normalizeDbData(targetDb);
}

export async function initDb(targetDb = db) {
  await syncDbFromDisk(targetDb);
  await targetDb.write();
}
