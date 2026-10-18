#!/usr/bin/env python3
"""
ECHOHAWK CONTINUOUS RECEIVER (Multi-Device Calibrated)
Listens on room microphone in real time.
"""
import numpy as np
import sounddevice as sd
import sys
import time

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

t = np.linspace(0, CHIRP_DUR, int(FS * CHIRP_DUR), endpoint=False)
ref_chirp = (np.sin(2 * np.pi * (CHIRP_F0 * t + (CHIRP_F1 - CHIRP_F0) / (2 * CHIRP_DUR) * t**2)) * np.hanning(int(FS * CHIRP_DUR))).astype(np.float32)

BUFFER_LEN = int(FS * 3.0)
audio_buf = np.zeros(BUFFER_LEN, dtype=np.float32)
last_decode_time = 0

print("\n" + "=" * 65)
print("  🎧 ECHOHAWK MULTI-DEVICE LISTENER RUNNING")
print("  Monitoring room air for acoustic pings... (Ctrl+C to exit)")
print("=" * 65 + "\n")

def decode_at_offset(start_offset, stream_data):
    def get_nibble(slot):
        p0 = start_offset + (slot * SLOT_SAMPLES)
        p1 = p0 + SYM_SAMPLES
        if p1 > len(stream_data) or p0 < 0: return 0
        chunk = stream_data[p0:p1] * np.hanning(SYM_SAMPLES)
        energies = [np.abs(np.dot(chunk, np.exp(-2j * np.pi * (BASE_FREQ + i * BIN_SPACING) * np.arange(SYM_SAMPLES) / FS))) for i in range(16)]
        return int(np.argmax(energies))

    len_b = (get_nibble(0) << 4) | get_nibble(1)
    if len_b == 0 or len_b > 32:
        return b"", 0, 1

    tot_syms = (len_b + 2) * 2
    syms = [get_nibble(s) for s in range(tot_syms)]
    raw_b = bytearray((syms[i] << 4) | syms[i+1] for i in range(0, len(syms), 2))
    
    pay = bytes(raw_b[1:-1])
    r_crc = raw_b[-1]
    e_crc = crc8(pay)
    return pay, r_crc, e_crc

def callback(indata, frames, time_info, status):
    global audio_buf, last_decode_time
    audio_buf = np.roll(audio_buf, -frames)
    audio_buf[-frames:] = indata[:, 0]

    now = time.time()
    if now - last_decode_time < 1.5:
        return

    # Check recent 0.8s for preamble
    search_window = audio_buf[-int(FS * 0.8):]
    corr = np.abs(np.correlate(search_window, ref_chirp, mode='valid'))
    if len(corr) == 0:
        return

    noise = np.median(corr) + 1e-9
    # 8.0x SNR threshold handles both room noise and distance attenuation
    above_thresh = np.where(corr > (noise * 8.0))[0]
    if len(above_thresh) == 0:
        return

    first_cluster_start = above_thresh[0]
    window_end = min(len(corr), first_cluster_start + int(FS * 0.050))
    peak_idx = first_cluster_start + int(np.argmax(corr[first_cluster_start:window_end]))

    base_start = (len(audio_buf) - int(FS * 0.8)) + peak_idx + len(ref_chirp) + int(FS * POST_CHIRP_GUARD) - int(SLOT_SAMPLES * 2)

    # Ensure enough trailing buffer exists to read message
    if (len(audio_buf) - base_start) < (SLOT_SAMPLES * 10):
        return

    # Sweep micro-sample alignment window
    for sample_shift in range(-int(FS * 0.030), int(FS * 0.030), int(FS * 0.003)):
        pay, r_crc, e_crc = decode_at_offset(base_start + sample_shift, audio_buf)
        if r_crc == e_crc and len(pay) > 0:
            try:
                decoded_str = pay.decode('utf-8')
                print("\n" + "=" * 60)
                print(" [★] DISPATCH PACKET RECEIVED ACROSS ROOM AIR!")
                print(f"     Payload   : '{decoded_str}'")
                print(f"     Length    : {len(pay)} Bytes")
                print(f"     CRC-8     : 0x{r_crc:02X} [PERFECT MATCH]")
                print("=" * 60 + "\n")
                last_decode_time = now
                break
            except UnicodeDecodeError:
                pass

try:
    with sd.InputStream(samplerate=FS, channels=1, callback=callback, blocksize=int(FS * 0.05)):
        while True:
            sd.sleep(100)
except KeyboardInterrupt:
    print("\n[✓] Receiver stopped.")
