# Bob log

Evidence for the demo video and the "Best Build with IBM Bob" judging. One entry per kept Bob result.
Workspace opened in Bob: `~/PROJECTS` (the repo is the `echohawk/` folder inside it, so every prompt starts with
"Work only inside the echohawk/ folder").

| # | Time (PT, Sat Oct 17) | Prompt (short) | Files touched | Tests before → after | Bob cost | Commit |
|---|---|---|---|---|---|---|
| P0 | ~5:30 AM | baseline: read README, npm install, npm test | none | 19/19 → 19/19 | 0.188 | (no change) |
| P1 | 6:05 AM | audit verifyRetellSignature / signRetellWebhook and frame.js, write security.test.js | server/test/security.test.js (no bugs found in http.js or frame.js) | 19 → 31 | 0.582 | 8686bf8 |
| P2 | 6:11 AM | route tests http.test.js | server/test/http.test.js (no bugs found in http.js) | 31 → 37 | 0.516 | 8686bf8 |
| P3 | 6:14 AM | callback ladder + silence panel | server/callbacks.js, server/http.js (3 routes), board/index.html (2 lines), server/test/callbacks.test.js (8 tests) | 37 → 45 | 1.95 | 80e62d6 |
| P4 | 6:19 AM | docs/API.md from the code, no code changes | docs/API.md | 45 → 45 | | |

## P1 (verbatim)

Work only inside the echohawk/ folder of this workspace (all paths below are relative to it). Audit two functions for
correctness and timing-safety, change nothing else: (1) verifyRetellSignature and signRetellWebhook in server/http.js. The
format must match retell-sdk 6.2.7 lib/webhook_auth.js: header "v=<unix ms>,d=<hex sha256 hmac of rawBody + timestamp>",
secret is the API key, reject if older than 5 minutes. (2) encodeFrame, decodeFrame and ReplayWindow in device/frame.js
(16-byte frame, 40-bit HMAC tag, 64-wide replay window). Fix only real bugs. Then add server/test/security.test.js with at
least 6 cases: valid signature, wrong key, tampered body, stale timestamp, a 1-bit flip in the frame is rejected by the
truncated tag, replay window accepts out-of-order within 64 and rejects beyond. Run `npm test` in echohawk/ and show me the
pass/fail line.

Bob's result: audited both files, reasoned through the 64-slot replay boundary ("seq <= max - 64 rejected, so 37..100 is
exactly 64 accepted values"), found no bugs, wrote 12 tests (S1 to S6d) including future-dated timestamps and a flip in the
tag itself. 31/31.

## P2 (verbatim)

Work only inside the echohawk/ folder of this workspace (all paths below are relative to it). Write server/test/http.test.js
using node:test and the same boot pattern as server/test/protocol.test.js (boot a real server on port 0, close it in
finally). Cover: POST /packets rejects a street address zone_id with 400; POST /packets with content_status "none" returns
201 and rung "watch"; POST /incidents/:id/close returns 403 for the dispatcher token when the incident max_severity >= 4 and
200 for the supervisor token; POST /twists then GET /twists round-trips the entry; GET /cost/meter has the fields ts,
calls_active, paid_concurrency, retell_cents_today, stream; GET /kits/EH-FAKE returns 404. Do not modify server/http.js
unless a test exposes a real bug, and if so tell me what it was. Run `npm test` in echohawk/ and show me the pass/fail line.

Bob's result: six tests B1 to B6, "No bugs found in server/http.js", 37/37.

## P3 (verbatim)

Work only inside the echohawk/ folder of this workspace (all paths below are relative to it). Create server/callbacks.js and
wire it into server/http.js with minimal edits. Behaviour, from docs/IMPLEMENTATION_PLAN.md section 5 acceptance test A18
and docs/BUILD_SPEC.md section 8 (supervisor board, silence panel): scheduleCallback(store, incidentId, attemptNo) pushes a
row to store.callbacks {id, incident_id, attempt_no, attempted_at: null, result: "pending", next_step: "call"} and emits
event callback_scheduled through store.appendEvent; recordCallback(store, callbackId, result) sets attempted_at and result
("answered" | "no_answer" | "busy"); on "no_answer" it emits callback_no_answer and, if attempt_no < 3, schedules
attempt_no + 1; the incident stays open either way; openCallbacks(store) returns incidents that have any callback with
result "no_answer" or "pending", newest first, each with zone_id, target, attempts, last_result and minutes since
first_report_at. Routes: POST /incidents/:id/callback {attempt_no?}, POST /callbacks/:id/result {result}, GET
/callbacks/open. Then make board/index.html fill the Silence panel section from GET /callbacks/open inside the existing
refresh() cycle. Add server/test/callbacks.test.js covering A18 (a no-answer callback leaves the incident open) and the
three-attempt cap. Run `npm test` in echohawk/ and show me the pass/fail line.

Bob's result: callbacks.js (three exported functions, events on schedule and no-answer, cap at 3), three routes, two-line
board change, 8 tests, 45/45.

## P4 (verbatim)

Work only inside the echohawk/ folder of this workspace. Read server/http.js, server/retell_ws.js and server/callbacks.js.
Write docs/API.md: one table of REST routes (method, path, auth token role, request body, response shape, event types it
emits), the SSE event names sent on /events/stream, and the Retell custom-LLM websocket message types in both directions
(interaction_type from Retell, response_type from us) including how Interpreter Mode uses agent_interrupt. Keep it under
150 lines. Do not change any code.

## Dashboard build (echohawk-dashboard/, Sat Oct 17 evening)

Bob builds the backend and the board, console and alerts screens from the spec, test-first, using echohawk/ as a
read-only reference. The resident app was copied unchanged. Prompts: docs/BOB_DASHBOARD_BUILD.md.

| # | Time (PT) | Stage | Tests before → after | Bob cost | Commit |
|---|---|---|---|---|---|
| D0 | 5:20 PM | git init, initial commit, baseline test run (no server code yet) | all 13 test files fail on missing modules | 0.40 | 5d09a47 |
| D1 | 5:44 PM | foundations: config, env, store, schema, kits, triggers, triage, languages, same_decoder, llm | 0 → 21/31 runnable (languages 17/17, zone 1/1, claude 3/3) | 2.90 | 62caaa5 |
| D2 | 5:50 PM | engine, units, callbacks, relay, research, broadcasts | 21/31 → 53/63 runnable (remaining failures only need http.js / retell_ws.js) | 4.03 | 04c49d0 |
| D3 | 6:02 PM | retell_ws, http, fake client, replay, resident, provisioning (seed checked) | 53/63 → 105/105 | 9.20 | a2fde91 |
| D4 | 6:26 PM | server/index.js, Wi-Fi device test (3 cases), firmware commit | 105 → 108/108 | 2.88 | be9b9f6 |
