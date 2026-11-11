import { createMatchaSynth } from '../lib/matchaSynth.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const original = readFileSync('public/models/matcha-icefall-zh-baker/lexicon.v3.txt', 'utf8');
const overlay = readFileSync('src/core/tts/polyphones.v1.txt', 'utf8');

const overlayLines = overlay.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const overlayWords = new Set(overlayLines.map(l => l.split(/\s+/)[0]));
const kept = original.split(/\r?\n/).filter(l => {
  const t = l.trim();
  return t && !overlayWords.has(t.split(/\s+/)[0]);
});
const patched = kept.join('\n') + '\n' + overlayLines.join('\n') + '\n';
writeFileSync('scripts/out/test-synth-lexicon.txt', patched, 'utf8');

const synth = await createMatchaSynth({
  quiet: true,
  lexiconPath: 'scripts/out/test-synth-lexicon.txt'
});

const items = [
  { name: '1_zhanpianyi_full', text: '正因如此，一些会占便宜的有钱人长期地用盐不给钱；' },
  { name: '1_zhanpianyi_short', text: '会占便宜' },
  { name: '1_pianyi_word', text: '便宜' },
  { name: '2_dipan_full', text: '朱元璋对张士诚极为头疼，自己只是占了点地盘；' },
  { name: '2_dipan_word', text: '地盘' },
  { name: '3_kuaiji_full', text: '朱文正可能是学会计出身的，' },
  { name: '3_kuaiji_word', text: '会计' },
  { name: '3_xuekuaiji_word', text: '学会计' },
];

for (const item of items) {
  const res = synth.generateText(item.text);
  synth.save(`scripts/out/audio_${item.name}.wav`, res);
  console.log(`Saved audio_${item.name}.wav, duration: ${Math.round(res.samples.length / res.sampleRate * 1000)}ms`);
}

synth.free();
