#!/usr/bin/env node
// Debug-log probe for the high-tier spike. Run in a child process so the raw
// Emscripten stdout/stderr can be captured reliably (it bypasses console.log).
// Usage: node phoneme-direct-log.mjs tokens|text
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const mode = process.argv[2] === 'text' ? 'text' : 'tokens'
const synth = await createMatchaSynth({ quiet: false, debug: true })
try {
  if (mode === 'tokens') synth.generate(['xue2', 'kuai4', 'ji4'])
  else synth.generateText('会计')
} finally {
  synth.free()
}
