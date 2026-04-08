import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import OpenAI from "openai";
import { createDb, initDb } from "../db.js";
import { createApp } from "../app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, "..");

config({ path: join(serverDir, ".env.local") });
config({ path: join(serverDir, ".env") });

const fixturePath = join(serverDir, "fixtures", "sample-imports.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-eval-"));
const db = createDb(join(tempDir, "eval-data.json"));
await initDb(db);

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const app = createApp({ db, openaiClient });
const server = createServer(app);
await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: fixture.goal })
  });
  const session = await sessionResponse.json();

  for (const source of fixture.sources) {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: source.sourceType,
        title: source.title,
        excerpt: source.content.slice(0, 280),
        content: source.content
      })
    });

    const payload = await response.json();
    process.stdout.write(`Imported ${source.sourceType}: ${source.title}\n`);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n\n`);
  }

  const graphResponse = await fetch(`${baseUrl}/api/graph/${session.id}`);
  const graph = await graphResponse.json();

  process.stdout.write(`Session goal: ${graph.session.goal}\n`);
  process.stdout.write(`Visible nodes: ${graph.nodes.length}\n`);
  process.stdout.write(`Review queue: ${graph.reviewQueue.length}\n`);
  process.stdout.write("Recommendations:\n");
  for (const recommendation of graph.recommendations ?? []) {
    process.stdout.write(`- ${recommendation.title}: ${recommendation.reason}\n`);
  }

  if (!openaiClient) {
    process.stdout.write("\nOpenAI is not configured, so this run exercises the import and recommendation loop without live classification.\n");
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(tempDir, { recursive: true, force: true });
}
