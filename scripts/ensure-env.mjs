import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const serverDir = resolve(rootDir, "server");
const envPath = resolve(serverDir, ".env");
const envLocalPath = resolve(serverDir, ".env.local");
const envExamplePath = resolve(serverDir, ".env.example");
const placeholderPattern = /^OPENAI_API_KEY\s*=.*$/m;
const blankKeyEntry = "OPENAI_API_KEY=";

function withBlankOpenAiKey(contents) {
  const normalizedContents = contents.replace(/\r\n/g, "\n");
  const updatedContents = placeholderPattern.test(normalizedContents)
    ? normalizedContents.replace(placeholderPattern, blankKeyEntry)
    : `${normalizedContents}${normalizedContents.endsWith("\n") ? "" : "\n"}${blankKeyEntry}`;

  return updatedContents.endsWith("\n") ? updatedContents : `${updatedContents}\n`;
}

if (existsSync(envLocalPath)) {
  console.log("Using existing server/.env.local");
  process.exit(0);
}

if (existsSync(envPath)) {
  console.log("Using existing server/.env");
  process.exit(0);
}

if (existsSync(envExamplePath)) {
  writeFileSync(envLocalPath, withBlankOpenAiKey(readFileSync(envExamplePath, "utf8")), "utf8");
  console.log("Created server/.env.local from server/.env.example");
} else {
  writeFileSync(envLocalPath, `${blankKeyEntry}\n`, "utf8");
  console.log("Created server/.env.local with a blank OpenAI API key entry");
}

console.log("Add your OpenAI API key to server/.env.local to enable AI-powered features.");
