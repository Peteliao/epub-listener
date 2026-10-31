# Third-party notices — offline TTS

## Sherpa-onnx WebAssembly runtime

- Package: `sherpa-onnx@2.0.0` (Apache-2.0)
- Source: https://github.com/k2-fsa/sherpa-onnx
- Upstream files: `sherpa-onnx-wasm-nodejs.js`, `sherpa-onnx-wasm-nodejs.wasm`, `sherpa-onnx-tts.js`
- Local changes: the Emscripten glue is patched so it keeps MEMFS in browsers
  instead of initializing NODERAWFS. A small `path` shim is supplied by
  `public/workers/sherpa-tts.worker.js`. No inference code was modified.
- The runtime keeps the upstream 512MB initial WebAssembly memory. AI playback
  is optional and automatically falls back to system speech if initialization
  fails.

The same runtime serves every voice pack. It is downloaded once, verified
against SHA-256, and cached separately from the model files so adding another
voice does not download the runtime again.

## Voice packs

All model files are self-hosted under `public/models/` so the app can download
and verify them from the same origin. Every file's byte size and SHA-256 are
recorded in `public/models/manifest.json` and checked both before caching and
again when the worker loads the files into memory.

### 山岚 — `matcha-icefall-zh-baker`

- Model: Matcha-TTS Chinese acoustic model with the 22.05 kHz Vocos vocoder,
  published in the sherpa-onnx `tts-models` release.
- Source: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
- Training data: Baker Chinese corpus.
- License: **non-commercial use only**. The app shows this notice before
  download and the voice cannot be presented as commercially licensed.
- Voice: `shanlan`, speaker 0, 22,050 Hz.

### 小雅 — `piper-zh-xiaoya`

- Model: Piper VITS `zh_CN-xiao_ya-medium` (single speaker, 22,050 Hz).
- Source: https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/xiao_ya/medium
- Training data: BZNSYP (Baker Chinese female corpus), distributed by
  DataBaker: https://huggingface.co/openspeech/BZNSYP.
- License: **non-commercial use only**, as stated in the model card and the
  DataBaker TTS terms (https://www.data-baker.com/data/index/TNtts/). The Piper
  model repository and shared frontend files are MIT, but the training-data
  restriction governs this voice.
- Voice: `xiaoya`, speaker 0, 22,050 Hz.
- It uses the same BZNSYP corpus family as 山岚 but a Piper VITS acoustic model
  and pinyin frontend instead of Matcha + Vocos, so it is a distinct rendition
  rather than a new speaker.

### 初晴 — `piper-zh-chaowen`

- Model: Piper VITS `zh_CN-chaowen-medium` (single speaker, 22,050 Hz).
- Source: https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/chaowen/medium
- Training data: the Chaowen dataset from
  https://github.com/OHF-Voice/voice-datasets, released under **CC0**.
- Model license: the `rhasspy/piper-voices` model repository is **MIT**.
- Frontend: Piper Chinese lexicon, tokens, and phone/date/number FST files
  (MIT).
- Commercial use: permitted by the above licenses. Attribution is retained
  here and in the in-app license notice.
- Voice: `chuqing`, speaker 0, 22,050 Hz.

### AISHELL-3 精选 — `piper-zh-aishell3`

- Model: community Piper VITS conversion `zh_CN-cn_aishell3-medium`
  (174 speakers, 22,050 Hz).
- Source: https://huggingface.co/writeAPoemForYou/piper-voices-zh-AISHELL-3
- Training data: AISHELL-3, https://www.openslr.org/93/, released under
  **Apache-2.0**.
- Model license: **Apache-2.0** (the voice repository above). The shared Piper
  frontend files (lexicon, tokens, FSTs) are **MIT**.
- Commercial use: permitted. The app exposes four curated speakers:
  - `aishell3-qinghe` (青禾), speaker 170
  - `aishell3-zhaoyue` (照月), speaker 71
  - `aishell3-songtao` (松涛), speaker 14
  - `aishell3-yuanchuan` (远川), speaker 36

### 英文 Kristin — `piper-en-kristin`

- Model: Piper VITS `en_US-kristin-medium` (single speaker, 22,050 Hz),
  published in the sherpa-onnx `tts-models` release.
- Source: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
- Training data: about 11.5 hours of LibriVox recordings, which are in the
  **public domain**.
- Model license: **public domain data / MIT** (Piper model repository).
- English frontend: `lexicon-en-us.txt` (word-to-phone entries generated from
  CMUDict, which is BSD-2-Clause, plus supplementary word lists) and
  `tokens.txt` (Piper, MIT). It is shared by every English voice, so one copy
  serves additional English packs.
- Commercial use: permitted. Word-level OOV entries are spelled letter by
  letter at synthesis time instead of being dropped silently.
- Voice: `kristin`, speaker 0, 22,050 Hz.

## Excluded candidates

MeloTTS and Kokoro int8 were evaluated in the same single-threaded WASM
runtime but produced 6-15 second utterances (RTF well above 1). They are not
shipped. The original 8 kHz icefall AISHELL-3 model was also replaced because
its sampling rate made speech muffled even though the license was permissive.

English Piper voices Lessac and Amy (both derived from the Blizzard 2013
research corpus) and HFC Female (CC BY-NC-SA 4.0) were rejected because their
training-data licenses do not allow commercial distribution.
