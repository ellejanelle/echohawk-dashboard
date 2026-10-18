# EchoHawk Build Spec

InnovateLA Dual-Use Hackathon, USC, October 16 to 18, 2026. Lens: Resilience Comms (Retell AI). Submission: Devpost, Saturday 10:00 PM, no extensions. Finals: Sunday 1:15 PM, Ginsburg Hall.

Team: ElleJanelle (problem, research, spec, prototype, pitch), computer engineer, data/IT analyst, Navy veteran.

This document is the single source of truth for the build. Every number in it is either verified with a source or labeled "team judgment." If something here contradicts a judge's question, the claims list in Section 14 wins.

---

## 0. One line, one seat, one moment, one Tuesday

**One line.** EchoHawk is an AI intake and corroboration layer for LA's overloaded 911 and non-emergency lines, plus a cheap household box that keeps alerts flowing in your language when the towers die.

**The seat.** The overnight supervisor of a call line (the prompt's seat), with the dispatcher at the console beside them.

**The moment.** 1 AM, January 8, 2025, the Eaton Fire. LA County Fire dispatch took 4,594 inbound 911 calls that day. The state-commissioned FSRI review found calls arrived faster than dispatch could assign them. At least 14 reports of fire west of Lake Avenue reached dispatch before the 3:25 AM evacuation order, in the area where 18 of the 19 deaths occurred. Reports of an ember storm seen by paramedics in west Altadena never reached incident commanders.

**The Tuesday customer.** LAPD's non-emergency line. The same operators answer emergency and non-emergency calls, and non-emergency callers averaged a 3:40 wait in 2024. The household device's Tuesday job: a weather radio that speaks the household's language and charges a phone.

**The rungs.** Ask (verify and cluster) and hand to a person (never-automate triggers). Watch runs underneath as the content-free scan layer. Hold appears once: the funded-capacity governor (Section 11).

**Pitch line.** Fourteen calls, one fire, no flag. EchoHawk turns the flood into the sensor, in every language, with or without the towers.

---

## 1. The problem, with receipts

| Fact | Source |
|---|---|
| LAPD answered 57.43% of 911 calls within 15 seconds in 2024; California's standard is 90% | LAPD report to City Council; Cal OES 9-1-1 Operations Manual |
| 64% within 15 seconds in 2025; more than 500,000 callers waited 40 seconds or longer | Mother Jones / Type Investigations analysis of state data, Sept 2026 |
| 92 call-taker vacancies as of Oct 29, 2025; about a year to train one | LAPD Communications Division fact sheet; NBC LA |
| Emergency and non-emergency calls share one LAPD queue; non-emergency average wait 3:40 (2024) | Councilmember Raman motion, April 2025 |
| LA County Fire dispatch: 4,594 inbound 911 calls on Jan 8, 2025 | LACoFD January 2025 dispatch statistics |
| "Calls came in faster than dispatch could manage or assign them"; 911 calls routed through a captain's personal cellphone | UL FSRI Phase Two review (2026), via NBC News |
| At least 14 reports of fire west of Lake Avenue before the 3:25 AM order; 18 of 19 deaths there | LA Times from LACoFD 911 logs; Rep. Judy Chu letter |
| Ember storm seen by paramedics never reached incident commanders | FSRI Phase Two, via Fire Engineering |
| County departments sat in "information silos"; review calls for a common operational picture | McChrystal Group after-action review, Sept 2025 |
| Kenneth Fire alert went to nearly 10 million residents by error (Jan 9, 2025); cause: evacuation polygon not uploaded, vendor did not notify county; "echo" alerts as towers came back online | LA County statement; congressional report (May 2025); CNN |
| Language barriers add 33% to BLS and 43% to ALS dispatch time | Meischke et al., Prehospital Emergency Care 2013 |
| NOAA Weather Radio: seven Spanish transmitters nationally, none in any other language | GAO-26-107680, January 2026 |
| All 21 West Maui cell towers failed (2023); 95.6% of Puerto Rico cell sites down after Maria, mostly from power loss | Maui County lawsuit; FCC DIRS |
| Woolsey 2018: county review named communication, collaboration and situational awareness as the three failure themes; residents on internet-based phone service lost alerts when power failed | Citygate after-action review; CBS LA |

**The honest limit.** FSRI says the communication shortcomings "did not drive the tragedy." Resource limits and fire behavior came first. EchoHawk shortens the minutes between first report and decision. It does not claim to have saved Altadena.

---

## 2. System architecture

```
RESIDENTS                      SOURCES                         ECHOHAWK CORE                        PEOPLE
phone call  ──────────► Retell voice agent ──┐
(any language)          (custom LLM websocket)│
                                              │   ┌──────────────────────┐    ┌──────────────────┐
EchoHawk app ─────────► app packets ──────────┼──►│ INGEST + PACKETIZE   │───►│ DISPATCHER       │
(check-in, beacon,      (JSON over HTTPS)     │   │ one schema, source   │    │ CONSOLE          │
 kits, contacts)                              │   │ field: voice/app/    │    │ live transcripts │
                                              │   │ ehawk/telemetry      │    │ interpreter mode │
eHawk device ─────────► chirp ─► node ─► LoRa ┘   └──────────┬───────────┘    │ kit controls     │
(SOS, check-in,          (last meters) (hops)                │                │ transfer         │
 NOAA SAME decode)                   gateway at fire station │                └──────────────────┘
                                     (satellite backup)      ▼
                                                  ┌──────────────────────┐    ┌──────────────────┐
NOAA Weather Radio ───► eHawk decodes SAME,       │ CORROBORATION ENGINE │───►│ SUPERVISOR BOARD │
(VHF broadcast,         re-voices in household    │ scan layer (counts)  │    │ ranked "needs a  │
 no towers needed)      language, chirps into     │ independence weights │    │ person" list,    │
                        phones in airplane mode   │ spread detection     │    │ hotspot map,     │
                                                  │ hard/soft triggers   │    │ silence panel,   │
                                                  └──────────┬───────────┘    │ twist log, cost  │
                                                             │                │ meter            │
                                                             ▼                └──────────────────┘
                                                  ┌──────────────────────┐
                                                  │ EVENT LOG            │  research instrumentation,
                                                  │ every transition,    │  per-county training set
                                                  │ provenance, versions │
                                                  └──────────────────────┘
```

### 2.1 Components

1. **Retell voice agent** (Section 6). Answers overflow and non-emergency calls in the caller's language, extracts four fields, reads approved kit cards aloud, transfers to a human on any hard trigger. Runs over Retell's custom LLM websocket so our server owns every turn.
2. **Orchestration server** (Node or Python; Bob scaffolds it). Holds the websocket loop, the LLM calls, the translation step, the packetizer, the webhook receiver with signature verification, the kit catalog, the corroboration engine, and the event log. One codebase, one database.
3. **Corroboration engine** (Section 4). Groups packets into incidents, scores independence, detects spread, applies triggers, ranks the supervisor list.
4. **Dispatcher console** (Section 8.1). Live call list, live transcript with translation, Interpreter Mode, kit controls, transfer, callback ladder.
5. **Supervisor board** (Section 8.2). Ranked incidents, map by zone, what-changed panel, silence panel, twist log, cost meter.
6. **Resident app** (Section 8.3). Web app (PWA) that runs on a phone: talk to the line, kits offline, check-in, beacon mode, registered contacts.
7. **eHawk device and acoustic layer** (Section 9). Battery box: NOAA SAME decode, re-voice, chirp, SOS, check-in, USB charge-out. Street nodes on LoRa, gateway at a fire station, tethered drone node for the aftermath.
8. **Event log** (Section 3.2). Every event, every transition, with provenance. This is both the audit trail and the future training set.

### 2.2 What runs where this weekend

| Piece | Real | Simulated or mocked |
|---|---|---|
| Retell agent, extraction, kit function, transfer | Real | |
| Orchestration server, packetizer, webhooks, event log | Real | |
| Corroboration engine on seeded packets | Real | |
| Dispatcher console, Interpreter Mode | Real (typed fallback if speech misbehaves) | |
| Supervisor board with LAPD and synthetic data | Real | |
| Resident app with 3 offline kits, check-in, beacon | Real | GPS from browser; chirp via ggwave web build or Waver |
| Airplane-mode handshake (laptop chirp to phone) | Real | |
| NOAA SAME decode | Decode from recorded burst on a laptop (samedec), labeled | Si4707 radio chip: on order, shown as render |
| LoRa hops, gateway, satellite backup | | Mocked: node posts into the same ingestion endpoint |
| eHawk enclosure, battery life, drone node | | Render and one slide; no battery or cost numbers claimed |

---

## 3. Data model

### 3.1 The packet (one schema for every source)

```json
{
  "packet_id": "uuid",
  "source": "voice | app | ehawk | telemetry | field_unit",
  "received_at": "ISO-8601 (server clock)",
  "observed_at": "ISO-8601 (source clock, may drift)",
  "zone_id": "county evacuation zone or LAPD reporting district; never a street address",
  "target": "power | water | gas | structure_fire | wildfire | road | flood | person | vehicle | unknown",
  "severity": 1,
  "action": "dispatch_ems | dispatch_fire | dispatch_police | welfare_check | info_only | deflect_311 | unknown",
  "independence_key": "sha256(phone or device id + zone_id), salted; repeat transmissions of one SOS share one key",
  "content_status": "extracted | partial | none",
  "language": "BCP-47 tag detected by Retell or set on device",
  "call_id": "Retell call_id when source is voice, else null",
  "provenance": "firsthand | forwarded | repeat_beacon | simulated"
}
```

Rules:
- **A packet is created for every call, even when extraction fails** (`content_status: none`). Abandoned calls, hang-ups and unsupported languages still carry time and zone, which is all the scan layer needs. Jasso et al. detected events from time and location alone, with locations deliberately blurred.
- **Zone, not address.** Privacy by default, and the unit supervisors already think in. Map zones to polygons with the county's evacuation zones or the LAPD Reporting District layer on LA GeoHub.
- **Severity is 1 to 5.** Single-caller severity never lifts an incident past 60% of the hand-to-person threshold on its own (team judgment, Section 4).
- **Independence key is salted and hashed.** Five transmissions of one SOS packet are one report. The engine never sees phone numbers.

### 3.2 The event log (research instrumentation, built into Version 1)

Every system event gets one row. Nothing is overwritten; status changes are new rows.

```
event_id, packet_id (nullable), device_pseudo_id (nullable), call_id (nullable),
event_type: packet_created | transmitted | received | forwarded | gateway_delivered | incident_opened |
            incident_merged | score_changed | rung_changed | trigger_fired | kit_shown | kit_changed_by_human |
            transfer_started | transfer_bridged | callback_attempt | callback_no_answer | acknowledged_by_human |
            incident_closed | alert_received | alert_revoiced | alert_chirped,
ts_source, ts_gateway, ts_server, clock_drift_ms (nullable),
provenance: firsthand | forwarded | repeat_beacon | simulated,
language, zone_id, actor: system | ai | dispatcher | supervisor | device,
payload_json (never raw audio; never a street address), schema_version
```

Why each field exists: the question future researchers can ask is "at what minute did enough evidence exist, and how many minutes passed before a human acted." That needs a timestamp per transition, not one per packet. Failed transmissions are logged as events, so five attempts and one success look like five attempts and one success, not one success.

Privacy boundaries: research logging never blocks or delays an SOS; no continuous household audio; no precise location unless the person opts in; emergency data is never used for unrelated research without consent and review.

---

## 4. Corroboration engine

**Bottom line.** Default to escalating. Every number below is configurable and shown with its reason on the board. Nothing automated ever closes a high-severity item.

### 4.1 Two layers, two jobs

| Layer | Input | Method | Output | Why it exists |
|---|---|---|---|---|
| **Scan layer (watch)** | Every packet's time and zone, content or not | Count per zone per 15-minute window vs that zone's hour-of-day baseline; Poisson tail test; optional SaTScan-style scan hourly over a rolling 21-day window | Shades the map; opens a watch item | Jasso et al. 2009 (space-time permutation scan on 911 call locations, daily runs); Cincinnati EPA pilot parameters (p < 0.025, rolling 21 days, 999 Monte Carlo replications, more than 16 calls). The 2007 Jasso hotspot rule was 10 calls within 1 km and 10 minutes |
| **Content layer (ask, hand)** | Packets with extracted target and severity | Independence-weighted corroboration per zone and target; spread across adjacent zones; triggers | Moves an incident to ask or hand-to-person | Sakaki et al. 2010: each independent reporter is a sensor; confidence is 1 minus p_f^n over distinct sources |

The scan layer alone never pages anyone at 2 AM. Cincinnati ran a 911 cluster scan for two and a half years, got 85 alarms, zero true events, and alert recognition lagged 10 to 13 hours. The content layer is what moves the rungs.

### 4.2 Grouping

| Setting | Default | Basis |
|---|---|---|
| Incident key | same zone and same target class | team judgment; zones mirror the evacuation zones used in the Eaton review |
| Merge window | 15 minutes sliding | team judgment, anchored to the RapidSOS patent's example 15-minute block and Jasso's 10-minute spacing |
| Keep-alive | 2 hours since last packet | team judgment |
| Adjacent-zone spread | same target in a bordering zone inside the window opens a linked incident flagged "spreading" | Eaton west-of-Lake lesson; validated on the Montgomery County testbed (Section 10) |
| Never discard duplicates | every duplicate adds corroboration and is re-scanned for hard triggers | Texas Supreme Court, City of Dallas v. Sanchez: two calls from different numbers about different people were wrongly treated as one |
| Distance fallback (no zone) | 500 m for point targets | team judgment, no published value verified |

### 4.3 Independence weighting and rungs

Corroboration score = 1 minus p_f^n over distinct independence keys, with p_f = 0.5 for unverified voice reports (team judgment). Two keys give 0.75, three give 0.875, four give about 0.94. **This is a heuristic score, not a calibrated probability.** It borrows Sakaki's independent-sensor form but assumes independence and an unmeasured false-report rate. Label it "confidence score" in every interface until it is calibrated on a county's own history (Section 12).

Weights (team judgment): distinct household or device 1.0; same household second line 0.25; repeat call from the same caller 0 toward corroboration but raises urgency; first responder or field unit 1.0 and flagged; utility telemetry agreeing on the same target 1.0; machine-originated alarm activations are a separate source class (see Section 10, the Palisades finding).

| Rung | Condition | What happens |
|---|---|---|
| Watch | one independent report, no hard trigger, non-life-safety target; or a scan-layer anomaly | map shading, watch list |
| Ask | 2 independent keys within 15 minutes on one zone and target, or 1 report on a high-consequence target (fire, gas, downed line, flooding) | outbound verification calls to opted-in neighbors in the zone; result feeds back as packets |
| Hand to a person | any hard trigger, or 3 or more independent keys within 15 minutes, or corroboration at or above 0.85 | item goes to the top of the supervisor list and the dispatcher console; warm transfer if a caller is live |

### 4.4 Cross-call patterns (escalate even when no single call qualifies)

1. Three or more independent keys on one zone and target within 15 minutes.
2. Zone call rate at 3x or more its trailing baseline (team judgment; Maui ran at about 2.8x its normal day, Harvey at more than 8x).
3. Two or more separate callers describing unconscious or injured people at one venue (Astroworld: five calls about unconscious persons before the show stopped).
4. Reports from a zone the command picture considers safe (Eaton: reports west of Lake from 10:50 PM).
5. Utility telemetry anomaly plus any caller report on the same asset (San Bruno: PG&E's SCADA saw the pressure drop and never called 911).
6. Two calls from one address with different callers: treat as possibly separate victims.

---

## 5. Trigger taxonomy

**Bottom line.** The dangerous moment is when the caller says something ambiguous that sounds reassuring. Escalate on uncertainty.

### 5.1 Hard triggers (always warm transfer, no automation)

| Trigger | Basis |
|---|---|
| Not breathing, or any qualified breathing: "gasping," "sort of," "barely," "snoring," "occasional" | Riou et al. 2018: 44% of "yes, breathing" answers in confirmed cardiac arrest calls were qualified, and most were not recognized; Ball et al.: agonal descriptions in 21% of calls but 38% of unrecognized cases; Berdowski 2009: normal breathing was never mentioned in true arrest calls |
| Unconscious, unresponsive, "won't wake up," seizure then still | Berdowski; IAED confounders |
| Trapped, "can't get out," fire or water inside the dwelling | Camp Fire 8:11 AM log: "her house is on fire and she can not get out," call disconnected, callback got a busy signal |
| Child, dependent or immobile person alone or unreachable | DC hot-car case 2025: father said baby not breathing, call misclassified |
| Active violence or weapon | standard dispatch practice (protocol text not verified) |
| Caller asks for a person | Aurelian/SECOMM practice: transfer immediately when urgent or complex |
| Caller cannot be understood after 2 attempts, or language unsupported | NENA 2025 practitioner fail-safe: transfer after two failed attempts |
| Silence, disconnect or busy callback on any call at or above the ask rung | Camp Fire; silence never counts as OK |
| Caller insists on a higher severity than the system assigned | Aiken County SC: son repeatedly said "cardiac arrest," coded "chest pain"; DC "lift assist" coding of a cardiac arrest |
| Self-harm language including indirect terms: pills, bridge, Tylenol, ibuprofen | Crisis Text Line: those words are about four times more likely to indicate high risk than the word "suicide" |

### 5.2 Soft triggers (raise score)

Distress markers (crying, shouting), rapid repeat calls; electrical "pop," sparks, transformer, lines down (Lahaina morning calls; Tubbs pre-ignition electrical reports); smell of gas or water-pressure change (team judgment, precursor status unverified); second- or third-party reports about a vulnerable person (never refused; Harvey dispatch refused them); night, power outage, no aerial reconnaissance (Eaton conditions).

### 5.3 What is never automated (say it on the slide)

Dispatch decisions. Evacuation orders. Medical diagnosis. Closing a high-severity item. Treating silence as resolved. Writing a medical instruction (Section 7).

---

## 6. Retell agent specification

**Verified feature names (current Retell docs).** Functions menu: Custom Function, Call Transfer, Agent Transfer, End Call, Press Digit, In-Call SMS, Extract Dynamic Variable, Code, MCP. Webhook events: `call_started`, `call_ended`, `call_analyzed` by default, plus `transcript_updated`, `transfer_started`, `transfer_bridged`, `transfer_cancelled`, `transfer_ended`. Post Call Extraction with Selector, Boolean, Number and Text fields. Web SDK `createWebCall` with `onTranscript`. Transfer modes: Cold, Warm (one-way brief, whisper), Agentic Warm. Multilingual: set language to multiselect; Retell detects the caller's language at call time. Pricing: $0.07 to $0.31 per minute, 20 free concurrent calls, $8 per additional concurrent call per month, enterprise concurrency from 50 plus. Every innovator gets $10 in credits at signup; the lens prize is judged on what you build with it.

### 6.1 Architecture decision: custom LLM websocket for every call

Retell's custom LLM websocket sends our server `update_only`, `response_required` and `reminder_required` events carrying the live `transcript` (and `transcript_with_tool_calls` when enabled in `config`). Our server answers with `response` events (`response_id`, `content`, `content_complete`, optional `end_call`, `transfer_number`) and can push an unprompted utterance at any time with `agent_interrupt` (`interrupt_id`, `content`, `content_complete`). That one capability is what makes Interpreter Mode possible, so every call runs through it. Consequences: our server runs the LLM loop (any model), owns transcripts for every call, fires tool calls itself (`tool_call_invocation`, `tool_call_result`), and must drive warm transfer itself (with a custom LLM, `transfer_number` is cold transfer only). Confirm the warm-transfer path at the 10:30 AM Retell session.

**Transfer fallback (must be tested before the demo, not assumed).** Primary: warm transfer driven from our server. Fallback A: cold transfer via `transfer_number` in a `response` or `agent_interrupt`, preceded by the agent reading a one-line brief to the caller ("I'm connecting you to a dispatcher now") and the server posting the four fields to the dispatcher console so the human has the brief even though Retell did not whisper it. Fallback B: a separate hosted-LLM "transfer agent" using Retell's built-in Warm Transfer, reached by Agent Transfer. The transfer test (one scripted life-threat call reaching a teammate's phone) is an acceptance test in the implementation plan, and the demo uses whichever path passed.

### 6.2 The agent's job, in order

1. Detect language (Retell multiselect; configure LA's threshold languages, list to be verified: start with English, Spanish, Korean, Mandarin, Cantonese, Tagalog, Armenian, Vietnamese, Farsi).
2. Scan every caller turn for hard triggers before anything else. On a hit: start the transfer first, immediately, and in parallel push the matching pre-arrival card via `show_kit_card` if one exists in the catalog. **A missing, unapproved or failed card never delays or blocks a transfer.** The transfer is the safety action; the card is a courtesy while help is coming.
3. Extract the four fields with Extract Dynamic Variable (Zone: Text then server-side geocode to zone; Target: Enum; Severity: Number 1 to 5; Action: Enum). Prefer Selector and Enum over Text.
4. Emit a packet the moment the four fields are present, not at call end. `call_analyzed` arrives after hang-up, which is too late for the board in flood mode.
5. Pick a kit only from the allowlisted catalog; read the card's script lines verbatim; never state a step that is not on the card.
6. Never hang up without a next step. Non-emergency conversations escalate after N turns or when confidence is low (N = 6, team judgment).

### 6.3 Interpreter Mode (dispatcher speaks, caller hears their language)

- Dispatcher clicks "Join" on a live call. The console opens the mic (headset required in the demo room).
- Dispatcher speech goes to speech-to-text on our server, then to the LLM for translation into the caller's detected language, then to Retell as `agent_interrupt` with `no_interruption_allowed: false`. The caller hears it in Retell's voice, in their language.
- Caller turns arrive in the transcript stream; the server translates them into the dispatcher's language and renders them live in the console (optionally spoken with browser TTS).
- Everything the dispatcher says is logged as `actor: dispatcher`; everything the AI said on its own is `actor: ai`. The board shows which was which.
- Typed input is the fallback for the same path.
- Why it matters: language barriers lengthen dispatch time by 33% (BLS) and 43% (ALS), and conference interpreters add connection delay. In Interpreter Mode the dispatcher is their own interpreter, and the human decides every word.

### 6.4 Provisioning script (Bob writes it, engineer runs it with `RETELL_API_KEY` in the environment)

Creates the LLM resource pointing at our websocket URL; creates the agent with multiselect languages, `webhook_url`, transcript events enabled, Post Call Extraction fields (Target: selector; Severity: number; Action: selector; Zone: text); registers the custom function `show_kit_card(kit_id, zone_id)` with async execution; sets `tool_call_strict_mode: true` and a low temperature. Rerunning the script after a twist is how a build change is proven.

### 6.5 Webhook handling

Verify `x-retell-signature` with the SDK on every request. `call_ended` excludes analysis; listen to `call_analyzed` for post-call fields and reconcile with the live packet. Failed dials fire `call_ended` and `call_analyzed` without `call_started`.

---

## 7. Action Kits and the Source Registry

**Rule one.** The AI picks the card; it never writes the card. `show_kit_card` accepts only catalog IDs, returns the card's approved script lines, and the agent reads them verbatim. If no kit matches, the agent asks one clarifying question or transfers.

**Rule two.** Original EchoHawk wording with links to the authority. Red Cross and AHA materials cannot be reproduced without permission; CDC content is public domain but needs attribution and a non-endorsement line; EPA reuse varies by document; FEMA and USFA materials are often reusable but graphics need rights checks.

**Rule three.** Medical cards ship labeled "pending qualified medical review." No improvised tourniquet instruction. The bleeding card fires alongside the warm transfer, never instead of it, and never gates it: if the card is unavailable or unapproved, the transfer proceeds exactly as fast without it.

### 7.1 Kits for this weekend

| ID | Kit | Mode | Authority | Review |
|---|---|---|---|---|
| EH-LIGHT-001 | Safe Lighting During an Outage | Tuesday, offline | CDC power outage safety | not required |
| EH-BLEED-001 | Life-Threatening Bleeding (pressure, call, monitor) | Emergency, with transfer | Red Cross severe bleeding; ACS Stop the Bleed | pending medical review |
| EH-BAG-001 | Build My Emergency Bag | Pre-emptive, offline | Ready.gov supply checklist | not required |
| EH-AIR-001 (stretch) | DIY Clean-Air Box Fan Filter | Tuesday, offline | EPA DIY air cleaner guidance (fan 2012 or later with safety features, MERV 13, never unattended) | not required |

### 7.2 Source Registry record (one per kit, stored with the catalog)

```
kit_id, title, mode, authority, reference_url, last_source_check, medical_review: not_required | pending | approved,
reviewer (nullable), revision, languages, offline_available, permissions_status, contraindications, requires_human: bool,
script_lines[] (what the agent reads, verbatim), display_steps[] (what the app shows), content_status: draft | approved
```

Every card shows a "Source and safety" panel: authority, link, review date, and a line that this is general guidance, not a replacement for emergency services.

---

## 8. The three interfaces

### 8.1 Dispatcher console

- Live call list with language, detected target and severity, rung, and elapsed time.
- Live transcript per call, original and translated side by side, tool calls shown inline.
- **Interpreter Mode**: Join, speak or type, caller hears their language (Section 6.3).
- Kit controls: see the card the caller sees; swap, close, or push a different card (logged as `kit_changed_by_human`).
- Transfer: take the call fully (warm transfer); the AI's brief is the four fields plus the last three turns.
- Callback ladder for no-answer: retry, alternate contact, eHawk acoustic ping, welfare-check flag. "No answer" stays open.

### 8.2 Supervisor board

- Ranked "needs a person" list, not a call queue. Each row: zone, target, independent caller count, corroboration score, trend arrow, time since first report, suggested rung, one-line summary generated from the calls with the evidence count beside it, source call IDs.
- Map by zone: scan-layer shading underneath, content-layer incidents on top, spread flags between adjacent zones.
- "What changed in the last 10 minutes" panel.
- Silence panel: callbacks nobody answered, oldest first.
- Dissent flag: a field or first-responder packet that contradicts the active picture.
- Push only when an incident crosses a rung; watch-tier items arrive as a digest.
- Twist log (timestamped: what changed, why, proof) and cost meter (Section 11).
- Nothing on this board auto-closes a high-severity item.

### 8.3 Resident app (PWA, white-label later)

- Talk to the line (Retell Web SDK; same agent, same transfer path).
- Kits: the catalog bundled offline; cards appear during a call when the agent calls `show_kit_card`, and the library opens manually with no network.
- Check-in: four questions, out loud or tapped, produces a packet; with no network it becomes a chirp to the nearest node (Section 9).
- Beacon mode: with no network, chirp last known zone and a status code every minute (team judgment on cadence).
- Registered contacts: Safe-and-Well style. Your contact gets "safe at zone X"; you can send one short canned message back. No chat over the mesh.
- Household language set once; alerts render in it.

---

## 9. eHawk device, acoustic layer, mesh, alert path

**What is true about sound.** A 2026 peer-reviewed evaluation (ACM Transactions on IoT, arXiv 2602.02249) found commercial data-over-sound products achieve only 10 to 100 bps and that audible ggwave became unusable under ambient noise. On microcontrollers ggwave runs at 5 to 10 bytes per second, reliable within 0.5 to 1.0 m. So: sound is the last few meters, into a phone running the EchoHawk app (or the Waver app) in the foreground with microphone permission, with no pairing and no network, even in airplane mode. It is not "any phone with nothing installed." Background listening on iOS and Android is unverified, so until it is, the receiving app must be open and the screen on. Street hops ride LoRa. Promise about one second for the table demo, not sub-second. A city-wide acoustic mesh is not supported by any evidence we found and is not claimed.

**The device.** Battery box, ESP32-class. Receives NOAA Weather Radio (an Si4707-class chip decodes SAME on-chip over I2C). SAME runs at 520.83 bits per second, logic one 2083.3 Hz, logic zero 1562.5 Hz (NWS Instruction 10-1712). The device plays the original NWS audio first, then re-voices the event from a pre-translated phrase table keyed by event code (no live translation needed offline), labeled "unofficial translation," and chirps the signed directive into phones in the room. Buttons: SOS (beacon mode: position and status code every minute), check-in (answer the four questions out loud). USB charge-out for a phone. Battery life and unit cost: not stated anywhere until sourced.

**The mesh.** Meshtastic-class LoRa: default 3 hops, maximum 7; Long Fast about 1.07 kbps theoretical before headers and retransmissions; payload at most 237 bytes. Private channel key. Telemetry and position broadcasts off in flood mode. Gateway at a fire station on USB to a small computer, uplink by satellite or cellular (the Helene pattern). Nodes inside a burn zone are expected losses; nodes matter ahead of the fire; most cell-site failures in these events are power loss, which battery and solar nodes survive. Spares ride on engines. Aftermath repeater: a tethered drone lifting a LoRa node to 200 feet (AT&T's Flying COW precedent after Maria: tethered for power and fiber, FAA exemption required, grounded in high wind).

**Who this reaches.** Households with no English (seven Spanish NWR transmitters nationally, none in any other language), people with dead phones or no app, people the county's own review says never registered for alerts and never received them, and older residents on the far side of the digital divide.

---

## 10. Data in hand

### 10.1 LAPD Calls for Service, Dec 1 2024 to Jan 31 2025 (real LA)

Source: data.lacity.org dataset xjgu-z4ju, pulled Oct 17, 2026 with CODE 6 and Outside excluded, then 902 traffic stops removed. 100,743 incidents, 1,129 reporting districts, 55-day baseline. Files in `echohawk-data/out/`: `calls_clean.csv`, `rd_15min_counts.csv`, `rd_baseline_by_hour.csv`, `surge_jan7_8_2025_by_rd_hour.csv`, `area_daily_counts.csv`.

**Finding for the demo.** West LA reporting district 0802 logged 8 incidents in the 15 minutes starting 7:00 PM on January 7, 2025, and 10 in that hour, against a baseline of 0.94 incidents per day. District 0823 spiked at 10:00 PM. 49 of the 56 rows in those two districts on Jan 7 to 8 are "906 CODE 30 RINGER," alarm activations. Individually the lowest-priority call type; collectively a fire signature. At the area level the surge nearly vanishes (West LA 123 vs a 78.3 daily mean). Resolution is the argument. Confirm 0802 and 0823 are Pacific Palisades with the LAPD RD map before naming the neighborhood. These are dispatched police incidents, not 911 phone calls; Altadena is Sheriff territory and not in this data.

### 10.2 Montgomery County, PA 911 (coordinates; the scan testbed)

Kaggle "Emergency - 911 Calls," 663,522 rows, Dec 2015 to Jul 2020, EMS/Fire/Traffic. A single-cell count detector (the 2007 Jasso rule or a Poisson test against each cell's baseline) flags crashes: one wreck logged by three agencies looks like seven callers. The spread detector (same subtype in 3 or more neighboring 1 km cells within 30 minutes) found 341 events whose top entries line up with regional disasters: water rescues Aug 13, 2018; road obstructions across five cells Mar 2, 2018; disabled-vehicle clusters Jan 23, 2016 and Nov 15, 2018; fire alarms across four cells Dec 21, 2018. Verify each with a news search before a slide. Lesson: a count finds crashes; independence plus spread finds disasters. Files: `montco_*.csv`, scripts `prep_montco.py`, `montco_dedupe_scan.py`.

### 10.3 Synthetic calls and recorded alerts

Twenty scripted calls seeded before the stage demo (three quiet water-pressure calls in adjacent zones, one frantic single caller, one bleeding call that triggers transfer, two non-English callers, one hang-up). One recorded SAME burst for the alert path. Labeled synthetic on the slide.

---

## 11. Funding (Twist 1) and the build change it caused

Three streams, each paying for a different piece:

1. **Tuesday pays the bills.** Agencies subscribe for the non-emergency overflow line. Benchmarks: Charleston County pays about $2,800 a month for its AI call system; agencies measure 20 to 40% of non-emergency calls deflected (San Diego Sheriff/Hyper up to 20%; Jefferson County CO about 40% of administrative calls). Cost of goods: Retell at roughly $0.11 per minute plus $8 per concurrent line per month.
2. **Crisis capacity rides the 911 surcharge.** California's 911 surcharge is 41 cents per access line in 2026 across about 47.5 million lines; the account expects $215 million in 2026-27; the budget added $141.9 million one-time for NG911 with the LA region prioritized before 2028. Revenue and Taxation Code 41136 lets the account pay for NG911 and the technologies and interfaces needed to send information, including alerts and warnings, to potential 911 callers. Federal backstop: EMPG FY2026 ($337 million, opened June 15) and BRIC (terminated April 2025, restored by court order December 2025, reopened March 25, 2026 with $1 billion, infrastructure only). Next money: CEC GFO-26-501 wildfire-resilient grid solicitation closes Nov 20, 2026; SBIR reauthorized through 2031.
3. **The household device rides the utility's wildfire budget.** SCE's Critical Care Backup Battery program already gives a free portable battery and solar panel to Medical Baseline customers in high fire risk areas, and SCE's resiliency kits already include small devices like a pre-charged phone battery. The eHawk is the next line in that kit. Everyone else buys retail (price unstated until sourced).

**Build change.** Every call is tagged Tuesday or Crisis in the packet. The supervisor board carries a live cost meter (Retell cost per call, dispatcher minutes saved, billing stream). A funded-capacity governor flips the ladder to text-back and callback when the queue exceeds paid concurrency instead of returning a busy signal. Logged in the twist log with a screenshot as proof.

---

## 12. Training and the future (say it carefully)

- Version 1 ships hand-set defaults and a curated catalog. The event log is the labeled dataset.
- Each county calibrates on its own history under a data agreement: baselines and thresholds per zone (what Section 10.1 does for LAPD), trigger-phrase recognition in its callers' languages and place names, and kit selection from operator overrides (every human swap is a label).
- Never trained: card text, the never-automate list, dispatch decisions.
- Say "trained on each county's own call history under a data agreement," not "on recorded 911 calls." Recordings carry health and identity information, access rules vary by state, and LA's own reviewers could not compel LAPD's dispatch data.
- The honest caveat: Copenhagen trained on real calls, the model beat dispatchers at spotting cardiac arrest (84.5% sensitivity, 97.1% specificity live), and the randomized trial (Blomberg et al., JAMA Network Open 2021) still showed no improvement in dispatcher recognition. Training is calibration and support, never a claim that outcomes improve.

---

## 13. Demo plan (fail-safe)

Five minutes including demo. Order: 0:30 the problem (the fourteen calls), then the handshake, then the call, then the twist log, then where it goes.

**Indispensable (build and rehearse first):** the airplane-mode handshake, and one live call that produces a packet on the board with Interpreter Mode shown for twenty seconds. **Should have:** the bleeding call with transfer plus card, and the SAME decode. **Cut without regret if time runs out:** everything else below. Six live segments in five minutes is too many; the backup video carries what the stage does not.

1. **Handshake first.** Phone in airplane mode, 30 to 50 cm from the laptop speaker, fixed volume, app in the foreground, screen on. Laptop plays the signed packet; phone shows the directive and "signature valid." Second phone ready. Rehearsed in the venue.
2. **Alert path.** Recorded SAME burst into samedec on the laptop; decoded header on screen; re-voiced in Spanish; chirped to the phone. Labeled "radio chip on order."
3. **Call to packet to map.** Board pre-seeded with 20 scripted calls. One live call in Spanish to the Retell line; the four fields appear; the packet lands; three quiet water-pressure calls surface as one flag while the frantic single caller stays damped.
4. **Interpreter Mode.** Dispatcher joins the live call with a headset, speaks English, caller hears Spanish; caller's Spanish renders as English live.
5. **Bleeding call.** Scripted call says "bleeding badly"; EH-BLEED-001 appears on the phone while the warm transfer starts. Both, never one.
6. **Twist log** and cost meter on screen for ten seconds.
7. **Backup video for every segment**, recorded tonight. Hardware misbehaving is expected; the Hub says a backup video is just as fine.

Devpost needs: name, lens, one line, deck (10 slides cap), demo video under 3 minutes showing the Retell and Bob prompts, repo, teammates, responsible-use note. Finalists' deck due Sunday 9 AM.

---

## 14. Claims

**Make these.**
1. Every caller gets an answer in their language, and dispatchers see only the calls that need a person.
2. Many quiet reports become one visible pattern on a map, and a dispatcher can speak to any caller in any language without waiting for an interpreter.
3. The household device hears NOAA alerts without cell service and speaks them in your language.
4. Sound carries a signed alert the last few feet to a phone with the app open, with no network and no pairing, even in airplane mode.
5. On real LA data, a Palisades reporting district went from under one incident a day to eight in fifteen minutes at 7 PM on January 7, while the area-level average barely moved.

**Never make these.**
- That EchoHawk replaces 911 or is a 911 line. It is an overflow and non-emergency layer behind the PSAP.
- That it invented triage or that nobody does cross-call detection (Hexagon markets similarity alerts inside CAD; MPDS/ProQA and LAFD's LA-TDS already prioritize calls one at a time).
- That faster intake would have saved Altadena. FSRI says the communication shortcomings did not drive the tragedy.
- That AI improves outcomes (Blomberg RCT).
- That acoustic beacons cover a city or find people under rubble.
- Any battery-life, unit-cost or death-count number not sourced.
- That 547,287 LAPD calls in 2024 were "unanswered emergencies" (the gap includes hang-ups and repeat dials).

**Responsible-use note (two lines).** Misuse: a spoofed chirp or fake directive, or an at-risk list leaking. Limits: signed packets with a replay window, the AI never orders evacuations or dispatches units or writes a medical step, and opt-in lists stay minimal and deletable.

---

## 15. Build order (now to 10 PM) and repo layout

**Order.** (1) Retell account, credit, KYC started. (2) Bob scaffolds the repo from this spec; provisioning script; websocket server with the LLM loop; webhook receiver with signature check. (3) Packetizer and event log. (4) Corroboration engine on seeded packets; supervisor board. (5) Dispatcher console: transcripts, then Interpreter Mode. (6) Resident app with three kits offline, check-in, beacon. (7) Handshake and alert path (ggwave or Waver, samedec). (8) Twist responses as build changes, logged. (9) Record backup videos. (10) Devpost by 9:30 PM.

```
echohawk/
  server/          websocket loop, llm, translate, packetizer, webhooks, engine, eventlog, provision_retell.py
  console/         dispatcher console (transcripts, interpreter mode, kits, transfer)
  board/           supervisor board (ranked list, map, panels, twist log, cost meter)
  app/             resident PWA (kits offline, check-in, beacon, contacts, web call)
  kits/            catalog.json + source registry + cards (original wording, links)
  device/          ESP32 sketch stub, SAME decode harness, chirp encoder, LoRa mock node
  data/            LAPD and Montgomery outputs, synthetic call scripts, SAME test audio
  docs/            BUILD_SPEC.md, twist_log.md, responsible_use.md, prompts.md (Retell and Bob prompts for the video)
```

**Bob's role (for the IBM prize).** Scaffold the repo, generate and audit `provision_retell.py`, the websocket server, the engine, and the event log; run its security scan on signature verification and the replay window; generate API docs. Keep every Bob prompt in `docs/prompts.md`; the demo video must show prompts for both tools. Keep secrets out of prompts.

---

## 16. What we could not verify (keep this list in the deck appendix)

- The exact SaTScan parameters in Jasso et al. 2009 (radius, window, replications, cutoff). Only the 2007 hotspot paper's 1 km / 10 minutes / 10 calls and "one day's worth of data per run" are known.
- Whether RD 0802 and 0823 are Pacific Palisades (check the LAPD RD polygon layer).
- LA County's current threshold language list; NG911 and Text-to-911 status in LA City and County.
- Retell warm transfer from a custom LLM server; native mobile SDK; extraction accuracy; independent latency.
- iOS and Android background microphone rules for the beacon; battery cost of listening; locked-screen transmit.
- WEA local decoding; FCC and NWS rules on third-party re-voicing; whether LA-area NWR carries Spanish.
- 915 MHz Part 15 details, node and solar costs, urban LA LoRa range.
- All eHawk battery-life and unit-cost figures.
- Montgomery County spread events against news dates (likely matches, unconfirmed).
- Red Cross Safe and Well's current status; Apple Emergency SOS questionnaire details.

---

## Sources (primary where available)

LAPD Communications Division fact sheet (Oct 30, 2025); LA City Council motion 23-0255-S1 (April 22, 2025); Cal OES 9-1-1 Operations Manual; NENA-STA-020.1-2020 and STA-020.2-2026; Mother Jones / Type Investigations (Sept 2026); LACoFD January 2025 dispatch statistics; UL FSRI Phase One and Phase Two reviews (via NBC News, Fire Engineering); McChrystal Group After Action Review (Sept 2025) and LA County synopsis; Rep. Judy Chu letter (Sept 29, 2025); LA County statement on erroneous alerts (Jan 10, 2025); congressional report on the Kenneth Fire alert (May 2025, via Spectrum News and NBC LA); CNN analysis (Jan 16, 2025); Citygate Woolsey After Action Review (2019); Meischke et al., Prehospital Emergency Care (2013); GAO-26-107680 (Jan 2026); FCC DIRS reports (Maria, Helene, PSPS 2019); Maui County lawsuit filings (via PBS/AP); Jasso, Hodgkiss, Baru, Fountain, Reich, Warner, Government Information Quarterly 26(2) 2009 and dg.o 2008; Jasso et al., "Spatiotemporal Characteristics of 9-1-1 Emergency Call Hotspots," NGDM 2007; SDSC release (Feb 12, 2008); Kulldorff et al., PLoS Medicine 2005; Haas et al., Int J Health Geographics 2011 and EPA 817-R-14-001E (Cincinnati pilot); Sakaki, Okazaki, Matsuo, WWW 2010; Riou et al. 2018; Ball et al. 2018; Berdowski et al., Circulation 2009; Blomberg et al., JAMA Network Open 2021; Crisis Text Line published findings; City of Dallas v. Sanchez (Tex. 2016); Motorola patent US 10742809; RapidSOS patent family US 10861320; Putz et al., ACM Transactions on IoT 7(1) 2026 (arXiv 2602.02249); ggwave author statements (Hackster, Hacker News); NWS Instruction 10-1712; Silicon Labs Si4707 documentation; Meshtastic documentation; FAA and AT&T Flying COW coverage (Nov 2017); Retell AI documentation (custom LLM websocket, custom functions, webhooks, transfer, post-call analysis, pricing); CDTFA 2026 surcharge notice; Cal OES access line letter CY2026; California Senate Budget Subcommittee (March 5, 2026); Cal OES NG911 fact sheet (May 2026); Revenue and Taxation Code 41136; SCE PSPS customer care fact sheet (2026); JD Supra on BRIC FY24-25 NOFO; InnovateLA Participant Hub and Builder's Kit; LA City open data xjgu-z4ju; Kaggle Montgomery County 911 dataset.
