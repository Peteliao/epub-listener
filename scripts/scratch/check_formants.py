import wave
import struct
import numpy as np

def estimate_formants(samples, sr):
    # Using LPC
    # Pre-emphasis
    d = np.append(samples[0], samples[1:] - 0.97 * samples[:-1])
    # Hamming window
    win = d * np.hamming(len(d))
    # Autocorrelation
    n_lpc = 2 + int(sr / 1000)
    # Solve Yule-Walker / Levinson-Durbin
    r = np.correlate(win, win, mode='full')
    r = r[len(win)-1:len(win)-1+n_lpc+1]
    
    # Levinson-Durbin
    a = np.zeros(n_lpc + 1)
    e = r[0]
    a[0] = 1.0
    for i in range(1, n_lpc + 1):
        k = -sum(a[j] * r[i - j] for j in range(i)) / e
        a[1:i] = a[1:i] + k * a[i-1:0:-1]
        a[i] = k
        e *= (1.0 - k * k)
        
    roots = np.roots(a)
    roots = [rt for rt in roots if np.imag(rt) >= 0.01]
    angles = np.arctan2(np.imag(roots), np.real(roots))
    freqs = sorted(angles * (sr / (2 * np.pi)))
    return freqs

def check_wav(wav_path, t_start, t_end):
    w = wave.open(wav_path, 'rb')
    sr = w.getframerate()
    n = w.getnframes()
    raw = w.readframes(n)
    w.close()
    samples = np.array(struct.unpack(f"{n}h", raw), dtype=float)
    
    st_idx = int(t_start * sr / 1000)
    en_idx = int(t_end * sr / 1000)
    clip = samples[st_idx:en_idx]
    
    # frame 30ms
    win_len = int(sr * 0.03)
    step = int(sr * 0.01)
    print(f"\nFormants for {wav_path} ({t_start} - {t_end}ms):")
    for i in range(0, len(clip) - win_len, step):
        t = t_start + i / sr * 1000
        frm = clip[i:i+win_len]
        rms = np.sqrt(np.mean(frm**2))
        if rms < 1000: continue
        freqs = estimate_formants(frm, sr)
        f_str = ", ".join(f"{f:.0f}Hz" for f in freqs[:4])
        print(f"  {t:5.1f}ms (rms={rms:5.0f}): {f_str}")

check_wav("scripts/out/dipan3___di4_pan2.wav", 250, 360)
check_wav("scripts/out/dipan3_di4_pan2.wav", 330, 450)
