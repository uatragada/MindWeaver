import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-force-graph") || id.includes("force-graph")) return "graph-vendor";
          if (id.includes("react-markdown")) return "markdown-vendor";
          if (id.includes("lucide-react") || id.includes("lucide")) return "icons-vendor";
          return undefined;
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5197,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 5197,
    strictPort: true
  }
});
