# eHawk tag: what the person flashing the chip needs

Send this folder (`firmware/`) only. The dashboard code is not needed on the chip.

**Server address:** `SERVER_URL` is the EchoHawk server's public https address (live on Railway).

```
SERVER_URL = https://echohawk-production-505f.up.railway.app   (no trailing slash)
FRAME_KEY  = dev-frame-key
```

## Your sketch (`relay_node/relay_node.ino`): point it at the server, nothing else changes

The server now speaks your WebSocket protocol (`relay_node/PROTOCOL.md`) at `wss://echohawk-production-505f.up.railway.app/node`.
The copy in `relay_node/` already has `DASH_HOST`, `DASH_PORT 443` and `DASH_USE_SSL true` set; fill in `WIFI_SSID` and
`WIFI_PASS` (2.4 GHz, no sign-in page) and upload. Hold the D32 wire to GND 1.5 s: the alert lands on the board as
"needs a person, picked up by echohawk-01 over wifi", the server acks, the relay clicks and the LED goes solid. Hold again
within 10 s: the incident is marked "sender cancelled" (a person closes it on the board). Audio frames are answered with
`stop_audio`; this build does not store audio.

## No Wi-Fi? Keep your sketch, add the USB bridge

If the chip already prints a line over USB when the wire is held (and another when it is held longer to cancel), you do
not need to reflash it. A small script on the laptop the chip is plugged into reads those lines and sends the signed SOS
to the server; the server's receipt is written back over the same cable.

1. Close Arduino's Serial Monitor (only one program can hold the USB port).
2. In the repo folder: `npm install serialport`
3. Run it, with the words your sketch prints for alert and cancel:
   ```
   ALERT_MATCH="SOS|ALERT" CANCEL_MATCH="CANCEL" node scripts/usb_bridge.mjs
   ```
   (`SERIAL_PORT=/dev/cu.usbserial-0001` or `COM5` if it picks the wrong port; `BAUD=` if the sketch is not 115200.)
4. Hold the wire. The terminal prints `on the board: incident inc_…`, and the row appears on the dashboard without a
   refresh. Hold to cancel: the incident is marked "sender cancelled"; a person closes it on the board.

Device identity: if the sketch prints the chip's MAC at boot (`Serial.println(WiFi.macAddress());`), the bridge uses it
as the device id, and the board shows `TAG-<mac>`. Otherwise set `DEVICE_ID=tag01`.

## Two sketches, pick one per chip (there is no automatic fallback between them)

| Folder | Path | Needs |
|---|---|---|
| `ehawk_tag/` | button → Bluetooth → laptop with `SERVER_URL/node` open in Chrome → server | a laptop near the tag |
| `ehawk_tag_wifi/` | button → Wi-Fi → `SERVER_URL/device/packets` → server | a 2.4 GHz Wi-Fi network with no sign-in page |

## Steps

1. Arduino IDE 2.x with the "esp32 by Espressif Systems" boards package. Board: **ESP32 Dev Module**. Serial Monitor 115200.
2. In the sketch folder, copy `secrets.example.h` to `secrets.h` and fill it in:
   - both: `FRAME_KEY` = the value the server owner gives you (it must equal the server's `ECHOHAWK_FRAME_KEY`;
     the server refuses every press if they differ). Never commit `secrets.h`.
   - Wi-Fi sketch: `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL` from above.
3. Wire the relay: IN → GPIO 26, VCC → 5V/VIN, GND → GND. Optional external button: GPIO 4 → GND.
4. Upload. Press BOOT (or the external button) for SOS; hold 3 s to cancel.

## What you should see

- Fast blink: sending. Solid LED: picked up (Bluetooth, receipt 1). Two relay clicks: delivered to dispatch (receipt 2).
- Slow blink (Wi-Fi sketch): the server refused the frame; `FRAME_KEY` is wrong.
- The incident appears on `SERVER_URL/board?token=...` within a second or two, without refreshing.

Neither sketch has been compiled by the authors yet; the first build is on your laptop. If it errors, send the
full error text back.
