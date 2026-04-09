import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const serverDir = resolve(rootDir, "server");
const envPath = resolve(serverDir, ".env");
const envLocalPath = resolve(serverDir, ".env.local");
const envExamplePath = resolve(serverDir, ".env.example");
const placeholder = "OPENAI_API_KEY=your_openai_api_key_here\n";

if (existsSync(envLocalPath)) {
  console.log("Using existing server/.env.local");
  process.exit(0);
}

if (existsSync(envPath)) {
  console.log("Using existing server/.env");
  process.exit(0);
}

if (existsSync(envExamplePath)) {
  copyFileSync(envExamplePath, envLocalPath);
  console.log("Created server/.env.local from server/.env.example");
} else {
  writeFileSync(envLocalPath, placeholder, "utf8");
  console.log("Created server/.env.local with an OpenAI API key placeholder");
}

console.log("Add your OpenAI API key to server/.env.local to enable AI-powered features.");
