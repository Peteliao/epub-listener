# 外部词组读音数据来源与许可记录

本目录是**构建期静态输入**，运行时不读取，`src/core/tts/phraseReadings.v1.txt` 才是由它编译出的运行时资产。

## 选型结论：采用 `mozillazg/phrase-pinyin-data` v0.20.0 的 `pinyin.txt`

| 项 | 核实结果 |
| --- | --- |
| 仓库 | https://github.com/mozillazg/phrase-pinyin-data |
| 固定版本 | `v0.20.0`（CHANGELOG 标注 2026-11-01；文件头 `# version: 0.20.0`） |
| 许可 | **MIT**，`Copyright (c) 2017 mozillazg`。允许商用、修改、合并、再分发与 sublicense，唯一条件是在所有副本或实质性部分保留版权声明与许可声明；无 ShareAlike / copyleft。全文见同目录 `LICENSE` |
| 数据格式 | `{词语}: {带调拼音}`，拼音以空格分隔；`#` 开头或行尾 `#` 为注释；一词多音会出现在多行 |
| 本目录文件 | `pinyin.txt`（1,257,452 B / 47,156 行）、`LICENSE`（1,066 B） |
| SHA-256 | `pinyin.txt` = `5D4D86B1337BB2FCA95BC5135564A821BFDB40597481EE3E3871BF52D4668622`；`LICENSE` = `89AC55DF747E4776088C3E77531EF61B973A1A59DD8E6A4548A58996DA9A4F70` |
| 获取方式 | `curl -sSL -o pinyin.txt https://raw.githubusercontent.com/mozillazg/phrase-pinyin-data/v0.20.0/pinyin.txt`，`LICENSE` 同 tag |

### 为什么不用 `large_pinyin.txt`（覆盖更广，但许可不兼容）

仓库 README 明确 `large_pinyin.txt` = `zdic_cibs.txt`（汉典网汉语词典）+ `zdic_cybs.txt`（汉典网成语词典）+ `cc_cedict.txt`（CC-CEDICT）+ `pinyin.txt` + `di.txt` + `overwrite.txt` 的合并结果。其中：

- **CC-CEDICT 采用 CC BY-SA 4.0**（Attribution-ShareAlike），属 copyleft，衍生数据需以相同许可共享，与本项目的静态资产分发方式冲突；
- **汉典网数据许可未在仓库中声明**，无法确认可再分发。

仓库整体 `LICENSE` 为 MIT 并不自动覆盖这些第三方来源。因此**只取 `pinyin.txt`**：按 README，它是项目自有 `pinyin.txt` + `overwrite.txt` 的合并结果，初始数据来自 `hotoo/pinyin` 的 `phrases-dict.js` 与 `mozillazg/python-pinyin` 的 `phrases_dict.py`，由仓库 MIT 许可覆盖，许可链条清晰。

### 数据质量核验（只读评估，47154 条数据行）

| 处理 | 条数 |
| --- | ---: |
| 与模型基础词典读音完全相同（无收益） | 39,485 |
| 含「一」「不」（项目有专门变调规则，整词覆盖会绕过） | 3,551 |
| 仅声调差异（多为 3+3 变调还原，引入会破坏既有 `applySandhi`） | 1,749 |
| 与逐字单字默认读音相同 | 1,606 |
| 人工覆盖表已有同名词（`polyphones.v1.txt` 最后生效，重复无意义） | 223 |
| 词长不在 2–6 字 | 231 |
| 音素不在 `tokens.txt` / 轻声不在 `trainedNeutrals.v1.txt` / 重复词 | 38 |
| **最终候选（声母或韵母真变化的真多音字差异）** | **271** |

271 条覆盖 103 个字族（长、重、贾、行、佛、血、的、乐、薄、没、着、折、了、朝…），远低于 `MAX_BOOK_OVERLAY_ENTRIES = 2000`，不会显著增加 MEMFS 体积或 `patchLexicon()` 的线性成本。

**关键取舍**：文档原设想「外部词表覆盖更广」，实测绝大多数条目与 66,914 条模型基础词典完全一致，真正能纠正读音的是极少数多音字词组。若把纯声调差异也灌入，反而会把基础词典已应用好的 3+3 变调、轻声、「一/不」变调还原成原调，降低正确率。因此编译脚本采用保守筛选。

## 编译产物与安全模型

- 编译脚本：`scripts/compile-external-phrase.mjs`
- 产物：`src/core/tts/phraseReadings.v1.txt`（静态 overlay 文本，只读）
- 报告：`scripts/out/external-phrase-report.json`
- 默认只产候选与报告；`--apply` 必须同时给 `--confirm`，且要求零冲突、零意外影响面（与 `scripts/compile-overlay.mjs` 一致）
- `--verify` 只读校验产物与源数据可复现（含 SHA-256 与逐行比对）
- 所有候选行必须过：`tokens.txt` 音素存在性、`trainedNeutrals.v1.txt` 轻声白名单、纯汉字词、词长 2–6、无词内静音边界 `"`、不与人工表同名、按词去重
- 优先级链中，本产物排在「模型基础词典」之后、「整书自动」之前；人工覆盖表永远最后生效

## 回退结论

许可兼容、数据可获取、质量达标，**可落地**。若需回退：

1. 删除 `src/core/tts/phraseReadings.v1.txt` 与 `scripts/data/phrase-pinyin-data/`；
2. 移除 `src/core/tts/AiModel.ts` 中对该资产的一处引用；
3. 其余来源（整书自动、注音、反馈、人工表）不受影响，链路仍收敛到 `mergeLexiconOverlays → normalizeOverlayText → lexiconOverlay → patchLexicon`。

若后续该仓库不可用或许可变更，按上述 3 步即可完全回退，也可换用其它 MIT/Apache-2.0 词表重新编译，无需改动运行时。

## 署名

MIT 要求保留版权与许可声明。除本目录 `LICENSE` 原文外，编译产物 `phraseReadings.v1.txt` 的文件头注释与 `README.md` 的评估章节均标注来源、版本与许可。
