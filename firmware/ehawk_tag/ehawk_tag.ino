// EchoHawk personal device (eHawk tag) — demo firmware for a classic ESP32 dev board (ESP32-WROOM-32 / DevKit V1 / NodeMCU-32S).
//
// What it does
//   Press the BOOT button  -> signs a 16-byte SOS frame (same layout and key as device/frame.js) and sends it over Bluetooth LE
//                             to the nearest EchoHawk node, repeating every 5 s until a node picks it up.
//   Node receipt stage 1    -> "picked up by a node": LED goes solid, beacon stops repeating.
//   Node receipt stage 2    -> "delivered to dispatch": relay clicks twice (audible in the dark), LED double-blinks.
//   Hold BOOT for 3 s       -> cancel.
//
// Bluetooth: Nordic UART service (NUS). The tag NOTIFIES frames on TX and receives receipts (and a time sync) on RX.
//   TX 6e400003-...  tag -> node: 16-byte SOS frame
//   RX 6e400002-...  node -> tag: 16-byte signed ack frame, or 'T' + 4-byte minutes-since-2025 time sync
//
// Wiring (everything else is on the dev board):
//   Relay module IN  -> GPIO 26      Relay VCC -> 5V (VIN)      Relay GND -> GND
//   (most blue relay boards switch ON when IN is LOW; set RELAY_ACTIVE_LOW accordingly)
//   Optional external SOS button: GPIO 4 to GND (internal pull-up)
//
// Build: Arduino IDE 2.x with "esp32 by Espressif Systems" (2.x or 3.x). Board: "ESP32 Dev Module". Serial monitor 115200.
// DEMO KEY: "dev-frame-key" matches the server default ECHOHAWK_FRAME_KEY. A real device gets a per-deployment key.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "mbedtls/md.h"

// ---------- settings ----------
static const char *DEVICE_NAME = "EchoHawk-Tag-01";
static const char *FRAME_KEY = "dev-frame-key";
static const uint16_t ZONE = 6;          // demo zone Z06 (LAPD reporting district 0812 on the board)
static const uint8_t LANG = 0;           // 0 en, 1 es, 2 ko, 3 zh, 4 tl, 5 hy, 6 vi, 7 fa, 8 ru, 9 ar, 10 ja, 11 hi, 12 th, 13 uk, 14 yue
static const int PIN_BUTTON = 0;         // BOOT button on the dev board
static const int PIN_BUTTON_EXT = 4;     // optional external button to GND
static const int PIN_LED = 2;            // blue LED on most ESP32 dev boards
static const int PIN_RELAY = 26;
static const bool RELAY_ACTIVE_LOW = true;
static const uint32_t REPEAT_MS = 5000;

#define NUS_SERVICE "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX      "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

// frame codes (device/frame.js)
static const uint8_t TYPE_SOS = 2, TYPE_ACK = 3;
static const uint8_t TARGET_PERSON = 9;
static const uint8_t ACTION_DISPATCH_EMS = 1;

// ---------- state ----------
BLECharacteristic *txChar = nullptr;
volatile bool connected = false;
bool sosActive = false;
uint16_t sequence = 0;
uint32_t minutesSince2025 = 0;   // set by the node's time sync; 0 until then (the server does not need it to verify)
uint32_t lastSendMs = 0;
uint8_t stage = 0;               // 0 none, 1 picked up, 2 delivered
uint16_t pickedUpBy = 0;
volatile bool receiptPending = false;
uint8_t receipt[16];

// ---------- crypto ----------
void hmac40(const uint8_t *data, size_t len, uint8_t out5[5]) {
  uint8_t full[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, (const unsigned char *)FRAME_KEY, strlen(FRAME_KEY), data, len, full);
  memcpy(out5, full, 5);
}

void buildSos(uint8_t f[16]) {
  f[0] = (1 << 4) | TYPE_SOS;
  f[1] = ZONE >> 8; f[2] = ZONE & 0xff;
  f[3] = (TARGET_PERSON << 4) | 5;                 // severity 5
  f[4] = (ACTION_DISPATCH_EMS << 4) | (LANG & 0x0f);
  f[5] = minutesSince2025 >> 24; f[6] = (minutesSince2025 >> 16) & 0xff; f[7] = (minutesSince2025 >> 8) & 0xff; f[8] = minutesSince2025 & 0xff;
  f[9] = sequence >> 8; f[10] = sequence & 0xff;
  hmac40(f, 11, f + 11);
}

