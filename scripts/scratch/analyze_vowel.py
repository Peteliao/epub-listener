"""Estimate F1/F2 of the vowel in the rendered 地/的 reference WAVs.

Pure Python (no numpy): read the WAV, find voiced segments, take a frame near
the vowel centre, FFT, smooth the magnitude into a spectral envelope and pick
the first two broad peaks. /i/ (di) has a low F1 and a high F2; the particle
/de/ has a mid F1 and a much lower F2.
"""
import cmath
import json
import math
import os
import struct
import wave

DIR = os.path.join('scripts', 'out', 'audio', 'vowel-di')


def read_wav(path):
    with wave.open(path, 'rb') as wav:
        rate = wav.getframerate()
        frames = wav.getnframes()
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        raw = wav.readframes(frames)
    if width == 2:
        values = struct.unpack(f'{frames * channels}h', raw)
        mono = [v / 32768.0 for v in values[::channels]]
    elif width == 4:
        values = struct.unpack(f'{frames * channels}f', raw)
        mono = [float(v) for v in values[::channels]]
    else:
        raise ValueError(f'unsupported sample width {width}')
    return rate, mono


def downsample(rate, samples, target=11025):
    if rate <= target:
        return rate, samples
    factor = max(1, round(rate / target))
    out = []
    for i in range(0, len(samples) - factor + 1, factor):
        out.append(sum(samples[i:i + factor]) / factor)
    return rate / factor, out


def fft(values):
    n = len(values)
    if n == 1:
        return [complex(values[0])]
    even = fft(values[0::2])
    odd = fft(values[1::2])
    result = [0j] * n
    for k in range(n // 2):
        t = cmath.exp(-2j * math.pi * k / n) * odd[k]
        result[k] = even[k] + t
        result[k + n // 2] = even[k] - t
    return result


def voiced_segments(rate, samples, frame_ms=20, threshold_ratio=0.12):
    win = max(1, int(rate * frame_ms / 1000))
    rms = []
    for i in range(0, len(samples) - win + 1, win):
        chunk = samples[i:i + win]
        rms.append(math.sqrt(sum(v * v for v in chunk) / win))
    if not rms:
        return []
    peak = max(rms)
    if peak <= 0:
        return []
    threshold = peak * threshold_ratio
    segments = []
    start = None
    gap = 0
    for index, value in enumerate(rms):
        if value > threshold:
            if start is None:
                start = index
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= 2:
                segments.append((start * win, (index - gap + 1) * win))
                start = None
    if start is not None:
        segments.append((start * win, len(rms) * win))
    return [(a, b) for a, b in segments if b - a >= int(rate * 0.04)]


def spectrum(rate, frame):
    n = 2048
    if len(frame) < n:
        frame = frame + [0.0] * (n - len(frame))
    else:
        centre = (len(frame) - n) // 2
        frame = frame[centre:centre + n]
    windowed = [
        frame[i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1)))
        for i in range(n)
    ]
    bins = fft(windowed)
    return [abs(bins[i]) for i in range(n // 2)]


def smooth(values, radius=10):
    out = []
    for i in range(len(values)):
        lo = max(0, i - radius)
        hi = min(len(values), i + radius + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def peaks(rate, magnitude, lo_hz, hi_hz):
    n = 2048
    lo = int(lo_hz / (rate / n))
    hi = min(len(magnitude) - 1, int(hi_hz / (rate / n)))
    best = max(range(lo, hi), key=lambda i: magnitude[i])
    return best * rate / n, magnitude[best]


def analyse(path, pick):
    rate, samples = read_wav(path)
    rate, samples = downsample(rate, samples)
    segments = voiced_segments(rate, samples)
    if not segments:
        return None
    start, end = segments[0] if pick == 'first' else segments[-1]
    # Fixed vowel window 100-180ms after the syllable onset. Fraction-of-segment
    # went wrong when two syllables merged into one energy island (地图: the 55%
    # frame landed on the /u/ of 图).
    mags = []
    for offset_ms in (100, 140, 180):
        centre = start + int(rate * offset_ms / 1000)
        half = int(rate * 0.03)
        frame = samples[max(0, centre - half):min(len(samples), centre + half)]
        mags.append(spectrum(rate, frame))
    averaged = [sum(items) / len(items) for items in zip(*mags)]
    envelope = smooth(averaged, radius=12)
    f1, m1 = peaks(rate, envelope, 200, 1000)
    # F2 must sit clearly above F1.
    lo = max(900, int(f1 + 250))
    f2, m2 = peaks(rate, envelope, lo, 3200)
    total = sum(envelope) or 1
    centroid = sum(i * value for i, value in enumerate(envelope)) / total * rate / 2048
    return {
        'first_f1': round(f1),
        'f2': round(f2),
        'f2_db': round(20 * math.log10((m2 or 1e-9) / (max(envelope) or 1e-9)), 1),
        'centroid_hz': round(centroid),
        'segments': len(segments),
        'ms': round(len(samples) / rate * 1000),
    }


def main():
    manifest = json.load(open(os.path.join(DIR, 'manifest.json'), encoding='utf8'))
    print(f"{'label':18} {'F1':>5} {'F2':>6} {'centroid':>9}  判断")
    for item in manifest:
        pick = 'last' if item['label'].startswith('huang1') else 'first'
        result = analyse(os.path.join(DIR, item['file']), pick)
        if not result:
            print(f"{item['label']:18} no voiced segment")
            continue
        f2 = result['f2']
        verdict = 'F2 高 → /i/ (di)' if f2 >= 1900 else ('F2 低 → /ə/ (de)' if f2 <= 1700 else '边界区')
        print(f"{item['label']:18} {result['first_f1']:5} {f2:6} {result['centroid_hz']:9}  {verdict}")


if __name__ == '__main__':
    main()
