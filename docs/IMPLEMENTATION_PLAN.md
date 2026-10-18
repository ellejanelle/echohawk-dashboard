# EchoHawk Implementation Plan

Companion to `BUILD_SPEC.md`. That document says what and why; this one says exactly what to build, in what order, by whom, with what contract, and how we know it works. Section numbers in brackets refer to the spec.

Deadline: Devpost locks Saturday 10:00 PM. Working backward: 9:30 PM upload, 8:30 PM final video cut, 7:00 PM feature freeze, 1:00 PM everything indispensable working end to end.

---

## 1. Stack decisions (made, not debated)

| Layer | Choice | Why |
|---|---|---|
| Server | Node 20 + TypeScript, Fastify, `ws` for the Retell websocket | one language for server and three web UIs; Retell SDK is first-class in Node |
| Database | SQLite via Prisma for the weekend (Postgres later; schema is portable) | zero ops, one file, fits in the repo for the demo |
| LLM for the loop and translation | any chat-completion API behind one `llm()` function; model name in env | swap without touching the loop |
| UIs | Vite + React, three apps in one workspace (`console/`, `board/`, `app/`); `app/` is a PWA | shared types and components |
| Realtime to UIs | server-sent events (`/events/stream`) | simplest fan-out; no socket server to babysit |
| Chirp | ggwave JS build in the PWA (receive), ggwave CLI or web page on the laptop (send); Waver app as fallback | proven, free, works offline |
| SAME decode | `samedec` on the laptop against a recorded burst | drop-in replacement for multimon-ng EAS mode |
| Map | Leaflet with zone polygons as GeoJSON; LAPD Reporting Districts from LA GeoHub if downloadable tonight, else a synthetic hex grid labeled as such | |

---

## 2. Database schema (Prisma-style, SQLite)

```
Call            id (Retell call_id) PK, started_at, ended_at, from_hash, language, direction (inbound|outbound|web),
                mode (tuesday|crisis), status (active|ended|transferred|failed), transfer_path (warm|cold_a|cold_b|none),
                retell_cost_cents (nullable), dispatcher_id (nullable)

Turn            id PK, call_id FK, idx, role (agent|user|dispatcher|system), text_original, text_translated (nullable),
                lang_original, ts, tool_call_json (nullable)

Packet          id PK, call_id FK (nullable), source (voice|app|ehawk|telemetry|field_unit), received_at, observed_at,
                zone_id, target, severity (1..5), action, independence_key, content_status (extracted|partial|none),
                language, provenance (firsthand|forwarded|repeat_beacon|simulated), incident_id FK (nullable)

Incident        id PK, zone_id, target, opened_at, last_packet_at, closed_at (nullable, never set by automation when
                severity>=4), rung (watch|ask|hand), score (float, labeled confidence score), independent_count,
                spread_linked_incident_id (nullable), summary_text (nullable), summary_evidence_count

Event           id PK, event_type, packet_id FK (nullable), call_id FK (nullable), incident_id FK (nullable),
                device_pseudo_id (nullable), ts_source (nullable), ts_gateway (nullable), ts_server,
                clock_drift_ms (nullable), provenance, actor (system|ai|dispatcher|supervisor|device),
                payload_json, schema_version

Kit             kit_id PK, title, mode (tuesday|emergency|preemptive), authority, reference_url, last_source_check,
                medical_review (not_required|pending|approved), reviewer (nullable), revision, languages_json,
                offline_available (bool), permissions_status, contraindications, requires_human (bool),
                script_lines_json, display_steps_json, content_status (draft|approved)

KitShow         id PK, call_id FK (nullable), app_session_id (nullable), kit_id FK, shown_at, by (ai|dispatcher),
                replaced_by_kit_id (nullable), closed_at (nullable)

Callback        id PK, incident_id FK, target_hash, attempt_no, attempted_at, result (answered|no_answer|busy|disconnect),
                next_step (retry|alt_contact|ehawk_ping|welfare_flag)

Baseline        zone_id, hour (0..23), mean_per_15min, source (lapd_cfs|synthetic), computed_at   PK(zone_id, hour)

ZoneWindow      zone_id, window_start, n, p_tail (nullable), flagged (bool)   PK(zone_id, window_start)

TwistLog        id PK, twist_no, received_at, what_changed, why, proof_path, commit_sha

CostMeter       id PK, ts, calls_active, paid_concurrency, retell_cents_today, dispatcher_minutes_saved_est, stream (tuesday|crisis)
```

