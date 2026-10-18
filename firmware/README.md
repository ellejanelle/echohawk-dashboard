# eHawk tag firmware (personal device demo)

Board: classic ESP32 dev board (ESP32-WROOM-32, "ESP32 Dev Module" in Arduino IDE). Needs the "esp32 by Espressif Systems" boards package.

1. Open `ehawk_tag/ehawk_tag.ino` in Arduino IDE 2.x, board "ESP32 Dev Module", upload, Serial Monitor at 115200.
2. Wire the relay: IN to GPIO 26, VCC to 5V/VIN, GND to GND. (If the relay is on when it should be off, set `RELAY_ACTIVE_LOW` to false.)
3. On the laptop running EchoHawk, open `http://localhost:8787/node` in Chrome, press **Connect an eHawk tag by Bluetooth**, pick `EchoHawk-Tag-01`.
4. Press **BOOT** on the ESP32. LED blinks fast while it looks for a node; goes solid on receipt 1 (picked up); relay clicks twice on receipt 2 (delivered to dispatch). The board shows the SOS as "needs a person, picked up by N-0812-A over Bluetooth". Hold BOOT 3 s to cancel.

Not compiled in our cloud workspace (the toolchain download is blocked there); compile on a team laptop. The frame bytes and receipt check were verified against the server by an emulation of `buildSos()` and `verifyAck()`.
