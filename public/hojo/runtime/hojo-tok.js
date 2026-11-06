// Minimal tokenizer equivalent to Hojo-TTS-Light tokenizer.json (BPE, 135 merges).
(function (root) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  class HojoTokenizer {
    constructor(j) {
      this.vocab = j.vocab; this.special = j.special; this.norm = j.normalized;
      this.ranks = new Map(j.merges.map((m, i) => [m, i]));
      const alt = o => new RegExp('(' + Object.keys(o).sort((a, b) => b.length - a.length).map(esc).join('|') + ')');
      this.reSpecial = alt(this.special); this.reNorm = alt(this.norm);
      this.cache = new Map();
    }
    bpe(word) {
      if (this.cache.has(word)) return this.cache.get(word);
      let parts = Array.from(word);
      while (parts.length > 1) {
        let best = -1, bi = -1;
        for (let i = 0; i < parts.length - 1; i++) { const r = this.ranks.get(parts[i] + ' ' + parts[i + 1]); if (r !== undefined && (best < 0 || r < best)) { best = r; bi = i; } }
        if (bi < 0) break;
        const a = parts[bi], b = parts[bi + 1], np = [];
        for (let i = 0; i < parts.length; i++) { if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) { np.push(a + b); i++; } else np.push(parts[i]); }
        parts = np;
      }
      const ids = parts.map(p => this.vocab[p] ?? 0); this.cache.set(word, ids); return ids;
    }
    encodePlain(text, out) {
      text = text.toLowerCase().replace(/\s+/gu, ' ');
      for (const seg of text.split(this.reNorm)) {
        if (!seg) continue;
        if (seg in this.norm) { out.push(this.norm[seg]); continue; }
        const pieces = seg.split(/(\p{Nd})/u).filter(Boolean);
        for (const p of pieces) {
          const m = p.match(/\s+|[\p{L}\p{M}\p{N}\p{Pc}]+|[^\s\p{L}\p{M}\p{N}\p{Pc}]+/gu) || [];
          for (const w of m) out.push(...this.bpe(w));
        }
      }
    }
    encode(text) {
      const out = [];
      for (const seg of text.split(this.reSpecial)) {
        if (!seg) continue;
        if (seg in this.special) out.push(this.special[seg]); else this.encodePlain(seg, out);
      }
      return out;
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { HojoTokenizer }; else root.HojoTokenizer = HojoTokenizer;
})(typeof self !== 'undefined' ? self : this);
