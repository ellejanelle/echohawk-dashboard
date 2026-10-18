# EchoHawk

AI intake and corroboration layer for overloaded 911 and non-emergency lines, with an off-grid household alert path.
It sits behind the 911 center (PSAP); it does not answer 911 and does not replace dispatchers or CAD.

One Retell voice agent takes the overflow in 15 languages, tells callers it is automated, and extracts zone, target, severity
and action from every call. A corroboration engine turns many quiet reports into one visible pattern for a supervisor,
counting independent callers separately from machine sources (alarms never count as people) and flagging a district when its
15-minute volume is unusual against its own LAPD baseline. Dispatchers can listen to any call, interpret through translation,
or take it over. Alerting agencies send public alerts back to residents through the app and through a signed audio chirp that
phones and eHawk household devices verify with no network.

Spec: `docs/BUILD_SPEC.md`. Build plan, acceptance tests and lanes: `docs/IMPLEMENTATION_PLAN.md`. Bob prompts: `docs/prompts.md`.

## Run it

```bash
npm install            # server dependency (ws); retell-sdk is optional and only needed for provisioning
cp .env.example .env   # RETELL_API_KEY for provisioning, ANTHROPIC_API_KEY for Claude; the demo runs with no keys
npm test               # server and integration tests
npm start              # http://localhost:8787
npm run build:web      # only after changing web/src: rebuilds the React screens into web/dist (a built copy is committed)
```

| URL | Who | What |
|---|---|---|
| `/board?token=dev-supervisor` | supervisor | counts, ranked incidents with inline details and send buttons, LA district map or zone grid, pop-up alerts for bigger issues, live calls (listen, interpret, take over), units in the field with watchdog timers and nearby stops, close with a disposition, history layer on the map, chirp relay demo, public alert button |
| `/console?token=dev-dispatcher` | dispatcher | live calls first, transcript with translation, Interpreter Mode, takeover, send EMS/Fire/Police/Utility/Callback, unit status, Flag AI, Action Kits |
| `/alerts` | alerting agency | sign in (agency, name, passcode `dev-agency`), draft evacuation order or warning, shelter in place, advisory, all clear; a second person approves before anything goes out; active alerts with resident replies and translation status |
| `/app/` | resident | installable PWA: alerts for your zone in your language with "I'm safe / I've left / I need help", updates on your own reports, call the support line, check in (queued offline), Action Kits offline, listen for a chirp, beacon |
| `/replay` | anyone | a real LA evening (LAPD calls for service) as a guided story and free play |
| `/chirp` | eHawk stand-in | simulate a NOAA SAME burst, sign a 16-byte directive, play it as sound |

The React screens live in `web/` (Vite + React + TypeScript). The previous single-file pages stay at `/legacy/board`,
`/legacy/console`, `/legacy/replay` and `/app/legacy`.

## Demo run of show

Start clean: **↺ Reset demo** on the board (click twice). It clears calls, reports, incidents, units, alerts and the event log, keeps baselines, kits and the twist log, and every open screen reloads.


1. Board: **Run demo surge**. Water reports in three neighboring districts become one spreading line; five alarms in one
   district stay "alarms only"; two medical calls go straight to "needs a person". Alerts drop in top right.
2. Board or console: **Simulate a live call**. A Spanish caller ("no tenemos agua") stays on for three minutes. Open it:
   listen, **Join interpreter**, type in English and the caller hears Spanish, then **Take over**.
3. Board: expand a row, **Send Utility**, move the unit En route then On scene in "Units in the field". Leave one in Assigned
   for two minutes and it flags as overdue. Under the unit, "Also nearby" offers calls the same crew can clear; tap one to add the stop. Close it **as Unable to locate** and a callback lands in the silence panel.
4. Phone (`/app/`, zone 0812): check in about the water. When the unit goes En route the phone shows "A unit is on the way."
5. Board: **Public alert**, send an advisory ("we know, crews are on it, no need to call"). It appears on the phone in the
   phone's language and is read aloud. Ask for an evacuation warning: it lands in `/alerts` as a request.
