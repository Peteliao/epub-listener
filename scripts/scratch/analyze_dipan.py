import wave
import struct
import math

def analyze(wav_path):
    w = wave.open(wav_path, 'rb')
    nchannels, sampwidth, framerate, nframes, comptype, compname = w.getparams()
    raw = w.readframes(nframes)
    w.close()
    
    samples = struct.unpack(f"{nframes}h", raw)
    
    frame_size = int(framerate * 0.02)
    step = frame_size
    energies = []
    for i in range(0, len(samples) - frame_size, step):
        chunk = samples[i:i+frame_size]
        rms = math.sqrt(sum(s*s for s in chunk) / frame_size)
        t_ms = (i / framerate) * 1000
        energies.append((t_ms, rms))
        
    print(f"=== {wav_path} ===")
    print(f"Total time: {nframes / framerate * 1000:.1f}ms")
    
    in_syllable = False
    start_t = 0
    peak_rms = 0
    syllables = []
    for t_ms, rms in energies:
        if rms >= 800:
            if not in_syllable:
                in_syllable = True
                start_t = t_ms
                peak_rms = rms
            else:
                if rms > peak_rms: peak_rms = rms
        else:
            if in_syllable:
                in_syllable = False
                syllables.append((start_t, t_ms, t_ms - start_t, peak_rms))
    if in_syllable:
        syllables.append((start_t, energies[-1][0], energies[-1][0] - start_t, peak_rms))
        
    print(f"Found {len(syllables)} syllable bursts:")
    for idx, (st, en, dur, pk) in enumerate(syllables):
        print(f"  #{idx+1:2d}: {st:6.1f} - {en:6.1f}ms ({dur:5.1f}ms, peak {pk:6.1f})")

analyze("scripts/out/audio_2_dipan_full.wav")
