import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDb, initDb } from "../../server/db.js";
import { createApp } from "../../server/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const extensionDir = resolve(rootDir, "extension");

function createMockOpenAI({ prompts = null } = {}) {
  return {
    chat: {
      completions: {
        async create({ messages }) {
          const prompt = messages.map((message) => message.content).join("\n");
          prompts?.push(prompt);
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

async function startMindWeaverServer({ staticDir = null, prompts = null } = {}) {
  const tempDir = await mkdtemp(resolve(os.tmpdir(), "mindweaver-extension-api-"));
  const db = createDb(resolve(tempDir, "data.json"));
  await initDb(db);
  const app = createApp({
    db,
    openaiClient: createMockOpenAI({ prompts }),
    staticDir
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

async function startFallbackWebAppDir() {
  const tempDir = await mkdtemp(resolve(os.tmpdir(), "mindweaver-extension-web-"));
  await writeFile(resolve(tempDir, "index.html"), `<!doctype html>
  <html>
    <body>
      <main>MindWeaver Test App</main>
    </body>
  </html>`);

  return {
    staticDir: tempDir,
    async close() {
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

async function startNoisyArticleServer() {
  const html = `<!doctype html>
  <html>
    <head>
      <title>Idempotence - Wikipedia</title>
      <meta name="description" content="Idempotence means repeated application produces the same result as a single application." />
    </head>
    <body>
      <main>
        <nav>
          <p>Toggle the table of contents</p>
          <p>32 languages العربية Català Čeština Dansk Deutsch Ελληνικά Esperanto Español</p>
        </nav>
        <article>
          <div id="toc">
            <p>Contents</p>
            <ul>
              <li>Definition</li>
              <li>Computer science</li>
            </ul>
          </div>
          <h1>Idempotence</h1>
          <p>In computer science, an idempotent operation can be applied multiple times without changing the result beyond the initial application.</p>
          <p>HTTP semantics use idempotent methods to make retries safer because repeating the same request should not create additional side effects.</p>
          <p>Engineers often pair idempotent handlers with deduplication keys, retries, and at-least-once delivery guarantees in distributed systems.</p>
          <p>${"Idempotent systems reduce duplicate side effects when requests or messages are retried. ".repeat(20)}</p>
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

async function waitForArtifactCount(baseUrl, sessionId, expectedMinimumCount) {
  const timeoutAt = Date.now() + 8000;

  while (Date.now() < timeoutAt) {
    const graph = await getGraph(baseUrl, sessionId);
    if ((graph.artifacts?.length ?? 0) >= expectedMinimumCount) {
      return graph;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }

  assert.fail(`Timed out waiting for at least ${expectedMinimumCount} artifact(s) in ${sessionId}.`);
}

test("extension workflow creates maps, switches targets, toggles continuous save, and captures real page content", async () => {
  const fallbackWebApp = await startFallbackWebAppDir();
  const apiServer = await startMindWeaverServer({ staticDir: fallbackWebApp.staticDir });
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

    const openAppPagePromise = browser.context.waitForEvent("page");
    await popupPage.click("#open");
    const appPage = await openAppPagePromise;
    await appPage.waitForLoadState("domcontentloaded");
    const appUrl = new URL(appPage.url());
    assert.equal(appUrl.searchParams.get("sessionId"), mapA.id);
    assert.equal(appUrl.origin, apiServer.baseUrl);
    assert.match(await appPage.textContent("body"), /MindWeaver Test App/);

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

    await popupPage.selectOption("#target", mapB.id);
    await popupPage.waitForFunction((goal) => document.querySelector("#status")?.textContent?.includes(goal), mapB.goal);
    targetState = await getSessionTarget(apiServer.baseUrl);
    assert.equal(targetState.activeSessionId, mapB.id);

    await articlePage.bringToFront();
    await popupPage.bringToFront();
    await popupPage.click("#autoCapture");
    await popupPage.waitForFunction(() => document.querySelector("#autoCapture")?.textContent?.includes("On"));
    await popupPage.close();

    await articlePage.bringToFront();
    await articlePage.goto(`${articleServer.url}?auto=1`, { waitUntil: "domcontentloaded" });
    let graphB = await waitForArtifactCount(apiServer.baseUrl, mapB.id, 1);
    const autoCaptureBaseline = graphB.artifacts.length;

    await articlePage.goto(`${articleServer.url}?auto=2`, { waitUntil: "domcontentloaded" });
    graphB = await waitForArtifactCount(apiServer.baseUrl, mapB.id, autoCaptureBaseline + 1);

    const reopenedPopupPage = await browser.context.newPage();
    reopenedPopupPage.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await reopenedPopupPage.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await reopenedPopupPage.waitForSelector("#status");
    await reopenedPopupPage.waitForFunction(() => document.querySelector("#autoCapture")?.textContent?.includes("On"));
    await reopenedPopupPage.click("#autoCapture");
    await reopenedPopupPage.waitForFunction(() => document.querySelector("#autoCapture")?.textContent?.includes("Off"));

    await articlePage.bringToFront();
    await articlePage.goto(`${articleServer.url}?auto=3`, { waitUntil: "domcontentloaded" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));

    graphA = await getGraph(apiServer.baseUrl, mapA.id);
    assert.equal(graphA.artifacts.length, 1);
    const finalGraphB = await getGraph(apiServer.baseUrl, mapB.id);
    assert.equal(finalGraphB.artifacts.length, graphB.artifacts.length);

    await reopenedPopupPage.reload();
    await reopenedPopupPage.waitForFunction(() => document.querySelector("#lastCapture")?.textContent?.includes("Map B"));
    await reopenedPopupPage.waitForFunction(() => document.querySelector("#autoCapture")?.textContent?.includes("Off"));

    assert.deepEqual(dialogs, []);
  } finally {
    await browser.close();
    await articleServer.close();
    await apiServer.close();
    await fallbackWebApp.close();
  }
});

test("extension capture strips navigation-heavy chrome before classification", async () => {
  const prompts = [];
  const apiServer = await startMindWeaverServer({ prompts });
  const noisyArticleServer = await startNoisyArticleServer();
  const browser = await launchExtensionContext();

  try {
    await browser.serviceWorker.evaluate(async ({ apiBase }) => {
      await chrome.storage.local.set({
        mindweaverApiBases: [apiBase],
        mindweaverAllowLocalPageCapture: true
      });
    }, { apiBase: apiServer.baseUrl });

    const popupPage = await browser.context.newPage();
    await popupPage.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await popupPage.waitForSelector("#status");
    await popupPage.fill("#goal", "Noisy Article Map");
    await popupPage.click("#create");
    await popupPage.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Noisy Article Map"));

    const articlePage = await browser.context.newPage();
    await articlePage.goto(noisyArticleServer.url, { waitUntil: "domcontentloaded" });
    await articlePage.bringToFront();

    const captureResult = await popupPage.evaluate(() => chrome.runtime.sendMessage({ type: "CAPTURE_ACTIVE_TAB" }));
    assert.equal(captureResult.ok, true);

    const classificationPrompt = prompts.find((prompt) => prompt.includes("Classify this source into one domain, one skill, and 1-8 core concepts."));
    assert.ok(classificationPrompt);
    assert.match(classificationPrompt, /idempotent operation can be applied multiple times/i);
    assert.match(classificationPrompt, /http semantics use idempotent methods/i);
    assert.doesNotMatch(classificationPrompt, /toggle the table of contents/i);
    assert.doesNotMatch(classificationPrompt, /32 languages/i);
  } finally {
    await browser.close();
    await noisyArticleServer.close();
    await apiServer.close();
  }
});
