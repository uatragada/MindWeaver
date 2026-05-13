import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.MINDWEAVER_QA_URL ?? "http://127.0.0.1:5197/";
const OUTPUT_DIR = path.resolve("output/playwright/agents-qa");

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844, isMobile: true },
  { name: "ultrawide", width: 2560, height: 1440 }
];

function assertCheck(report, condition, message) {
  if (!condition) report.failures.push(message);
}

async function auditPage(page, report, name) {
  const metrics = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    };

    const getTargetRect = (element) => {
      const label = element.closest("label");
      if (label && element.matches("input[type='checkbox'], input[type='radio']")) {
        return label.getBoundingClientRect();
      }
      return element.getBoundingClientRect();
    };

    const controls = Array.from(document.querySelectorAll([
      "button",
      "a[href]",
      "input",
      "select",
      "textarea",
      "[role='button']"
    ].join(","))).filter(isVisible);
    const smallTargets = controls
      .map((element) => ({ element, rect: getTargetRect(element) }))
      .filter(({ element, rect }) => !element.disabled && (rect.width < 24 || rect.height < 24))
      .map(({ element, rect }) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.getAttribute("aria-label") || element.textContent || element.name || element.type || "").trim().slice(0, 80),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }));
    const mobileSmallTargets = window.innerWidth <= 760
      ? controls
        .map((element) => ({ element, rect: getTargetRect(element) }))
        .filter(({ element, rect }) => !element.disabled && !element.closest(".topbar-tab-strip, .map-reopen-row") && (rect.width < 44 || rect.height < 44))
        .map(({ element, rect }) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.getAttribute("aria-label") || element.textContent || element.name || element.type || "").trim().slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }))
      : [];
    const unlabeledIconButtons = controls
      .filter((element) => element.matches("button"))
      .filter((button) => button.querySelector("svg") && !(button.textContent || "").trim() && !button.getAttribute("aria-label") && !button.getAttribute("title"))
      .map((button) => button.outerHTML.slice(0, 140));
    const inputFontFailures = window.innerWidth <= 760
      ? Array.from(document.querySelectorAll("input, textarea, select, .select-trigger"))
        .filter(isVisible)
        .map((element) => ({ element, fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize) }))
        .filter(({ fontSize }) => fontSize < 16)
        .map(({ element, fontSize }) => ({
          tag: element.tagName.toLowerCase(),
          name: element.getAttribute("name") || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "",
          fontSize
        }))
      : [];
    const horizontalOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const metaThemeColor = document.querySelector("meta[name='theme-color']")?.getAttribute("content") ?? "";
    const viewportMeta = document.querySelector("meta[name='viewport']")?.getAttribute("content") ?? "";
    const colorScheme = window.getComputedStyle(document.documentElement).colorScheme;
    const skipLink = document.querySelector(".skip-link[href='#main-content']");
    const reducedMotionRule = Array.from(document.styleSheets).some((sheet) => {
      try {
        return Array.from(sheet.cssRules).some((rule) => String(rule.media?.mediaText ?? "").includes("prefers-reduced-motion"));
      } catch {
        return false;
      }
    });
    const transitionAll = Array.from(document.styleSheets).some((sheet) => {
      try {
        return Array.from(sheet.cssRules).some((rule) => /transition\s*:\s*all\b/i.test(rule.cssText));
      } catch {
        return false;
      }
    });
    const nativeSelectColorFailures = Array.from(document.querySelectorAll("select")).filter(isVisible).map((select) => {
      const style = window.getComputedStyle(select);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color
      };
    }).filter((style) => !style.backgroundColor || !style.color);
    const visibleText = document.body.innerText ?? "";

    return {
      title: document.title,
      metaThemeColor,
      viewportMeta,
      colorScheme,
      skipLinkExists: Boolean(skipLink),
      mainExists: Boolean(document.querySelector("#main-content")),
      horizontalOverflow,
      smallTargets: smallTargets.slice(0, 20),
      mobileSmallTargets: mobileSmallTargets.slice(0, 20),
      unlabeledIconButtons,
      inputFontFailures,
      reducedMotionRule,
      transitionAll,
      nativeSelectColorFailures,
      visibleTripleDots: visibleText.includes("...")
    };
  });

  assertCheck(report, metrics.title.includes("MindWeaver"), `${name}: document title should identify MindWeaver.`);
  assertCheck(report, /^#0|rgb\(0|#050505/i.test(metrics.metaThemeColor), `${name}: theme-color should be dark.`);
  assertCheck(report, metrics.viewportMeta.includes("width=device-width"), `${name}: viewport metadata missing width=device-width.`);
  assertCheck(report, !/maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i.test(metrics.viewportMeta), `${name}: viewport disables zoom.`);
  assertCheck(report, metrics.colorScheme.includes("dark"), `${name}: html color-scheme should be dark.`);
  assertCheck(report, metrics.skipLinkExists, `${name}: skip-to-content link missing.`);
  assertCheck(report, metrics.mainExists, `${name}: #main-content missing.`);
  assertCheck(report, !metrics.horizontalOverflow, `${name}: page has horizontal overflow.`);
  assertCheck(report, metrics.unlabeledIconButtons.length === 0, `${name}: unlabeled icon buttons found: ${JSON.stringify(metrics.unlabeledIconButtons)}`);
  assertCheck(report, metrics.smallTargets.length === 0, `${name}: controls below 24px target: ${JSON.stringify(metrics.smallTargets)}`);
  assertCheck(report, metrics.mobileSmallTargets.length === 0, `${name}: mobile controls below 44px target: ${JSON.stringify(metrics.mobileSmallTargets)}`);
  assertCheck(report, metrics.inputFontFailures.length === 0, `${name}: mobile inputs/selects below 16px: ${JSON.stringify(metrics.inputFontFailures)}`);
  assertCheck(report, metrics.reducedMotionRule, `${name}: reduced-motion CSS rule missing.`);
  assertCheck(report, !metrics.transitionAll, `${name}: transition: all found.`);
  assertCheck(report, metrics.nativeSelectColorFailures.length === 0, `${name}: native select colors missing.`);
  assertCheck(report, !metrics.visibleTripleDots, `${name}: visible text still contains three-dot ellipsis.`);

  return metrics;
}

