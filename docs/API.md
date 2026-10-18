# EchoHawk API Reference

Auth is a Bearer token (or `?token=` query param). Roles: **agency** (`AGENCY_TOKEN`, returned by `/agency/login`), **supervisor**, **dispatcher**, **anon** (no token).
Agency and supervisor requests may add `x-agency: <agency id>` and `x-operator: <name>` headers; these become the drafter and approver names on public alerts.

---

## REST Routes

| Method | Path | Min role | Request body (JSON) | Response shape | Events emitted |
|--------|------|----------|---------------------|----------------|----------------|
| GET | `/health` | anon | — | `{ ok, calls_active, paid_concurrency, mode }` | — |
| POST | `/webhooks/retell` | — (HMAC sig) | Retell webhook body | `{ ok }` | `retell_<ev>`, `packet_reconciled` |
| POST | `/packets` | anon | `{ zone_id, target, severity, action, text?, … }` | `{ packet_id, incident_id, rung, reason }` | `packet_ingested`, `incident_opened/updated` |
| POST | `/device/packets` | anon | same as `/packets`; `source` defaults to `"ehawk"`, `provenance` to `"forwarded"`; optional `node_id` + `frame_id` or `frame_b64` | `{ packet_id, incident_id, rung, heard_by, approx_area }`, or `{ duplicate: true, heard_by }` when another node already relayed the same frame | same as above, `relay_heard` |
| GET | `/incidents` | anon | `?rung=<rung>` (optional filter) | array of incident objects | — |
| GET | `/incidents/:id` | anon | — | incident + `packets[]` + `events[]` | — |
| POST | `/incidents/:id/ack` | dispatcher | — | `{ ok }` | `acknowledged_by_human` |
| POST | `/incidents/:id/close` | dispatcher | `{ reason? }` | `{ ok }` or error | `incident_closed` |
| POST | `/incidents/:id/dispatch` | dispatcher | `{ units: ems\|fire\|police\|utility\|callback (or array), note? }` | `{ ok, dispatched[] }`, each unit starts `assigned` | `units_dispatched` |
| POST | `/incidents/:id/units/:n/status` | dispatcher | `{ status }`: assigned → en_route → on_scene → cleared, or cancelled from assigned/en_route; a skip returns 409 | `{ ok, unit }` | `unit_status` |
| POST | `/incidents/:id/disposition` | dispatcher | `{ disposition, note? }`: resolved, report_taken, referred, unfounded, duplicate, unable_to_locate | `{ ok, disposition, callback_id }`; closes the incident, clears units, `unable_to_locate` schedules a callback | `incident_closed`, `incident_disposition` |
| GET | `/units` | anon | — | `{ units[]: { incident_id, zone_id, target, n, unit, status, seconds, limit_s, overdue, next[] }, watchdog_s, dispositions }`, overdue first | — |
| POST | `/incidents/:id/units/:n/stop` | dispatcher | `{ incident_id }` | `{ ok, unit }`; 409 if the call needs a person or the unit does not cover that type | `unit_stop_added` |
| POST | `/demo/reset` | supervisor | — | `{ ok, cleared }`; clears live data, keeps baselines, kits, twists | `demo_reset` (open pages reload) |
| GET | `/nodes` | anon | — | `{ simulated: true, nodes }` pole node positions | — |
| POST | `/demo/relay` | anon | — | `{ ok, results[] }`; one SOS chirp relayed by three nodes | `packet_created`, `relay_heard` |
| GET | `/history/rd` | anon | — | past dispatched LAPD calls per district by type | — |
| GET | `/research/export.csv` | dispatcher | — | CSV, one row per incident, no identifiers | — |
| GET | `/my/updates` | anon | `?device&zone` | updates on that device's own reports: `[{ incident_id, units[], disposition, message, updated_at }]` | — |
| POST | `/incidents/:id/callback` | anon | `{ attempt_no? }` | callback row `{ id, incident_id, attempt_no, result, … }` | `callback_scheduled` |
| GET | `/zones/windows` | anon | — | last 2 000 zone-window records | — |
| POST | `/callbacks/:id/result` | anon | `{ result }` — one of `answered`, `no_answer`, `busy` | `{ ok, callback }` | `callback_no_answer` (+ schedules next if `< 3`); re-schedules via `callback_scheduled` |
| GET | `/callbacks/open` | anon | — | array of `{ incident_id, zone_id, target, attempts, last_result, minutes_since_first_report }` sorted newest-first | — |
| GET | `/calls` | anon | `?status=active` (optional) | array of call objects with `target`, `severity`, `rung`, `elapsed_s` | — |
| GET | `/calls/:id/transcript` | anon | — | array of turn rows | — |
| POST | `/calls/:id/join` | dispatcher | `{ dispatcher_id? }` | `{ ok, caller_language }` | `dispatcher_joined` |
| POST | `/calls/:id/say` | dispatcher | `{ text, lang_from? }` | `{ ok, sent_text, lang_to }` | `dispatcher_said` |
| POST | `/calls/:id/language` | anon | `{ lang }` | `{ ok }` | — |
| POST | `/calls/:id/kit` | dispatcher | `{ kit_id }` (omit to close) | `{ ok }` or kit card | `kit_changed_by_human` |
| POST | `/calls/:id/takeover` | dispatcher | — | `{ ok }`; the AI stops and the line goes to a person | `transfer_started` |
| POST | `/calls/:id/flag` | dispatcher | `{ flag }` e.g. `wrong_zone`, `wrong_severity`, `needs_interpreter`, `review` | `{ ok, flags[] }` | `call_flagged` |
| POST | `/demo/call` | anon | `{ scenario? }`: spanish_water (default), spanish, water, bleeding, breathing | `{ ok, scenario, hold_seconds: 180 }` (202) | `call_started`, `turn_added` |
| POST | `/demo/surge` | anon | — | `{ ok, calls: 20 }` (202) | the 20-call script |
| GET | `/languages` | anon | — | 15 rows `{ code, name, native, retell, speaks }` | — |
| GET | `/phrasebook` | anon | `?lang=` | `{ lang, machine, phrases }`: what a phone says for each signed directive, cached offline | — |
| GET | `/agencies` | anon | — | `{ agencies[], kinds }` | — |
| POST | `/agency/login` | anon | `{ agency, name, passcode }` | `{ ok, token, agency, name }` or 401 | `agency_login`, `agency_login_failed` |
| GET | `/broadcasts` | supervisor | — | all public alerts, newest first | — |
| POST | `/broadcasts` | agency or supervisor | `{ kind, zones[], message (≤360), hazard?, instructions?, channels?, request? }` | `{ ok, broadcast }` (201). Supervisor: advisory sends at once; a protective kind needs `request: true` and lands as `requested` | `alert_drafted` or `alert_requested` (+ `alert_sent`) |
| POST | `/broadcasts/:id/send` | agency or supervisor | — | `{ ok, broadcast }`; protective kinds need an agency approver who is not the drafter (409 otherwise); `all_clear` lifts overlapping active alerts | `alert_sent`, then `alert_translated` |
| POST | `/broadcasts/:id/cancel` | agency or supervisor | `{ reason? }` | `{ ok, broadcast }` | `alert_cancelled` |
| GET | `/broadcasts/active` | anon | `?zone&lang` | active alerts for that zone in that language, each with `frame_b64` | — |
| POST | `/broadcasts/:id/ack` | anon | `{ status: safe\|need_help\|left, zone?, device?, lang? }` | `{ ok, incident_id? }`; `need_help` with a zone opens a "needs a person" incident | `alert_ack` (+ `packet_ingested`) |
| GET | `/events/stream` | anon | — | SSE stream (see below) | — |
| GET | `/events` | anon | — | last 500 event rows | — |
| GET | `/kits` | anon | — | full kit catalog array | — |
| GET | `/kits/:id` | anon | — | single kit object | — |
| POST | `/tools/show_kit_card` | anon | `{ kit_id, zone_id?, call_id?, language? }` | kit card with `script_lines[]` | — |
| POST | `/alerts/same` | anon | `{ event_code, zone, target?, language?, locations? }` | alert row with `frame_b64` | `alert_received`, `alert_revoiced` |
| GET | `/alerts/directive/:id/frame` | anon | — | `{ frame_b64 }` | — |
| GET | `/frames/codes` | anon | — | `{ TARGET_CODES, ACTION_CODES, LANG_CODES }` | — |
| GET | `/twists` | anon | — | all twist rows | — |
| POST | `/twists` | anon | arbitrary body | saved twist row | — |
| GET | `/cost/meter` | anon | — | `{ ts, calls_active, paid_concurrency, retell_cents_today, dispatcher_minutes_saved_est, stream, basis }` | — |

