import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import OpenAI from "openai";
import { db, initDb } from "./db.js";
import { createApp } from "./app.js";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(__dirname, ".env.local") });
config({ path: resolve(__dirname, ".env") });

await initDb(db);

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const staticDir = resolve(__dirname, "../web/dist");
const app = createApp({ db, openaiClient, staticDir });
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

const server = app.listen(port, host, () => {
  console.log(`MindWeaver running on http://${host}:${port}`);
  console.log(`API available at http://${host}:${port}/api/health`);
  console.log(existsSync(staticDir) ? "Serving built web app from web/dist" : "Built web app not found. Run npm run build for production UI serving.");
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down MindWeaver...`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
