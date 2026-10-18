# Bob prompt chain for EchoHawk (credit-conscious)

The repo already runs and passes 19 tests. Bob's job is not to build it again. Bob's job is the work that is worth a
credit each: audits that could embarrass us on stage, tests that prove the hard claims, a few self-contained modules, and
docs. Every prompt below is scoped to named files so Bob reads little and writes little.

Rules that save credits:

- Open the folder `~/PROJECTS/echohawk` in Bob. Do not paste the spec. Point Bob at a file and a section instead.
- One prompt, one outcome, one file or two. If Bob starts refactoring, stop it and re-run the prompt with "change only X".
- Every prompt ends with "run `npm test` and show me the pass/fail line". That is the acceptance check and it is cheap.
- Never paste `.env`, the Retell key, or a phone number into Bob. Bob has no reason to see them.
- After each Bob result that you keep: `git add -A && git commit -m "bob: <what>"`, then paste the prompt, the first lines of
  Bob's answer, and the commit sha into `docs/BOB_LOG.md`. The demo video has to show Bob prompts, and the twist log needs shas.

Order below is by value. Stop wherever the credits stop; P0 to P3 are the ones that matter.

---

## P0. Baseline (do first, cheapest)

```
Read README.md only. Run `npm install` and `npm test`. Tell me the test count and whether all pass. Do not change any file.
```

If anything fails here, send me the output before spending another credit.

## P1. Security audit of the two things a judge could poke

```
Audit two functions for correctness and timing-safety, change nothing else:
1. verifyRetellSignature and signRetellWebhook in server/http.js. The format must match retell-sdk 6.2.7 lib/webhook_auth.js:
   header "v=<unix ms>,d=<hex sha256 hmac of rawBody + timestamp>", secret is the API key, reject if older than 5 minutes.
2. encodeFrame, decodeFrame and ReplayWindow in device/frame.js (16-byte frame, 40-bit HMAC tag, 64-wide replay window).
Fix only real bugs. Then add server/test/security.test.js with at least 6 cases: valid signature, wrong key, tampered body,
stale timestamp, frame tag truncation still rejects a 1-bit flip, replay window accepts out-of-order within 64 and rejects
beyond. Run `npm test` and show me the pass/fail line.
```

## P2. Route tests (so "it runs" is provable, not claimed)

```
Write server/test/http.test.js using node:test and the existing boot pattern from server/test/protocol.test.js (withServer).
Cover: POST /packets rejects a street address with 400; POST /packets with content_status "none" returns 201 and rung
"watch"; POST /incidents/:id/close returns 403 for a dispatcher when max_severity >= 4 and 200 for a supervisor; POST /twists
then GET /twists round-trips; GET /cost/meter has the fields ts, calls_active, paid_concurrency, retell_cents_today, stream;
GET /kits/EH-FAKE returns 404. Do not modify server/http.js unless a test exposes a real bug, and if so tell me what it was.
Run `npm test` and show me the pass/fail line.
```

## P3. Silence panel module (the board panel that is still a placeholder)

```
Create server/callbacks.js and wire it into server/http.js with minimal edits. Behaviour, from docs/IMPLEMENTATION_PLAN.md
section 5 acceptance test A18 and docs/BUILD_SPEC.md section 8 (supervisor board, "silence panel"):
- scheduleCallback(store, incidentId, attemptNo) pushes a row to store.callbacks {id, incident_id, attempt_no, attempted_at:
  null, result: "pending", next_step: "call"} and emits event callback_scheduled.
- recordCallback(store, callbackId, result) sets attempted_at and result ("answered" | "no_answer" | "busy"); on "no_answer"
  it emits callback_no_answer, and if attempt_no < 3 schedules attempt_no + 1; the incident stays open either way.
- openCallbacks(store) returns incidents with any callback whose result is "no_answer" or "pending", newest first.
Routes: POST /incidents/:id/callback {attempt_no?} , POST /callbacks/:id/result {result}, GET /callbacks/open.
Then make board/index.html fill the "Silence panel" section from GET /callbacks/open (incident zone, target, attempts,
last result, minutes since first report). Add server/test/callbacks.test.js with A18 (no-answer leaves the incident open)
and the three-attempt cap. Run `npm test` and show me the pass/fail line.
```

## P4. API doc (no code changes)

```
Read server/http.js and server/retell_ws.js. Write docs/API.md: one table of REST routes (method, path, auth, request body,
response shape, which event types it emits), the SSE event names on /events/stream, and the Retell websocket message types in
both directions. Keep it under 150 lines. Do not change code.
```

## P5. SAME header parser (hardware lane support)

```
Create server/same_decoder.js exporting parseSameHeader(text). Input is a NOAA SAME header string like
"ZCZC-WXR-SPW-006037+0100-2911830-KLOX/NWS-". Return {originator, event, locations: ["006037"], durationMinutes: 60,
issued: {dayOfYear: 291, hhmm: "1830"}, sender: "KLOX/NWS"} or {error} for malformed input. Map event codes SPW, EVI, CEM, RWT,
FFW, TOR to the actions used in server/http.js /alerts/same (shelter_in_place, evacuate, info_only). Add
server/test/same_decoder.test.js with 4 headers including one malformed. Then let POST /alerts/same accept {header: "..."}
as an alternative to {event_code, zone, ...}. Run `npm test` and show me the pass/fail line.
```

## P6. When a twist lands (one prompt per twist)

```
Twist <N>: "<paste the twist text>". Read docs/BUILD_SPEC.md section 11 (Twist 1 and the build change it caused) and docs/IMPLEMENTATION_PLAN.md section 3.7 (twists and cost) only. Propose the smallest change in
this repo that answers it, name the files, and wait for my yes before writing anything.
```

After the change: `git commit`, then `curl -X POST localhost:8787/twists -H 'content-type: application/json' -d
'{"twist_no":N,"what_changed":"...","why":"...","proof_path":"docs/BOB_LOG.md","commit_sha":"<sha>"}'`.

## P7. Hardening pass on the three pages (only if credits remain)

```
Review board/index.html, console/index.html and app/index.html for: unescaped text inserted with innerHTML (transcript
text, incident reasons, kit titles), fetch calls without error handling that would leave a page blank, and anything that
breaks when the server returns an empty list. Fix with minimal edits, keep each page a single file with no build step, and
do not change the visual design. Open each page against `npm start` and confirm no console errors.
```

---

## What not to ask Bob

- Not "build the supervisor board" or "implement the engine". Those exist. Re-generation burns credits and breaks tests.
- Not "review the whole repo". Scope to files.
- Not anything with the Retell key, a phone number, or a caller's data in it.

## Judging note (Best Build with IBM Bob)

The judges score how central Bob was and whether the code is clean and runs. The log in `docs/BOB_LOG.md` is the evidence:
each entry is prompt, outcome, tests before and after, commit sha. Keep it current as you go, not at 9 PM.
