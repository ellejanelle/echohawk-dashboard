# EchoHawk dashboard: Bob build chain

Scope: IBM Bob builds the EchoHawk backend (`server/`) and the three dashboard screens (`web/src/board`,
`web/src/console`, `web/src/alerts`) in `~/PROJECTS/echohawk-dashboard`, test-first.
The resident app (`app/`, `web/src/app`, `web/src/resident`, `web/src/shared`, `web/ios`) is already done and was
copied in unchanged. Bob does not edit it; the new server must serve it with the same API.

- Reference (read-only): `~/PROJECTS/echohawk` (105/105 tests at commit 8c292b4 plus uncommitted work)
- Backup (do not touch): `~/PROJECTS/echohawk-BACKUP-2026-10-17-1730` (full copy incl. .git and uncommitted changes)
- Acceptance spec: the 13 test files in `server/test/` (105 tests), copied unchanged
- Cutoff: if D1 to D5 are not at 105/105 by 8:00 PM, submit the reference app

Prompts are written for the Bob workspace `~/PROJECTS`. Log each kept result in `docs/BOB_LOG.md` (D-entries).

## D0. Context
Work only inside the echohawk-dashboard/ folder of this workspace. You are building the EchoHawk backend and the dashboard
screens (board, console, alerts) there. The folder echohawk/ is a working prototype: treat it as a READ-ONLY reference for
behavior, routes, message formats and data shapes, and never write to it. Do not copy files wholesale: write each module
yourself, keeping behavior and exports compatible with the tests, with clearer names, error handling and comments.
Already present and NOT yours to change: app/, web/src/app, web/src/resident, web/src/shared, web/ios, device/, kits/,
data/, vendor/, firmware/, server/test/. The tests in echohawk-dashboard/server/test are the acceptance spec (105 tests).
Source of truth: docs/BUILD_SPEC.md (section 14 claims and 5.3 never-automate list win any conflict), then
docs/IMPLEMENTATION_PLAN.md, then docs/API.md, then the reference code.
Stack: Node 20 ES modules with node:http and ws for the server, React + Vite + TypeScript for the screens, same as reference.
Non-negotiables: a packet for every call even when extraction fails; zone_id is never a street address (400); events are
append-only and packets are never deleted; severity >= 4 closes only by supervisor (403); hard triggers start a transfer
within one turn and a missing kit never delays it; kits come only from the catalog, verbatim; the AI never orders
evacuations, dispatches units, closes high-severity items or writes a medical step; Retell webhook signatures and device
frame HMAC plus replay window are verified; no secrets in code or logs.
Each stage: write the code, run `npm test` in echohawk-dashboard/, end with the pass/fail line and a short summary.
First: run `git init` in echohawk-dashboard/ and make an initial commit "bob: D0 scaffold from spec, app and tests copied".
Then run `npm test` and report the count of failing test files. Write no application code yet.

## D1. Foundations
Build server/config.js, server/env.js, server/store.js, server/schema.js, server/kits.js, server/triggers.js,
server/triage.js, server/languages.js and server/same_decoder.js, reading the reference versions for behavior and exports.
Make zone.test.js, languages.test.js and same_decoder.test.js pass. Run `npm test` in echohawk-dashboard/ and show me the
pass/fail line. Commit "bob: D1 foundations".

## D2. Engine
Build server/engine.js (scan, corroboration by zone and target in a 15-minute window, confidence score 1 - 0.5^n over
independent callers, rungs watch/ask/hand, adjacent-zone spread, machine sources never reach "hand" alone, district
volume against its own baseline), server/units.js (status order, watchdog timers, dispositions, nearby stops, reporter
updates), server/callbacks.js (three-attempt ladder), server/relay.js (same frame from several nodes counts once),
server/research.js (CSV with no identifiers) and server/broadcasts.js (agency alerts, two-person approval for protective
actions, supervisor advisories and requests, signed frames). Read the reference for each. Make engine, units, callbacks,
broadcasts and mentor tests pass where they do not need http.js. Run `npm test` and show me the pass/fail line.
Commit "bob: D2 engine".

## D3. Voice
Build server/llm.js (Claude provider with rule-based fallback when no key), server/retell_ws.js (custom LLM websocket:
ping_pong, call_details, update_only, response_required, reminder_required; config, response, agent_interrupt; AI
disclosure greeting; hard-trigger scan first; packet the moment the four fields exist; Interpreter Mode and takeover;
close calls left open by dropped sockets on restart), server/fake_retell_client.js, server/seed.js, server/replay.js,
server/resident.js and server/provision_retell.js. Read the reference for message formats. Make claude, protocol and
resident tests pass where they do not need http.js. Run `npm test` and show me the pass/fail line. Commit "bob: D3 voice".

## D4. HTTP
Build server/http.js and server/index.js: every route in docs/API.md and in the reference http.js with the same path,
method, auth role and response shape, the SSE stream, the Retell webhook with signature verification, and static serving
that exposes only the UI folders (never data/, server/, docs/ or dotfiles). Run `npm test` and show me the pass/fail line;
the goal is 105/105. Then list reference routes vs new routes side by side and flag anything missing.
Commit "bob: D4 http, 105/105".

## D5. Dashboard screens
Build web/src/board, web/src/console and web/src/alerts in React + TypeScript, reading the reference screens for features
and layout (README "URL" table and "Demo run of show"). Use web/src/shared for api, sse, types, units and live call; do not
edit shared files, add new ones if needed. Escape nothing by hand (React), handle fetch errors and empty lists so no screen
goes blank. Then run `npm --prefix web install` and `npm --prefix web run build`, start the server on port 8788 with
`PORT=8788 npm start`, and confirm /board?token=dev-supervisor, /console?token=dev-dispatcher, /alerts and /app/ load.
Run `npm test` and show me the pass/fail line. Commit "bob: D5 dashboard screens".

## D6. Parity
Run the reference on 8787 (in echohawk/, `npm start`) and this build on 8788. Compare GET responses for /health,
/incidents, /zones/windows, /units, /callbacks/open, /cost/meter. Run the demo surge on both (POST /demo/surge or the
board button) and compare incident counts and rungs. Fix anything missing. Run `npm test` and show me the pass/fail line.
Commit "bob: D6 parity".
