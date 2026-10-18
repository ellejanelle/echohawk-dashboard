// EchoHawk server entry point. `npm start` then open http://localhost:8787
import "./env.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { RetellHub } from "./retell_ws.js";
import { createHttpServer } from "./http.js";
import { loadAdjacency, loadBaselines } from "./seed.js";

// Snapshot path: DB_PATH on a hosted volume (Railway: /var/data/db.json), data/db.json locally.
// Never the repo's data/ directory on a host: it holds the baselines and replay files the server reads.
const store = new Store(config.dbPath);
const engine = new Engine(store, { adjacency: loadAdjacency() });
if (store.baselines.length === 0) loadBaselines(store);
// A restart drops every websocket; mark any still-open call as ended so it stops showing as live.
for (const c of store.calls) {
  if (!c.ended_at) {
    c.ended_at = new Date().toISOString();
    if (c.status === "active") c.status = "ended";
    c.end_reason = "server_restart";
  }
}
store.save();
const hub = new RetellHub({ store, engine });
const server = createHttpServer({ store, engine, hub });
hub.attach(server);
server.listen(config.port, config.host, () => {
  console.log(`EchoHawk on http://localhost:${config.port}  board=/  console=/console  app=/app  chirp=/chirp  (snapshot: ${config.dbPath})`);
  console.log(`Retell custom LLM websocket: ${config.publicBaseUrl.replace(/^http/, "ws")}/retell/llm/{call_id}`);
  console.log(`LLM: ${config.llm.apiKey ? `${config.llm.provider} ${config.llm.model}` : "rule-based script (set ANTHROPIC_API_KEY in .env to use Claude)"}`);
});
