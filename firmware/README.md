# eHawk tag firmware (personal device demo)

Board: classic ESP32 dev board (ESP32-WROOM-32, "ESP32 Dev Module" in Arduino IDE). Needs the "esp32 by Espressif Systems" boards package.

1. Open `ehawk_tag/ehawk_tag.ino` in Arduino IDE 2.x, board "ESP32 Dev Module", upload, Serial Monitor at 115200.
2. Wire the relay: IN to GPIO 26, VCC to 5V/VIN, GND to GND. (If the relay is on when it should be off, set `RELAY_ACTIVE_LOW` to false.)
3. On the laptop running EchoHawk, open `http://localhost:8787/node` in Chrome, press **Connect an eHawk tag by Bluetooth**, pick `EchoHawk-Tag-01`.
4. Press **BOOT** on the ESP32. LED blinks fast while it looks for a node; goes solid on receipt 1 (picked up); relay clicks twice on receipt 2 (delivered to dispatch). The board shows the SOS as "needs a person, picked up by N-0812-A over Bluetooth". Hold BOOT 3 s to cancel.

Not compiled in our cloud workspace (the toolchain download is blocked there); compile on a team laptop. The frame bytes and receipt check were verified against the server by an emulation of `buildSos()` and `verifyAck()`.

## Key (both versions)

Each sketch folder needs a `secrets.h` (git-ignored). Copy `secrets.example.h` to `secrets.h` and set `FRAME_KEY` to the
server's `ECHOHAWK_FRAME_KEY`. If the keys differ, the server rejects every press. Send `secrets.h` to whoever flashes the
chip directly (AirDrop or DM), never through GitHub.

## Wi-Fi version (no laptop page): `ehawk_tag_wifi/`

Button → Wi-Fi → `SERVER_URL/device/packets` → board. The chip posts the same signed SOS frame with channel `wifi` and
node `TAG-01-WIFI`, repeats every 5 s until the server answers, then checks the server's signed receipt.

1. In `ehawk_tag_wifi/secrets.h` set `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL` (the server's public https URL, the
   Cloudflare tunnel; update it whenever the tunnel restarts) and `FRAME_KEY`.
2. Upload as above, Serial Monitor 115200. It prints the IP once it joins Wi-Fi.
3. Press BOOT. Fast blink while sending; solid LED and two relay clicks when the server confirms ("delivered to
   dispatch"); slow blink means the server refused the frame (wrong key). Hold 3 s to cancel.

Wi-Fi limits: 2.4 GHz only (iPhone hotspot: turn on Maximize Compatibility); networks with a sign-in page do not work.
The server side was tested with this exact byte layout (201 "needs a person", repeat counted once, receipt verifies,
tampered frame 400). The sketch itself has not been compiled yet.
