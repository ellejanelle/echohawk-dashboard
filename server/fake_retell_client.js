// Drives the WebSocket the way Retell does so tests pass with no phone and no credits.
// Usage: node server/fake_retell_client.js [ws://localhost:8787] [scenario] [--hold SECONDS]
// Scenarios: water | bleeding | breathing | spanish | spanish_water | hangup
// --hold keeps the call open after the script so a dispatcher can Join from /console.
import WebSocket from "ws";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const holdIdx = process.argv.indexOf("--hold");
const holdSeconds = holdIdx > 0 ? Number(process.argv[holdIdx + 1] || 120) : 0;
const base = args[0] || "ws://localhost:8787";
const scenario = args[1] || "water";
const callId = `fake_${scenario}_${Date.now().toString(36)}`;

const scripts = {
  water:         ["Hi, this is zone Z06.", "Our water pressure dropped to almost nothing a few minutes ago.", "No, nobody is hurt, I just wanted to report it."],
  bleeding:      ["Zone Z02.", "My husband cut his leg and he's bleeding badly, there's blood everywhere."],
  breathing:     ["Zone Z09, my mother collapsed.", "She's sort of breathing, like gasping."],
  spanish:       ["Zona Z04.", "Se fue la luz en mi casa, nada más quería saber cuándo regresa."],
  spanish_water: ["Zona seis.", "No tenemos agua en la casa. La presión bajó hace unos minutos.", "Mi vecina de al lado tampoco tiene agua."],
  hangup:        ["uh"],
};

const lines = scripts[scenario] || scripts.water;
const transcript = [{ role: "agent", content: "This is the EchoHawk line. How can I help?" }];
let i = 0, rid = 0;

const ws = new WebSocket(`${base}/retell/llm/${callId}`);
ws.on("open", () => {
  console.log("connected", callId);
  ws.send(JSON.stringify({ interaction_type: "call_details", call: { call_id: callId, metadata: { language: scenario.startsWith("spanish") ? "es" : "en" } } }));
  setTimeout(next, 300);
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.response_type === "config") return console.log("config", m.config);
  if (m.response_type === "metadata") return console.log("metadata", JSON.stringify(m.metadata).slice(0, 200));
  if (m.response_type === "agent_interrupt") return console.log(`[caller hears, via dispatcher] ${m.content}`);
  if (m.response_type === "response") {
    console.log(`[agent] ${m.content}${m.transfer_number ? `  -> transfer ${m.transfer_number}` : ""}`);
    transcript.push({ role: "agent", content: m.content });
    if (m.end_call || m.transfer_number) return ws.close();
    setTimeout(next, 400);
  }
});
ws.on("close", () => console.log("closed"));

function next() {
  if (i >= lines.length) {
    if (holdSeconds) {
      console.log(`holding the call open ${holdSeconds}s: open /console, click the call, Join, then speak or type`);
      return setTimeout(() => ws.close(), holdSeconds * 1000);
    }
    ws.send(JSON.stringify({ interaction_type: "reminder_required", response_id: ++rid, transcript }));
    return setTimeout(() => ws.close(), 800);
  }
  const content = lines[i++];
  transcript.push({ role: "user", content });
  console.log(`[user] ${content}`);
  ws.send(JSON.stringify({ interaction_type: "update_only", transcript, turntaking: "user_turn" }));
  ws.send(JSON.stringify({ interaction_type: "response_required", response_id: ++rid, transcript }));
}
