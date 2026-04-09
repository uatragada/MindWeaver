import { detectChromePath, launchChromeWithExtension } from "./chrome-extension.mjs";

const chromePath = detectChromePath();

if (!chromePath) {
  console.log("Chrome auto-launch skipped. Run quick-start-first-time.bat if you want the extension loaded automatically.");
  process.exit(0);
}

const launched = launchChromeWithExtension({
  chromePath,
  urls: ["http://localhost:5197"]
});

if (launched) {
  console.log("Opened Chrome with the MindWeaver extension loaded.");
} else {
  console.log("Chrome auto-launch skipped because the configured chrome.exe path was not found.");
}
