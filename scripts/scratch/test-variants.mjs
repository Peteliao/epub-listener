import { createMatchaSynth } from '../lib/matchaSynth.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs';
import { caseStream, boundaryVariants } from '../lib/omission.mjs';

const original = readFileSync('public/models/matcha-icefall-zh-baker/lexicon.v3.txt', 'utf8');
const baseOverlay = readFileSync('src/core/tts/polyphones.v1.txt', 'utf8');

async function testVariant(reading) {
  const overlayLines = baseOverlay.split(/\r?\n/).map(l => {
    const t = l.trim();
    if (t.startsWith('占便宜 ')) return '占便宜 ' + reading;
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
  const text = '正因如此，一些会占便宜的有钱人长期地用盐不给钱。';
  const res = synth.generateText(text);
  synth.save('scripts/out/test-' + reading.replace(/[^a-zA-Z0-9]/g, '_') + '.wav', res);
  synth.free();
  return res;
}

async function run() {
  const variants = [
    '" zhan4 pian2 yi2',
    'zhan4 pian2 yi2',
    'zhan4 pian2 yi',
    '" zhan4 pian2 yi',
    'zhan4 pian2 yi "',
    'zhan4 pian2 yi2 "'
  ];
  for (const v of variants) {
    const res = await testVariant(v);
    console.log(v, 'samples:', res.samples.length, 'duration ms:', Math.round(res.samples.length / res.sampleRate * 1000));
  }
}
run().catch(console.error);
