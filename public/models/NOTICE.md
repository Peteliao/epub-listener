# Voice pack notices

The app ships optional TTS packs. Files are downloaded only after the user
starts a pack download, verified against the SHA-256 values in `manifest.json`,
and kept in Cache Storage on the device.

| Pack | Voices | Model source | License |
| :--- | :--- | :--- | :--- |
| 山岚 (`matcha-icefall-zh-baker`) | 山岚 | [sherpa-onnx tts-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) (Matcha Baker + Vocos 22.05 kHz) | **Non-commercial only** (Baker dataset) |
| 小雅 (`piper-zh-xiaoya`) | 小雅 | [Piper xiao_ya medium](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/xiao_ya/medium) | **Non-commercial only** (BZNSYP / DataBaker dataset); Piper repo MIT |
| 初晴 (`piper-zh-chaowen`) | 初晴 | [Piper chaowen medium](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/chaowen/medium) | CC0 dataset + MIT model repository |
| AISHELL-3 精选 (`piper-zh-aishell3`) | 青禾、照月、松涛、远川 | [Piper AISHELL-3 conversion](https://huggingface.co/writeAPoemForYou/piper-voices-zh-AISHELL-3) | Apache-2.0 (AISHELL-3 data and model) + MIT frontend |
| Hojo 双语 (`hojo-light`) | 岚一、岚二 + 13 English voices | [Hojo-TTS-Light-40M](https://huggingface.co/HojoAI/Hojo-TTS-Light-40M) | Apache-2.0. The mobile int8 LM is the community quantisation [`nocmt/Hojo-TTS-Light-40M-INT8`](https://huggingface.co/nocmt/Hojo-TTS-Light-40M-INT8); decoder and FineLocal stay fp32. |
| English · Kristin (`piper-en-kristin`) | Kristin | [Piper Kristin medium](https://brycebeattie.com/files/tts/) | Public-domain LibriVox recordings; CMUDict (BSD-2-Clause) lexicon; Piper repo MIT |

The Piper Chinese frontend (`lexicon.txt`, `tokens.txt`, `phone.fst`,
`date.fst`, `number.fst`) comes from the MIT-licensed `rhasspy/piper-voices`
repository. AISHELL-3 training data: https://www.openslr.org/93/. BZNSYP
licensing terms: https://www.data-baker.com/data/index/TNtts/.

The Hojo browser runtime is a local JavaScript port of the upstream inference
code. It runs on [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
(MIT), served from `../hojo/runtime/`; see the upstream project for the full
notice set. The non-commercial restriction of 山岚 and 小雅 is a product
boundary, not an implementation detail.

The Sherpa-onnx WASM runtime and detailed attributions are documented in
[`../sherpa/NOTICE.md`](../sherpa/NOTICE.md).
