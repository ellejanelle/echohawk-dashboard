/*
  EchoHawk — ESP32 emergency relay node

  Button press goes STRAIGHT to the dashboard over one WebSocket:
    - text frames   = JSON events (alert, cancel, audio_start, audio_stop)
    - binary frames = live audio (16 kHz, 16-bit, mono PCM) after an alert

  Button = jumper wire on GPIO32 -> CALL CENTER
    BUTTON_MODE_TOUCH 0: touch the loose end to GND (default, reliable)
    BUTTON_MODE_TOUCH 1: pinch the loose end (capacitive touch)
  Hold it ~1.5 s to send an alert.
  Hold it again within 10 s to cancel (also stops audio).

  Other hardware:
    GPIO26 -> Relay IN (clicks when the dashboard ACKs an alert)
    GPIO2  -> Onboard LED (status)

  Mic (add later — INMP441 I2S, then set MIC_ENABLED 1):
    SCK -> GPIO14   WS -> GPIO25   SD -> GPIO13
    VDD -> 3V3      GND -> GND     L/R -> GND

  Status LED:
    slow blink (1 s)  = not connected to Wi-Fi/dashboard
    medium blink      = pad being held
    fast blink        = alert waiting for dashboard ACK
    solid 3 s         = dashboard acknowledged
    off               = idle, connected

  Libraries (Arduino Library Manager):
    "WebSockets" by Markus Sattler
  Board package: esp32 by Espressif, version 3.x

  Don't touch the pads while the board boots (it calibrates them).
*/

#include <WiFi.h>
#include <WebSocketsClient.h>

// ====================== CONFIG — EDIT THESE ======================
const char* WIFI_SSID = "YOUR_WIFI_NAME";        // must be 2.4 GHz
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char*    DASH_HOST = "echohawk-production-505f.up.railway.app";  // the EchoHawk server (Railway)
const uint16_t DASH_PORT = 443;
const char*    DASH_PATH = "/node";
#define DASH_USE_SSL true                        // wss:// for the cloud dashboard; false + port 8787 for a laptop on the same Wi-Fi

const char* NODE_ID = "echohawk-01";

// Button mode:
//   0 = wire-to-GND: touch the loose end of the D32 wire to the GND (–) rail,
//       or wire a real push button between D32 and GND. Most reliable.
//   1 = capacitive touch: pinch the loose end of the D32 wire.
#define BUTTON_MODE_TOUCH 0

#define MIC_ENABLED      0      // set to 1 once the INMP441 mic is wired
#define RELAY_ACTIVE_LOW true   // most cheap relay modules; set false if backwards
#define DEBUG_TOUCH      0      // 1 = print raw touch values every second
// =================================================================

#if MIC_ENABLED
  #include <ESP_I2S.h>
#endif

// ---- Pins ----
const uint8_t PIN_RELAY = 26;
const uint8_t PIN_LED   = 2;
const int8_t  MIC_SCK   = 14;
const int8_t  MIC_WS    = 25;
const int8_t  MIC_SD    = 13;

// ---- Timing / audio ----
const unsigned long HOLD_MS        = 1500;
const unsigned long CANCEL_MS      = 10000;
const unsigned long ACK_TIMEOUT_MS = 5000;   // resend if no ACK
const unsigned long RELAY_PULSE_MS = 1000;
const unsigned long ACK_SHOW_MS    = 3000;
const unsigned long AUDIO_SECONDS  = 60;     // stream length after an alert
const uint32_t SAMPLE_RATE         = 16000;
const int CHUNK_SAMPLES            = 256;    // 16 ms of audio per frame
const int MIC_GAIN                 = 4;      // raise if audio is too quiet
const float TOUCH_RATIO            = 0.65;   // touched when reading < baseline * this

WebSocketsClient ws;

// ---- Touch pads ----
struct Pad {
  const char* service;
  uint8_t pin;
  uint32_t baseline, threshold;
  bool touched, fired;
  unsigned long touchStart;
};
Pad pads[] = {
  {"call_center", 32, 0, 0, false, false, 0},
};
const int NUM_PADS = sizeof(pads) / sizeof(pads[0]);