Rules enforced in code, not left to the UI: `Incident.closed_at` cannot be set when `severity >= 4` unless `actor = supervisor`. `Packet` rows are never deleted. `Event` rows are append-only. `independence_key = sha256(salt + from_hash + zone_id)`; repeat SOS transmissions reuse the first packet's key.

---

## 3. API contracts

All JSON. All timestamps ISO-8601 UTC. Auth for the weekend: a single bearer token per UI in env; the Retell webhook uses `x-retell-signature` verification instead.

### 3.1 Retell custom LLM websocket `WS /retell/llm/:call_id`

Server receives (from Retell): `ping_pong`, `call_details`, `update_only`, `response_required`, `reminder_required`, each with `interaction_type`, and `transcript` where applicable.
Server sends: `config` (`auto_reconnect: true`, `call_details: true`, `transcript_with_tool_calls: true`), `response` (`response_id`, `content`, `content_complete`, optional `end_call`, `transfer_number`), `agent_interrupt` (`interrupt_id`, `content`, `content_complete`), `tool_call_invocation` / `tool_call_result`, `metadata`.

Loop per `response_required`:
1. Persist the new user turn(s).
2. Hard-trigger scan on the latest user turn (regex list plus an LLM yes/no, both must be fast; regex alone is enough to fire).
3. If a hard trigger fires: emit `trigger_fired` event; start transfer path; if a kit matches, emit `tool_call_invocation show_kit_card`; respond with the approved transfer line.
4. Else: run extraction (four fields, structured output); if all four present and no packet yet for this call, create the packet and emit `packet_created`.
5. Generate the next agent utterance with the LLM under the Section 6 prompt; respond.
6. If a dispatcher has joined: suppress automatic utterances except safety lines; dispatcher input arrives via 3.4 and goes out as `agent_interrupt`.

### 3.2 Retell webhooks `POST /webhooks/retell`

Verifies signature; handles `call_started`, `call_ended`, `call_analyzed`, `transcript_updated`, `transfer_*`. On `call_analyzed`, reconciles post-call extraction into the live packet (never overwrites a human edit). Responds 200 within 2 seconds; work is queued.

### 3.3 Packets and incidents

```
POST /packets                 body: Packet (source app|ehawk|telemetry|field_unit); returns {packet_id, incident_id, rung}
GET  /incidents?rung=&since=  returns ranked list: [{id, zone_id, target, rung, score, independent_count, trend,
                              first_report_at, last_packet_at, summary_text, summary_evidence_count, packet_ids[]}]
GET  /incidents/:id           full incident with packets and events
POST /incidents/:id/ack       body {actor} -> event acknowledged_by_human
POST /incidents/:id/close     body {actor, reason}; 403 unless actor=supervisor when severity>=4
GET  /zones/windows?since=    scan-layer shading: [{zone_id, window_start, n, p_tail, flagged}]
```

### 3.4 Calls, transcripts, Interpreter Mode

```
GET  /calls?status=active                 live call list with language, target, severity, rung, elapsed
GET  /calls/:id/transcript                turns with text_original and text_translated
POST /calls/:id/join                      body {dispatcher_id}; marks dispatcher present; AI goes quiet
POST /calls/:id/say                       body {text, lang_from}; server translates to the caller's language and sends agent_interrupt;
                                          persists a dispatcher turn; returns {sent_text, lang_to}
POST /calls/:id/say-audio                 multipart audio chunk; STT -> same path as /say
POST /calls/:id/transfer                  body {path: warm|cold_a|cold_b, destination}; returns {started: true, path}
POST /calls/:id/kit                       body {kit_id | null}; dispatcher shows, swaps or closes a card; event kit_changed_by_human
GET  /events/stream                       SSE: packet_created, incident_*, rung_changed, trigger_fired, turn_added, kit_shown, callback_*
```

### 3.5 Kits

```
GET  /kits                                catalog with source registry fields; the PWA caches this for offline
GET  /kits/:kit_id                        one kit
POST /tools/show_kit_card                 called by the loop; body {kit_id, zone_id, call_id}; 404 for any id not in catalog;
                                          returns {script_lines[], display_steps[], review_status}; emits kit_shown
```

### 3.6 Device and alert path

```
POST /device/packets                      chirp or LoRa-relayed packet (16-byte frame decoded by the node mock); same Packet shape; provenance set by node
POST /alerts/same                         body {raw_header, event_code, locations[], issued_at, expires_at}; server builds the signed directive and the
                                          pre-translated phrase per household language; emits alert_received, alert_revoiced, alert_chirped
GET  /alerts/directive/:id/frame          returns the 16-byte signed frame for the laptop to chirp
```

### 3.7 Twists and cost

