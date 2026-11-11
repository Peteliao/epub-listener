import { createMatchaSynth } from '../lib/matchaSynth.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const original = readFileSync('public/models/matcha-icefall-zh-baker/lexicon.v3.txt', 'utf8');
const baseOverlay = readFileSync('src/core/tts/polyphones.v1.txt', 'utf8');

async function testVariant(reading) {
  const overlayLines = baseOverlay.split(/\r?\n/).map(l => {
    const t = l.trim();
    if (t.startsWith('地盘 ')) return '地盘 ' + reading;
    return t;
  }).filter(l => l && !l.startsWith('#'));
  const overlayWords = new Set(overlayLines.map(l => l.split(/\s+/)[0]));
  const kept = original.split(/\r?\n/).filter(l => {
    const t = l.trim();
    return t && !overlayWords.has(t.split(/\s+/)[0]);
  });
  const patched = kept.join('\n') + '\n' + overlayLines.join('\n') + '\n';
  writeFileSync('scripts/out/tmp-test-lexicon.txt', patched, 'utf8');

  const synth = await createMatchaSynth({
    quiet: true,
    lexiconPath: 'scripts/out/tmp-test-lexicon.txt'
  });
  
  const text1 = '朱元璋对张士诚极为头疼，自己只是占了点地盘；';
  const text2 = '当时徐寿辉的地盘很小，只有黄州和浠水这一片地方，';
  const text3 = '地盘';
  
  const res1 = synth.generateText(text1);
  const res2 = synth.generateText(text2);
  const res3 = synth.generateText(text3);
  
  const name = reading.replace(/[^a-zA-Z0-9]/g, '_');
  synth.save(`scripts/out/dipan1_${name}.wav`, res1);
  synth.save(`scripts/out/dipan2_${name}.wav`, res2);
  synth.save(`scripts/out/dipan3_${name}.wav`, res3);
  
  synth.free();
  console.log(`Saved for ${reading}`);
}

async function run() {
  const variants = [
    '" di4 pan2',
    'di4 pan2',
    'di4 pan2 "',
    '" di4 pan2 "',
  ];
  for (const v of variants) {
    await testVariant(v);
  }
}
run().catch(console.error);