async function run() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const report = {
    baseUrl: BASE_URL,
    createdAt: new Date().toISOString(),
    failures: [],
    warnings: [],
    screenshots: [],
    consoleErrors: []
  };

  try {
    const response = await fetch(BASE_URL);
    assertCheck(report, response.ok, `Dev server returned ${response.status} for ${BASE_URL}`);
  } catch (error) {
    report.failures.push(`Dev server is not reachable at ${BASE_URL}: ${error.message}`);
  }

  if (report.failures.length) {
    await writeFile(path.join(OUTPUT_DIR, "agents-qa-report.json"), JSON.stringify(report, null, 2));
    throw new Error(report.failures.join("\n"));
  }

  const browser = await chromium.launch({ headless: true });

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: Boolean(viewport.isMobile)
      });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") {
          report.consoleErrors.push(`${viewport.name}: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => {
        report.consoleErrors.push(`${viewport.name}: ${error.message}`);
      });

      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.screenshot({ path: path.join(OUTPUT_DIR, `${viewport.name}-home.png`), fullPage: true });
      report.screenshots.push(`${viewport.name}-home.png`);
      await auditPage(page, report, `${viewport.name} home`);

      if (viewport.name === "desktop") {
        const providerButton = page.getByRole("button", { name: "AI provider" });
        if (await providerButton.count() === 1) {
          await providerButton.focus();
          await providerButton.press("ArrowDown");
          const listboxCount = await page.getByRole("listbox", { name: "AI provider" }).count();
          assertCheck(report, listboxCount === 1, "SelectControl should open a listbox with ArrowDown.");
          await providerButton.press("Escape");
          const listboxAfterEscapeCount = await page.getByRole("listbox", { name: "AI provider" }).count();
          assertCheck(report, listboxAfterEscapeCount === 0, "SelectControl should close with Escape.");
        } else {
          report.warnings.push("AI provider SelectControl not found on home page.");
        }

        const recentMap = page.locator(".home-map-row").first();
        if (await recentMap.count()) {
          await recentMap.click();
          await page.waitForLoadState("networkidle");
          await page.screenshot({ path: path.join(OUTPUT_DIR, "desktop-workspace.png"), fullPage: true });
          report.screenshots.push("desktop-workspace.png");
          await auditPage(page, report, "desktop workspace");

          const workspaceLabels = ["Inspector", "Assistant", "Actions", "Review", "Study", "Progress", "Import", "Gaps", "Quiz", "Map"];
          for (const label of workspaceLabels) {
            const item = page.locator(".workspace-nav-rail .workspace-nav-item").filter({ hasText: label });
            if (await item.count() === 1) {
              await item.click();
            } else {
              report.warnings.push(`Workspace nav item not found or ambiguous: ${label}`);
            }
          }
          await page.screenshot({ path: path.join(OUTPUT_DIR, "desktop-workspace-panels.png"), fullPage: true });
          report.screenshots.push("desktop-workspace-panels.png");
          await auditPage(page, report, "desktop workspace panels");
        } else {
          report.warnings.push("No recent maps available; workspace panel sweep skipped.");
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  assertCheck(report, report.consoleErrors.length === 0, `Console/page errors found: ${JSON.stringify(report.consoleErrors)}`);
  await writeFile(path.join(OUTPUT_DIR, "agents-qa-report.json"), JSON.stringify(report, null, 2));

  if (report.failures.length) {
    throw new Error(report.failures.join("\n"));
  }

  console.log(`Agents QA passed. Screenshots and report written to ${OUTPUT_DIR}`);
  if (report.warnings.length) {
    console.log(`Warnings:\n- ${report.warnings.join("\n- ")}`);
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