```
POST /twists                              body {twist_no, what_changed, why, proof_path, commit_sha}
GET  /twists
GET  /cost/meter                          current CostMeter row
```

---

## 4. The 16-byte frame (chirp and LoRa)

```
byte 0      version (4 bits) | type (4 bits): 0 directive, 1 check-in, 2 sos, 3 ack
bytes 1-2   zone_id (uint16, zone table index)
byte 3      target (4 bits) | severity (4 bits)
byte 4      action (4 bits) | language (4 bits, household language index)
bytes 5-8   issued_at (uint32, minutes since 2025-01-01 UTC)
bytes 9-10  sequence (uint16, anti-replay window of 64)
bytes 11-15 HMAC-SHA256 truncated to 40 bits over bytes 0-10 with the deployment key
```

Encode with ggwave fixed-length payload (16 bytes). Verify sequence inside a sliding window of 64 before trusting the frame. Show "signature valid" or "rejected: replay" on the phone.

---

## 5. Acceptance tests (each is a checkbox before the demo)

| ID | Test | Pass condition |
|---|---|---|
| A1 | Fake Retell client drives `update_only`, `response_required`, `reminder_required` through the websocket | every turn persisted; a `response` returned within 1.5 s with canned content |
| A2 | Scripted call produces a packet before the call ends | `packet_created` event fires when the fourth field arrives, not at `call_ended` |
| A3 | Call with no extractable content (gibberish, hang-up) still produces a packet | `content_status = none`, zone from caller metadata, visible on the board as a watch item |
| A4 | Five repeat SOS transmissions | one independence key, one incident, `independent_count = 1`, five `transmitted` events |
| A5 | Three independent callers, same zone and target, within 15 minutes | rung = hand, score >= 0.85, appears at top of `GET /incidents` |
| A6 | One frantic single caller, severity 5, no hard trigger | rung stays at or below ask; score <= 0.6 of hand threshold |
| A7 | Same target in two adjacent zones within the window | linked incident with `spread` flag on the board |
| A8 | "She's sort of breathing" in a user turn | `trigger_fired` within one turn; transfer started; transcript marked |
| A9 | Hard trigger with no matching kit in catalog | transfer starts with zero added latency; no error surfaced to caller |
| A10 | `show_kit_card` with an id not in the catalog | 404; agent's next utterance contains no instruction text |
| A11 | Kit card shown | agent utterance equals `script_lines` joined, verbatim, no additions |
| A12 | Transfer test, real phones | one scripted life-threat call reaches a teammate's phone by the primary path; if not, Fallback A passes and is recorded as the demo path |
| A13 | Interpreter Mode | dispatcher types or speaks English; caller hears Spanish within 4 s; caller's Spanish renders as English in the console |
| A14 | Webhook signature | a request without a valid `x-retell-signature` is rejected 401 and logged |
| A15 | Chirp handshake | laptop frame to phone in airplane mode at 30 to 50 cm; "signature valid" on screen; replayed frame rejected |
| A16 | SAME decode | recorded burst decodes to the expected event code and location codes; directive frame generated; Spanish phrase played |
| A17 | High-severity incident close | `POST /incidents/:id/close` by dispatcher returns 403; by supervisor succeeds and logs |
| A18 | Silence ladder | callback `no_answer` leaves the item open and schedules the next step; nothing marks it resolved |
| A19 | Twist entry | `POST /twists` with a commit sha renders in the board's twist log |
| A20 | Board load on LAPD data | `rd_baseline_by_hour.csv` loads into `Baseline`; Jan 7 19:00 for RD 0802 shows flagged in `ZoneWindow` |

Tests A1 through A14 are automated (unit or scripted). A15 and A16 are manual with a recording. A12 is the one most likely to fail; run it by 2 PM.

---

## 6. Parallel lanes (four people, one repo, short-lived branches)

**Lane 1, engineer: server and Retell.** Prompts 1 to 4 with Bob (repo, websocket loop, packets and events, provisioning script). Then extraction, hard-trigger scan, transfer paths and A12, Interpreter Mode endpoints, webhooks. Owns `server/`.

**Lane 2, data/IT analyst: engine, board, data.** Load LAPD baselines and Montgomery outputs; implement grouping, scoring, spread, rungs (Section 4 of the spec) as a pure module with the synthetic 20-call script as fixtures; build `board/` (ranked list, map, panels, twist log, cost meter). Owns `server/engine/`, `board/`, `data/`.