6. `/alerts`: sign in as one person, draft it; sign in as a second person, **Approve and send**. The phone shows it with
   "I need help", which puts that resident on the board as "needs a person".
7. Board: **Chirp relay**. One SOS chirp reaches three pole nodes; the row says "heard by 3 nodes, counted once" and the map draws the area.
8. `/replay`: chapter 2, RD 0802 rang 8 times in 30 seconds on January 7, 2025, flagged at the third ring.

Terminal alternatives: `npm run seed` (the 20-call script), `npm run fake-call -- ws://localhost:8787 spanish_water --hold 180`.
Fake callers: `water | bleeding | breathing | spanish | spanish_water | hangup`.

## Languages

Recognized: English, Spanish, Mandarin, Cantonese, Korean, Tagalog, Armenian, Vietnamese, Farsi, Russian, Arabic, Japanese,
Hindi, Thai, Ukrainian. Chosen from LA County DMH threshold languages plus four LA County languages, limited to what Retell's
speech recognition supports (Khmer is a threshold language Retell does not list). Retell setup: select these languages on the
agent, transcription provider Soniox (the one that covers all 15), and a voice provider that covers Armenian (OpenAI or
ElevenLabs v3). Cantonese has recognition but no voice that pairs with the rest, so Cantonese calls are flagged "needs a
human interpreter". Alerts, system lines and the chirp phrasebook are machine translated by the model and labeled as such;
Action Kits stay in reviewed English and Spanish only.

## Retell (real phone line)

1. Expose the server: `cloudflared tunnel --url http://localhost:8787`. Put the https URL in `PUBLIC_BASE_URL`.
2. Put your key in `.env` as `RETELL_API_KEY` (never in code, never in a Bob prompt).
3. `npm install retell-sdk` then `npm run provision` (dry run) and `npm run provision -- --apply`.
4. Attach a phone number to the agent in the Retell dashboard, or start a web call with the agent id.

The agent uses a custom LLM over websocket (`wss://.../retell/llm/{call_id}`), so our server owns every turn, the kit cards,
the triggers and the transfer decision. With `ANTHROPIC_API_KEY` set, Claude does extraction, replies and translation; without
a key the rule-based fallback runs the demo in English and Spanish.

## Mentor feedback built in (Oct 17)

- One crew, several stops: `GET /units` lists nearby calls each unit can also clear (same or neighboring district, a type it covers, never a call that needs a person); `POST /incidents/:id/units/:n/stop`.
- The app cannot set its own priority: app and eHawk reports marked above 3 are held at 3 unless danger words back them up (fire, gas, downed lines and floods keep what was reported). `server/triage.js`.
- Node relays: the same chirp heard by several nodes counts once; the board shows which nodes heard it and the area they cover. Nodes are simulated (`server/relay.js`).
- History layer: districts shaded by past dispatched LAPD calls of one type, 55 days, labeled as calls, not confirmed crimes (`data/history_by_rd.json`, built by `scripts/history_by_rd.py`).
- Research export: `GET /research/export.csv` (dispatcher or supervisor token), one row per incident, no identifiers.

## Who may send which alert

Protective action decisions (evacuation orders and warnings, shelter in place) are made by law enforcement and fire and sent
by the county Office of Emergency Management. In January 2025 LA County OEM staff sent the Eaton and Palisades alerts in
coordination with the Sheriff and county Fire. So in EchoHawk:

- agency accounts (LA County OEM, Sheriff, Fire, LAPD, LAFD, City of LA EMD) draft and send; a protective action needs a second
  person from an agency to approve it
- the EchoHawk supervisor can send an advisory and can request a protective action, which lands in the agency queue
- this is not Wireless Emergency Alerts; WEA and IPAWS stay with the agency's existing system

## What is real and what is a stand-in

