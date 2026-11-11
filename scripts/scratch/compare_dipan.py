import wave
import struct
import math

def analyze_file(path):
    w = wave.open(path, 'rb')
    framerate = w.getframerate()
    nframes = w.getnframes()
    raw = w.readframes(nframes)
    w.close()
    samples = struct.unpack(f"{nframes}h", raw)
    
    frame = int(framerate * 0.02)
    energies = []
    for i in range(0, len(samples) - frame, frame):
        chunk = samples[i:i+frame]
        rms = math.sqrt(sum(s*s for s in chunk) / frame)
        energies.append(rms)
    return nframes / framerate * 1000, energies

variants = [
    ('lead quote', '___di4_pan2'),
    ('no quote', '_di4_pan2'),
    ('tail quote', '_di4_pan2__'),
    ('both quotes', '___di4_pan2__'),
]

print("=== dipan3 (standalone 地盘) ===")
for label, v in variants:
    dur, energies = analyze_file(f"scripts/out/dipan3{v}.wav")
    active = [e for e in energies if e > 500]
    print(f"{label:15s}: dur={dur:.0f}ms, active_frames={len(active)}, peak={max(energies):.0f}")

print("\n=== dipan1 (自己只是占了点地盘) tail 1200ms ===")
for label, v in variants:
    dur, energies = analyze_file(f"scripts/out/dipan1{v}.wav")
    tail = energies[-int(1200 / 20):]
    print(f"{label:15s}: dur={dur:.0f}ms, tail_peak={max(tail):.0f}")

print("\n=== dipan2 (徐寿辉的地盘很小) ===")
for label, v in variants:
    dur, energies = analyze_file(f"scripts/out/dipan2{v}.wav")
    print(f"{label:15s}: dur={dur:.0f}ms, peak={max(energies):.0f}")
