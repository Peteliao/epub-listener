"""F0 contour check for the pian2 phoneme diagnosis.

The duration/island measurements say *whether* a syllable sounds; pitch says
*whether it is the right tone*. pian2 is a rising (yangping) tone, so an
isolated 便 should show a rising F0 inside a single voiced stretch.
"""
import glob
import math
import os
import struct
import wave

DIR = os.path.join('scripts', 'out', 'audio', 'pian2')


def read_wav(path):
    with wave.open(path, 'rb') as wav:
        rate = wav.getframerate()
        frames = wav.getnframes()
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        raw = wav.readframes(frames)
    if width == 2:
        values = struct.unpack(f'{frames * channels}h', raw)
    elif width == 4:
        values = struct.unpack(f'{frames * channels}f', raw)
    else:
        raise ValueError(f'unsupported sample width {width}')
    mono = [float(v) for v in values[::channels]]
    peak = max((abs(v) for v in mono), default=0) or 1
    return [v / peak for v in mono], rate


def f0_contour(samples, rate):
    win = int(rate * 0.04)
    step = int(rate * 0.01)
    min_lag, max_lag = rate // 450, rate // 150
    result = []
    for start in range(0, len(samples) - win, step):
        frame = samples[start:start + win]
        rms = math.sqrt(sum(v * v for v in frame) / win)
        if rms < 0.06:
            result.append((start / rate * 1000, 0.0))
            continue
        energy = sum(v * v for v in frame[:win - max_lag])
        best_lag, best_corr = 0, 0.0
        for lag in range(min_lag, max_lag):
            corr = sum(frame[j] * frame[j + lag] for j in range(win - max_lag))
            if corr > best_corr:
                best_corr, best_lag = corr, lag
        voiced = energy > 0 and best_corr / energy > 0.55
        result.append((start / rate * 1000, rate / best_lag if voiced and best_lag else 0.0))
    return result


def voiced_segments(contour):
    segments, current = [], []
    for time_ms, hz in contour:
        if hz > 0:
            current.append((time_ms, hz))
        elif current:
            segments.append(current)
            current = []
    if current:
        segments.append(current)
    return [s for s in segments if len(s) >= 4]


for path in sorted(glob.glob(os.path.join(DIR, '*.wav'))):
    samples, rate = read_wav(path)
    segments = voiced_segments(f0_contour(samples, rate))
    name = os.path.basename(path).replace('.wav', '')
    print(f'\n{name}: {len(segments)} 段浊音 · {len(samples) / rate * 1000:.0f}ms')
    for seg in segments[:6]:
        head = sum(hz for _, hz in seg[:3]) / 3
        tail = sum(hz for _, hz in seg[-3:]) / 3
        slope = '升' if tail - head > 12 else ('降' if head - tail > 12 else '平')
        print(f'  {seg[0][0]:6.0f}-{seg[-1][0]:6.0f}ms  '
              f'F0 {head:5.1f}→{tail:5.1f}Hz ({slope}, 跨度 {seg[-1][0]-seg[0][0]:.0f}ms)')