**Lane 3, ElleJanelle: app, kits, pitch.** Write the three kit cards in original wording with source records (Section 7); build `app/` with offline catalog, check-in, beacon, contacts, web call; write the deck and the responsible-use note; record the problem segment; keep `docs/prompts.md` and `docs/twist_log.md` current. Owns `app/`, `kits/`, `docs/`.

**Lane 4, Navy veteran: physical proof.** ggwave send page on the laptop and receive in the PWA (or Waver), frame encoder and HMAC verify, A15 rehearsal in the venue; `samedec` against the recorded burst and A16; LoRa node mock that POSTs to `/device/packets`; eHawk render and the one hardware slide; backup videos of A15 and A16. Owns `device/`.

Integration points, in time order: packet shape (frozen by 7 AM, Lane 1 publishes the TypeScript type), `GET /incidents` shape (frozen by 9 AM, Lane 2 consumes), `show_kit_card` contract (frozen by 9 AM, Lane 3 supplies catalog JSON), device packet POST (by 11 AM, Lane 4). Everyone rebases on `main` before the 10:30 Retell session and again at 1 PM.

---

## 7. Bob prompt chain (saved verbatim to `docs/prompts.md` as they are used)

1. Repo layout from spec Section 15; websocket skeleton with exact Retell message fields; fake client; health; env config; tests. Done: A1.
2. Packet schema and event log from spec Section 3; validation; packet-for-every-call rule; independence key. Done: A3, A4.
3. `provision_retell.py` from spec Section 6.4: idempotent, dry-run, prints the plan first. Done: agent exists in the Retell dashboard.
4. Hard-trigger scanner (regex list from spec Section 5.1 plus LLM confirmation) and extraction to the four fields with structured output. Done: A2, A8.
5. Transfer paths: primary warm from server; Fallback A cold with brief; Fallback B transfer agent. Done: A12.
6. Corroboration engine as a pure module with fixtures. Done: A5, A6, A7.
7. Kit catalog loader and `show_kit_card` handler; verbatim-read guard. Done: A9, A10, A11.
8. Interpreter Mode endpoints: `/join`, `/say`, `/say-audio`, translation, `agent_interrupt`. Done: A13.
9. Security pass: signature verification, replay window, rate limiting on `/device/packets`, secrets scan. Done: A14, A15 (server side).
10. Board and console scaffolds from the contracts in Section 3; SSE stream. Done: A17, A18, A19, A20 visible.
11. Each twist: one prompt that names the change, the spec section it touches, and the test it adds. Done: twist log entry with commit sha.

Rule for every prompt: name the spec sections, state the acceptance test IDs it must pass, ask Bob to run the tests and report, and keep secrets out of the prompt.

---

## 8. Synthetic call script (fixtures for A2 to A11 and the stage)

Twenty calls, seeded at 1 AM demo time, zones from the LAPD reporting district list, Spanish and English:
- 3 quiet water-pressure calls in adjacent zones, 6 minutes apart, severity 2 each (expect: linked incident, spread, rung hand after the third)
- 1 frantic "my power is out" single caller, severity 5 (expect: watch or ask, damped)
- 1 "bleeding badly" call (expect: trigger, transfer, EH-BLEED-001)
- 1 "she's sort of breathing" call (expect: trigger, transfer, no kit)
- 2 Spanish non-emergency calls (expect: Tuesday packets, EH-LIGHT-001 on one)
- 1 hang-up after 4 seconds (expect: packet with content_status none)
- 1 unsupported-language call (expect: two attempts then transfer)
- 5 alarm-ringer style app packets in one zone within 15 minutes, source `telemetry` (expect: separate source class, watch shading, not a hand rung on their own)
- 6 ordinary non-emergency calls spread across zones (noise floor)

---

## 9. Freeze schedule

| Time (Sat) | Must be true |
|---|---|
| 7:00 AM | Packet type frozen; Retell account live; twist 3 read and logged |
| 9:00 AM | A1 to A4 green; `GET /incidents` shape frozen; kit catalog JSON in repo |
| 10:30 AM | Retell session: confirm warm transfer path, credits, SMS/A2P status |
| 1:00 PM | Indispensable demo working end to end: handshake plus live call to packet to board with Interpreter Mode |
| 2:00 PM | A12 transfer test passed on real phones (primary or Fallback A) |
| 4:00 PM | Bleeding call and SAME decode working or cut |
| 7:00 PM | Feature freeze; all twist responses logged as build changes with commit shas |
| 8:30 PM | Demo video cut (under 3 minutes, shows Retell and Bob prompts) |
| 9:30 PM | Devpost submitted: name, lens, one line, deck (10 slides), video, repo, teammates, responsible-use note |
| 10:00 PM | Locked |
