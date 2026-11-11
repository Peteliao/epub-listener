import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateBookLexicon } from '../../src/core/tts/bookLexicon';

const root = process.cwd();
const lexiconText = readFileSync(resolve(root, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt'), 'utf8');
const tokensText = readFileSync(resolve(root, 'public/models/matcha-icefall-zh-baker/tokens.txt'), 'utf8');
const curatedOverlay = readFileSync(resolve(root, 'src/core/tts/polyphones.v1.txt'), 'utf8');

const ming = readFileSync(resolve(root, 'scripts/out/ming.txt'), 'utf8');
const lines = ming.split('\n').filter(Boolean);
const result = generateBookLexicon({
  chunks: lines,
  lexiconText,
  tokensText,
  curatedOverlay,
});

console.log('Total generated entries:', result.entries.length);
for (const entry of result.entries) {
  if (['地盘', '占便宜', '便宜', '会计', '学会计', '点地'].some(w => entry.word.includes(w))) {
    console.log('MATCH:', entry.word, entry.reading);
  }
}