---

## SSE — `/events/stream`

Connect with `Accept: text/event-stream`. One `event: hello` frame is sent immediately on connect; thereafter every store event is pushed verbatim.

| SSE event name (`event:` field) | When |
|----------------------------------|------|
| `hello` | Handshake on connect |
| `call_started` | WebSocket opens for a new call |
| `call_ended` | WebSocket closes |
| `turn_added` | New transcript turn stored |
| `turn_translated` | Dispatcher-mode translation complete |
| `trigger_fired` | Hard trigger detected; transfer imminent |
| `transfer_started` | Call routed to dispatcher/PSTN |
| `dispatcher_joined` | Dispatcher joined via `/calls/:id/join` |
| `dispatcher_said` | Dispatcher spoke via `/calls/:id/say` |
| `packet_reconciled` | Post-call analysis merged into packet |
| `acknowledged_by_human` | Incident acked |
| `incident_closed` | Incident closed |
| `callback_scheduled` | New callback attempt created |
| `callback_no_answer` | Callback attempt returned no answer |
| `kit_changed_by_human` | Dispatcher opened/closed a kit card |
| `alert_received` | SAME alert ingested |
| `alert_revoiced` | Alert encoded as device frame |
| `webhook_rejected` | Retell webhook signature failed |
| `retell_call_started` | Retell webhook `call_started` event |
| `retell_call_ended` | Retell webhook `call_ended` event |
| `retell_call_analyzed` | Retell webhook `call_analyzed` event |
| `call_flagged` | Dispatcher flagged an AI call, or the caller's language needs a human interpreter |
| `units_dispatched` | Units sent to an incident |
| `unit_status` | A unit moved to en route, on scene, cleared or cancelled |
| `incident_disposition` | Incident closed with a disposition code |
| `unit_stop_added` | A unit already out took a nearby call as a stop |
| `relay_heard` | Another node heard a chirp that was already reported |
| `alert_drafted` / `alert_requested` | Public alert saved by an agency, or requested by the supervisor |
| `alert_sent` | Public alert approved and sent |
| `alert_translated` | Machine translations of a sent alert are ready |
| `alert_cancelled` | Public alert lifted |
| `alert_ack` | A resident answered an alert |
| `agency_login` / `agency_login_failed` | Agency sign-in |

