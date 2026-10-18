# EchoHawk node → dashboard protocol

One WebSocket per node. The node connects to `ws://<DASH_HOST>:<DASH_PORT>/node`
(or `wss://` with `DASH_USE_SSL true`) and reconnects automatically.

## Node → dashboard (text frames, JSON)

| type | when | fields |
|---|---|---|
| `hello` | on every connect | `node_id`, `mic` (bool), `sample_rate` |
| `alert` | pad held 1.5 s | `node_id`, `event_id`, `service` (`police`/`ambulance`/`hospital`), `audio` (bool), `rssi`, `uptime_ms` |
| `cancel` | same pad held again within 10 s | `node_id`, `event_id`, `service`, `ref_event_id` (the alert being cancelled), `uptime_ms` |
| `audio_start` | right before audio frames | `node_id`, `event_id` (the alert), `sample_rate` (16000), `format` (`pcm_s16le`), `channels` (1) |
| `audio_stop` | stream ends (60 s, cancel, or stop_audio) | `node_id`, `event_id` |

## Node → dashboard (binary frames)

Raw audio for the stream announced by the last `audio_start`:
16-bit signed little-endian PCM, mono, 16 kHz, ~16 ms (512 bytes) per frame.
Only sent when the mic is enabled.

## Dashboard → node (text frames, JSON)

| message | effect |
|---|---|
| `{"type":"ack","event_id":"..."}` | **Required** for every `alert` and `cancel`. Until ACKed, the node resends every 5 s. On ACK of an alert the relay clicks and the LED goes solid. |
| `{"type":"stop_audio"}` | Ends the current audio stream early. |

## Playing the audio in a browser dashboard

Have the dashboard backend forward the binary frames to the browser (over its own
WebSocket), then convert each frame to Float32 (`sample / 32768`) and play it with
the Web Audio API at 16 kHz.
