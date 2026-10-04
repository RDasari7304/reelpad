import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // Share server/.env locally; only VITE_* variables are exposed to the browser.
  envDir: "../server",
  plugins: [react(), nodePolyfills({ include: ["buffer", "crypto", "stream"], globals: { Buffer: true } })],
  server: {
    port: 5173,
    // Allow HTTPS tunnels (ngrok/cloudflared) in dev, needed to test Instagram login locally.
    allowedHosts: true,
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false },
});
