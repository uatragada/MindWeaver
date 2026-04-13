import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import OpenAI from "openai";
import { createDb, initDb } from "./db.js";
import { createApp } from "./app.js";
import { DEFAULT_OLLAMA_BASE_URL } from "./openai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultStaticDir = resolve(__dirname, "../web/dist");
let envConfigured = false;

function configureEnv() {
  if (envConfigured) return;
  config({ path: resolve(__dirname, ".env.local") });
  config({ path: resolve(__dirname, ".env") });
  envConfigured = true;
}

export async function startMindWeaverServer({
  port,
  host,
  staticDir = defaultStaticDir,
  dataFile
} = {}) {
  configureEnv();
  const resolvedPort = Number(port ?? process.env.PORT ?? 3001);
  const resolvedHost = host ?? process.env.HOST ?? "127.0.0.1";
  const db = createDb(dataFile);
  await initDb(db);

  const openaiClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;

  const app = createApp({ db, openaiClient, ollamaBaseUrl, staticDir });
  const server = await new Promise((resolveServer, rejectServer) => {
    const listener = app.listen(resolvedPort, resolvedHost, () => resolveServer(listener));
    listener.on("error", rejectServer);
  });
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : resolvedPort;

  const close = () =>
    new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });

  return {
    app,
    db,
    server,
    host: resolvedHost,
    port: activePort,
    url: `http://${resolvedHost}:${activePort}`,
    apiUrl: `http://${resolvedHost}:${activePort}/api/health`,
    staticDir,
    staticDirExists: existsSync(staticDir),
    close
  };
}
