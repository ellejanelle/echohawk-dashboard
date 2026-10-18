#!/usr/bin/env python3
"""
===============================================================================
ECHOHAWK VOICE-TO-PHONOBYTE ACOUSTIC TRANSLOCATOR
===============================================================================
1. Captures live human voice from microphone at 16 kHz.
2. Extracts acoustic articulatory envelope into an 8-bit R_8 Phonobyte.
3. Packages R_8 into a PADLOA packet with CRC-8.
4. Broadcasts the verified 5.8-7.4 kHz FSK chirp over speakers at 48 kHz.
===============================================================================
"""

import sys
import time
import numpy as np
import sounddevice as sd

# --- Audio Engine Configurations ---
VOICE_FS = 16000         # 16 kHz for speech formant extraction
MODEM_FS = 48000         # 48 kHz for FSK chirp transmission
CHUNK_SIZE = 512         # 32 ms processing window
ENERGY_THRESHOLD = 0.018 # RMS noise gate

# --- PADLOA Modem Physical Parameters ---
CHIRP_F0 = 5000
CHIRP_F1 = 7400
CHIRP_DUR = 0.040

BASE_FREQ = 5800
BIN_SPACING = 100
SYMBOL_DUR = 0.040
GUARD_DUR = 0.010
POST_CHIRP_GUARD = 0.020

SYM_SAMPLES = int(MODEM_FS * SYMBOL_DUR)
SLOT_SAMPLES = int(MODEM_FS * (SYMBOL_DUR + GUARD_DUR))

# Canonical Phonobyte dictionary mapping for display
WORD_DICTIONARY = {
    0x79: "TOP (CARGO_LOADED)",
    0x80: "SEE (SEAL_VERIFIED)",
    0x4A: "REROUTE (BAY_4)",
    0x84: "HOLD (CUSTOMS_FLAG)",
    0x61: "LOCK (CONTAINER_CLAMP)"
}

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
    t = np.linspace(0, CHIRP_DUR, int(MODEM_FS * CHIRP_DUR), endpoint=False)
    sig = np.sin(2 * np.pi * (CHIRP_F0 * t + (CHIRP_F1 - CHIRP_F0) / (2 * CHIRP_DUR) * t**2))
    return (sig * np.hanning(len(sig))).astype(np.float32)

def generate_modem_wave(payload_bytes: bytes) -> np.ndarray:
    """Generates the verified 48 kHz physical audio burst."""
    packet = bytes([len(payload_bytes)]) + payload_bytes + bytes([crc8(payload_bytes)])
    nibbles = []
    for b in packet:
        nibbles.append((b >> 4) & 0x0F)
        nibbles.append(b & 0x0F)

    blocks = [make_chirp()]
    blocks.append(np.zeros(int(MODEM_FS * POST_CHIRP_GUARD), dtype=np.float32))

    t = np.linspace(0, SYMBOL_DUR, SYM_SAMPLES, endpoint=False)
    taper = np.hanning(SYM_SAMPLES)

    for nib in nibbles:
        freq = BASE_FREQ + (nib * BIN_SPACING)
        tone = (np.sin(2 * np.pi * freq * t) * taper).astype(np.float32)
        blocks.append(tone)
        blocks.append(np.zeros(int(MODEM_FS * GUARD_DUR), dtype=np.float32))

    blocks.append(np.zeros(int(MODEM_FS * 0.05), dtype=np.float32))
    return np.concatenate(blocks)

