#!/usr/bin/env node
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const lexicon = process.argv.find((arg) => arg.startsWith('--lexicon='))?.slice(10)
const text = process.argv.find((arg) => arg.startsWith('--text='))?.slice(7)
if (!lexicon || text === undefined) throw new Error('缺少 --lexicon 或 --text')
const synth = await createMatchaSynth({ lexiconPath: lexicon, debug: true })
try {
  const audio = synth.generateText(text)
  console.log(`ACOUSTIC_NATIVE_RESULT=${JSON.stringify({
    durationMs: Math.round(audio.samples.length / audio.sampleRate * 1000),
  })}`)
} finally {
  synth.free()
}
