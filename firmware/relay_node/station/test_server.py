"""
EchoHawk test dashboard (stand-in until the real dashboard is hooked up).

Setup (once):
    cd ~/Documents/GitHub/EchoHawk
    python3 -m venv .venv
    source .venv/bin/activate
    pip install websockets

Run:
    source .venv/bin/activate
    python3 test_server.py

Then set DASH_HOST in the sketch to your Mac's IP (ipconfig getifaddr en0).
Alerts print here, get ACKed, and any audio is saved to recordings/<event_id>.wav
"""
import asyncio
import json
import os
import wave
from datetime import datetime

import websockets

PORT = 8765
REC_DIR = "recordings"
ICONS = {"call_center": "📞"}


def ts():
    return f"{datetime.now():%H:%M:%S}"


async def handle(ws):
    node = "unknown"
    wav = None
    wav_path = None
    try:
        async for msg in ws:
            # Binary frame = raw audio for the current stream
            if isinstance(msg, bytes):
                if wav:
                    wav.writeframes(msg)
                continue

            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                print(f"[{ts()}] bad JSON: {msg!r}")
                continue

            t = data.get("type")
            if t == "hello":
                node = data.get("node_id", node)
                print(f"[{ts()}] ✅ {node} connected (mic={data.get('mic')})")

            elif t == "alert":
                icon = ICONS.get(data.get("service"), "❓")
                print(f"\n[{ts()}] {icon}  ALERT: {data.get('service', '?').upper()} from {node}")
                print(f"   event_id={data.get('event_id')}  rssi={data.get('rssi')}  audio={data.get('audio')}")
                await ws.send(json.dumps({"type": "ack", "event_id": data.get("event_id")}))

            elif t == "cancel":
                print(f"\n[{ts()}] ✖  CANCEL: {data.get('service')} from {node} (ref={data.get('ref_event_id')})")
                await ws.send(json.dumps({"type": "ack", "event_id": data.get("event_id")}))

            elif t == "audio_start":
                os.makedirs(REC_DIR, exist_ok=True)
                if wav:
                    wav.close()
                wav_path = os.path.join(REC_DIR, f"{data.get('event_id')}.wav")
                wav = wave.open(wav_path, "wb")
                wav.setnchannels(data.get("channels", 1))
                wav.setsampwidth(2)
                wav.setframerate(data.get("sample_rate", 16000))
                print(f"[{ts()}] 🎙  audio streaming → {wav_path}")

            elif t == "audio_stop":
                if wav:
                    wav.close()
                    wav = None
                    print(f"[{ts()}] 🎙  audio saved: {wav_path}")

            else:
                print(f"[{ts()}] other: {data}")

    except websockets.ConnectionClosed:
        pass
    finally:
        if wav:
            wav.close()
            print(f"[{ts()}] 🎙  audio saved (connection closed): {wav_path}")
        print(f"[{ts()}] ⚠️  {node} disconnected")


async def main():
    async with websockets.serve(handle, "0.0.0.0", PORT):
        print(f"EchoHawk test dashboard listening on ws://0.0.0.0:{PORT}/node  (Ctrl+C to stop)")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped")