bool verifyAck(const uint8_t f[16]) {
  if ((f[0] & 0x0f) != TYPE_ACK) return false;
  uint8_t mac[5]; hmac40(f, 11, mac);
  if (memcmp(mac, f + 11, 5) != 0) { Serial.println("receipt: signature invalid, ignored"); return false; }
  uint16_t seq = (f[9] << 8) | f[10];
  if (seq != sequence) { Serial.println("receipt: not for this SOS, ignored"); return false; }
  return true;
}

// ---------- outputs ----------
void relay(bool on) { digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }
void clickRelay(int times) { for (int i = 0; i < times; i++) { relay(true); delay(180); relay(false); delay(180); } }
void led(bool on) { digitalWrite(PIN_LED, on ? HIGH : LOW); }

// ---------- BLE ----------
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { connected = true; Serial.println("node connected"); }
  void onDisconnect(BLEServer *s) override { connected = false; Serial.println("node disconnected, advertising again"); BLEDevice::startAdvertising(); }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    auto v = c->getValue();                       // std::string on core 2.x, String on core 3.x: both have c_str()/length()
    const uint8_t *d = (const uint8_t *)v.c_str();
    size_t n = v.length();
    if (n == 5 && d[0] == 'T') { minutesSince2025 = ((uint32_t)d[1] << 24) | ((uint32_t)d[2] << 16) | ((uint32_t)d[3] << 8) | d[4]; Serial.printf("time synced: %lu min since 2025\n", (unsigned long)minutesSince2025); return; }
    if (n == 16) { memcpy(receipt, d, 16); receiptPending = true; }
  }
};

void sendSos() {
  uint8_t f[16]; buildSos(f);
  Serial.print("SOS #"); Serial.print(sequence); Serial.print(connected ? " -> node over Bluetooth: " : " (no node connected yet): ");
  for (int i = 0; i < 16; i++) Serial.printf("%02x", f[i]);
  Serial.println();
  if (connected && txChar) { txChar->setValue(f, 16); txChar->notify(); }
  lastSendMs = millis();
}

void startSos() {
  sequence = (uint16_t)(esp_random() & 0xffff);    // one emergency = one sequence; repeats keep it so nodes count it once
  sosActive = true; stage = 0; pickedUpBy = 0;
  Serial.println("SOS started");
  sendSos();
}

void cancelSos() { sosActive = false; stage = 0; led(false); relay(false); Serial.println("SOS cancelled"); }

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BUTTON_EXT, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT); led(false);
  pinMode(PIN_RELAY, OUTPUT); relay(false);

  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *svc = server->createService(NUS_SERVICE);
  txChar = svc->createCharacteristic(NUS_TX, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic *rx = svc->createCharacteristic(NUS_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCallbacks());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("%s ready. Press BOOT for SOS, hold 3 s to cancel.\n", DEVICE_NAME);
}

uint32_t pressedAt = 0;
void loop() {
  bool pressed = digitalRead(PIN_BUTTON) == LOW || digitalRead(PIN_BUTTON_EXT) == LOW;
  if (pressed && !pressedAt) pressedAt = millis();
  if (!pressed && pressedAt) {
    uint32_t held = millis() - pressedAt; pressedAt = 0;
    if (held > 3000) cancelSos();
    else if (held > 40 && !sosActive) startSos();
  }

  if (receiptPending) {
    receiptPending = false;
    if (sosActive && verifyAck(receipt)) {
      uint8_t st = receipt[3] & 0x0f; uint16_t node = (receipt[1] << 8) | receipt[2];
      if (st > stage) {
        stage = st;
        if (st == 1) { pickedUpBy = node; Serial.printf("RECEIPT 1: picked up by node %u. Beacon stopped.\n", node); led(true); clickRelay(1); }
        if (st >= 2) { Serial.println("RECEIPT 2: delivered to dispatch."); clickRelay(2); }
      }
    }
  }

  if (sosActive) {
    if (stage == 0) {
      led((millis() / 150) % 2);                                  // fast blink: looking for a node
      if (millis() - lastSendMs > REPEAT_MS) sendSos();           // repeat until picked up
    } else if (stage == 1) {
      led(true);                                                  // solid: a node has it
    } else {
      led(((millis() / 120) % 10) < 3 && ((millis() / 120) % 10) != 1); // double blink: dispatch has it
    }
  }
  delay(10);
}
