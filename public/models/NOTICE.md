# Voice pack notices

The app ships four optional Chinese TTS packs. Files are downloaded only after
the user starts a pack download, verified against the SHA-256 values in
`manifest.json`, and kept in Cache Storage on the device.

| Pack | Voices | Model source | License |
| :--- | :--- | :--- | :--- |
| 山岚 (`matcha-icefall-zh-baker`) | 山岚 | [sherpa-onnx tts-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) (Matcha Baker + Vocos 22.05 kHz) | **Non-commercial only** (Baker dataset) |
| 小雅 (`piper-zh-xiaoya`) | 小雅 | [Piper xiao_ya medium](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/xiao_ya/medium) | **Non-commercial only** (BZNSYP / DataBaker dataset); Piper repo MIT |
| 初晴 (`piper-zh-chaowen`) | 初晴 | [Piper chaowen medium](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/chaowen/medium) | CC0 dataset + MIT model repository |
| AISHELL-3 精选 (`piper-zh-aishell3`) | 青禾、照月、松涛、远川 | [Piper AISHELL-3 conversion](https://huggingface.co/writeAPoemForYou/piper-voices-zh-AISHELL-3) | Apache-2.0 (AISHELL-3 data and model) + MIT frontend |

The Piper Chinese frontend (`lexicon.txt`, `tokens.txt`, `phone.fst`,
`date.fst`, `number.fst`) comes from the MIT-licensed `rhasspy/piper-voices`
repository. AISHELL-3 training data: https://www.openslr.org/93/. BZNSYP
licensing terms: https://www.data-baker.com/data/index/TNtts/.

The Sherpa-onnx WASM runtime and detailed attributions are documented in
[`../sherpa/NOTICE.md`](../sherpa/NOTICE.md). The non-commercial restriction of
山岚 and 小雅 is a product boundary, not an implementation detail.
