// EchoHawk personal device (eHawk tag), Wi-Fi version: same button, same signed 16-byte SOS frame as the Bluetooth
// version, but the chip posts it straight to the EchoHawk server over the internet. No laptop page, no Bluetooth.
//
//   Press BOOT (or the external button) -> signs an SOS frame and POSTs it to <SERVER_URL>/device/packets
//                                          with channel "wifi", repeating every 5 s until the server confirms.
//   Server confirms                      -> the server returns its signed "delivered to dispatch" receipt; the chip
//                                          checks the signature, the LED goes solid and the relay clicks twice.
//   Server refuses (bad signature)       -> LED blinks slowly; check FRAME_KEY in secrets.h.
//   Hold BOOT for 3 s                    -> cancel.
//
// The board shows it like any other SOS: "needs a person", heard by TAG-01-WIFI over wifi.
//
// Setup: copy secrets.example.h to secrets.h in this folder and fill it in (secrets.h is git-ignored).
// Wi-Fi: the ESP32 joins 2.4 GHz networks only. On an iPhone hotspot turn on Maximize Compatibility. Networks with a
// sign-in page (captive portal) will not work.
// Build: Arduino IDE 2.x, "esp32 by Espressif Systems" 2.x or 3.x, board "ESP32 Dev Module", Serial Monitor 115200.
// Wiring: same as the Bluetooth version (relay IN -> GPIO 26, optional button GPIO 4 -> GND).

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "mbedtls/md.h"
#include "mbedtls/base64.h"
#include "secrets.h"   // WIFI_SSID, WIFI_PASS, SERVER_URL, FRAME_KEY

// ---------- settings ----------
static const char *TAG_ID = "TAG-01-WIFI";   // shows on the board as the node that heard it
static const uint16_t ZONE = 6;              // demo zone Z06 (LAPD reporting district 0812 on the board)
static const uint8_t LANG = 0;               // 0 en, 1 es, 2 ko, 3 zh, 4 tl, 5 hy, 6 vi, 7 fa, 8 ru, 9 ar, 10 ja, 11 hi, 12 th, 13 uk, 14 yue
static const int PIN_BUTTON = 0;             // BOOT button
static const int PIN_BUTTON_EXT = 4;         // optional external button to GND
static const int PIN_LED = 2;
static const int PIN_RELAY = 26;
static const bool RELAY_ACTIVE_LOW = true;
static const uint32_t REPEAT_MS = 5000;

// frame codes (device/frame.js)
static const uint8_t TYPE_SOS = 2, TYPE_ACK = 3;
static const uint8_t TARGET_PERSON = 9;
static const uint8_t ACTION_DISPATCH_EMS = 1;

// ---------- state ----------
bool sosActive = false;
bool refused = false;
uint16_t sequence = 0;
uint32_t lastSendMs = 0;
uint8_t stage = 0;   // 0 sending, 2 delivered

// ---------- crypto (identical to the Bluetooth version) ----------
void hmac40(const uint8_t *data, size_t len, uint8_t out5[5]) {
  uint8_t full[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, (const unsigned char *)FRAME_KEY, strlen(FRAME_KEY), data, len, full);
  memcpy(out5, full, 5);
}

void buildSos(uint8_t f[16]) {
  const uint32_t minutes = 0;                       // the server does not need the time stamp to verify
  f[0] = (1 << 4) | TYPE_SOS;
  f[1] = ZONE >> 8; f[2] = ZONE & 0xff;
  f[3] = (TARGET_PERSON << 4) | 5;                  // severity 5
  f[4] = (ACTION_DISPATCH_EMS << 4) | (LANG & 0x0f);
  f[5] = minutes >> 24; f[6] = (minutes >> 16) & 0xff; f[7] = (minutes >> 8) & 0xff; f[8] = minutes & 0xff;
  f[9] = sequence >> 8; f[10] = sequence & 0xff;
  hmac40(f, 11, f + 11);
}

bool verifyAck(const uint8_t f[16]) {
  if ((f[0] & 0x0f) != TYPE_ACK) return false;
  uint8_t mac[5]; hmac40(f, 11, mac);
  if (memcmp(mac, f + 11, 5) != 0) { Serial.println("receipt: signature invalid, ignored"); return false; }
  uint16_t seq = (f[9] << 8) | f[10];
  return seq == sequence;
}

// ---------- outputs ----------
void relay(bool on) { digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }
void clickRelay(int times) { for (int i = 0; i < times; i++) { relay(true); delay(180); relay(false); delay(180); } }
void led(bool on) { digitalWrite(PIN_LED, on ? HIGH : LOW); }

