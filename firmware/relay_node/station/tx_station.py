#!/usr/bin/env python3
"""
ECHOHAWK STANDALONE TRANSMITTER
Usage:
  python3 tx_station.py "SECTOR_4_OK"
  python3 tx_station.py "BAY_4_CLEAR"
"""
import numpy as np
import sounddevice as sd
import sys

FS = 48000
CHIRP_F0 = 5000
CHIRP_F1 = 7400
CHIRP_DUR = 0.040

BASE_FREQ = 5800
BIN_SPACING = 100
SYMBOL_DUR = 0.040
GUARD_DUR = 0.010
POST_CHIRP_GUARD = 0.020

SYM_SAMPLES = int(FS * SYMBOL_DUR)
SLOT_SAMPLES = int(FS * (SYMBOL_DUR + GUARD_DUR))

def crc8(data: bytes) -> int:
    crc = 0x00
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0x07) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc

def make_chirp():
    t = np.linspace(0, CHIRP_DUR, int(FS * CHIRP_DUR), endpoint=False)
    sig = np.sin(2 * np.pi * (CHIRP_F0 * t + (CHIRP_F1 - CHIRP_F0) / (2 * CHIRP_DUR) * t**2))
    return (sig * np.hanning(len(sig))).astype(np.float32)

def generate_wave(msg: str) -> np.ndarray:
    payload = msg.encode('utf-8')
    packet = bytes([len(payload)]) + payload + bytes([crc8(payload)])
    nibbles = []
    for b in packet:
        nibbles.append((b >> 4) & 0x0F)
        nibbles.append(b & 0x0F)
        
    blocks = [make_chirp()]
    blocks.append(np.zeros(int(FS * POST_CHIRP_GUARD), dtype=np.float32))
    
    t = np.linspace(0, SYMBOL_DUR, SYM_SAMPLES, endpoint=False)
    taper = np.hanning(SYM_SAMPLES)
    
    for nib in nibbles:
        freq = BASE_FREQ + (nib * BIN_SPACING)
        tone = (np.sin(2 * np.pi * freq * t) * taper).astype(np.float32)
        blocks.append(tone)
        blocks.append(np.zeros(int(FS * GUARD_DUR), dtype=np.float32))
        
    blocks.append(np.zeros(int(FS * 0.05), dtype=np.float32))
    return np.concatenate(blocks)

if __name__ == "__main__":
    msg = sys.argv[1] if len(sys.argv) > 1 else "SECTOR_4_OK"
    wave = generate_wave(msg)
    
    print("=" * 60)
    print(f"[*] ECHOHAWK BROADCASTING: '{msg}'")
    print(f"[*] Payload Size         : {len(msg)} Bytes")
    print(f"[*] Air-Time Duration    : {len(wave)/FS*1000:.1f} ms")
    print("=" * 60)
    
    # 85% volume provides clean signal without speaker distortion
    sd.play(wave * 0.85, samplerate=FS, blocking=True)
    print("[✓] Transmission complete.\n")
