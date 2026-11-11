import wave
import struct
import math

def analyze(wav_path):
    w = wave.open(wav_path, 'rb')
    nchannels, sampwidth, framerate, nframes, comptype, compname = w.getparams()
    raw = w.readframes(nframes)
    w.close()
    
    samples = struct.unpack(f"{nframes}h", raw)
    
    # 20ms frames
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
    # print significant frames
    peaks = []
    for t_ms, rms in energies:
        if rms > 500: # audible
            bar = '#' * int(rms / 1000)
            print(f"{t_ms:6.1f}ms: rms={rms:6.1f} {bar}")

analyze("scripts/out/audio_2_dipan_word.wav")
analyze("scripts/out/audio_1_pianyi_word.wav")
analyze("scripts/out/audio_1_zhanpianyi_short.wav")
