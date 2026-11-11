import wave
import struct
import math

def get_f0(wav_path):
    w = wave.open(wav_path, 'rb')
    sr = w.getframerate()
    n = w.getnframes()
    raw = w.readframes(n)
    w.close()
    samples = struct.unpack(f"{n}h", raw)
    
    # window size: 40ms, step 10ms
    win = int(sr * 0.04)
    step = int(sr * 0.01)
    
    # Pitch range for female voice: 150 - 450 Hz
    min_lag = int(sr / 450)
    max_lag = int(sr / 150)
    
    pitches = []
    for i in range(0, len(samples) - win, step):
        chunk = samples[i:i+win]
        rms = math.sqrt(sum(s*s for s in chunk) / win)
        if rms < 800:
            pitches.append((i / sr * 1000, 0, rms))
            continue
        
        # autocorrelation
        best_corr = 0
        best_lag = 0
        # energy at 0
        r0 = sum(chunk[j]*chunk[j] for j in range(win - max_lag))
        for lag in range(min_lag, max_lag):
            corr = sum(chunk[j]*chunk[j+lag] for j in range(win - max_lag))
            if corr > best_corr:
                best_corr = corr
                best_lag = lag
        
        if r0 > 0 and best_corr / r0 > 0.4:
            f0 = sr / best_lag
            pitches.append((i / sr * 1000, f0, rms))
        else:
            pitches.append((i / sr * 1000, 0, rms))
    return pitches

def show_f0(wav_path, t_start, t_end):
    pitches = get_f0(wav_path)
    print(f"\nF0 for {wav_path} ({t_start} - {t_end}ms):")
    for t_ms, f0, rms in pitches:
        if t_start <= t_ms <= t_end:
            if f0 > 0:
                print(f"  {t_ms:6.1f}ms: F0={f0:5.1f}Hz, rms={rms:5.0f}")
            else:
                print(f"  {t_ms:6.1f}ms: unvoiced (rms={rms:5.0f})")

show_f0("scripts/out/dipan3___di4_pan2.wav", 200, 700)
show_f0("scripts/out/dipan3_di4_pan2.wav", 200, 700)
show_f0("scripts/out/dipan3_di4_pan2__.wav", 200, 700)
