import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDb, initDb } from "../../server/db.js";
import { createApp } from "../../server/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const extensionDir = resolve(rootDir, "extension");

function createMockOpenAI() {
  return {
    chat: {
      completions: {
        async create({ messages }) {
          const prompt = messages.map((message) => message.content).join("\n");
          if (prompt.includes('Return only JSON: {"domain":"...", "skill":"...", "concepts":["..."]}')) {
            return {
              choices: [
                {
                  message: {
                    content: '{"domain":"distributed systems","skill":"delivery guarantees","concepts":["at least once delivery"]}'
                  }
                }
              ]
            };
          }

          if (prompt.includes("should_ingest")) {
            return {
              choices: [
                {
                  message: {
                    content: '{"should_ingest":true,"reason":"substantive"}'
                  }
                }
              ]
            };
          }

          return {
            choices: [
              {
                message: {
                  content: "{}"
                }
              }
            ]
          };
        }
      }
    }
  };
}

async function startMindWeaverServer() {
  const tempDir = await mkdtemp(resolve(os.tmpdir(), "mindweaver-extension-api-"));
  const db = createDb(resolve(tempDir, "data.json"));
  await initDb(db);
  const app = createApp({
    db,
    openaiClient: createMockOpenAI(),
    staticDir: null
  });
  const server = createServer(app);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    db,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function startArticleServer() {
  const html = `<!doctype html>
  <html>
    <head>
      <title>At Least Once Delivery</title>
      <meta name="description" content="At least once delivery retries messages until an acknowledgement arrives." />
      <meta name="keywords" content="distributed systems, messaging, retries" />
    </head>
    <body>
      <main>
        <article>
          <h1>At Least Once Delivery</h1>
          <p>At least once delivery retries a message until the broker receives an acknowledgement from the consumer.</p>
          <p>That makes duplicates possible, so consumers need idempotent handlers and deduplication keys.</p>
          <p>Teams typically monitor retry counts, dead letter queues, and consumer lag to keep the system healthy.</p>
          <p>This article is intentionally long enough for the extension extractor to prefer the article body over chrome text.</p>
          <p>${"Reliable message processing depends on retries, acknowledgements, and idempotency. ".repeat(24)}</p>
        </article>
      </main>
    </body>
  </html>`;

  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();

  return {
    url: `http://127.0.0.1:${address.port}/article`,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  };
}

async function launchExtensionContext() {
  const userDataDir = await mkdtemp(resolve(os.tmpdir(), "mindweaver-extension-browser-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }

  const extensionId = new URL(serviceWorker.url()).host;
  return {
    context,
    extensionId,
    serviceWorker,
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  };
}

async function getSessionTarget(baseUrl) {
  const response = await fetch(`${baseUrl}/api/session-target?limit=24`);
  return await response.json();
}

async function getGraph(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/api/graph/${encodeURIComponent(sessionId)}`);
  return await response.json();
}

test("extension workflow creates maps, switches targets, ends the active map, and captures real page content", async () => {
  const apiServer = await startMindWeaverServer();
  const articleServer = await startArticleServer();
  const browser = await launchExtensionContext();

  try {
    await browser.serviceWorker.evaluate(async ({ apiBase }) => {
      await chrome.storage.local.set({
        mindweaverApiBases: [apiBase],
        mindweaverAllowLocalPageCapture: true
      });
    }, { apiBase: apiServer.baseUrl });

    const popupPage = await browser.context.newPage();
    const dialogs = [];
    popupPage.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await popupPage.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await popupPage.waitForSelector("#status");

    await popupPage.fill("#goal", "Map A");
    await popupPage.click("#create");
    await popupPage.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Map A"));

    let targetState = await getSessionTarget(apiServer.baseUrl);
    assert.equal(targetState.activeSession?.goal, "Map A");
    const mapA = targetState.activeSession;

    const articlePage = await browser.context.newPage();
    await articlePage.goto(articleServer.url, { waitUntil: "domcontentloaded" });
    await articlePage.bringToFront();

    const firstCapture = await popupPage.evaluate(() => chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" }));
    assert.equal(firstCapture.ok, true);

    let graphA = await getGraph(apiServer.baseUrl, mapA.id);
    assert.equal(graphA.artifacts.length, 1);
    assert.equal(graphA.artifacts[0].title, "At Least Once Delivery");

    await popupPage.bringToFront();
    await popupPage.fill("#goal", "Map B");
    await popupPage.click("#create");
    await popupPage.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Map B"));

    targetState = await getSessionTarget(apiServer.baseUrl);
    assert.equal(targetState.activeSession?.goal, "Map B");
    const mapB = targetState.activeSession;

    await popupPage.selectOption("#target", mapA.id);
    await popupPage.waitForFunction((goal) => document.querySelector("#status")?.textContent?.includes(goal), mapA.goal);

    targetState = await getSessionTarget(apiServer.baseUrl);
    assert.equal(targetState.activeSessionId, mapA.id);

    await popupPage.click("#end");
    await popupPage.waitForFunction(() => document.querySelector("#status")?.textContent === "No active map selected");

    targetState = await getSessionTarget(apiServer.baseUrl);
    assert.equal(targetState.activeSessionId, null);
    assert.equal(targetState.lastSessionId, mapA.id);

    await articlePage.bringToFront();
    const skippedCapture = await popupPage.evaluate(() => chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" }));
    assert.equal(skippedCapture.skipped, true);

    await popupPage.bringToFront();
    await popupPage.selectOption("#target", mapB.id);
    await popupPage.waitForFunction((goal) => document.querySelector("#status")?.textContent?.includes(goal), mapB.goal);

    await articlePage.bringToFront();
    const mapBCapture = await popupPage.evaluate(() => chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" }));
    const dedupedCapture = await popupPage.evaluate(() => chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" }));
    assert.equal(mapBCapture.ok, true);
    assert.equal(dedupedCapture.ok, true);
    assert.equal(dedupedCapture.body.deduped, true);

    graphA = await getGraph(apiServer.baseUrl, mapA.id);
    const graphB = await getGraph(apiServer.baseUrl, mapB.id);
    assert.equal(graphA.artifacts.length, 1);
    assert.equal(graphB.artifacts.length, 1);

    await popupPage.bringToFront();
    await popupPage.reload();
    await popupPage.waitForFunction(() => document.querySelector("#lastCapture")?.textContent?.includes("Map B"));

    assert.deepEqual(dialogs, []);
  } finally {
    await browser.close();
    await articleServer.close();
    await apiServer.close();
  }
});