// ---------- network ----------
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  static uint32_t lastTry = 0;
  if (lastTry && millis() - lastTry < 10000) return;
  lastTry = millis();
  Serial.printf("joining Wi-Fi \"%s\"...\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// returns the HTTP status (or a negative HTTPClient error); fills ack when the server sent a 16-byte receipt
int postSos(const uint8_t f[16], uint8_t ack[16], bool &gotAck) {
  gotAck = false;
  unsigned char b64[32]; size_t olen = 0;
  mbedtls_base64_encode(b64, sizeof(b64) - 1, &olen, f, 16); b64[olen] = 0;
  String body = String("{\"node_id\":\"") + TAG_ID + "\",\"channel\":\"wifi\",\"frame_b64\":\"" + (const char *)b64 + "\"}";
  String url = String(SERVER_URL) + "/device/packets";

  HTTPClient http;
  WiFiClientSecure tls;
  WiFiClient plain;
  if (url.startsWith("https")) { tls.setInsecure(); http.begin(tls, url); }   // demo: no certificate pinning
  else http.begin(plain, url);
  http.addHeader("content-type", "application/json");
  http.setTimeout(8000);
  int code = http.POST(body);
  String resp = code > 0 ? http.getString() : String(http.errorToString(code));
  http.end();
  Serial.printf("POST /device/packets -> %d %s\n", code, resp.substring(0, 160).c_str());

  int i = resp.indexOf("\"ack_b64\":\"");
  if (i >= 0) {
    i += 11; int j = resp.indexOf('"', i);
    String a = resp.substring(i, j); size_t n = 0;
    if (mbedtls_base64_decode(ack, 16, &n, (const unsigned char *)a.c_str(), a.length()) == 0 && n == 16) gotAck = true;
  }
  return code;
}

void sendSos() {
  lastSendMs = millis();
  if (WiFi.status() != WL_CONNECTED) { Serial.println("SOS waiting for Wi-Fi"); return; }
  uint8_t f[16], ack[16]; bool gotAck = false;
  buildSos(f);
  Serial.printf("SOS #%u -> %s\n", sequence, SERVER_URL);
  int code = postSos(f, ack, gotAck);
  if (code == 400) { refused = true; Serial.println("server refused the frame: FRAME_KEY in secrets.h must equal ECHOHAWK_FRAME_KEY in the server .env"); return; }
  if ((code == 200 || code == 201) && gotAck && verifyAck(ack)) {
    stage = 2;
    Serial.println("RECEIPT: delivered to dispatch (signed by the server).");
    led(true); clickRelay(2);
  }
}

void startSos() {
  sequence = (uint16_t)(esp_random() & 0xffff);   // one emergency = one sequence; repeats keep it so the server counts it once
  sosActive = true; refused = false; stage = 0;
  Serial.println("SOS started");
  sendSos();
}

void cancelSos() { sosActive = false; refused = false; stage = 0; led(false); relay(false); Serial.println("SOS cancelled"); }

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BUTTON_EXT, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT); led(false);
  pinMode(PIN_RELAY, OUTPUT); relay(false);
  WiFi.mode(WIFI_STA);
  ensureWifi();
  Serial.printf("%s ready. Press BOOT for SOS, hold 3 s to cancel. Server: %s\n", TAG_ID, SERVER_URL);
}

uint32_t pressedAt = 0;
bool wasConnected = false;
void loop() {
  ensureWifi();
  bool nowConnected = WiFi.status() == WL_CONNECTED;
  if (nowConnected && !wasConnected) Serial.printf("Wi-Fi connected, IP %s\n", WiFi.localIP().toString().c_str());
  wasConnected = nowConnected;

  bool pressed = digitalRead(PIN_BUTTON) == LOW || digitalRead(PIN_BUTTON_EXT) == LOW;
  if (pressed && !pressedAt) pressedAt = millis();
  if (!pressed && pressedAt) {
    uint32_t held = millis() - pressedAt; pressedAt = 0;
    if (held > 3000) cancelSos();
    else if (held > 40 && !sosActive) startSos();
  }

  if (sosActive && stage == 0) {
    if (refused) led((millis() / 600) % 2);                        // slow blink: server refused, check the key
    else {
      led((millis() / 150) % 2);                                   // fast blink: sending
      if (millis() - lastSendMs > REPEAT_MS) sendSos();            // repeat until the server confirms
    }
  }
  delay(10);
}
