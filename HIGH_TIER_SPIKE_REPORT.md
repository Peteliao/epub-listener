# 高档路线 Spike 评估报告（只评估，未落地）

> 本报告是**评估结论**，不是实现。本轮没有改动 `public/workers/sherpa-tts.worker.js`、
> `public/sherpa/runtime/*`、`public/models/manifest.json`，没有下载模型、没有新增运行时依赖。
> 可复现证据：`node scripts/spike/phoneme-direct.mjs`（真实 WASM）→ `scripts/out/phoneme-spike.json`。

## 结论摘要：两条路线都建议暂缓（No-Go），先观察本轮低/中档收益

| 路线 | 可行性 | 体积/首启代价 | 改造面 | 建议 |
| --- | --- | --- | --- | --- |
| A. 按句预注音（音素直输） | **技术可行且已验证** | 0 新增资产 | 中～大（前端 G2P + worker/driver 消息） | **暂缓**：消歧问题只是搬家，且会绕过全部既有规则 |
| B. 轻量 ONNX 消歧模型 | 可行但需训练/蒸馏 | fp32 ≈ 635 MB / int8 ≈ 159 MB；蒸馏小模型 ≈ 1.7 MB 但需自训 | 大（模型加载、推理运行时、授权核查） | **暂缓**：体积或工程代价远超本轮 7.2 KB 词表收益 |

---

## 路线 A：按句预注音（`tokens` / `phonemeCodepoints` 直输）

### 前提修正（与旧文档不同）

`TECHNICAL_IMPLEMENTATION_ROADMAP.md:589` 写「`phonemeCodepoints` 需研究、首版不做」。核实后：

- vendored `public/sherpa/runtime/sherpa-onnx-tts.js:756-791` **已实现** `phonemeCodepoints`(`number[][]`) 与 `tokens`(`string[][]`) 的校验、marshalling（`:853-910`）、内存释放（`:927-939`）与互斥检查；`:1050-1053` 注明二者互斥。
- `OfflineTts.generateWithConfig(text, genConfig)`（`:1016`）是入口；`generate()`（`:972`）只接文本。
- `scripts/lib/matchaSynth.mjs:79-90` **已经在用真实 WASM** 做 `generateWithConfig('', { tokens: [tokens] })`，即「空文本 + 纯 token 序列」。生产链路的声学审计（`audit-omission`、`audit-acoustics`、`audit-word-family`）全都跑在这条路径上。

所以 C 侧前提**已经成立**，缺的是生产 worker/driver 的消息透传与一个整句 → token 序列的前端。

### 真实 WASM 证据（`scripts/out/phoneme-spike.json`）

| 项 | 结果 |
| --- | --- |
| 运行时 | sherpa-onnx-wasm-tts-2.0.0，Matcha 山岚，22050 Hz |
| `bypassesLexicon` | **true** |
| token 路径实际序列 | `[xue2(1806), kuai4(808), ji4(678)]` |
| token 路径是否进入词典最长匹配 | **否**（debug 日志无 `TokenizeFromLexiconStr`） |
| text 路径是否进入词典最长匹配 | **是**（`Lexicon matched: '会计' -> 'kuai4 ji4'`） |
| 互斥语义 | runtime JS 同时校验 `tokens` 与 `phonemeCodepoints`，并注明二者互斥 |
| 同实例逐样本可复现 | **否**（`noiseScale=0.667` 有随机性） |

> 方法说明：一开始用「换词典后音频是否一致」判断绕过，得到 `false`，是**错误的判据**——
> 同一实例同一输入逐样本都不可复现，且追加的重复词典行是否被 C++ 采用未知。
> 最终改用 runtime 自己的 debug token 日志作为判据（子进程捕获原始 stdout/stderr，
> 见 `scripts/spike/phoneme-direct-log.mjs`），结论才成立。这一段特意保留，避免后续复用错误方法。

### 客观差异（同一句，音素直输 vs 词典路径）

| 场景 | 音素直输音频 | 词典路径音频 |
| --- | ---: | ---: |
| 抢词（学会计） | 1068 ms | 2125 ms |
| 普通短句（他答应了一声） | 1544 ms | 1823 ms |
| 数字与标点（一共 123 元） | 1753 ms | 1939 ms |

音素直输更短，因为它没有标点/停顿 token 与分句逻辑；`text` 路径会命中 `ruleFsts`
（`phone.fst` / `date.fst` / `number.fst`）、`min_words_in_sentence=12` 的分句与标点替换。
数字用例里词典路径还打印了 `OOV word skipped: '123'`，说明数字归一化由 FST 处理。

### 改造面（若要落地）

1. `public/workers/sherpa-tts.worker.js:618-687`：`synth` 消息增加 `tokens`（或 `phonemeCodepoints`）字段并放进 `generateWithConfig` 的 config；当前 config 只有 `{sid, speed, silenceScale, extra}`。
2. `src/core/tts/SherpaDriver.ts:917-930`：`speak()` / 缓存 key 要区分「文本」与「token 序列」；现有缓存键基于 text，直接复用会把不同读音合成成同一条。
3. 新增一个整句前端：分词 → 多音字消歧 → 数字/日期/标点归一化 → `tokens.txt` ID 序列。
4. `tokens.txt` → ID 映射（当前 2069 个 token）与 BOS/EOS/pad 顺序需与 WASM 一致（debug 日志显示 final IDs 会在每个音素间插 `1`，即 `[1, 1806, 1, 808, 1, 678, 1]`）。

