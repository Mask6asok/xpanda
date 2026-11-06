import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    server: { host: "127.0.0.1", port: 5174, strictPort: true },
    preview: { host: "127.0.0.1", port: 4174, strictPort: true },
    worker: { format: "es" },
    build: { chunkSizeWarningLimit: 4096 },
});