---

## Retell Custom-LLM WebSocket — `ws://.../retell/llm/:callId`

Retell opens the connection; EchoHawk is the server.

### Retell → EchoHawk (`interaction_type`)

| `interaction_type` | Payload fields | Handled as |
|--------------------|----------------|------------|
| `ping_pong` | `timestamp` | Echo back `ping_pong` response |
| `call_details` | `call.metadata.language` | Stores caller language; updates call record |
| `update_only` | `transcript[]` | Absorbs new turns; no reply required |
| `response_required` | `transcript[]`, `response_id` | Full LLM reply cycle (extraction → packet → content) |
| `reminder_required` | `transcript[]`, `response_id` | Same as `response_required`; AI may reply with empty string if dispatcher has joined |

### EchoHawk → Retell (`response_type`)

| `response_type` | Key fields | When sent |
|-----------------|------------|-----------|
| `config` | `{ auto_reconnect, call_details, transcript_with_tool_calls }` | Once on connection open |
| `response` (id 0) | `content`: the greeting, which says the line is automated and that a person can join | Right after `config` |
| `ping_pong` | `timestamp` | Reply to every `ping_pong` |
| `response` | `response_id`, `content`, `content_complete: true`, optional `transfer_number` | Reply to `response_required` / `reminder_required` |
| `agent_interrupt` | `interrupt_id`, `content`, `content_complete: true`, `no_interruption_allowed: false` | **Interpreter Mode only** — dispatcher text injected via `/calls/:id/say` |
| `metadata` | `metadata.show_kit_card` | Kit card pushed to the Retell client alongside a `response` when a kit fires |

### Interpreter Mode flow

1. Supervisor/dispatcher calls `POST /calls/:id/join` → sets `dispatcherJoined = true` on the session.  
2. AI goes silent: on subsequent `response_required` the AI sends an empty `response` content.  
3. Dispatcher calls `POST /calls/:id/say` with English text.  
4. Server translates to `callerLang` if needed, increments `interruptSeq`, and sends `response_type: agent_interrupt` with the translated text directly to the Retell WebSocket so the caller hears it immediately — bypassing the normal LLM turn cycle.  
5. The dispatcher utterance is appended to the transcript as role `dispatcher` and emits `dispatcher_said` on the SSE stream so the board updates in real time.