- Real: the Retell custom LLM handler, the engine, triggers, kit mechanism, signed frames and their verification, the LAPD
  baselines and replay, all five screens, the chirp (ggwave, audible, about one meter), the alert approval rules.
- Stand-in: unit status is tapped in on the board; in production it comes from the agency's CAD. The eHawk device is the
  `/chirp` page; NOAA SAME decode is simulated by `POST /alerts/same`. No SMS: updates reach app users, not phone-only callers.
- Heuristic, labeled on screen: the confidence score (1 - 0.5^n over independent callers), the watchdog times (2 min assigned,
  10 min en route, 20 min on scene), and the cost meter rates.

## Layout

```
server/   index.js · http.js (REST, SSE, static) · retell_ws.js (custom LLM, greeting, Interpreter Mode, takeover)
          engine.js (scan + corroboration + spread) · triggers.js · schema.js · kits.js · llm.js (Claude, fallbacks)
          languages.js (15 languages, detection) · broadcasts.js (public alerts, approvals, frames) · units.js (unit status,
          watchdog, dispositions, reporter updates) · callbacks.js · replay.js · seed.js · store.js · config.js · test/
web/      Vite + React + TypeScript: src/board, src/console, src/alerts, src/app, src/replay, src/shared; dist/ is the build
app/      sw.js (offline cache for /app/), manifest, icon; index.html is the legacy page
device/   frame.js (16-byte signed frame, replay window) · chirp_send.html
kits/     catalog.json (EN + ES, sources, review status)
data/     LAPD baselines and replay days
```

## Tests

`npm test` runs the engine, protocol (over a real websocket), Claude provider, security, HTTP, callbacks, SAME decoder, zone,
language detection (one sentence in each of the 15 languages), public alert rules (two-person approval, supervisor limits,
all clear, signed frames, "I need help" escalation) and post-dispatch tests (unit status order, watchdog, unable to locate
schedules a callback, reporter sees "a unit is on the way") and the mentor tests (nearby stops, self-report triage, node relays, research export without identifiers).

## Connected resident app and iPhone pilot

The new `/app/` follows the approved four-tile resident layout. `/app/standard` keeps the existing full React app with language, chirp and check-in tools; `/legacy/app` keeps the original HTML interface. The simple screen also receives the same public agency alerts automatically while open, with cached alerts labeled when updates cannot be checked. Build with `npm --prefix web ci` and `npm --prefix web run build`, then start the server normally.

A **demo call** creates a real shared dashboard call session with a simulated text conversation. Open `/console` alongside `/app/`, start Emergency Help, choose “Try the bleeding kit”, then take that call in the console. Dispatcher messages, kit replacement, kit close and call end synchronize with the resident. The resident's own Close kit only hides it locally; Reopen instructions restores it. Demo calls are explicitly labeled. They do not contact emergency services or use Retell credits.

Live browser audio is wired through Retell's Web SDK and a server-only create-web-call endpoint. It is off until all four values are configured: `RESIDENT_LIVE_ENABLED=true`, `RETELL_AGENT_ID`, `RETELL_API_KEY`, and `RESIDENT_ACCESS_CODE`. The agent must use this server's custom-LLM websocket and its reachable HTTPS public URL. Enter the pilot code in app Settings; it stays in memory. Resident read access uses a random per-call capability, never a staff token. Live audio needs a real microphone/device test. Existing console takeover uses dispatcher text or speech-to-text relayed through the agent voice, not a verified direct human-audio conference. No 911 routing is configured by this change.

The severe-bleeding photo and screen are **prototype content pending qualified medical review**. Pending medical kits cannot be deployed to live resident calls. The existing catalog remains unchanged. The photo was produced with the built-in image-generation tool from the approved mockup, using the prompt: “Extract/recreate only the central first-aid demonstration photograph; preserve stacked hands applying pressure through gauze on a supported forearm, no phone or text, non-graphic.” Asset: `app/media/bleeding-pressure-prototype.png`.

### iPhone first

