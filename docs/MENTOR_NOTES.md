# Mentor session 1 (Oct 17, 2026): feedback and what we did with it

Source: 37-minute recording with our mentor (a veteran building an acoustic anti-drone system). Machine transcript kept outside the repo.

## Built into the product

| Mentor said | What we built | Where |
|---|---|---|
| Units are limited; one resource can be routed to solve several problems nearby (4:13) | Board offers each unit already out the nearby calls it can also clear (same or next district, a type it covers). One tap adds the stop. A call that needs a person always gets its own unit. | `server/units.js` nearbyFor, addStop; board "Units in the field" |
| People will use the app for a cat in a tree; prioritizing has to happen on our side, not the user's (11:20) | App and eHawk reports marked above 3 are held at 3 until danger words or other callers back them up. Fire, gas, downed lines and floods keep what the resident said. The board shows "self-reported 5, held at 3". | `server/triage.js` |
| One chirp may hit three nodes at once; you need a protocol so it is not counted three times, and the system can narrow the location from which nodes heard it (15:01 to 17:14) | Same frame from several nodes within 10 minutes is one report with a heard_by list; the board shows the area covered by those nodes and draws it on the map. Demo nodes are simulated. | `server/relay.js`; board "Chirp relay" |
| Add a GIS layer of historical hot spots: violence, domestic violence, robbery (35:38) | Map "History" selector shades districts by past dispatched LAPD calls of one type over 55 days (fire week excluded). Labeled as calls, not confirmed crimes. | `data/history_by_rd.json`, `scripts/history_by_rd.py` |
| The data EchoHawk gathers is valuable; let it grow and feed research (34:37) | Research export, one row per incident: channels, time to first unit, time on scene, outcome. No phone numbers, device ids or transcripts. | `GET /research/export.csv` |

## Into the pitch and roadmap (not built)

- **Hardware is the weakest part; acoustic noise is the hard problem.** Answer before judges ask: record real street sound at node sites, generate synthetic variants (wind, weather, season, time of day), retrain as live nodes collect real data. Say "physics-based." Expect military buyers to ask what share of training data is synthetic; report it.
- **Nodes on public poles, solar powered**, not on houses (people won't mount things on their homes).
- **Sound first, radio as backup.** Radio needs line of sight in a city; sound diffracts around buildings.
- **Personal device:** rechargeable, no screen, wearable clip, wakes on its name.
- **Privacy pitch:** no ads, no targeting, only listens for its name.
- **Funding:** dual use fits SBIR/STTR. Verified: reauthorized by the Small Business Innovation and Economic Security Act of 2026, signed April 13, 2026, through September 30, 2031 (Mondaq summary). SDVOSB certification brings a 5% governmentwide contracting goal plus set-asides and sole-source eligibility (CRS IF13309). The "10% weighting on SBIR" mentioned in the session is **not verified**; do not put it on a slide.
- Cost numbers from the session (node about $200 to $300, GPS module about $75 to $80) are the mentor's estimates, unverified.

## Claims to keep out of the pitch

Said in the room, still on the never-make list in BUILD_SPEC section 14: city-wide acoustic mesh, finding or locating people under rubble, a wake word that "cannot get it wrong." Keep them as roadmap language at most.
