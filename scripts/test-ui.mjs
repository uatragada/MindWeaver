import { chromium } from "playwright";
import { mkdir } from "fs/promises";

const DIAG = process.argv.includes("--diag");
await mkdir("output", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(15000);

const results = [];
const pass = (msg) => { results.push(`  ✅ ${msg}`); };
const fail = (msg) => { results.push(`  ❌ ${msg}`); };
const info = (msg) => { results.push(`  ℹ  ${msg}`); };

// ── Homepage ─────────────────────────────────────────────────────────
console.log("\n── Homepage ─────────────────────────────────────");
await page.goto("http://localhost:5197");
await page.waitForLoadState("networkidle");

const topbarOnHome = await page.locator(".workspace-topbar").count();
topbarOnHome === 0 ? pass("No workspace-topbar on homepage (correct)") : fail("workspace-topbar unexpectedly on homepage");

const mapTabsOnHome = await page.locator(".map-tabs-shell").count();
mapTabsOnHome > 0 ? pass("map-tabs-shell present on homepage") : fail("map-tabs-shell missing on homepage");

await page.screenshot({ path: "output/01-homepage.png" });
info("Screenshot: output/01-homepage.png");

// ── Create a map & enter workspace ──────────────────────────────────
console.log("\n── Creating test map ────────────────────────────");
const newMapInput = page.locator(".map-tab-input").first();
await newMapInput.fill("Playwright UI Test");
await page.locator("button:has-text('New Map')").first().click();
await page.waitForURL(/session/, { timeout: 12000 });
await page.waitForLoadState("networkidle");
await page.waitForTimeout(2000);
info(`Workspace URL: ${page.url()}`);

// ── Workspace structure ──────────────────────────────────────────────
console.log("\n── Workspace topbar ─────────────────────────────");
const topbarCount = await page.locator(".workspace-topbar").count();
topbarCount === 1 ? pass("workspace-topbar rendered (1)") : fail(`workspace-topbar count = ${topbarCount}`);

const oldToolbar = await page.locator(".graph-toolbar").count();
oldToolbar === 0 ? pass("graph-toolbar removed") : fail("graph-toolbar still present");

const oldWorkflow = await page.locator(".graph-workflow-bar").count();
oldWorkflow === 0 ? pass("graph-workflow-bar removed") : fail("graph-workflow-bar still present");

const mapTabsInWorkspace = await page.locator(".map-tabs-shell").count();
mapTabsInWorkspace === 0 ? pass("map-tabs-shell gone from workspace") : fail("map-tabs-shell leaked into workspace");

// ── Topbar sections ──────────────────────────────────────────────────
console.log("\n── Topbar content ───────────────────────────────");
const homeBtn = await page.locator(".topbar-home").count();
homeBtn === 1 ? pass("Home button present") : fail(`Home button count = ${homeBtn}`);

const searchInput = await page.locator(".topbar-search-input").count();
searchInput === 1 ? pass("Search input present") : fail(`Search input count = ${searchInput}`);

const viewChips = await page.locator(".topbar-view-chip").count();
viewChips >= 4 ? pass(`View chips: ${viewChips}`) : fail(`View chips too few: ${viewChips}`);

const focusDirBtns = await page.locator(".topbar-dir-btn").count();
focusDirBtns === 3 ? pass("Direction toggle buttons: ↑ Up, ↕ Both, ↓ Down") : fail(`Direction button count = ${focusDirBtns}`);

const statusPill = await page.locator(".topbar-status-pill").count();
statusPill === 1 ? pass("Status pill present") : fail(`Status pill count = ${statusPill}`);

// Active tab pill should show map name
const activeTab = await page.locator(".topbar-tab.is-active").textContent().catch(() => "");
activeTab.includes("Playwright UI Test") ? pass(`Active tab shows map name`) : fail(`Active tab text: "${activeTab.trim()}"`);

await page.screenshot({ path: "output/02-workspace-topbar.png" });
info("Screenshot: output/02-workspace-topbar.png");

// ── Context strip (shows when node selected) ──────────────────────
console.log("\n── Context strip ────────────────────────────────");
const contextStrip = await page.locator(".graph-context-strip").count();
if (contextStrip > 0) {
  // Strip is shown — verify it has actual content (not empty)
  const nodeLabel = await page.locator(".context-node-label, .graph-breadcrumb, .graph-selection-pill").count();
  nodeLabel > 0
    ? pass("Context strip visible with content (node selected)")
    : fail("Context strip visible but empty");
} else {
  pass("Context strip hidden (no node selected)");
}

// ── Canvas fills viewport ────────────────────────────────────────────
console.log("\n── Graph canvas size ─────────────────────────────");
const topbarBB = await page.locator(".workspace-topbar").boundingBox();
const canvasBB = await page.locator(".graph-canvas").boundingBox();
const contextStripBB = await page.locator(".graph-context-strip").boundingBox();
const viewportH = page.viewportSize()?.height ?? 0;

const topbarH = topbarBB?.height ?? 0;
const canvasH = canvasBB?.height ?? 0;
const stripH = contextStripBB?.height ?? 0;
const combined = topbarH + stripH + canvasH;

info(`Viewport height: ${viewportH}px`);
info(`Topbar height: ${Math.round(topbarH)}px`);
if (stripH > 0) info(`Context strip height: ${Math.round(stripH)}px`);
info(`Canvas height: ${Math.round(canvasH)}px`);
info(`Total: ${Math.round(combined)}px`);

Math.abs(combined - viewportH) < 10
  ? pass(`Layout fills viewport (${Math.round(combined)}px ≈ ${viewportH}px)`)
  : fail(`Layout height mismatch: ${Math.round(combined)}px vs ${viewportH}px`);

// ── Search then find ─────────────────────────────────────────────────
console.log("\n── Topbar search ────────────────────────────────");
await page.locator(".topbar-search-input").fill("test");
const findBtn = page.locator(".topbar-btn:has-text('Find')");
const findEnabled = await findBtn.isEnabled();
findEnabled ? pass("Find button enabled when query entered") : fail("Find button still disabled");

await page.screenshot({ path: "output/03-search-filled.png" });
info("Screenshot: output/03-search-filled.png");

// ── View chips ────────────────────────────────────────────────────────
console.log("\n── View chip interaction ────────────────────────");
const overviewChip = page.locator(".topbar-view-chip").first();
await overviewChip.click();
await page.waitForTimeout(400);
const isActive = await overviewChip.evaluate((el) => el.classList.contains("is-active"));
isActive ? pass("Clicking view chip adds is-active class") : fail("is-active class not added after click");

await page.screenshot({ path: "output/04-view-chip.png" });
info("Screenshot: output/04-view-chip.png");

// ── Home navigation ───────────────────────────────────────────────────
console.log("\n── Home button ──────────────────────────────────");
await page.locator(".topbar-home").click();
await page.waitForTimeout(600);
const urlAfterHome = page.url();
const backOnHome = !urlAfterHome.includes("session");
backOnHome ? pass("Home button navigates away from workspace") : fail(`Still in workspace: ${urlAfterHome}`);

await page.screenshot({ path: "output/05-after-home.png" });
info("Screenshot: output/05-after-home.png");

// ── Summary ───────────────────────────────────────────────────────────
await browser.close();

console.log("\n══════════════════════════════════════════════════");
console.log("  Results");
console.log("══════════════════════════════════════════════════");
for (const r of results) console.log(r);

const failures = results.filter((r) => r.startsWith("  ❌"));
console.log(`\n  ${results.length - failures.length - results.filter(r=>r.startsWith("  ℹ")).length} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exit(1);