The Capacitor iOS project is in `web/ios/App/App.xcodeproj`. Its resident UI, kit catalog and illustration are bundled on-device so the shell does not depend on a live website.

```sh
npm --prefix web ci
cd web
npm run sync:ios
npx cap open ios
```

In Xcode, choose your signing team and iPhone, then run. Full Xcode is required; command-line tools alone cannot compile or install the iOS app. Set the dashboard's HTTPS base URL in app Settings. Bluetooth and microphone usage descriptions are present. The privacy manifest records Preferences/UserDefaults usage; App Store privacy disclosures must reflect the eventual deployment. The current code uses the same Capacitor Bluetooth interface on iOS and Android; an Android project has not yet been generated or tested.

### Offline Bluetooth → radio → gateway → dashboard

Beacon and reports are saved before transmission. The three states are saved on this phone, received by a node, and received by the dashboard. A GATT write is never counted as delivery, and a receipt does not mean responders were dispatched. The backend applies the existing self-report triage; a beacon requests human attention. Voice calls, images and long text do not fit the small radio path.

The iPhone uses `@capacitor-community/bluetooth-le` (Core Bluetooth) as a central connecting to a receiver peripheral. Two configurable profiles are present:

- **EchoHawk demo frame (default):** matches the existing signed 16-byte format in `device/frame.js` and `web/src/app/frame.ts`. Nordic UART service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`, writes `6e400002-…`, receipts notify `6e400003-…`. The report keeps one sequence across retries. Signed stage 1 means node picked up; stage 2/3 means dashboard received. The demo uses the existing shared development key, a 16-bit random sequence and the server's 10-minute deduplication window; it is not production authentication. These queued frames expire after ten minutes. Internet and radio arrivals share a packet within that window. Message text is sent over HTTPS only; radio carries category, zone and request type. The existing personal ESP32 **tag is a sender**, not the town receiver this app connects to. A receiver peripheral plus its radio driver still need implementation/testing on the selected hardware.
- **Custom JSON adapter:** UTF-8 JSON plus newline in sequential 20-byte writes, specified by `app/relay-protocol.js`. It preserves a random `message_id`, device pseudonym, type, zone, category, severity, action, short text, creation and expiry time. The node must persist the message before notifying `{ "version": 1, "state": "node_received", "message_id": "<same-id>" }`. Only node receipts are accepted over this profile; dashboard receipt comes over HTTPS. JSON messages expire within 24 hours. Firmware must implement reassembly, radio fragmentation, routing, authentication and return receipts. This is not a Meshtastic implementation.

The JSON gateway submits `{gateway_id, envelope}` to `POST /relay/ingest` with a gateway-only bearer token from `RELAY_GATEWAY_TOKEN`. `device/relay/gateway.js` durably spools reassembled envelopes from stdin, retries through outages and writes receipts to stdout for a radio driver. The compact frame path continues to use the existing `/device/packets` endpoint and signed acknowledgment. Neither path implements a radio driver. A gateway can reach a local dashboard over the LAN without internet; the nodes, gateway and dashboard need backup power.

Example gateway launch (supply the same secret to server and gateway through their environment, not source):

```sh
ECHOHAWK_GATEWAY_URL=http://127.0.0.1:8787 RELAY_GATEWAY_ID=town-gateway node device/relay/gateway.js
```

Saved queues are retried while the app is active. `bluetooth-central` is declared for iOS, but background execution, state restoration, automatic reconnect, locked-screen alert reception and push notifications have **not** been implemented/validated as an always-on service. A native background service and physical-device tests are required before promising background reception. The web preview detects Bluetooth support and explains when the installed iPhone app is needed.

Validation: server tests cover call ownership, dispatcher takeover, AI silence in demo mode, scoped kit delivery/close, live-kit review gates, gateway authentication, duplicate delivery, BLE chunk round trips, and gateway persistence across outages/restarts. Browser checks cover call → kit → close → reopen → dispatcher message. Physical radio range, battery behavior, iOS build/signing and live Retell audio remain device/integration checks.