// ---- Outgoing event queue (resent until the dashboard ACKs) ----
struct Msg {
  char json[256];
  char eventId[40];
  bool isAlert;
  bool sent;
  unsigned long sentAt;
  uint16_t attempts;
};
const int QSIZE = 6;
Msg queue[QSIZE];
int qHead = 0, qCount = 0;

// ---- State ----
int lastAlertPad = -1;
unsigned long lastAlertTime = 0;
char lastAlertId[40] = "";

unsigned long relayOffAt = 0;
unsigned long ackUntil = 0;
bool wifiWasUp = false;

// ---- Audio state ----
bool streaming = false;
bool audioAnnounced = false;
unsigned long streamEndAt = 0;
char streamEventId[40] = "";
#if MIC_ENABLED
I2SClass i2s;
int32_t rawBuf[CHUNK_SAMPLES];
int16_t pcmBuf[CHUNK_SAMPLES];
#endif

// ================= Helpers =================
void relayWrite(bool on) {
  digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

uint32_t readTouch(uint8_t pin) {
  uint32_t sum = 0;
  for (int i = 0; i < 3; i++) sum += touchRead(pin);
  return sum / 3;
}

void calibratePads() {
#if !BUTTON_MODE_TOUCH
  for (auto &p : pads) pinMode(p.pin, INPUT_PULLUP);
  Serial.println("Button mode: touch the D32 wire to GND to trigger");
  return;
#endif
  Serial.println("Calibrating touch pads, don't touch them...");
  for (auto &p : pads) {
    uint32_t sum = 0;
    for (int i = 0; i < 20; i++) { sum += touchRead(p.pin); delay(10); }
    p.baseline = sum / 20;
    p.threshold = p.baseline * TOUCH_RATIO;
    Serial.printf("  %-11s GPIO%-2d baseline=%lu threshold=%lu\n",
                  p.service, p.pin, (unsigned long)p.baseline, (unsigned long)p.threshold);
  }
}

void newEventId(char* out, size_t len) {
  snprintf(out, len, "%s-%08lx", NODE_ID, (unsigned long)esp_random());
}

bool dashboardUp() {
  return WiFi.status() == WL_CONNECTED && ws.isConnected();
}

// ================= Queue =================
void enqueue(const char* json, const char* eventId, bool isAlert) {
  if (qCount == QSIZE) {
    Serial.println("WARN: queue full, dropping oldest event");
    qHead = (qHead + 1) % QSIZE;
    qCount--;
  }
  Msg &m = queue[(qHead + qCount) % QSIZE];
  strlcpy(m.json, json, sizeof(m.json));
  strlcpy(m.eventId, eventId, sizeof(m.eventId));
  m.isAlert = isAlert;
  m.sent = false;
  m.sentAt = 0;
  m.attempts = 0;
  qCount++;
}

void handleQueue() {
  if (qCount == 0 || !dashboardUp()) return;
  Msg &m = queue[qHead];
  if (!m.sent || millis() - m.sentAt > ACK_TIMEOUT_MS) {
    m.attempts++;
    Serial.printf("SEND %s (attempt %u)\n", m.eventId, m.attempts);
    ws.sendTXT(m.json);
    m.sent = true;
    m.sentAt = millis();
  }
}

void onAck(const char* eventId) {
  if (qCount == 0 || strcmp(queue[qHead].eventId, eventId) != 0) return;
  Serial.printf("  ACK %s\n", eventId);
  ackUntil = millis() + ACK_SHOW_MS;
  if (queue[qHead].isAlert) {
    relayWrite(true);
    relayOffAt = millis() + RELAY_PULSE_MS;
  }
  qHead = (qHead + 1) % QSIZE;
  qCount--;
}

// ================= Audio =================
void sendAudioStart() {
  char msg[200];
  snprintf(msg, sizeof(msg),
    "{\"type\":\"audio_start\",\"node_id\":\"%s\",\"event_id\":\"%s\","
    "\"sample_rate\":%lu,\"format\":\"pcm_s16le\",\"channels\":1}",
    NODE_ID, streamEventId, (unsigned long)SAMPLE_RATE);
  ws.sendTXT(msg);
  audioAnnounced = true;
}

void stopStream() {
  if (!streaming) return;
  if (dashboardUp() && audioAnnounced) {
    char msg[128];
    snprintf(msg, sizeof(msg), "{\"type\":\"audio_stop\",\"node_id\":\"%s\",\"event_id\":\"%s\"}",
             NODE_ID, streamEventId);
    ws.sendTXT(msg);
  }
  streaming = false;
  audioAnnounced = false;
  Serial.println("Audio stream stopped");
}

void startStream(const char* eventId) {
#if MIC_ENABLED
  stopStream();
  strlcpy(streamEventId, eventId, sizeof(streamEventId));
  streaming = true;
  audioAnnounced = false;
  streamEndAt = millis() + AUDIO_SECONDS * 1000UL;
  for (int i = 0; i < 4; i++) i2s.readBytes((char*)rawBuf, sizeof(rawBuf));  // flush stale samples
  Serial.printf("Audio stream started (%lu s)\n", AUDIO_SECONDS);
#endif
}

void handleAudio() {
#if MIC_ENABLED
  if (!streaming) return;
  if (millis() >= streamEndAt) { stopStream(); return; }
  if (!dashboardUp()) return;
  if (!audioAnnounced) sendAudioStart();

  size_t n = i2s.readBytes((char*)rawBuf, sizeof(rawBuf));
  size_t samples = n / sizeof(int32_t);
  for (size_t i = 0; i < samples; i++) {
    int32_t s = (rawBuf[i] >> 16) * MIC_GAIN;   // INMP441: 24-bit data, left-justified in 32 bits
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    pcmBuf[i] = (int16_t)s;
  }
  if (samples) ws.sendBIN((uint8_t*)pcmBuf, samples * sizeof(int16_t));
#endif
}

// ================= Dashboard messages =================
void handleDashboardText(const char* msg) {
  // Expected from the dashboard:
  //   {"type":"ack","event_id":"..."}
  //   {"type":"stop_audio"}
  if (strstr(msg, "\"ack\"")) {
    const char* p = strstr(msg, "\"event_id\"");
    if (!p) return;
    p = strchr(p + 10, '"');
    if (!p) return;
    p++;
    const char* end = strchr(p, '"');
    if (!end) return;
    char id[40];
    size_t len = min((size_t)(end - p), sizeof(id) - 1);
    memcpy(id, p, len);
    id[len] = '\0';
    onAck(id);
  } else if (strstr(msg, "\"stop_audio\"")) {
    Serial.println("Dashboard asked to stop audio");
    stopStream();
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      Serial.println("Dashboard connected");
      char hello[160];
      snprintf(hello, sizeof(hello),
        "{\"type\":\"hello\",\"node_id\":\"%s\",\"mic\":%s,\"sample_rate\":%lu}",
        NODE_ID, MIC_ENABLED ? "true" : "false", (unsigned long)SAMPLE_RATE);
      ws.sendTXT(hello);
      if (qCount) queue[qHead].sent = false;    // resend anything still pending
      audioAnnounced = false;                   // re-announce an in-progress stream
      break;
    }
    case WStype_DISCONNECTED:
      Serial.println("Dashboard disconnected, retrying...");
      audioAnnounced = false;
      break;
    case WStype_TEXT: {
      char buf[256];
      size_t len = min(length, sizeof(buf) - 1);
      memcpy(buf, payload, len);
      buf[len] = '\0';
      handleDashboardText(buf);
      break;
    }
    default:
      break;
  }
}

