import { createMatchaSynth } from '../lib/matchaSynth.mjs';
import { caseStream } from '../lib/omission.mjs';
import { loadMatchaAssets } from '../lib/reading.mjs';

const assets = await loadMatchaAssets();
const sentence = '正因如此，一些会占便宜的有钱人长期地用盐不给钱。';
const stream = caseStream(sentence, '占便宜', assets);
console.log('Stream tokens:', stream.tokens);
console.log('Range:', stream.range);

const synth = await createMatchaSynth({ quiet: true });

// Measure contributions of target word syllables under different token sequences
const variants = [
  { name: 'current (lead quote yi2)', tokens: stream.tokens },
  { name: 'lead quote yi', tokens: stream.tokens.map(t => t === 'yi2' ? 'yi' : t) },
  { name: 'no quote yi2', tokens: stream.tokens.filter(t => t !== '"') },
  { name: 'no quote yi', tokens: stream.tokens.filter(t => t !== '"').map(t => t === 'yi2' ? 'yi' : t) },
];

for (const v of variants) {
  // Find indices of zhan4, pian2, yi in v.tokens
  const idxZhan = v.tokens.indexOf('zhan4');
  const idxPian = v.tokens.indexOf('pian2');
  const idxYi = v.tokens.findIndex((t, i) => i > idxPian && (t === 'yi' || t === 'yi2'));
  const vals = synth.contributions(v.tokens, [idxZhan, idxPian, idxYi]);
  console.log(v.name, '-> [zhan, pian, yi]:', vals.map(x => Math.round(x) + 'ms'));
}

synth.free();
