import wave
import struct
import math

def analyze(wav_path):
    w = wave.open(wav_path, 'rb')
    framerate = w.getframerate()
    nframes = w.getnframes()
    raw = w.readframes(nframes)
    w.close()
    samples = struct.unpack(f"{nframes}h", raw)
    
    frame_size = int(framerate * 0.02) # 20ms
    energies = []
    for i in range(0, len(samples) - frame_size, frame_size):
        chunk = samples[i:i+frame_size]
        rms = math.sqrt(sum(s*s for s in chunk) / frame_size)
        t_ms = (i / framerate) * 1000
        energies.append((t_ms, rms))
        
    print(f"\n=== {wav_path} (focus 4000ms - 4800ms: 点地盘) ===")
    for t_ms, rms in energies:
        if 4000 <= t_ms <= 4800:
            bar = '#' * int(rms / 500)
            print(f"{t_ms:6.1f}ms: rms={rms:6.1f} {bar}")

files = [
    "scripts/out/dipan1___di4_pan2.wav",
    "scripts/out/dipan1_di4_pan2.wav",
    "scripts/out/dipan1_di4_pan2__.wav",
]

for f in files:
    try:
        analyze(f)
    except Exception as e:
        print(f, e)
