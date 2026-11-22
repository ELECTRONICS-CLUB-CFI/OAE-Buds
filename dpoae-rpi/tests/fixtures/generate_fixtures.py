#!/usr/bin/env python3
"""
tests/fixtures/generate_fixtures.py
Generates deterministic synthetic audio fixtures for offline DPOAE test validation.
"""
import os, struct, math

FS = 48000

def write_wav_mono(filename, samples, sample_rate=FS):
    num_samples = len(samples)
    byte_rate = sample_rate * 2
    block_align = 2
    subchunk2_size = num_samples * 2
    chunk_size = 36 + subchunk2_size

    with open(filename, 'wb') as f:
        # RIFF header
        f.write(b'RIFF')
        f.write(struct.pack('<I', chunk_size))
        f.write(b'WAVE')
        # fmt subchunk
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16)) # Subchunk1Size (16 for PCM)
        f.write(struct.pack('<H', 1))  # AudioFormat (1 for PCM)
        f.write(struct.pack('<H', 1))  # NumChannels (1 mono)
        f.write(struct.pack('<I', sample_rate))
        f.write(struct.pack('<I', byte_rate))
        f.write(struct.pack('<H', block_align))
        f.write(struct.pack('<H', 16)) # BitsPerSample (16 bits)
        # data subchunk
        f.write(b'data')
        f.write(struct.pack('<I', subchunk2_size))
        for s in samples:
            clamped = max(-32768, min(32767, int(s)))
            f.write(struct.pack('<h', clamped))

def main():
    out_dir = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(out_dir, exist_ok=True)
    
    # 1. Generate 5-second clean synthetic recording for f1=1640, f2=2016, OAE=1264 Hz
    duration = 5.0
    num_samples = int(FS * duration)
    samples = []
    for i in range(num_samples):
        t = i / FS
        # Primary tones (leaked into mic) + OAE tone at 1264 Hz + low noise
        s = 5000.0 * math.sin(2.0 * math.pi * 1640.0 * t) + \
            4000.0 * math.sin(2.0 * math.pi * 2016.0 * t) + \
            250.0  * math.sin(2.0 * math.pi * 1264.0 * t)
        samples.append(s)
    
    out_path = os.path.join(out_dir, "synthetic_dpoae_pair1_clean.wav")
    write_wav_mono(out_path, samples)
    print(f"Generated fixture: {out_path}")

if __name__ == "__main__":
    main()
