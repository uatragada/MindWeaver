import { startMindWeaverServer } from "./runtime.js";

const runtime = await startMindWeaverServer();

console.log(`MindWeaver running on ${runtime.url}`);
console.log(`API available at ${runtime.apiUrl}`);
console.log(runtime.staticDirExists ? "Serving built web app from web/dist" : "Built web app not found. Run npm run build for production UI serving.");

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down MindWeaver...`);
  runtime.close()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