### 风险（这是建议暂缓的主因）

- **消歧问题没有消失，只是搬家**：抢词 `学会计 → 学会/计` 在直输下不存在，但前端仍必须判定「会」读 `kuai4`。本轮中档已用 271 条静态词组 + 注音 + 人工表覆盖这个判定，直输需要重新实现同等能力。
- **绕过全部既有治理**：本轮与历史所有 overlay、整词保护 U+200B、语句重置 U+2060、静音边界 `"`、`ruleFsts` 都不再生效；数字、日期、标点、轻声、变调要在新前端里重做，回归面比收益大。
- **可听性回归难验证**：现有 `audit:golden` / `audit:omission` / `audit:acoustics` 全都假设词典路径；改成直输后这些门禁的语义需要重定义。
- 纯前端仍然成立（无新资产），但工程收益/风险比目前不划算。

---

## 路线 B：轻量 ONNX 多音字消歧模型

### 已核实的真实候选

| 候选 | 体积 | 许可 | 说明 |
| --- | ---: | --- | --- |
| g2pW fp32 ONNX（`g2pw.onnx`） | 635,212,732 B ≈ **606 MiB** | 上游 `GitYCC/g2pW` **Apache-2.0** | INTERSPEECH 2022，Conditional Weighted Softmax BERT，158M 参数 |
| g2pW int8 动态量化 ONNX | 159,287,335 B ≈ **152 MiB** | 需逐个核查再分发仓库的许可 | CPU 8 线程单句约 35 ms（fp32 约 86 ms） |
| 蒸馏小模型（字符嵌入 + 单层 BiGRU，约 60 万参数） | ≈ **1.7 MB** | 需自训/自行授权 | 社区项目把 g2pW 决策蒸馏进小模型，训练标签需与 g2pW 金标对齐 |

来源：`https://github.com/GitYCC/g2pW`（Apache-2.0 许可全文已核实）、Hugging Face 上的
`g2pW-int8-onnx` 量化版与 `G2PWModel-v2-onnx.zip`（589 MB）。**这些来源仅用于评估，本轮未下载任何模型。**

### 与现有基线对照

| 项 | 当前 | 增量 |
| --- | ---: | ---: |
| 主 JS bundle（gzip） | 440 KB | — |
| 本轮外部词表静态资产 | 7.2 KB | 已落地 |
| 人工覆盖表 | 55.5 KB | 既有 |
| 模型基础词典 | 1.32 MB | 既有 |
| WASM runtime | 14.5 MB | 既有 |
| 声学模型 + vocoder | 123.5 MB | 既有（用户按需下载） |
| g2pW int8 | — | **+152 MiB** |

即使只看 int8 版，也相当于再下载一个比现有两个 ONNX 模型加起来（123 MB）更大的文件；
fp32 版更不可接受。蒸馏小模型体积可接受，但需要训练数据、训练管线与授权核查，
且收益上限仍受「声学模型吞音/融合」限制——本轮低档已确认静态一致率 100% 时仍会错读。

### 收益上限与可验证性

- 消歧模型只能改善「选哪个读音」，不能改善声学层的吞音、音节融合、抢词（那些是
  `polyphones.v1.txt` 的静音边界与 U+2060 语句重置在管）。
- 现有 `pronunciation-golden.jsonl` / `pronunciation-regression.jsonl` 是**静态词典音素一致率**，
  不是听感正确率；引入模型后仍需要 `npm run lab:ab` 的人工 A/B 才能证明提升。
  按用户要求，本轮不安排任何需要用户协助的听感打分，因此无法给出可信的准确率增益数字。

---

## Go / No-Go 建议

**两条路线都暂缓（No-Go）**，理由：

1. 本轮低/中档已把「默认路由绕过全部读音资产」这个最大杠杆修好，并叠加了字族白名单、
   动态整词保护、即时纠错、EPUB 拼音注音与 271 条 MIT 外部词组读音；这些是零/低成本且
   全部有自动化门禁覆盖的收益。应先复测基线并用真实 A/B 观察是否还有剩余缺口。
2. 路线 A 的消歧问题只是从词典搬到前端，且会一次性绕过所有既有治理，回归面最大。
3. 路线 B 的体积或训练成本与当前收益不匹配，且无法在不做人工听感的前提下证明增益。

**后续触发条件**（满足任一才值得重启 Spike）：

- 真实 A/B 显示剩余错读集中在大批量 OOV 多音字词，且本轮静态资产覆盖不到；
- 出现可商用、≤ 5 MB、带可复现评测的消歧模型（或自训蒸馏小模型完成许可与数据核查）；
- 生产 worker 需要支持非 Matcha 音色（无 lexicon overlay 能力），此时音素直输才成为刚需。

**回退**：本轮 Spike 只新增 `scripts/spike/*` 与本文件，删掉即可完全回退，不影响运行时。