class VoiceToPhonobyteTransmitter:
    def __init__(self):
        self.is_voicing = False
        self.syllable_buffer = []

    def compute_rms(self, chunk: np.ndarray) -> float:
        return float(np.sqrt(np.mean(chunk**2)))

    def compute_spectral_features(self, chunk: np.ndarray):
        windowed = chunk * np.hanning(len(chunk))
        fft_mag = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(windowed), 1.0 / VOICE_FS)

        total_energy = np.sum(fft_mag) + 1e-12
        centroid = np.sum(freqs * fft_mag) / total_energy

        hf_mask = freqs >= 3000.0
        hf_energy_ratio = np.sum(fft_mag[hf_mask]) / total_energy

        f1_mask = (freqs >= 200.0) & (freqs <= 1000.0)
        f2_mask = (freqs > 1000.0) & (freqs <= 3000.0)

        f1_idx = np.argmax(fft_mag[f1_mask]) if np.any(f1_mask) else 0
        f2_idx = np.argmax(fft_mag[f2_mask]) if np.any(f2_mask) else 0

        f1 = freqs[f1_mask][f1_idx] if np.any(f1_mask) else 500.0
        f2 = freqs[f2_mask][f2_idx] if np.any(f2_mask) else 1500.0

        return centroid, hf_energy_ratio, f1, f2

    def classify_onset(self, hf_ratio: float, centroid: float) -> int:
        if hf_ratio > 0.40 or centroid > 3800.0:
            return 2  # Fricative (s, z, f)
        elif centroid > 2200.0:
            return 1  # Plosive (p, t, k)
        elif centroid < 800.0:
            return 3  # Nasal (m, n)
        elif centroid < 1600.0:
            return 4  # Liquid (l, r, w)
        else:
            return 0  # Open vowel onset

    def classify_nucleus(self, f1: float, f2: float) -> int:
        if f2 >= 1800.0:
            return 0  # High-Front (ee, i)
        elif f2 <= 1100.0:
            return 2  # Low-Back (oo, u)
        elif f1 >= 600.0:
            return 3  # Open-Jaw (ah, eye)
        else:
            return 1  # Mid-Central (eh, schwa)

    def classify_coda(self, hf_ratio: float, energy: float) -> int:
        if hf_ratio > 0.35:
            return 3  # Fricative tail (-s, -z)
        elif energy > 0.02:
            return 1  # Nasal tail (-m, -n)
        else:
            return 0  # Open release

    def process_and_transmit(self, vocal_audio: np.ndarray):
        n_samples = len(vocal_audio)
        if n_samples < CHUNK_SIZE:
            return

        third = n_samples // 3
        attack_chunk = vocal_audio[:third]
        nucleus_chunk = vocal_audio[third:2*third]
        decay_chunk = vocal_audio[2*third:]

        _, on_hf, _, _ = self.compute_spectral_features(attack_chunk)
        on_centroid = self.compute_spectral_features(attack_chunk)[0]
        _, _, f1, f2 = self.compute_spectral_features(nucleus_chunk)
        _, co_hf, _, _ = self.compute_spectral_features(decay_chunk)
        co_rms = self.compute_rms(decay_chunk)

        on_code = self.classify_onset(on_hf, on_centroid)
        nuc_code = self.classify_nucleus(f1, f2)
        coda_code = self.classify_coda(co_hf, co_rms)

        # Pack into 8-bit register
        r8_byte = ((on_code & 0x07) << 5) | ((nuc_code & 0x03) << 3) | (coda_code & 0x07)

        # Lookup word or display register
        word_meaning = WORD_DICTIONARY.get(r8_byte, f"R8_DIRECTIVE_{r8_byte:02X}")

        print("\n" + "=" * 65)
        print(f" 🎙️  SPEECH CAPTURED & TRANSDUCED:")
        print(f"     ├─ Articulatory Analysis : Onset={on_code} | Vowel={nuc_code} (F1={f1:.0f}Hz, F2={f2:.0f}Hz) | Coda={coda_code}")
        print(f"     ├─ Extracted Phonobyte   : 0x{r8_byte:02X} [{r8_byte:08b}]")
        print(f"     └─ Mnemonic Directive    : '{word_meaning}'")

        # Generate PADLOA transmission packet
        # Payload carries the single extracted Phonobyte
        payload = word_meaning.encode('utf-8')
        wave = generate_modem_wave(payload)

        print(f"[*] Broadcasting 16-byte PADLOA acoustic chirp over speakers...")
        sd.play(wave * 0.85, samplerate=MODEM_FS, blocking=True)
        print("[✓] Transmitted over air. Waiting for next vocal command...\n")

    def audio_callback(self, indata, frames, time_info, status):
        audio_mono = indata[:, 0]
        rms = self.compute_rms(audio_mono)

        if rms > ENERGY_THRESHOLD:
            self.is_voicing = True
            self.syllable_buffer.extend(audio_mono)
        else:
            if self.is_voicing and len(self.syllable_buffer) > (VOICE_FS * 0.08):
                # Completed syllable
                vocal_data = np.array(self.syllable_buffer, dtype=np.float32)
                self.syllable_buffer = []
                self.is_voicing = False
                self.process_and_transmit(vocal_data)
            elif self.is_voicing and len(self.syllable_buffer) <= (VOICE_FS * 0.08):
                self.syllable_buffer = []
                self.is_voicing = False

def main():
    print("=" * 65)
    print("  🎤 ECHOHAWK VOICE-TO-PHONOBYTE LIVE TRANSLOCATOR")
    print("  Speak into your Mac mic (e.g. 'TOP', 'HOLD', 'SEE').")
    print("  Your voice is extracted into an R_8 byte and transmitted over air.")
    print("  (Press Ctrl+C to stop)")
    print("=" * 65 + "\n")

    transceiver = VoiceToPhonobyteTransmitter()
    with sd.InputStream(
        samplerate=VOICE_FS,
        channels=1,
        blocksize=CHUNK_SIZE,
        callback=transceiver.audio_callback
    ):
        while True:
            time.sleep(0.1)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[✓] Transceiver stopped.")
