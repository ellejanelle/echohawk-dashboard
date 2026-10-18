# eHawk tag: what the person flashing the chip needs

Send this folder (`firmware/`) only. The dashboard code is not needed on the chip.

**Server address:** `SERVER_URL` is the EchoHawk server's public https address (live on Railway).

```
SERVER_URL = https://echohawk-production-505f.up.railway.app   (no trailing slash)
FRAME_KEY  = dev-frame-key
```

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
