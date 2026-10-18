// Claude provider: request shape (Messages API), JSON extraction, and timeout fallback, against a local mock.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

async function mock(handler) {
  const seen = [];
  const srv = createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; seen.push({ url: req.url, headers: req.headers, body: JSON.parse(b || "{}") }); handler(req, res, seen.at(-1)); });
  await new Promise((r) => srv.listen(0, r));
  return { url: `http://localhost:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}
const reply = (text) => (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text }] })); };

test("Claude: Messages API shape, alternating turns, spoken reply", async () => {
  const m = await mock(reply("Got it, zone 6. Is anyone hurt?"));
  process.env.ANTHROPIC_API_KEY = "test-key"; process.env.ANTHROPIC_BASE_URL = m.url;
  const { agentReply } = await import(`../llm.js?claude1`);
  const out = await agentReply([{ role: "agent", content: "How can I help?" }, { role: "user", content: "Zone six, water pressure is gone." }], { fields: { zone_id: "Z06", target: "water" }, language: "en" });
  assert.equal(out, "Got it, zone 6. Is anyone hurt?");
  const r = m.seen[0];
  assert.equal(r.url, "/v1/messages");
  assert.equal(r.headers["x-api-key"], "test-key");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.match(r.body.system, /EchoHawk/);
  assert.equal(r.body.messages[0].role, "user");
  for (let i = 1; i < r.body.messages.length; i++) assert.notEqual(r.body.messages[i].role, r.body.messages[i - 1].role);
  assert.equal(r.body.messages.at(-1).role, "user");
  await m.close();
});

test("Claude: JSON extraction strips code fences", async () => {
  const m = await mock(reply('```json\n{"zone_id":"Z04","target":"power","severity":2,"action":"deflect_311"}\n```'));
  process.env.ANTHROPIC_BASE_URL = m.url;
  const { extractFields } = await import(`../llm.js?claude2`);
  const f = await extractFields("Zona cuatro, se fue la luz");
  assert.equal(m.seen.length, 1, "the model was actually called");
  assert.match(m.seen[0].body.system, /single JSON object/);
  assert.equal(f.zone_id, "Z04"); assert.equal(f.target, "power"); assert.equal(f.complete, true);
  await m.close();
});

test("Claude: a slow model falls back to the script instead of leaving the caller in silence", async () => {
  const m = await mock(() => {}); // never answers
  process.env.ANTHROPIC_BASE_URL = m.url; process.env.LLM_TIMEOUT_MS = "300";
  const { agentReply } = await import(`../llm.js?claude3`);
  const t0 = Date.now();
  const out = await agentReply([{ role: "user", content: "Zone six, water pressure is gone." }], { fields: { zone_id: "Z06", target: "water" }, language: "en" });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(m.seen.length, 1, "the model was called and timed out");
  assert.match(out, /zone 6/i);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; delete process.env.LLM_TIMEOUT_MS;
  m.close();
});
