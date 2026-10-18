# EchoHawk: Devpost draft and video script

Everything here stays inside the claims list (BUILD_SPEC section 14). Fill the four bracketed fields before submitting.

## Fields

- **Name:** EchoHawk
- **Lens:** Resilience Comms (Retell AI)
- **One line:** EchoHawk is an AI intake and corroboration layer for LA's overloaded 911 and non-emergency lines, plus a household box that keeps alerts flowing in your language when the towers die.
- **Repo:** [GitHub URL]
- **Video:** [YouTube or Loom URL, under 3 minutes]
- **Deck:** [10-slide PDF]
- **Teammates:** [names and Devpost handles]
- **Built with:** Retell AI (custom LLM websocket, Interpreter Mode via agent_interrupt), IBM Bob, Claude, Node 20, React, Vite, TypeScript, Leaflet, ggwave, LAPD Calls for Service open data

## Inspiration

On January 8, 2025, LA County Fire dispatch took 4,594 inbound 911 calls. The state-commissioned FSRI review found calls arrived faster than dispatch could assign them, and at least 14 reports of fire west of Lake Avenue reached dispatch before the 3:25 AM evacuation order. Each call was handled one at a time. Nobody saw the fourteen as one pattern.

On an ordinary Tuesday, the same LAPD operators answer emergency and non-emergency lines, and non-emergency callers waited 3:40 on average in 2024.

## What it does

