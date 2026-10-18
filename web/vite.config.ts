import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Three screens, one workspace. The Node server serves web/dist and proxies nothing:
// in dev, `npm run dev` proxies the API to the running EchoHawk server on 8787.
const API = ["/resident", "/relay", "/app/media", "/app/sw.js", "/app/manifest.webmanifest", "/app/icon.svg","/incidents", "/calls", "/zones", "/events", "/cost", "/health", "/callbacks", "/kits", "/demo", "/replay/run", "/replay/days", "/geo", "/vendor", "/broadcasts", "/agencies", "/agency", "/languages", "/phrasebook", "/packets", "/device", "/units", "/history", "/nodes", "/research", "/my"];
export default defineConfig({
  plugins: [react(), {
    name: 'resident-precache',
    generateBundle(_options, bundle) {
      this.emitFile({ type: 'asset', fileName: 'resident-precache.json', source: JSON.stringify(Object.keys(bundle).filter(p => p.startsWith('assets/')).map(p => '/' + p)) });
    },
  }],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        board: resolve(__dirname, "board/index.html"),
        console: resolve(__dirname, "console/index.html"),
        replay: resolve(__dirname, "replay/index.html"),
        alerts: resolve(__dirname, "alerts/index.html"),
        standard: resolve(__dirname, "standard/index.html"),
        app: resolve(__dirname, "app/index.html"),
        node: resolve(__dirname, "node/index.html"),
      },
    },
  },
  server: { proxy: Object.fromEntries(API.map((p) => [p, "http://localhost:8787"])) },
});
