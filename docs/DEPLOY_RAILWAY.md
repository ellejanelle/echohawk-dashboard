# Deploying EchoHawk to Railway

One always-on Node service, one replica, a persistent volume for the snapshot, a public Railway domain.
`railway.json` in the repo root carries the build and deploy settings (Railpack, `npm ci && npm run build:web`,
`npm start`, health check `/health`, sleeping off, restart on failure). The volume and the variables are set in the
Railway dashboard; config-as-code cannot create them.

This is a hackathon prototype. It is not an emergency service and must not be presented as one.

## 1. Create the service

1. railway.com → New Project → Deploy from GitHub repo → `ellejanelle/echohawk-dashboard`, branch `main`.
2. Open the service → Settings. Confirm: Builder shows Railpack, Build Command `npm ci && npm run build:web`,
   Start Command `npm start`, Healthcheck Path `/health`, Replicas 1, App Sleeping **off**. (These come from
   `railway.json`; set them by hand if the UI shows blanks.)

## 2. Attach the volume

Service → Settings → Volumes → Add Volume → Mount Path `/var/data`. Do **not** mount at `/app/data`:
the repo's `data/` directory holds the baselines and replay files the server reads at boot, and a volume mounted
there would hide them.

## 3. Variables (service → Variables → Raw Editor)

```
DB_PATH=/var/data/db.json
PUBLIC_BASE_URL=https://<your-service>.up.railway.app
ECHOHAWK_FRAME_KEY=<device key; must match FRAME_KEY in the tag's secrets.h and the resident app build>
ECHOHAWK_SALT=<long random string>
DISPATCHER_TOKEN=<random>
SUPERVISOR_TOKEN=<random>
AGENCY_TOKEN=<random>
RESIDENT_LIVE_ENABLED=false
```

Leave `RETELL_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_API_KEY` and `RETELL_AGENT_ID` unset for the public demo:
the server then runs the rule-based script, no paid calls are placed, and the demo buttons use simulated calls.
Railway sets `PORT`; the server listens on it and on `0.0.0.0`.

Generate the random values with `openssl rand -hex 24`. The tokens are the sign-ins for `/board`, `/console`
and `/alerts`, so the links you share carry them: `https://<domain>/board?token=<SUPERVISOR_TOKEN>`.

**About the frame key.** The 16-byte report is signed with one shared HMAC key: the ESP32 tag has it in `secrets.h`,
the resident web app has it compiled in (`web/src/app/frame.ts`), and the server verifies with it. It is a device
key, not a server-private secret, so keep it separate from the tokens and salt above. The `/node` page no longer
needs it: receipt 1 is signed by the server at `POST /device/receipt`. If you change `ECHOHAWK_FRAME_KEY` from the
demo value, change `FRAME_KEY` in `web/src/app/frame.ts` and rebuild, or the phone app's own reports are refused.

## 4. Domain

Service → Settings → Networking → Generate Domain. Copy it into `PUBLIC_BASE_URL` (step 3) and redeploy.
A GoDaddy domain can be added later under Custom Domain (CNAME to the Railway target it shows).

## 5. Verify

```
curl https://<domain>/health            # {"ok":true,...}
open https://<domain>/board?token=...   # loads, then run the signed-SOS check below
node scripts/railway_check.mjs https://<domain> <ECHOHAWK_FRAME_KEY>
```

`scripts/railway_check.mjs` posts a signed SOS, posts it again (duplicate), checks the returned receipt
signature, and confirms the incident is on `/incidents`. Then restart the service (Deployments → ⋮ → Restart)
and reload `/incidents`: the incident must still be there (volume).

## 6. Point the devices at it

- Wi-Fi tag: `SERVER_URL` in `firmware/ehawk_tag_wifi/secrets.h` = `https://<domain>` (no trailing slash).
- Bluetooth tag: open `https://<domain>/node` in Chrome on a laptop near the tag, press Connect.
  Receipt 1 goes back only after the report is saved in the page's outbox; if the server is unreachable the page
  retries every 10 s (also after a reload) and sends receipt 2 once dispatch has it.

## What a hosted move changes

- The dashboard keeps working with the Mac off. The Bluetooth path still needs *a* computer near the tag with
  `/node` open; the Wi-Fi path needs none.
- Retell: `provision_retell.js` must be rerun with the new `PUBLIC_BASE_URL` before live calls can route here.
  Not needed for the simulated demo.
- `POST /demo/call` and `/demo/surge` are open demo endpoints that spawn a simulated call on the server. Fine for
  a demo link; put the tokens on them before any wider exposure.