// ================= Pads =================
void onPadHold(int i) {
  unsigned long now = millis();
  char eventId[40], json[256];
  newEventId(eventId, sizeof(eventId));

  if (i == lastAlertPad && now - lastAlertTime < CANCEL_MS) {
    Serial.printf(">>> CANCEL %s\n", pads[i].service);
    snprintf(json, sizeof(json),
      "{\"type\":\"cancel\",\"node_id\":\"%s\",\"event_id\":\"%s\",\"service\":\"%s\","
      "\"ref_event_id\":\"%s\",\"uptime_ms\":%lu}",
      NODE_ID, eventId, pads[i].service, lastAlertId, now);
    enqueue(json, eventId, false);
    stopStream();
    lastAlertPad = -1;
  } else {
    Serial.printf(">>> ALERT %s\n", pads[i].service);
    snprintf(json, sizeof(json),
      "{\"type\":\"alert\",\"node_id\":\"%s\",\"event_id\":\"%s\",\"service\":\"%s\","
      "\"audio\":%s,\"rssi\":%d,\"uptime_ms\":%lu}",
      NODE_ID, eventId, pads[i].service, MIC_ENABLED ? "true" : "false", WiFi.RSSI(), now);
    enqueue(json, eventId, true);
    startStream(eventId);
    strlcpy(lastAlertId, eventId, sizeof(lastAlertId));
    lastAlertPad = i;
    lastAlertTime = now;
  }
}

