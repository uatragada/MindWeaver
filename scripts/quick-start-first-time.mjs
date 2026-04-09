import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  detectChromePath,
  launchChromeWithExtension,
  rootDir,
  saveChromePath,
  trimQuotes
} from "./chrome-extension.mjs";

const serverDir = resolve(rootDir, "server");
const envLocalPath = resolve(serverDir, ".env.local");
const envExamplePath = resolve(serverDir, ".env.example");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const openAiPlaceholder = "your_openai_api_key_here";

function normalizeEnvContents(contents) {
  return contents.replace(/\r\n/g, "\n");
}

function ensureTrailingNewline(contents) {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureEnvLocalFile() {
  if (existsSync(envLocalPath)) {
    return;
  }

  if (existsSync(envExamplePath)) {
    const exampleContents = normalizeEnvContents(readFileSync(envExamplePath, "utf8"));
    const sanitizedContents = exampleContents.replace(/^OPENAI_API_KEY\s*=.*$/m, "OPENAI_API_KEY=");
    writeFileSync(envLocalPath, ensureTrailingNewline(sanitizedContents), "utf8");
    return;
  }

  writeFileSync(envLocalPath, "OPENAI_API_KEY=\n", "utf8");
}

function readEnvValue(contents, key) {
  const match = normalizeEnvContents(contents).match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`, "m"));
  if (!match) {
    return "";
  }

  const value = match[1].trim();
  return value === openAiPlaceholder ? "" : value;
}

function upsertEnvValue(contents, key, value) {
  const normalizedContents = normalizeEnvContents(contents);
  const entry = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");

  if (pattern.test(normalizedContents)) {
    return ensureTrailingNewline(normalizedContents.replace(pattern, entry));
  }

  if (!normalizedContents.trim()) {
    return `${entry}\n`;
  }

  return `${ensureTrailingNewline(normalizedContents)}${entry}\n`;
}

async function runSetup() {
  console.log("Installing MindWeaver dependencies...");

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(npmCommand, ["run", "setup"], {
      cwd: rootDir,
      stdio: "inherit"
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`npm run setup exited with code ${code ?? 1}`));
    });
  });
}

async function promptForOpenAiKey(rl, existingKey) {
  console.log("");
  console.log(`MindWeaver stores the API key in ${envLocalPath}.`);
  console.log("Enter your OpenAI API key to enable AI-powered features, or leave it blank to skip for now.");

  const prompt = existingKey
    ? "OpenAI API key [press Enter to keep the current value, type SKIP to clear it]: "
    : "OpenAI API key [press Enter to skip for now]: ";
  const response = (await rl.question(prompt)).trim();

  if (!response) {
    return existingKey;
  }

  if (/^skip$/i.test(response)) {
    return "";
  }

  return response;
}

async function promptForChromePath(rl, detectedChromePath) {
  console.log("");
  console.log("MindWeaver can launch Chrome with the unpacked extension loaded for you.");

  if (detectedChromePath) {
    console.log(`Detected Chrome at: ${detectedChromePath}`);
  } else {
    console.log("Chrome was not auto-detected.");
  }

  while (true) {
    const prompt = detectedChromePath
      ? "Chrome path [press Enter to use it, paste a different chrome.exe path, or type SKIP]: "
      : "Chrome path [paste the full path to chrome.exe, or press Enter to skip]: ";
    const response = trimQuotes(await rl.question(prompt));

    if (!response) {
      return detectedChromePath;
    }

    if (/^skip$/i.test(response)) {
      return "";
    }

    if (existsSync(response)) {
      return response;
    }

    console.log("That path was not found. Paste the full path to chrome.exe or type SKIP.");
  }
}

async function main() {
  const rl = createInterface({ input, output });

  try {
    console.log("MindWeaver first-time setup");
    console.log("---------------------------");

    await runSetup();
    ensureEnvLocalFile();

    const currentEnvContents = readFileSync(envLocalPath, "utf8");
    const existingKey = readEnvValue(currentEnvContents, "OPENAI_API_KEY");
    const openAiKey = await promptForOpenAiKey(rl, existingKey);
    const updatedEnvContents = upsertEnvValue(currentEnvContents, "OPENAI_API_KEY", openAiKey);
    writeFileSync(envLocalPath, updatedEnvContents, "utf8");

    if (openAiKey) {
      console.log(`Saved OPENAI_API_KEY to ${envLocalPath}.`);
    } else {
      console.log(`Left OPENAI_API_KEY blank in ${envLocalPath}. You can add it later any time.`);
    }

    const chromePath = await promptForChromePath(rl, detectChromePath());
    if (chromePath) {
      saveChromePath(chromePath);

      const launched = launchChromeWithExtension({
        chromePath,
        urls: ["chrome://extensions/"]
      });

      if (launched) {
        console.log("Chrome launched with the MindWeaver extension loaded.");
        console.log("Check chrome://extensions if you want to pin or inspect the extension.");
      } else {
        console.log("Chrome path was saved, but Chrome could not be launched.");
      }
    } else {
      console.log("Skipped Chrome launch. You can rerun this setup later to save a Chrome path.");
    }

    console.log("");
    console.log("Setup complete.");
    console.log("Next time, run quick-start-dev.bat to start the backend and web app.");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
