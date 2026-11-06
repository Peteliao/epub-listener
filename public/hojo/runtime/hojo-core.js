// Browser/Node port of HojoAI/Hojo-TTS-Light-40M onnx_model.py (Apache-2.0).
(function (root) {
  const N_FFT = 1920, HOP = 480, SR = 24000, SLOTS = 16, H = 512;

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function sample(logits, { temperature, topP, generated, repPen, rand }) {
    const row = Float32Array.from(logits);
    if (repPen !== 1 && generated.length) for (const id of new Set(generated)) { const v = row[id]; row[id] = v > 0 ? v / repPen : v * repPen; }
    if (temperature <= 0) { let b = 0; for (let i = 1; i < row.length; i++) if (row[i] > row[b]) b = i; return b; }
    let mx = -Infinity; for (let i = 0; i < row.length; i++) { row[i] /= temperature; if (row[i] > mx) mx = row[i]; }
    let sum = 0; for (let i = 0; i < row.length; i++) { row[i] = Math.exp(row[i] - mx); sum += row[i]; }
    const idx = Array.from(row.keys()).filter(i => row[i] / sum > 1e-9).sort((a, b) => row[b] - row[a]);
    let keep = idx, cum = 0;
    if (topP < 1) { for (let j = 0; j < idx.length; j++) { cum += row[idx[j]] / sum; if (cum > topP) { keep = idx.slice(0, j + 1); break; } } }
    let ks = 0; for (const i of keep) ks += row[i];
    let r = rand() * ks; for (const i of keep) { r -= row[i]; if (r <= 0) return i; }
    return keep[keep.length - 1];
  }

  let fft = null;
  function tables() {
    if (fft) return fft;
    const cos = new Float64Array(N_FFT), sin = new Float64Array(N_FFT), win = new Float32Array(N_FFT);
    const radices = [2, 2, 2, 2, 2, 2, 2, 3, 5], stages = [], permutation = new Uint16Array(N_FFT);
    let size = 1;
    for (const radix of radices) { stages.push({ radix, size, step: N_FFT / (size * radix) }); size *= radix; }
    for (let i = 0; i < N_FFT; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / N_FFT); sin[i] = Math.sin(2 * Math.PI * i / N_FFT);
      win[i] = 0.5 - 0.5 * cos[i];
      let digits = i, stride = N_FFT, index = 0;
      for (const radix of radices) { stride /= radix; index += (digits % radix) * stride; digits = Math.floor(digits / radix); }
      permutation[index] = i;
    }
    fft = { cos, sin, win, stages, permutation, re: new Float64Array(N_FFT), im: new Float64Array(N_FFT),
      workRe: new Float64Array(5), workIm: new Float64Array(5), frame: new Float32Array(N_FFT) };
    return fft;
  }
  function inverseFft(plan) {
    const { re, im, cos, sin, stages, workRe, workIm } = plan;
    for (const { radix, size, step } of stages) {
      const block = size * radix;
      for (let start = 0; start < N_FFT; start += block) {
        for (let k = 0; k < size; k++) {
          const first = start + k;
          if (radix === 2) {
            const second = first + size, angle = k * step;
            const r = re[second] * cos[angle] - im[second] * sin[angle];
            const i = re[second] * sin[angle] + im[second] * cos[angle];
            re[second] = re[first] - r; im[second] = im[first] - i;
            re[first] += r; im[first] += i;
          } else {
            for (let j = 0; j < radix; j++) {
              let r = re[first], i = im[first];
              const angle = (k + j * size) * step;
              for (let q = 1; q < radix; q++) {
                const index = first + q * size, twiddle = q * angle % N_FFT;
                r += re[index] * cos[twiddle] - im[index] * sin[twiddle];
                i += re[index] * sin[twiddle] + im[index] * cos[twiddle];
              }
              workRe[j] = r; workIm[j] = i;
            }
            for (let j = 0; j < radix; j++) { re[first + j * size] = workRe[j]; im[first + j * size] = workIm[j]; }
          }
        }
      }
    }
  }
  function istft(mag, phase, T) {
    const plan = tables(), { re, im, win, permutation, frame } = plan;
    const K = N_FFT / 2 + 1, pad = (N_FFT - HOP) / 2;
    const outLen = (T - 1) * HOP + N_FFT, y = new Float32Array(outLen), env = new Float32Array(outLen);
    for (let t = 0; t < T; t++) {
      for (let k = 0; k < K; k++) {
        let m = mag[k * T + t]; m = Math.min(Math.max(m, 1e-12), 100); const p = phase[k * T + t];
        // Keep the decoder's Float32 spectrum rounding; use doubles only inside the FFT.
        const r = Math.fround(m * Math.cos(p)), i = Math.fround(m * Math.sin(p)), index = permutation[k];
        re[index] = r; im[index] = k === 0 || k === K - 1 ? 0 : i;
        if (k > 0 && k < K - 1) { const mirror = permutation[N_FFT - k]; re[mirror] = r; im[mirror] = -i; }
      }
      inverseFft(plan);
      for (let n = 0; n < N_FFT; n++) frame[n] = re[n] / N_FFT * win[n];
      const st = t * HOP;
      for (let n = 0; n < N_FFT; n++) { y[st + n] += frame[n]; env[st + n] += win[n] * win[n]; }
    }
    const L = outLen - 2 * pad, out = new Float32Array(L);
    for (let i = 0; i < L; i++) out[i] = y[i + pad] / env[i + pad];
    return out;
  }

  class HojoTTS {
    constructor({ ort, lm, fine, dec, tokenizer, emb, voices }) {
      Object.assign(this, { ort, lm, fine, dec, tokenizer, emb, voices });
      this.audio = new Uint8Array(voices.vocab); for (const i of voices.audio_token_ids) this.audio[i] = 1;
    }
    embed(ids) { const o = new Float32Array(ids.length * H); ids.forEach((id, j) => o.set(this.emb.subarray(id * H, id * H + H), j * H)); return o; }
    async generate(text, voice, { temperature = 0.8, topP = 0.95, repPen = 1.1, seed = 42, maxNew = 2048, minNew = 10, onProgress, shouldStop } = {}) {
      const { ort } = this, V = this.voices, vi = V.voice_ids.indexOf(voice);
      if (vi < 0) throw new Error('Unknown voice ' + voice);
      const stopped = () => { if (shouldStop && shouldStop()) { const error = new Error('语音合成已取消。'); error.name = 'AbortError'; throw error; } };
      const prompt = `[target_text_start]${text}[target_text_end][spk_start]${Array.from({ length: SLOTS }, (_, i) => `[spk_emb_${i}]`).join('')}[spk_end][target_speech_start]`;
      const ids = Array.from(this.tokenizer.encode(prompt)).map(Number);
      const L = ids.length, rand = mulberry32(seed);
      const x = this.embed(ids); const s0 = ids.indexOf(V.spk_start_id) + 1;
      for (let s = 0; s < SLOTS && s0 + s < L; s++) x.set(V.speaker_embeds[vi][s], (s0 + s) * H);
      const T = (d, dims, type = 'float32') => new ort.Tensor(type, d, dims);
      let feed = { inputs_embeds: T(x, [1, L, H]), position_ids: T(BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, L], 'int64') };
      for (let l = 0; l < V.num_layers; l++) { feed[`past_key_values.${l}.key`] = T(new Float32Array(0), [1, 1, 0, 128]); feed[`past_key_values.${l}.value`] = T(new Float32Array(0), [1, 1, 0, 128]); }
      const hidden = []; const gen = []; let cur = L, next;
      const step = async () => {
        const out = await this.lm.run(feed);
        const lg = out.logits, n = lg.dims[1], Vs = lg.dims[2];
        hidden.push(out.last_hidden_state.data);
        const last = lg.data.subarray((n - 1) * Vs, n * Vs);
        next = sample(last, { temperature, topP, generated: gen, repPen, rand }); gen.push(next);
        const f = {}; for (let l = 0; l < V.num_layers; l++) { f[`past_key_values.${l}.key`] = out[`present.${l}.key`]; f[`past_key_values.${l}.value`] = out[`present.${l}.value`]; }
        return f;
      };
      let past = await step();
      stopped();
      for (let i = 0; i < maxNew - 1; i++) {
        stopped();
        if (gen.length >= minNew && next === V.speech_end_id) break;
        feed = { inputs_embeds: T(this.embed([next]), [1, 1, H]), position_ids: T(BigInt64Array.from([BigInt(cur)]), [1, 1], 'int64'), ...past };
        past = await step(); cur++;
        stopped();
        if (onProgress && i % 8 === 0) await onProgress(gen.length);
      }
      stopped();
      // positions of audio tokens (before speech_end)
      let end = gen.indexOf(V.speech_end_id); if (end < 0) end = gen.length;
      const pos = []; for (let j = 0; j < end; j++) if (this.audio[gen[j]]) pos.push(L + j);
      if (!pos.length) throw new Error('No audio tokens generated');
      const allHidden = new Float32Array(hidden.reduce((a, h) => a + h.length, 0)); let o = 0; for (const h of hidden) { allHidden.set(h, o); o += h.length; }
      const full = ids.concat(gen), F = pos.length;
      const hs = new Float32Array(F * H); pos.forEach((p, j) => hs.set(allHidden.subarray((p - 1) * H, p * H), j * H));
      const ce = this.embed(pos.map(p => full[p]));
      stopped();
      const fl = await this.fine.run({ hidden_states: T(hs, [1, F, H]), coarse_embeddings: T(ce, [1, F, H]),
        speaker_embedding: T(Float32Array.from(V.speaker_vecs[vi]), [1, 192]), valid_mask: T(new Uint8Array(F).fill(1), [1, F], 'bool') });
      stopped();
      const bl = fl.binary_logits.data, bits = new Float32Array(bl.length); for (let i = 0; i < bl.length; i++) bits[i] = bl[i] > 0 ? 1 : -1;
      const d = await this.dec.run({ bits: T(bits, [F, 128]) });
      stopped();
      const Tm = d.mag.dims[1];
      const wav = istft(d.mag.data, d.phase.data, Tm);
      return { wav, sampleRate: SR, tokens: gen.length, frames: F };
    }
  }
  function toWav(wav, sr) {
    const buf = new ArrayBuffer(44 + wav.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + wav.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, wav.length * 2, true);
    for (let i = 0; i < wav.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, wav[i])) * 32767, true);
    return buf;
  }
  function f16ToF32(u16) {
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const h = u16[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return out;
  }
  const api = { HojoTTS, istft, sample, toWav, f16ToF32, SR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Hojo = api;
})(typeof self !== 'undefined' ? self : this);
