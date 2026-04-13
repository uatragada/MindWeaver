import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

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

export function createDb(filePath = resolve(__dirname, "data.json")) {
  return new Low(new JSONFile(filePath), createDefaultData());
}

export const db = createDb();

export async function initDb(targetDb = db) {
  await targetDb.read();
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
  await targetDb.write();
}
