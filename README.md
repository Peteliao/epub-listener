# 书声 · 网页听书

[![Deploy to GitHub Pages](https://github.com/Peteliao/epub-listener/actions/workflows/deploy.yml/badge.svg)](https://github.com/Peteliao/epub-listener/actions/workflows/deploy.yml)

**把 EPUB、TXT、MOBI、AZW3、FB2 电子书变成有声书。** 书声是免费、纯前端、移动优先的网页听书工具：导入电子书后逐句朗读并同步高亮，支持系统语音与离线 AI 中英文音色，中英混排可全离线朗读，iPhone 锁屏也能继续听。无需安装 App，没有后端，书籍与阅读进度只保存在本机。

**在线使用：** https://peteliao.github.io/epub-listener/

书声是一个源码公开的 **EPUB 朗读器 / TXT 转语音 / 电子书转有声书** 工具，支持 **iPhone 锁屏听书**、**中英混读** 与 **离线语音合成**，在 iPhone、iPad、Android 手机和电脑浏览器里打开即可使用。

## 为什么选择书声

- **免费、免安装**：打开网页就能听，也可以添加到主屏幕当 App 用
- **隐私优先**：没有账号、没有云端，书籍、进度和设置只保存在浏览器本机
- **中英混读**：中文与英文按语言片段自动切换；英文可用离线音色，也可回落到系统英文语音
- **离线可用**：下载音色包后断网也能朗读，中英混排同样可以全离线
- **中文听感优化**：多音字、轻声、专名与整书自动读音持续校核，配有真实 WASM 声学门禁与人工盲听流程
- **跨设备**：手机、平板和电脑的现代浏览器都能用，无需安装扩展

## 功能

- **多格式书架**：EPUB / TXT / MOBI / AZW3 / FB2 导入与书架管理，书籍保存在 IndexedDB
- **逐句朗读与高亮同步**：点击正文任意句子立即从该句开始；播放中高亮与滚动自动跟随
- **双朗读引擎**：浏览器自带系统语音，或离线 sherpa-onnx / Hojo AI 音色
- **iOS 锁屏续读**：使用离线 AI 音色时，iPhone 锁屏后仍可继续朗读，锁屏界面支持播放、暂停和上一句/下一句
- **锁屏保护**：iOS 锁屏且英文走系统语音时，默认跳过英文段，解锁后恢复并提示跳过数量
- **多套离线音色**：山岚、小雅、初晴、AISHELL-3 精选、Hojo 双语，以及英文 Kristin；中英文音色可同时驻留
- **中文读音覆盖**：人工核过的多音字词表、整书自动读音、EPUB 注音、用户即时纠错按优先级合并；读音反馈可在本机记录并导出候选
- **英文朗读优化**：数字、年份、日期、时间、货币、小数、序数、常见缩写与符号转成英文读法；词典外生词按字母拼读
- **节奏控制**：同段短句连读、三档停顿、对话引号独立成句，数字、百分比、分数、单位与电话号码规范化
- **阅读体验**：27 款主题、字号与语速独立面板、手机两侧翻页按钮、目录、章节剩余时间
- **听书辅助**：睡眠定时、口袋模式（自动切换 OLED 纯黑主题，退出恢复原主题）、Wi-Fi 下空闲预热、低端机性能提示
- **听书统计与分享**：按天与按书统计真实播放时长，生成跟随阅读主题的分享海报
- **PWA 与新手引导**：可添加到主屏幕，应用壳离线可用；书架和阅读器都有可重看的分步引导

## 支持哪些电子书格式

| 格式 | 支持情况 | 说明 |
| --- | --- | --- |
| EPUB | 支持 | 基于 epub.js，保留原书排版、目录、插图与内链 |
| TXT | 支持 | 自动识别章节标题并分节，适合网络小说与纯文本读物 |
| MOBI | 支持 | 基于 foliate-js，支持未加密的 MOBI |
| AZW3 | 支持 | 基于 foliate-js，支持未加密的 KF8 / AZW3 |
| FB2 | 支持 | 基于 foliate-js，支持 FictionBook 2 |

单个文件上限 200 MB；带 DRM 保护的电子书无法打开。

## iOS 锁屏听书

iPhone 锁屏后，浏览器通常会暂停网页里的系统语音与 Web Audio。书声在使用**离线 AI 音色**时，会把合成好的语音交给页面里的媒体元素播放，因此锁屏后朗读仍能继续，进度与高亮会在解锁后同步到当前句。

使用方法：

1. 在「朗读设置」中把「朗读引擎」切换为「离线 AI」
2. 下载并启用朗读内容对应语言的音色包；中英混排建议同时下载中文与英文音色
3. 开始朗读后锁屏；锁屏界面会显示书名与章节，并支持播放、暂停和上一句/下一句

注意：

- 系统语音在 iOS 锁屏后会被系统暂停，锁屏续读必须使用离线 AI 音色
- 英文若走系统英文音色，默认启用「锁屏跳过英文」；下载英文离线音色后不受该开关影响
- 已在 iPhone（iOS 18）的 Safari 与主屏 PWA 中验证；其他浏览器和平台受各自后台策略影响
- 系统内存紧张、手动关闭页面或标签页被回收时，锁屏朗读仍可能中断；建议添加到主屏幕

## 中英混读

书声会按语言自动切分中文和英文片段：

- 中文交给所选中文音色
- 英文优先交给英文离线音色 Kristin，或改用 Hojo 双语包中的英文声音
- 英文包未下载、关闭「英文使用离线音色」或离线引擎启动失败时，自动回落到系统英文音色

英文朗读前会做文本归一化：数字、年份、日期、时间、货币、小数、序数、常见缩写和符号转换成英文读法；词典外的生词按字母拼读，不会静默丢失。英文音量（60%–120%）和英文语速（0.6–1.4×）可独立调节，对离线与系统英文都生效。

## 离线音色包

音色包在应用内按需下载，下载后完全在本机合成，文本不会发送给第三方语音服务。所有模型文件在下载时做 SHA-256 完整性校验；具体许可以 [`public/models/manifest.json`](public/models/manifest.json) 与 [`public/models/NOTICE.md`](public/models/NOTICE.md) 为准。

| 音色包 | 声音 | 许可 | 模型体积 |
| --- | --- | ---: | ---: |
| 山岚（Matcha Baker） | 山岚 | **仅限非商业** | 约 131 MB |
| 小雅（Piper） | 小雅 | **仅限非商业** | 约 66 MB |
| 初晴（Piper） | 初晴 | CC0 / MIT | 约 66 MB |
| AISHELL-3 精选（Piper） | 青禾、照月、松涛、远川 | Apache-2.0 | 约 80 MB |
| Hojo 双语 | 岚一、岚二 + 13 个英文声音 | Apache-2.0 | 完整版约 284 MB；移动 int8 约 190 MB |
| 英文 Kristin（Piper） | Kristin | 公有领域 / MIT | 约 26 MB |

Sherpa 音色包共享同一份约 15 MB 的 WASM 运行时，只下载一次；Hojo 使用约 12 MB 的独立 ONNX Runtime Web 运行时。桌面端默认使用 Hojo 完整版，移动端自动使用 int8 轻量版。

> 山岚与小雅的训练数据为**非商业**许可，不能用于商业产品。初晴、AISHELL-3 精选、Hojo 与英文 Kristin 可用于商业场景，但正式发布前仍建议完成法务复核。

Sherpa-onnx、foliate-js 等第三方组件的许可见 [`public/sherpa/NOTICE.md`](public/sherpa/NOTICE.md) 与 [`src/vendor/foliate-js/NOTICE.md`](src/vendor/foliate-js/NOTICE.md)。

## 本地开发

需要 Node.js `^20.19.0` 或 `>=22.12.0`（CI 使用 Node 24）。

```bash
npm install
npm run dev       # 本地开发服务器
npm test          # Vitest：单元/集成测试 + 真实 WASM 回归
npm run build     # vue-tsc 类型检查 + vite 生产构建
npm run preview   # 预览生产构建
```

### 项目结构

```text
src/
  views/         书架与阅读器页面
  components/    阅读设置、音色包、目录、反馈、统计等界面
  core/
    reader/      EPUB / TXT / MOBI / AZW3 / FB2 解析、分句与高亮
    player/      播放调度、媒体会话与锁屏控制
    tts/         读音数据、整书词典、音色包与运行时管理
    library/     导入、书架与封面
    db/          IndexedDB 封装
    feedback/    读音反馈与即时覆盖层
    stats/       听书统计
    share/       分享卡
  stores/        Pinia 设置与状态
public/
  workers/       sherpa / hojo TTS Worker
  models/        音色包与 manifest.json
  sherpa/        共享 sherpa-onnx WASM 运行时
  hojo/          Hojo ONNX Runtime Web 运行时
scripts/         开发期读音审计与评测脚本（不进入应用包）
tests/           Vitest 测试与固定语料
```

技术栈：Vue 3 · TypeScript · Vite · Pinia · epub.js · foliate-js · sherpa-onnx (WASM) · ONNX Runtime Web · IndexedDB · Service Worker · Media Session。

## 读音质量与自迭代

中文读音是书声投入最多的一条链路。目标不是把词典做得无限大，而是让**实际送进声学模型的音素与韵律**可验证、可回退、可复听。

### 数据来源与优先级

```text
基础模型词典 < 外部静态词表 < 整书自动生成 < EPUB 注音 < 用户即时纠错 < 人工覆盖表
```

所有来源最终合并成一份 overlay，经音素校验后写入 Worker 的运行时词典；人工覆盖表始终最后生效，自动结果不会压过人工复核。词典指纹变化会自动重建 Worker，避免继续使用旧词典。

关键约束：

- 轻声只能使用声学模型训练过的音素；`tokens.txt` 中存在但训练时未出现的无调 token 会产生怪音或静音
- 词内边界全面禁用；词首边界是强改动，只允许用于登记了完整反馈原句并经过真实 WASM 验收的词
- 整书自动词条不超过 6 字，总量受 2000 条去重裁剪；读音反馈只收 2–4 字纯汉字词
- 即时纠错是内存叠加层，删除反馈即撤销；写回人工表必须经过影响面 diff 与人工复核

### 常用质量命令

| 命令 | 作用 |
| --- | --- |
| `npm test` | 单元/集成测试，以及真实 WASM 的声学、漏读、自迭代回归 |
| `npm run audit:all` | 按顺序运行全部读音门禁，结果写入 `scripts/out/gate-results.json` |
| `npm run audit:golden` | 黄金集与一致性快照 |
| `npm run audit:polyphones -- --overlay-only` | 覆盖表格式与音素校验 |
| `npm run scan:risks -- <book.epub>` | 全书扫描音素选错与数据漂移风险 |
| `npm run audit:impact -- --overlay=<候选> --corpus=<book>` | 改动前后全书影响面 diff |
| `npm run audit:acoustics -- --corpus=<book>` | 真实 WASM 逐音节时长与边界建议 |
| `npm run audit:omission -- --verify` | 用完整反馈原句重建 token，验证每个音节可听 |
| `npm run audit:word-family -- --verify` | 词族逐词可听性回归 |
| `npm run audit:envelope -- --case=<id>` | 整句包络测量（advisory） |
| `npm run oov:recall` | 抽样列出探测器未命中的 OOV，供人工复听 |
| `npm run pronunciation:auto -- --verify` | 融合抢读音回归 |
| `npm run health` | 读音资产沉淀量与收敛趋势 |
| `npm run quality:report` | 汇总门禁、包络、OOV、盲听与版本指纹 |
| `npm run blind:render` / `blind:ab` / `blind:score` | 双盲 A/B 建包、评分与解盲 |

这些脚本全部是开发期工具：不进入应用包，不需要后端；整书语料默认只在本机使用。

### 评测原则

- **静态一致率不等于听感正确率**：黄金集校验的是「有效词典最长匹配音素 == 标注音素」，声学模型仍可能吞音、融合或抢词。真实听感只能由真实 WASM 测量与人工盲听确认。
- **门禁必须能守住回归**：每个历史听感修复都要有可重放的完整反馈原句、前后对照和真实 WASM 验收，不靠单句短文本冒充。
- **双盲不可反推**：每轮使用加密随机种子与实验 ID；公开清单只含随机代号和播放顺序，种子与版本映射只写入独立 `.key.json`，评分完成前不打开。
- **解盲前先校验**：评分表必须完整、评分者不能重复、实验 ID 与代号必须一致；未完成或跨实验直接拒绝。
- **正式结论至少两名评分者**：评测副本做活动语音 RMS 响度归一化，原始 WAV 不改；单名评分者只能算样本不足。
- **版本必须一致**：报告记录 commit、应用版本、评测套件版本、音色包、词典与语料指纹、`experimentId`；来自不同实验或缺失指纹的数据不能判为 PASS。
- **默认不自动改表**：自动流程默认只产出候选；带 `--apply` 的自动写回也必须经过影响面 diff、真实 WASM 复验与全量门禁，失败自动回滚。

`npm run quality:report` 输出四种状态：

| 状态 | 含义 |
| --- | --- |
| `PASS` | 硬性门禁、包络高置信度检查、声学冒烟、版本指纹与双人盲听全部满足 |
| `WARNING` | 只有 advisory 风险，没有阻断项 |
| `NEEDS_LISTENING` | 包络定位不确定、S 级风险、OOV 待复听、评分者不足、版本未验证或缺少声学结果 |
| `FAIL` | 必需门禁失败、历史回归失败或高置信度包络异常 |

### 外部语料

外部读音与韵律数据只用于开发期对照，不进入运行时词典，也不自动修改人工表：

- [`scripts/data/phrase-pinyin-data/SOURCE.md`](scripts/data/phrase-pinyin-data/SOURCE.md)：`mozillazg/phrase-pinyin-data` v0.20.0（MIT）的来源、筛选与许可说明
- [`scripts/data/bytedance-zh-wiki/SOURCE.md`](scripts/data/bytedance-zh-wiki/SOURCE.md)：ByteDance / zh-wiki 派生资料的来源、转换、指纹与用途边界；许可未确认前只限本仓库开发审计，不得再分发

## 隐私与安全

- **无后端**：所有导入的电子书、阅读进度、设置与听书统计仅保存在本机
- **本机合成**：离线中文与英文朗读都在浏览器内完成，文本不会发给第三方语音服务
- **反馈可控**：读音反馈默认只写入本机 IndexedDB；只有主动点击「去 GitHub 提交」才会打开预填 issue，提交内容将公开可见
- **不可信书籍隔离**：阅读 iframe 禁用脚本，图片、样式、字体仅允许 `data:` / `blob:`，默认阻止远程资源
- **导入上限**：单个文件 200 MB
- **模型校验**：音色包下载后做 SHA-256 完整性校验

## 测试与部署

- 测试：`npm test`，当前 **83 个测试文件 / 721 项通过**
- 读音门禁：`npm run audit:all`（新鲜 checkout 可运行，不依赖全书语料；声学冒烟可用 `--strict` 设为必需）
- 构建：`npm run build`（`vue-tsc --noEmit` + vite）
- CI：推送到 `main` 后，[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 会依次执行 `npm ci`、`npm test`、`npm run audit:all`、`npm run build`，然后发布到 GitHub Pages
- GitHub Pages 的 Source 需在仓库 Settings → Pages 中选择 **GitHub Actions**

站点已包含 canonical、Open Graph / Twitter Card、`WebApplication` 结构化数据，以及 `public/robots.txt` 与 `public/sitemap.xml`。GitHub Pages 项目站点无法在域名根目录提供 `robots.txt`，建议在 Google Search Console 中提交 `https://peteliao.github.io/epub-listener/sitemap.xml`。

## 常见问题

### 书籍会上传到服务器吗？

不会。项目没有后端，EPUB、TXT 等书籍、阅读进度和设置只保存在浏览器本机（IndexedDB / localStorage）。

### 可以离线听书吗？

应用壳和已下载的音色包可以离线使用。首次打开需要联网加载网页；使用离线音色前需在应用内下载音色包。系统语音是否可用离线取决于设备已安装的语音。

### 中英混排的书怎么朗读？

书声会按语言自动切分片段：中文用所选中文音色，英文优先用离线 Kristin 或 Hojo 的英文声音。想全离线朗读中英混排，需要下载对应语言的音色包；英文包未下载或离线引擎启动失败时会自动改用系统英文音色。

### 为什么英文部分没有声音或听不清？

离线英文音色需要先下载英文包并开启「英文使用离线音色」；改用系统英文音色时，请确认设备已安装英语语音。英文音量与语速可单独调节，系统语音音量上限是 100%。

### 为什么有些书没有封面？

书声会读取 EPUB、FB2、MOBI、AZW3 书内声明的封面；TXT 没有封面，会显示渐变书脊。封面缺失、损坏或超过 12 MB 时也会使用占位。

### 支持 DRM 电子书吗？

不支持。Kindle、Apple Books 等带 DRM 的 MOBI、AZW3 或 EPUB 无法解析。

### TXT 小说怎么分章？

自动识别「第 X 章」「序章」「楔子」「前言」「后记」「番外」等常见标题；没有标题的长文本会按长度自动分节。

### 为什么提示「合成速度偏慢」？

性能较弱的手机可能来不及实时合成，播放会断续。可以切换到系统语音，或关闭「连读模式」缩短等待。

### 怎么添加到主屏幕？

iPhone / iPad 用 Safari 打开后点「分享」→「添加到主屏幕」；Android 用 Chrome 菜单里的「安装应用」或「添加到主屏幕」。

### 跳过新手引导之后还能再看吗？

可以。书架和朗读界面右上角都有问号按钮；也可以在「阅读设置 → 新手引导 → 查看」中重新打开。

## 已知限制

- 睡眠定时仅对当前阅读页生效，刷新或返回书架后取消
- 锁屏续读依赖离线 AI 音色；系统语音在 iOS 锁屏后会被系统暂停
- 锁屏续读仅在 iPhone（iOS 18）Safari 与主屏 PWA 验证，其他平台未做同等保证
- 同时驻留中文与英文离线音色会增加内存占用，内存较小的设备可以只下载常用语言
- 手机上点按正文用于跳转朗读，暂不能长按选中正文文字
- 离线 AI 模式需要支持 WebAssembly SIMD 的现代浏览器；系统语音模式的可用性取决于设备语音包

## 反馈与贡献

- 问题与功能建议：https://github.com/Peteliao/epub-listener/issues
- 读音反馈：在应用内标记后可导出 JSONL，或点击「去 GitHub 提交」生成 issue
- 从反馈记录汇总读音候选：

```bash
npm run reports:overlay -- pronunciation-reports-20261102.jsonl --out=scripts/out/overlay-candidates.txt
```

提交代码前请运行 `npm test`、`npm run audit:all` 与 `npm run build`。涉及读音的改动还需要真实 WASM 审计与影响面 diff；外部语料必须附带来源、许可与指纹说明。

如果书声对你有帮助，欢迎在 GitHub 上点一个 Star。

## 样书

首次打开可点「试听样书」体验《山间来信》。《山间来信》为「书声」项目创作的虚构中篇（共 16 章），作者署名「林深」为笔名，与任何真实人物、已出版作品无关。

## 搜索关键词

网页听书、在线听书、免费听书网站、EPUB 朗读器、EPUB 转语音、TXT 转语音、TXT 小说朗读、电子书转有声书、电子书 TTS、MOBI 朗读器、AZW3 朗读、FB2 阅读器、中文 TTS、英文 TTS、离线语音合成、中英混读、中英混排朗读、iPhone 锁屏听书、iOS 锁屏朗读、锁屏续读、浏览器听书、隐私优先的听书工具。