bool anyPadHolding() {
  for (auto &p : pads) if (p.touched && !p.fired) return true;
  return false;
}

void handlePads() {
  unsigned long now = millis();
  for (int i = 0; i < NUM_PADS; i++) {
    Pad &p = pads[i];
#if BUTTON_MODE_TOUCH
    bool t = readTouch(p.pin) < p.threshold;
#else
    bool t = digitalRead(p.pin) == LOW;   // LOW = wire touching GND
#endif
    if (t && !p.touched) {
      p.touched = true;
      p.fired = false;
      p.touchStart = now;
    } else if (t && !p.fired && now - p.touchStart >= HOLD_MS) {
      p.fired = true;
      onPadHold(i);
    } else if (!t) {
      p.touched = false;
    }
  }
}

// ================= Wi-Fi + LED =================
void handleWiFi() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up && !wifiWasUp) {
    Serial.printf("Wi-Fi connected, IP %s, RSSI %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else if (!up && wifiWasUp) {
    Serial.println("Wi-Fi lost, reconnecting...");
  }
  wifiWasUp = up;
}

void handleLed() {
  unsigned long now = millis();
  bool on;
  if (anyPadHolding())    on = (now / 250) % 2;
  else if (qCount > 0)    on = (now / 100) % 2;
  else if (now < ackUntil) on = true;
  else if (!dashboardUp()) on = (now / 1000) % 2;
  else                    on = false;
  digitalWrite(PIN_LED, on);
}

// ================= Setup / Loop =================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== EchoHawk Relay Node ===");

  pinMode(PIN_RELAY, OUTPUT);
  relayWrite(false);
  pinMode(PIN_LED, OUTPUT);

  calibratePads();

#if MIC_ENABLED
  i2s.setPins(MIC_SCK, MIC_WS, -1, MIC_SD);
  if (!i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT)) {
    Serial.println("ERROR: mic (I2S) failed to start, check wiring");
  } else {
    Serial.println("Mic ready");
  }
#else
  Serial.println("Mic disabled (MIC_ENABLED 0): alerts only");
#endif

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // lower latency for audio
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("Connecting to %s...\n", WIFI_SSID);

#if DASH_USE_SSL
  ws.beginSSL(DASH_HOST, DASH_PORT, DASH_PATH);
#else
  ws.begin(DASH_HOST, DASH_PORT, DASH_PATH);
#endif
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  unsigned long now = millis();

  handleWiFi();
  ws.loop();
  handlePads();
  handleQueue();
  handleAudio();

  if (relayOffAt && now >= relayOffAt) {
    relayWrite(false);
    relayOffAt = 0;
  }

  handleLed();

#if DEBUG_TOUCH
  static unsigned long lastDbg = 0;
  if (now - lastDbg > 1000) {
    lastDbg = now;
    Serial.printf("touch=%lu threshold=%lu\n",
      (unsigned long)readTouch(pads[0].pin), (unsigned long)pads[0].threshold);
  }
#endif

  if (!streaming) delay(5);   // audio reads already pace the loop while streaming
}