- **Answers the overflow.** A Retell voice agent picks up when the line is full, says up front that it is automated and that a person can join any time, and listens in 15 languages common in LA County (English, Spanish, Mandarin, Cantonese, Korean, Tagalog, Armenian, Vietnamese, Farsi, Russian, Arabic, Japanese, Hindi, Thai, Ukrainian). It pulls four fields from every call: zone, what is affected, how bad, and what is needed. Cantonese callers are recognized and flagged for a human interpreter.
- **Hands life threats to a person immediately.** Phrases like "she's sort of breathing" or "bleeding badly" trigger a transfer within one turn. The AI never orders an evacuation, never dispatches a unit and never writes a medical step; reviewed Action Kits are read verbatim or not at all.
- **Turns many quiet calls into one pattern.** The corroboration engine counts independent callers separately from repeat dials and machine sources, links the same problem across neighboring districts as a spreading line, and flags a district when its 15-minute volume is unusual against its own LAPD baseline. On real LAPD data, reporting district 0802 in the Palisades went from under one incident a day to eight in fifteen minutes at 7 PM on January 7, 2025.
- **Lets a dispatcher speak any of those languages now.** From the console or the supervisor board, a dispatcher can listen to a live AI call, join as interpreter (types English, the caller hears their own language, the caller's words appear in English), or take the call over.
- **Sorts every channel the same way.** App check-ins and chirps go through the same triage as calls. A resident who marks "emergency" is held at a middle priority until danger words or other callers back it up, so a cat in a tree cannot jump the line; fire, gas, downed lines and floods keep what the resident said.
- **Follows the call after dispatch.** Units move assigned, en route, on scene, cleared, with watchdog timers that flag a unit that sits too long. Incidents close with a disposition code; "unable to locate" schedules a callback. Residents who reported through the app see "a unit is on the way." A crew already out is offered nearby calls it can also clear (a utility crew on a water call takes the power call next door), so limited units cover more; a call that needs a person always gets its own unit.
- **Sends public alerts back, from the right people.** Alerting agencies (County OEM, Sheriff, Fire, LAPD, LAFD, City EMD) sign in to their own console. Evacuation orders, warnings and shelter in place need a second person to approve before they go out, which matches how LA County sent the January 2025 alerts. The EchoHawk supervisor can send advisories ("crews are on it, no need to call") and request a protective action. Residents get the alert in their own language, read aloud, with "I'm safe / I've left / I need help." "I need help" lands on the board as a call that needs a person.
- **Carries the last few feet with no network.** A signed 16-byte directive plays as sound; a phone in airplane mode verifies the signature and rejects replays. The eHawk household box is the off-grid stand-in for a weather radio that speaks your language. When pole-mounted nodes relay a chirp, the same chirp heard by three nodes counts as one report, and the nodes that heard it narrow where it came from (simulated nodes in the demo).
- **Gives planners context and gives data back.** The map can shade districts by past dispatched calls of one type (violence, domestic violence, robbery, burglary, medical) from 55 days of LAPD data, labeled as calls, not confirmed crimes. A research export gives one row per incident (channels, time to first unit, time on scene, outcome) with no phone numbers, device ids or transcripts.

## How we built it

IBM Bob scaffolded the repo from our spec and wrote most of the server modules and tests from scoped prompts (`docs/prompts.md`, evidence in `docs/BOB_LOG.md` with tests before and after and commit shas). Claude handles extraction, replies and translation inside the Retell custom LLM websocket, so our server owns every turn, the triggers and the transfer decision. The screens are React and TypeScript on Vite. The engine, triggers and frame format have 97 automated tests, including a fake Retell client driving a real websocket.

## Challenges

- Retell has no single voice that covers both Cantonese and Armenian, and no speech recognition for Khmer. We chose the languages Retell's recognition covers and flag the rest for a human interpreter instead of pretending.
- Who may send an evacuation order. We read how LA County actually sent the Eaton and Palisades alerts and built the approval rule around it rather than letting a call-center supervisor push one.
- Sound is hard outdoors. Our mentor's first question was street noise; the answer is in What's next, and the demo keeps the claim to about one meter.
- Keeping the AI from claiming more than it knows: alarms never count as people, a single frantic caller stays damped, and a confidence number is labeled as a heuristic on screen.

## What's next

- Pilot behind a non-emergency line, with unit status coming from the agency's CAD instead of being tapped in.
- Nodes on public poles, solar powered, relaying by sound first (it bends around buildings) and radio as the backup where there is line of sight.
- Street noise: record real sound at node sites, generate synthetic variants for wind, weather, season and time of day, and keep retraining on real data as nodes go live. We will report how much of the training set is real.
- A wearable personal device (clip, rechargeable, wakes on its name) for when a phone is out of reach.
- Funding: EchoHawk is dual use (the same off-grid path works where troops have no phone network), which fits SBIR/STTR, reauthorized in April 2026 through September 30, 2031.

## Responsible use

Misuse: a spoofed chirp or fake directive, a fake public alert, or an at-risk list leaking. Limits: signed packets with a replay window; protective-action alerts need two agency people; the AI never orders evacuations, dispatches units or writes a medical step; it is not Wireless Emergency Alerts and does not replace 911; opt-in lists stay minimal and deletable.

## Not claimed

EchoHawk does not replace 911, did not invent triage (Hexagon and MPDS already prioritize calls), does not claim AI improves outcomes (Blomberg et al., 2021), and does not claim faster intake would have saved Altadena (FSRI says communication shortcomings did not drive the tragedy).

---

# Demo video script (2:50)

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 | Black, then "4,594 calls. January 8, 2025." | "The night of the Eaton Fire, county dispatch took 4,594 calls. At least fourteen reported fire west of Lake Avenue before the evacuation order. Each one was handled alone." |
| 0:15 | `/replay` chapter 2, RD 0802 lighting up | "On real LAPD data, one Palisades district went from under one incident a day to eight in fifteen minutes. EchoHawk flags it at the third ring." |
| 0:30 | Board, Run demo surge, alerts drop in top right | "EchoHawk answers the overflow. Many quiet water calls become one spreading line. Five alarms stay alarms. Two medical calls go straight to a person." |
| 0:55 | Phone dials the Retell number; greeting plays | "The agent says it's automated and a person can join any time." |
| 1:05 | Console, live Spanish call, Join interpreter, type English | "A dispatcher types English. The caller hears Spanish. The caller's Spanish shows in English." |
| 1:25 | Board, expand row, Send Utility, En route, tap "+ Water, District 0813"; phone shows "A unit is on the way" | "After dispatch, units carry timers, one crew can take the call next door, and the resident who reported sees help is coming." |
| 1:45 | `/alerts`, two sign-ins, Approve and send; phone shows the warning in Spanish, taps "I need help" | "Evacuation warnings come from the agencies, with a second person approving. Residents answer, and anyone who needs help lands on the board." |
| 2:10 | Phone in airplane mode, laptop chirps, "signature valid"; board, Chirp relay, row shows "heard by 3 nodes" | "When the towers die, a signed alert travels the last few feet as sound, and one chirp heard by three nodes counts once." |
| 2:25 | Bob terminal and `docs/BOB_LOG.md`; Retell dashboard agent page | "IBM Bob built the server from our spec. Retell carries the voice, and our server owns every turn." |
| 2:40 | Logo, one line | "Fourteen calls, one fire, no flag. EchoHawk turns the flood into the sensor." |
