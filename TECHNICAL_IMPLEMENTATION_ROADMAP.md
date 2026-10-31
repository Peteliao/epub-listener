# 纯 Web 移动端听书与高亮同步：技术实现路线报告

> 对应方案：《纯 Web 移动端听书与高亮同步方案（固定高品质音色版）》  
> 版本：v1.0（代码实施基线）  
> 日期：2026-10-26  
> 目标读者：前端工程师、QA、产品负责人  
> 结论：方案主线可行，但原方案中的若干技术判断需要校正。本报告把“可落地的实现路线”和“必须提前验证的风险”分开写清楚，后续按第 8 节排期进入编码。
>
> **2026-10-26 更新（多音色）**：离线音色已扩展为三个独立音色包，统一使用 schema v3 清单与同一份 15.3MB WASM 运行时：
>
> - **山岚**：Matcha Baker 22.05kHz，保留，原包直接复用缓存；训练数据仅限非商业。
> - **初晴**：Piper Chaowen medium VITS 22.05kHz，数据集 CC0、模型仓库 MIT，可商用。
> - **AISHELL-3 精选**：Piper AISHELL-3 多发音人 VITS 22.05kHz，提供青禾/照月/松涛/远川四个音色；数据与模型 Apache-2.0，可商用。
>
> 下载、校验、缓存与删除均按包独立管理；首个包额外下载共享运行时，后续包只下载模型。下文早期单音色 / 8kHz / 33MB 论述保留为选型历史；当前体积、许可证与清单以 3.2 节及 `public/models/manifest.json` 为准。
>
> **2026-10-27 更新（新增小雅）**：新增 `piper-zh-xiaoya`（小雅，Piper VITS 22.05kHz，BZNSYP 标贝女声，仅限非商业）。它与山岚同属标贝女声语料，但使用 Piper 声学模型与拼音前端，停顿与语调风格不同；共享运行时与缓存机制不变。当前交付为四个音色包，下文数量、体积与许可已同步更新。

---

## 0. 执行摘要

### 0.1 一句话结论

纯 Web、无后端、可选固定音色包、句子级高亮同步的听书闭环可以成立。核心不是“把 VITS 塞进浏览器”这件事本身，而是把 **WASM 运行时、模型缓存、音频调度、EPUB 分句与高亮** 四条链路做成可降级、可观测、可复现的工程系统。

### 0.2 推荐落地组合

| 层 | 推荐方案 | 说明 |
| :--- | :--- | :--- |
| 应用框架 | Vue 3 + Vite + TypeScript + Pinia | 移动端单页应用，静态托管 |
| 阅读引擎 | epub.js（锁定版本）+ 薄适配层 | 首版使用纵向滚动 `scrolled-doc`，分页模式作为 P1 |
| AI 语音 | Sherpa-onnx WASM（定制构建）+ 四个离线音色包 | 共享 15.3MB 运行时；山岚（单音色，非商用）、小雅（单音色，非商用）、初晴（单音色，CC0/MIT）、AISHELL-3 精选（4 音色，Apache-2.0）；均为 22.05kHz |
| 兜底语音 | Web Speech API | 0MB、即时可用，但行为受系统/浏览器影响 |
| 分句 | 自研 DOM 分句器 + `Intl.Segmenter` 辅助 | 标点断句、最大长度控制、稳定 sid |
| 多音字 | 模型词典为主 + 自定义词典补丁 | `pinyin-pro` 用于生成/校验补丁，不能直接覆盖模型内部转写 |
| 存储 | Cache API + IndexedDB + Service Worker | 共享运行时缓存 + 每包独立模型缓存；EPUB 与进度存 IndexedDB；离线可用 |
| 高亮 | `<span data-sid>` + class 切换 + 自定义滚动 | 句子级同步；AI 模式不做逐字对齐 |
| 保活 | Wake Lock + 黑色遮罩“口袋模式” | 不承诺锁屏后台；不能通过 Web 调低系统亮度 |

### 0.3 关键量化指标（首版目标）

| 指标 | 目标值 | 备注 |
| :--- | :--- | :--- |
| 首个 AI 音色包下载 | 山岚 146.4MB / 小雅 80.8MB / 初晴 80.8MB / AISHELL-3 精选 95.2MB（均含 15.3MB 运行时） | 建议 Wi-Fi；运行时只下一次 |
| 后续音色包下载 | 山岚 131.1MB / 小雅 65.5MB / 初晴 65.5MB / AISHELL-3 精选 79.9MB | 运行时已缓存时只下载模型文件 |
| 应用首屏可交互 | 4G 中端机 < 2.5s | epub.js 与 Sherpa 运行时按需加载 |
| 系统语音首句发声 | 点击后 < 1s | 受系统语音包影响 |
| AI 首句发声 | 模型就绪后 < 2s（P95） | 不含首次下载；含 warmup 后测量 |
| 单句合成延迟 | 山岚常用句 1.0-1.7s；小雅 1.1-1.7s；初晴 0.8s、AISHELL-3 精选 0.6s（桌面 WASM，RTF 0.27-0.36） | 移动端会变慢；通过预取下一句掩盖延迟 |
| 高亮与发声偏差 | < 120ms | 句子级；以音频时钟为准 |
| 连续播放 | 60 分钟无崩溃、无持续欠载 | 内存增长 < 15% |
| 峰值内存 | < 350MB（4GB 设备） | 音频队列本身只占 1-2MB，主要占用在 WASM/模型 |
| 兼容基线 | iOS Safari 16.4+、Android Chrome 110+ | AI 模式还要求 WASM SIMD；低配自动降级 |

### 0.4 不可承诺的边界

1. **锁屏/后台持续合成不成立**。纯 Web 页面在 iOS 锁屏或切后台后，JS 线程与 WebAudio 都可能被冻结。口袋模式是“保持亮屏 + 黑色遮罩”的替代方案，不是锁屏方案。
2. **网页不能设置系统亮度**。黑色遮罩只能减少 OLED 像素发光，LCD 背光仍在工作；功耗不等同于锁屏。
3. **不存在“零崩溃风险”**。WASM OOM、iOS 标签页回收、系统语音异常都可能导致中断。正确目标是：把故障限制在 Worker/引擎内，并自动回退到系统语音。
4. **模型许可因包而异**。山岚与小雅的训练数据均为**非商用**许可；初晴（CC0 + MIT）与 AISHELL-3 精选（Apache-2.0 + MIT 前处理）可用于商业产品。设置页逐包展示许可，商用发布前仍应完成法务复核；不能把山岚或小雅标注为可商用。详见第 3.2 节。

### 0.5 排期结论

原方案“3 周完成”可以作为 **MVP/演示版** 的排期，但前提是至少 2 名前端并行（阅读链路与 TTS/WASM 链路各一人）+ 0.5 名 QA，并且第 1 周就完成 WASM 真机验证。单人开发建议按 4-5 周排；达到生产级还需要额外 1-2 周做兼容、性能和稳定性硬化。详见第 8 节。

---

## 1. 目标、范围与验收

### 1.1 产品目标

1. 用户通过链接/扫码打开网页，导入一本无 DRM 的 EPUB。
2. 系统语音可“秒开”朗读；可选下载离线 AI 音色。
3. 播放时高亮当前句，自动滚动到可视区；点击任意句子从该句开始朗读。
4. AI 模型下载后完全离线可用；听书过程中不请求后端、不上传书籍内容。
5. 提供屏幕常亮 + 口袋模式，降低手机放进口袋时的误触和功耗。
6. 关闭页面后再次打开，能恢复阅读位置、音色与语速设置。

### 1.2 非目标（首版不做）

- 零样本/少样本声音克隆、用户上传声音。
- 锁屏后持续生成与播放、系统级后台播放保证。
- 服务端 TTS、GPU 推理、账号体系、云同步、多人书库。
- DRM EPUB、PDF、固定版式（fixed-layout）漫画/画册的朗读。
- AI 模式的逐字/逐词高亮（没有强制对齐数据，手写计时误差不可接受）。
- 用户自行安装任意第三方模型；首版只提供清单内置、校验过哈希的音色包。
- 朗读时的背景音乐、音效、录音导出。

### 1.3 支持内容范围

| 项目 | 首版支持 | 说明 |
| :--- | :--- | :--- |
| EPUB 2 / EPUB 3 可重排 | 是 | 以中文正文、小说、非虚构为主 |
| 含图片的章节 | 是 | 图片跳过不读；不影响进度 |
| 脚注/尾注 | 可跳过或按正文读 | 首版默认跳过 `epub:type="footnote"` 的旁注，避免打断正文 |
| 表格/诗歌 | 有限支持 | 按块切句，保留换行停顿 |
| 中英混排 | 有限支持 | AI 中文模型对英文效果有限，建议系统语音 |
| 加密/DRM EPUB | 否 | 直接提示不支持 |
| 单本大小 | ≤ 100MB | 超过时提示；避免 iOS 标签页内存风险 |

### 1.4 验收口径

首版以“可听、可停、可跳、可恢复、可离线”为闭环，不以“音色像真人”为验收硬指标。音色质量单独做主观评测和模型 A/B，不阻塞主链路。

---

## 2. 对原方案的技术校验（必须先对齐）

| # | 原方案表述 | 2026-10 核实结论 | 对实现的影响与处理 |
| :--- | :--- | :--- | :--- |
| 1 | VITS 单发音人中文模型约 25-30MB | Aishell3 官方包 `vits-icefall-zh-aishell3`：压缩包 30.1MB，ONNX 30.5MB，词典 2.0MB；但它是 **174 个发音人** 的多发音人模型。Piper 单发音人 INT8 可到 13.4MB 压缩包（解压约 21MB） | 产品从内置 sid 中固定若干音色即可，不需要声音克隆；不额外做模型蒸馏。首版下载按 **33MB** 预估，不写 25MB |
| 2 | Piper/小雅等小模型可直接商用 | 不能一概而论：`xiao_ya` 的 MODEL_CARD 标注 BZNSYP 为 **Non-commercial use**；Chaowen 为 CC0、AISHELL-3 为 Apache-2.0 | 逐音色看 MODEL_CARD。当前可商用包选 Chaowen 与 AISHELL-3 精选；上线前仍须法务复核 |
| 3 | Sherpa-onnx WASM 跑在 Worker 中 | 官方仓库确实提供 `sherpa-onnx-tts.worker.js`，通过 `tts.generate()` 返回 Float32 采样并 transfer 到主线程 | Worker 链路已被官方验证，可复用；但官方构建把模型 `--preload-file` 打包进 `.data`，且 `INITIAL_MEMORY=512MB`，不适配“按需下载/低内存手机” | 需要定制 WASM 构建：关闭预打包、减小初始内存、导出 FS、按需挂载模型文件。列为 Day 1-2 的 Go/No-Go |
| 4 | Web Speech 0MB，iOS 是 Siri 音色 | API 免费、无需下载属实；但不保证 Siri 音色，取决于系统已安装语音包；iOS 静音开关、后台、微信 WebView 都可能影响 | 作为兜底而不是主体验；必须做能力检测、中文声音缺失提示、异常回退 |
| 5 | Wake Lock + 黑屏可接近锁屏功耗 | Wake Lock API 在 Safari 16.4+ 可用，但只保证屏幕不自动熄灭；**网页不能设置亮度**；OLED 黑屏只是减少像素发光，SoC/显示控制器仍工作 | 口袋模式按“防误触 + 黑色 UI + 降低渲染”设计，不宣传为锁屏或零功耗；必须做真机功耗/发热测试 |
| 6 | epub.js 是虚拟 DOM，滑动翻页成熟 | epub.js 用 iframe 渲染每章内容，分页模式依赖 CSS Columns；不是虚拟 DOM。滑动翻页需要自己绑定触摸事件 | 首版建议 `scrolled-doc` 纵向滚动，天然适配句子级平滑滚动与点击映射；分页模式 P1。不要让 epub.js 的内部实现假设泄漏到业务层 |
| 7 | 分句注入 span 后可以继续用 CFI | 向 DOM 插入 span 会改变 CFI 路径，深层的书内锚点、`book.locations` 可能失效 | 进度/恢复改用自建稳定 `sid`；目录跳转用章节 href；首周验证脚注链接。若问题严重，P1 改为 Range + CSS Custom Highlight API，不修改 DOM |
| 8 | pinyin-pro 可解决 95% 多音字 | pinyin-pro 能给出候选拼音，但 Sherpa 模型内部通过 `lexicon.txt` 决定发音；仅在前端算拼音不会改变模型输出 | 以模型词典为准，建立“自定义词典补丁”机制；pinyin-pro 负责 OOV 词/术语的拼音生成与人工校验，不要把它当运行时发音开关 |
| 9 | 模型存 Cache API，二次打开完全离线 | Cache API 可用，但 iOS 对脚本可写存储有清理/配额策略，用户清缓存、系统回收都会丢 | 请求 `navigator.storage.persist()`；模型清单带版本和 SHA-256；丢失后自动重新下载；UI 明确显示“已离线缓存” |
| 10 | 首次等待 5-10 秒下载 | 取决于网络。30MB 在 30Mbps 下约 8-10s，在弱 4G/微信内置浏览器可能 20-40s | 提供真实进度、失败重试、边听系统语音边后台下载；不要写死 5-10 秒 |

### 2.1 三个需要产品拍板的硬边界

1. **锁屏续播是否硬需求？** 若是，纯 Web 方案不成立，需要原生壳或预渲染整本音频（后者不推荐）。若否，口袋模式是首版方案。
2. **是否商用？** 山岚与小雅仅限非商用；初晴与 AISHELL-3 精选用 CC0/MIT/Apache-2.0 许可，可用于商业产品。商用发布前仍需逐包确认许可并做法务复核。
3. **是否必须首版分页翻页？** 若必须，先做分页模式的自动翻页与跨列高亮验证；否则首版用纵向滚动换取稳定性。

---

## 3. 技术选型与基线

### 3.1 技术栈

| 模块 | 选型 | 版本策略 | 选型理由与边界 |
| :--- | :--- | :--- | :--- |
| 应用框架 | Vue 3 + Vite + TypeScript | 以 lockfile 固定 | 与方案中的 `.vue` 组件一致；生态成熟、构建轻 |
| 状态管理 | Pinia | 固定大版本 | 阅读器/播放器/设置/书库四个 store，避免全局事件总线 |
| 阅读引擎 | epub.js | 锁定 0.3.x 具体版本 | 移动端可重排 EPUB 事实标准；用适配层隔离；关注 iframe/CFI 限制 |
| AI 运行时 | sherpa-onnx WASM（SIMD，单线程） | 固定 commit + 构建产物哈希 | 官方 TTS + Worker 支持；定制构建以降低内存、支持按需模型 |
| AI 模型 | 山岚 / 小雅 / 初晴 / AISHELL-3 精选 | 固定包版本与逐文件哈希 | 四包均为 22.05kHz；许可与体积逐包独立，可并行下载缓存 |
| 兜底 TTS | Web Speech API | 浏览器能力 | 零下载、即时；不保证一致性和后台 |
| 分句 | 自研 + `Intl.Segmenter` | 原生 API | 自研保证偏移与标点规则；Segmenter 用于词级/辅助 |
| 多音字辅助 | pinyin-pro | 按需动态加载 | 生成 OOV 词拼音和词典补丁；不直接控制模型内部转写 |
| 音频 | Web Audio API | 原生 | 精确调度、无缝衔接、暂停/恢复；不用 `<audio>` 逐句拼接 |
| 存储 | Cache API + IndexedDB | 原生/`idb` | 模型用 Cache，书籍/进度/设置用 IndexedDB |
| 离线 | Service Worker + Web App Manifest | `vite-plugin-pwa` 或手写 SW | 应用壳缓存、离线启动；模型由 ModelManager 单独管理 |
| 保活 | Screen Wake Lock API | 原生 + 能力检测 | iOS 16.4+；失败时提示并降级 |
| 测试 | Vitest + Playwright | 固定版本 | 单元测试分句/调度；E2E 覆盖导入→播放→高亮→恢复 |

不建议引入重型 UI 组件库（如完整 Vant/Element Plus）。听书界面以自定义底部播放器、弹层和阅读器为主，移动端首屏体积更可控。`pinyin-pro`、epub.js 和 Sherpa 运行时全部按需加载。

### 3.2 模型选型与许可证

#### 当前交付的四个音色包（schema v3）

| 音色包 | 音色 | 模型文件 | 首个包总下载 | 采样率 | 许可证 | 结论 |
| :--- | :--- | ---: | ---: | :--- | :--- | :--- |
| 山岚（`matcha-icefall-zh-baker`） | 山岚 | 131,103,774 B | 146,419,219 B（约 146.4MB） | 22,050Hz | Baker 数据 **仅限非商业** | 保留；原缓存名不变，老用户不重下 |
| 小雅（`piper-zh-xiaoya`） | 小雅 | 65,499,397 B | 80,814,842 B（约 80.8MB） | 22,050Hz | BZNSYP / DataBaker 数据 **仅限非商业**；Piper 仓库与前处理 MIT | 新增；与山岚同源，非商用 |
| 初晴（`piper-zh-chaowen`） | 初晴 | 65,499,397 B | 80,814,842 B（约 80.8MB） | 22,050Hz | 数据 CC0 + Piper 仓库 MIT | 新增；可商用 |
| AISHELL-3 精选（`piper-zh-aishell3`） | 青禾 / 照月 / 松涛 / 远川 | 79,916,874 B | 95,232,319 B（约 95.2MB） | 22,050Hz | AISHELL-3 数据与模型 Apache-2.0 + 前处理 MIT | 新增；可商用，4 个 sid 同包切换 |

四个包共用一份 15,315,445 B 的 Sherpa WASM 运行时：首次下载任选其一时才会带上运行时，之后新增音色包只下载模型文件。四个包全部缓存约 357.3MB（十进制），但用户只需下载想听的一个或几个包。每个包使用独立 Cache Storage；删除一个包不会影响其他包，只有最后一个音色包被删除时才清理共享运行时。

#### 候选对比（2026-10 用官方 WASM 运行时实测）

| 模型 | 部署体积 | 发音人/采样率 | 单句耗时 / RTF | 听感 | 许可证/数据 | 结论 |
| :--- | ---: | :--- | :--- | :--- | :--- | :--- |
| `vits-icefall-zh-aishell3` | 32.5MB | 174 / 8,000Hz | 0.2-0.5s | 发闷，吐字含混 | Apache-2.0 | 淘汰：8kHz 是音质天花板 |
| `melotts-zh`（int8/fp32） | 约 180MB | 1 / 44,100Hz | 6.1-14.5s，RTF 2.34 | 清晰 | MIT | 实时性不达标 |
| `kokoro-int8-zh` | 约 185MB | 多发音人 / 24,000Hz | 7.4-15.1s，RTF 2.16 | 有情感 | Apache-2.0 | 实时性不达标 |
| 山岚（Matcha Baker） | 131.1MB + 运行时 | 1 / 22,050Hz | 1.0-1.7s；80 字长句 4.75s | 清晰、自然 | Baker **仅限非商用** | 保留 |
| 小雅（Piper xiao_ya） | 65.5MB | 1 / 22,050Hz | 1.11s / 1.74s；RTF 0.31-0.33 | 清晰、停顿自然 | BZNSYP **仅限非商用** | 新增，非商用 |
| 初晴（Piper Chaowen） | 65.5MB | 1 / 22,050Hz | 0.84s / 1.54s；RTF 0.27-0.36 | 明亮、吐字清楚 | CC0 + MIT | 新增，可商用 |
| AISHELL-3 精选（Piper） | 79.9MB | 174 中选 4 / 22,050Hz | 0.63s / 1.31s；RTF 0.27-0.34 | 自然，男女声可选 | Apache-2.0 + MIT | 新增，可商用 |

上表耗时/RTF 为桌面 Node.js + 同款单线程 WASM 的实测值（山岚/初晴/AISHELL-3 精选为 15 字与 24 字；小雅为 16 字与 26 字，1.11s / 1.74s，RTF 0.31-0.33），移动端会更慢；小雅、初晴与 AISHELL-3 精选的 RTF 明显低于 1，配合下一句预取可以连续播放。MeloTTS/Kokoro 虽然音质更好，但在同一运行时下单句需 6-15 秒，不能作为听书主引擎。早期 8kHz icefall AISHELL-3 被淘汰并不代表 AISHELL-3 语料不可用——Piper 重新转换的 22.05kHz 版本解决了采样率瓶颈。

**为什么保留山岚？** 它的 Matcha + Vocos 组合听感自然、齿音清楚，是现有默认音色；直接保留原包与缓存名可避免老用户重新下载 131MB。其非商用边界继续在设置页逐包展示。

**为什么新增小雅？** 小雅与山岚同属 BZNSYP（标贝女声）语料，但走 Piper VITS + 拼音前端，音调起伏和停顿是另一套演绎；听感比初晴更柔和，单句 1.11s / 1.74s，RTF 0.31-0.33，体积只有 65.5MB。它的 MODEL_CARD 明确写了 **Non-commercial use**，正好补足“类似山岚的非商用音色”这个位置，也不与两个可商用包混淆。与山岚同源意味着不能把它宣传成“新发音人”，文案统一描述为“同语料的另一种演绎”。

**为什么选初晴和 AISHELL-3 精选？** 两者都满足“开源、许可清晰、可商用、22.05kHz、RTF < 1”。初晴是体积最小的单音色包；AISHELL-3 精选一个包提供 4 个差异明显的男女声，通过 `sid` 在同一次 Worker 初始化内切换，不必为每个音色单独下载 80MB。

**许可证边界（必须保留）：** 山岚的 Baker 数据集与小雅的 BZNSYP 语料都明确标注 **non-commercial use only**，不能宣传为可商用。初晴的数据集为 CC0、模型仓库为 MIT；AISHELL-3 数据与社区 Piper 模型仓库为 Apache-2.0，前处理文件为 MIT。所有来源、许可证与音色 sid 记录在 `public/sherpa/NOTICE.md` 和 `public/models/NOTICE.md`。

#### 多音色包的实际使用方式

- 清单使用 **schema v3**：顶层 `runtime` 描述共享运行时，`packs[]` 描述每个音色包；每个包有自己的 `id`、`version`、`license`、`model`、`voices[]`、`totalBytes` 和 `files[]`。
- 山岚是 `model.type = "matcha"`（声学模型 + Vocos + 词典 + tokens + 3 个 FST，共 7 个文件）；小雅、初晴与 AISHELL-3 精选是 `model.type = "vits"`（ONNX + 词典 + tokens + 3 个 FST，共 6 个文件）。
- 每个包各自携带一份 Piper 中文前处理文件（词典/ tokens / FST，约 2.3MB），换取“任删一个包都不影响其他包”的独立性；共享运行时不重复。
- 主线程只下载和缓存；Worker 打开当前包的 Cache，逐个读取、校验 SHA-256、写入 MEMFS。切换音色包时终止 Worker 并重新初始化，避免多个 80-131MB 模型同时驻留。
- 同包内多发音人（AISHELL-3 精选）切换时**不重启 Worker**，合成请求逐句携带 `speakerId`；音频缓存 key 包含 `speakerId + rate + text`，防止切声后重放上一音色的缓存。
- 采样率不要写死；初始化后从引擎读取，当前四包均为 22,050Hz。`tts.generate({ text, sid, speed })` 支持语速 0.8-2.0×。
- 数字/日期/电话规则交给 FST；JS 文本归一化只做清理，不替代模型转写。
- 与 VITS 不同，Matcha 需要同时配置声学模型与声码器，不能只替换一个 `model.onnx`。

#### 模型清单示例（schema v3，节选 AISHELL-3 精选）

```json
{
  "schemaVersion": 3,
  "runtime": {
    "version": "sherpa-onnx-wasm-tts-2.0.0",
    "baseUrl": "sherpa/runtime/",
    "glue": "sherpa-onnx-wasm-tts.js",
    "api": "sherpa-onnx-tts.js",
    "wasm": "sherpa-onnx-wasm-tts.wasm",
    "bytes": 15315445,
    "glueSha256": "...",
    "wasmSha256": "...",
    "apiSha256": "..."
  },
  "packs": [
    {
      "id": "piper-zh-aishell3",
      "name": "AISHELL-3 精选",
      "version": "2026.10.26",
      "license": {
        "label": "Apache-2.0",
        "commercialUse": true,
        "url": "https://www.openslr.org/93/",
        "notice": "音色基于 AISHELL-3 语料训练，语料与模型以 Apache-2.0 许可释出；Piper 前处理文件采用 MIT 许可。"
      },
      "baseUrl": "models/piper-zh-aishell3/",
      "model": {
        "type": "vits",
        "config": {
          "model": "zh_CN-cn_aishell3-medium.onnx",
          "lexicon": "lexicon.txt",
          "tokens": "tokens.txt",
          "noiseScale": 0.333,
          "noiseScaleW": 0.333,
          "lengthScale": 1
        },
        "ruleFsts": ["phone.fst", "date.fst", "number.fst"],
        "warmupText": "你好，欢迎收听。"
      },
      "voices": [
        {
          "id": "aishell3-qinghe",
          "speakerId": 170,
          "sampleRate": 22050,
          "label": "青禾",
          "description": "温柔女声，音色温暖，适合叙事类作品"
        }
      ],
      "totalBytes": 79916874,
      "files": [
        {
          "name": "zh_CN-cn_aishell3-medium.onnx",
          "url": "models/piper-zh-aishell3/zh_CN-cn_aishell3-medium.onnx",
          "bytes": 77639618,
          "sha256": "..."
        }
      ]
    }
  ]
}
```

完整字段、四个包与七个音色以 `public/models/manifest.json` 为准。清单加载时校验包 ID/音色 ID 唯一、`totalBytes` 等于文件字节和、许可证与运行时字段完整。

#### 许可证结论

- **代码/运行时**：sherpa-onnx Apache-2.0；Piper 模型仓库 MIT；epub.js BSD-2-Clause；Vue/Vite MIT。
- **山岚**：Baker 训练数据仅限非商用；这是产品边界，不是实现细节。设置页展示来源与非商用提示，商用发布不得使用该包。
- **小雅**：BZNSYP（标贝女声）训练数据仅限非商用，MODEL_CARD 明确标注；Piper 模型仓库与前处理文件 MIT。与山岚同属非商用边界。
- **初晴**：数据集 CC0，Piper 模型仓库与前处理文件 MIT；可用于商业产品。
- **AISHELL-3 精选**：AISHELL-3 训练数据与社区 Piper 模型仓库 Apache-2.0，前处理文件 MIT；可用于商业产品。
- **商用发布**：已不需要为了“可商用”替换全部音色，但仍需逐包保留许可信息并完成法务复核；MeloTTS/Kokoro 在当前单线程 WASM 运行时下不满足实时性，不能直接替换。

### 3.3 浏览器兼容矩阵

| 能力 | iOS Safari | Android Chrome | 微信内置浏览器 | 处理策略 |
| :--- | :--- | :--- | :--- | :--- |
| WebAssembly SIMD | 16.4+ | 91+ | 取决于 XWeb 内核，需真机 | 用 `wasm-feature-detect`；不支持则禁用 AI，走系统语音 |
| Web Worker + WASM | 支持 | 支持 | 多数支持 | 初始化失败自动降级 |
| Web Audio | 支持，但需用户手势解锁 | 支持 | 支持性需测 | 首次点击同步创建 AudioContext |
| Web Speech | 支持，声音取决于语音包 | 支持，取决于 Google TTS | 可能受限/无 UI | 播报前检测中文 voice；失败提示 |
| Screen Wake Lock | 16.4+ | 84+ | 可能不支持 | 失败时提示“请手动调高自动锁屏时间” |
| Cache API | 支持 | 支持 | 多数支持 | 模型缓存失败则每次下载/仅系统语音 |
| IndexedDB | 支持 | 支持 | 支持 | 书籍与进度都本地存储 |
| Service Worker/PWA | 支持（添加到主屏幕） | 支持 | 通常不支持 | 微信内提示“在浏览器打开” |
| 静音开关 | 会静音 Web Audio/语音 | Android 行为不同 | 依赖系统 | 首播提示“请关闭静音开关” |

**AI 模式推荐基线**：iOS 16.4+（建议 17+）、Android Chrome 110+、4GB 内存以上。低于此基线自动推荐系统语音，不阻塞主流程。

### 3.4 依赖与版本纪律

- Node 20/22 LTS、pnpm，提交 lockfile；CI 使用同一 Node 大版本。
- `epubjs` 固定精确版本（0.3.x），不要使用 `^`；在 `src/types/epubjs.d.ts` 补最小类型。
- `pinyin-pro`、`wasm-feature-detect`、`idb` 属于小体积依赖；pinyin-pro 仅在“补丁生成/生词注音”路径动态 import。
- 模型不进入 JS bundle；当前以独立静态文件放在 `public/models/` 同源分发。若改用 CDN，必须保持同源或 HTTPS，并在清单中固定 SHA-256。
- 每次升级 sherpa-onnx WASM 都必须重跑真机 RTF/内存基准；运行时版本与模型清单绑定。

---

## 4. 总体架构

### 4.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│ UI 层（Vue）                                                 │
│ Library / EpubViewer / PlayerBar / VoiceSheet / PocketLock   │
└───────────────┬─────────────────────────────────────────────┘
                │ Pinia actions/events
┌───────────────▼─────────────────────────────────────────────┐
│ 应用编排层                                                   │
│ ReadingSession（章节/句子游标）  PlaybackController（队列）   │
│ CapabilityService（能力检测）    Settings/Library stores     │
└───────┬───────────────────────┬─────────────────────────────┘
        │                       │
┌───────▼────────────┐  ┌───────▼─────────────────────────────┐
│ 阅读层              │  │ 语音层                               │
│ EpubAdapter         │  │ TtsDriver                           │
│ SentenceSplitter    │  │ ├─ SherpaDriver → classic Worker    │
│ Highlighter         │  │ │    └─ WASM + 模型 MEMFS           │
│ ScrollController    │  │ └─ WebSpeechDriver                  │
└───────┬─────────────┘  └───────┬─────────────────────────────┘
        │                        │
┌───────▼────────────────────────▼─────────────────────────────┐
│ 持久化层                                                     │
│ IndexedDB（书库/进度/设置）  CacheStorage（模型）  SW（壳）   │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 线程与内存模型

| 线程/区域 | 负责 | 不负责 | 内存预算 |
| :--- | :--- | :--- | :--- |
| 主线程 | EPUB DOM/高亮/滚动、AudioContext 调度、UI | WASM 推理、大文件哈希的长时间阻塞 | UI + 一章 DOM + 1-2MB 音频队列 |
| Worker | WASM 初始化、当前包的 Matcha/VITS 推理、PCM 生成、首尾静音裁剪/归一化 | DOM、滚动、UI | 当前包模型（最大 131MB）MEMFS + WASM 堆；切换包时先释放旧 Worker |
| CacheStorage | 共享运行时 + 各音色包模型 | 音频 | 运行时 15.3MB；每个已下载包 65.5-131.1MB |
| IndexedDB | EPUB Blob、封面、进度、设置 | 模型大文件 | 由书籍数量决定，展示配额 |

**注意**：原方案说“内存中只保留 2-3 句 AudioBuffer（不足 2MB）”只描述了音频队列；WASM 堆中还驻留模型和推理中间张量。山岚按 200-300MB 整页内存评估，小雅、初晴与 AISHELL-3 精选的模型更小，但同样需要真机实测并做低端机降级。同一时间只加载一个音色包。

### 4.3 关键数据流

1. 用户导入 EPUB → 计算文件哈希 → 存 IndexedDB → 解析元数据/封面 → 打开阅读器。
2. 渲染当前章节 → 注入分句 span → 建立 `sid → 元素` 映射。
3. 用户点击播放 → CapabilityService 决定系统语音或 AI → 创建 AudioContext（必须在此手势内）。
4. 若选 AI：ModelManager 检查 Cache → 下载/校验 → Worker 初始化 → warmup。
5. PlaybackController 从当前 sid 取句子 → 发给 TTS Driver → 音频调度/系统语音。
6. 句子实际开始 → 发出 `sentenceStart` → Highlighter 切 class → 必要时平滑滚动。
7. 当前音频结束 → 游标前进 → 预取下一句/下一章 → 保存进度。
8. 暂停/跳转/切章 → 清空队列或 epoch 失效 → 重新生成。
9. 关闭页面 → 保存 {bookId, spineIndex, sid, rate, engine} → 下次恢复但不自动播放。

---

## 5. 模块详细设计

### 5.1 工程目录

在原方案基础上补齐 Worker、适配层、测试与构建脚本：

```
src/
├── main.ts
├── App.vue
├── components/
│   ├── LibraryShelf.vue        # 书库/导入/删除
│   ├── EpubViewer.vue          # epub.js 容器、触摸、渲染生命周期
│   ├── AudioController.vue     # 底部/展开播放器
│   ├── PocketLock.vue          # 全黑防误触层
│   ├── VoiceSheet.vue          # 系统语音/AI 音色选择与下载
│   ├── DownloadProgress.vue    # 模型下载进度
│   ├── TocDrawer.vue           # 目录
│   └── DiagnosticsPage.vue     # 能力/内存/错误诊断（隐藏入口）
├── core/
│   ├── reader/
│   │   ├── EpubAdapter.ts      # epub.js 薄封装：打开/渲染/章节/坐标/事件
│   │   ├── SentenceSplit.ts    # DOM 分句、稳定 sid、span 注入
│   │   ├── TextNormalizer.ts   # 数字/日期/空白/标点归一化（TTS 输入）
│   │   ├── Pronunciation.ts    # 自定义词典、pinyin-pro 辅助
│   │   ├── Highlighter.ts      # sid→元素映射、active 样式、滚动
│   │   └── ScrollController.ts # 自定义平滑滚动/用户干预暂停
│   ├── tts/
│   │   ├── TtsDriver.ts        # 统一驱动接口与事件
│   │   ├── SherpaDriver.ts     # Worker 生命周期、请求队列、音频调度
│   │   ├── WebSpeechDriver.ts  # 系统语音封装
│   │   ├── AudioScheduler.ts   # AudioContext、时间线、暂停/恢复
│   │   ├── PlaybackController.ts # 跨句/跨章游标、预取、睡眠定时
│   │   ├── protocol.ts         # 主线程 ↔ Worker 消息类型
│   │   └── tts.worker.ts       # 构建成 classic IIFE，加载 Emscripten
│   └── storage/
│       ├── ModelManager.ts     # 清单、下载、校验、缓存、版本切换
│       ├── BookStore.ts        # IndexedDB 书籍/封面
│       └── ProgressStore.ts    # 阅读/听书进度
├── device/
│   ├── CapabilityService.ts    # SIMD/Worker/Audio/WakeLock/WebSpeech/存储
│   ├── WakeLockManager.ts      # 请求/释放/可见性重获
│   └── AudioUnlock.ts          # 首手势解锁 AudioContext
├── stores/
│   ├── library.ts
│   ├── reader.ts
│   ├── player.ts
│   └── settings.ts
├── styles/
│   ├── tokens.css
│   ├── reader.css
│   └── safe-area.css
└── types/
    ├── epubjs.d.ts
    └── models.ts

public/
├── manifest.webmanifest
├── icons/
└── wasm/<runtime-version>/
    ├── sherpa-onnx-wasm-main-tts.js
    ├── sherpa-onnx-wasm-main-tts.wasm
    ├── sherpa-onnx-tts.js          # 定制：VITS 中文 lexicon 配置
    └── tts.worker.js               # 构建产物（classic worker）

scripts/
├── build-wasm.sh                  # Docker/Emscripten 构建与校验
├── fetch-model.mjs                # 下载/校验/上传模型
└── check-bundle-size.mjs

tests/
├── unit/
├── fixtures/
└── e2e/
```

### 5.2 EPUB 导入、书库与持久化

**导入流程**

1. `<input type="file" accept=".epub,application/epub+zip">` 读取为 `ArrayBuffer`。
2. 校验 ZIP magic（`PK\x03\x04`）、文件大小 ≤ 100MB、EPUB mimetype（可选）。
3. 用 `crypto.subtle.digest('SHA-256', buffer)` 生成 `bookId`；重复导入直接打开已有记录。
4. 用 epub.js 打开，读取 `package.metadata`（title/author/language）与封面；封面存 Blob。
5. 存入 IndexedDB：`{ bookId, title, author, language, size, addedAt, fileBlob, coverBlob }`。
6. 打开阅读器；首次进入从第 1 个可读 spine 开始，之后从 `ProgressStore` 恢复。

**IndexedDB 结构（建议）**

```ts
// books
{ bookId: string; title: string; author?: string; language?: string;
  size: number; addedAt: number; file: Blob; cover?: Blob }

// progress
{ bookId: string; spineIndex: number; sid?: string;
  percent: number; updatedAt: number; engine: 'system' | 'sherpa'; rate: number }

// models
{ modelId: string; version: string; status: 'ready' | 'downloading' | 'failed';
  cachedBytes: number; activatedAt?: number }
```

**边界**

- 不把整本书挂到全局 store 的响应式对象里，避免 Vue 深度代理大 Blob/ArrayBuffer。书籍数据只由 ReaderSession 持有。
- 删除书籍时同时清理封面 Blob URL（`URL.revokeObjectURL`）、进度记录；不删除 AI 模型。
- 导入失败（DRM/损坏/格式不支持）给出具体错误码，不静默失败。
- 首版只支持本地文件导入；URL 导入涉及 CORS、隐私和盗版风险，P2 再评估。

### 5.3 EPUB 渲染与阅读器适配

#### 首版布局结论

采用 **`manager: "default"` + `flow: "scrolled-doc"` 的纵向滚动阅读**，每章一个 iframe，章节之间切换时重新渲染。理由：

1. 原方案的高亮/滚动算法（`getBoundingClientRect` + 下方 1/3 触发）天然是纵向滚动模型。
2. 分页模式的 CSS Columns 会把一句话拆到两页/两列，句子级高亮、跨页滚动和点击映射都更复杂。
3. 纵向滚动在手机上更接近网文阅读习惯；用户滑动即滚动，不需要额外的翻页手势。

分页翻页作为 P1：保留 `ReaderAdapter` 抽象，后续接入 `flow: "paginated"`，当高亮句不在当前页时自动 `next/prev`；不做首版。

> 注意：epub.js 官方示例中 `flow` 与 `manager` 的组合需要真机验证。Day 1 的 Spike S3 要确认：`scrolled-doc` 下实际滚动容器、iframe 高度、句子矩形坐标、`rendition.next()` 章节切换行为。以实测为准，不把选择器写死。

#### 初始化参数

```ts
const book = ePub(arrayBuffer);
const rendition = book.renderTo(container, {
  width: '100%',
  height: '100%',
  flow: 'scrolled-doc',
  manager: 'default',
  spread: 'none',
  allowScriptedContent: false, // iframe sandbox 仅 allow-same-origin
  allowPopups: false,
});
```

- `allowScriptedContent: false` 是关键安全边界：EPUB 内脚本不执行；书内容不能访问宿主应用状态。
- iframe 默认 `sandbox="allow-same-origin"`；父页面可以读 DOM 做分句，但书内脚本不能运行。
- EpubViewer 只负责容器、生命周期和触摸事件；所有书籍操作通过 `EpubAdapter` 暴露，禁止业务组件直接调用 epub.js 的内部 manager。

#### 章节与事件

- 监听 `rendition.on('rendered', (section, view) => ...)`，在每次章节渲染后重新执行分句、重建 `sid → elements` 映射、恢复当前高亮。
- 监听 `relocated` / 滚动事件保存进度；进度节流 1-2s，避免频繁写 IndexedDB。
- 章节末尾由 PlaybackController 触发 `adapter.goToNextChapter()`；首版允许 0.5-1.5s 章节加载空档，P1 再做下一章文本预解析/预合成。
- 监听 `resized`/屏幕旋转：epub.js 会重排，span 仍在 DOM 中；重建映射并重新计算当前句位置。防抖 150ms。
- 字号/主题切换通过 epub.js themes 修改 CSS；高亮样式单独注入，避免被主题覆盖。

#### 触摸与点击

- iframe 内的触摸事件不会冒泡到父页面，必须在 `rendered` 后把监听器绑到 `view.document`（或在 `contents` 上）。
- 点击优先级：链接（`a`）> 脚注/目录锚点 > 句子。链接按 epub.js/浏览器的内部跳转处理；外部链接 `noopener noreferrer` 打开。
- 点击句子：`closest('[data-sid]')` 取 sid → `PlaybackController.seek(sid)`；若播放中直接跳读，若暂停则高亮并准备播放。
- 滑动判定：`touchstart` 记录坐标，`touchend` 位移 > 10px 视为滚动，不触发点击；`touchmove` 不 `preventDefault`，保留原生纵向滚动。
- P1 分页模式才需要横向 swipe 手势；首版不要为它增加复杂度。

#### 安全和内容边界

- 书内脚本禁用；注入 CSP `script-src 'none'` 到 iframe head（在 `hooks.content` 中），阻断远程脚本。
- 默认阻止远程图片/字体加载，避免隐私追踪；提供 P1 开关“允许远程资源”。
- 内部锚点/脚注在分句后可能受 CFI 影响，Day 3-4 用样本书验证；若异常，脚注跳转改为按 `href#id` + `getElementById` 定位，不依赖深层 CFI。
- EPUB 为不可信输入：限制单本大小、检查 ZIP 结构，避免压缩炸弹；任何解析异常都以用户可读错误结束，不崩溃主页面。

### 5.4 分句、稳定 ID 与文本归一化

#### 5.4.1 DOM 分句算法

目标：不破坏原文、不丢字符、支持内联标签、每句可稳定定位。

1. 按文档顺序收集“文本块”：`p, li, h1-h6, blockquote, td, dd, dt, figcaption, pre` 等；过滤嵌套在已选块内的块，避免重复。
2. 对每个块用 `TreeWalker` 遍历文本节点，跳过：
   - `rt`、`rp`（拼音注音不应朗读）
   - `script/style/noscript`
   - `svg/math`
   - `[hidden]`、`[aria-hidden="true"]`
   - `epub:type` 含 `footnote`/`endnote` 的 aside（首版）
3. 建立字符流：每个字符记录所属文本节点和 offset。
4. 在字符流上找句子边界：
   - 强边界：`。！？!?…`，以及其后连续的收尾引号/括号 `”’」』）】》`。
   - 保留省略号整体 `……`，不要把单个 `…` 拆开。
   - 小数点/英文缩写不拆（`.` 位于数字/字母之间时忽略；中文书籍中以句末标点为主）。
   - 换行/块结束也视为边界。
5. 后处理：
   - 过短句（< 8 个汉字）合并到前句或后句，避免 TTS 频繁启停。
   - 过长句（> 80 个字符）在次级标点 `，、；：,;:` 附近切分；仍超长则硬切，但不切断英文单词和数字。
   - 去掉纯空白/纯标点句；图片/空块跳过。
6. 包裹：
   - 一句话可能跨越多个文本节点（例如 `<em>`、`<a>`），因此**一句话对应一个或多个 span**，共享同一个 `data-sid`。
   - 从后往前处理文本节点，使用 `splitText` + 插入 span，避免前面的节点偏移失效。
   - 不改变文字顺序；span 只添加 `display:inline` 级样式，不引入额外空白。

```ts
interface SentenceFragment {
  node: Text;
  start: number;
  end: number;
}

interface Sentence {
  sid: string;              // `${spineIndex}-${blockIndex}-${sentenceIndex}`
  spineIndex: number;
  blockIndex: number;
  indexInBlock: number;
  displayText: string;      // 原始显示文本（含标点）
  speechText: string;       // 归一化后的 TTS 输入
  fragments: SentenceFragment[];
}
```

**稳定 ID**：`spineIndex-blockIndex-sentenceIndex`。同一本书文件版本下，重新渲染应得到相同 sid；字体大小、主题、窗口尺寸不改变 sid。书籍文件变更（不同哈希）视为新书。

**幂等性**：分句前检查 `section.document.body.dataset.ttsWrapped === 'v1'`；已包裹则只重建映射，不重复插 span。重新渲染（resize/主题）后如果 epub.js 重建了 iframe，则重新执行。

#### 5.4.2 语音文本归一化（与显示文本分离）

显示文本永远保留原文；`speechText` 只用于 TTS：

- 折叠连续空白、删除零宽字符、把不常见标点映射到模型支持的中文标点。
- 数字/日期/百分比/金额：
  - `2026年10月26日` → `二零二六年十月二十六日`（或按产品偏好 `二千零二十六`，首版统一用逐位读法，避免歧义）。
  - `3.14` → `三点一四`；`100%` → `百分之一百`；`¥35` → `三十五元`。
  - 优先自研 JS 规则；模型包里的 `number.fst/date.fst` 作为备选，不把 172MB 的 `rule.far` 带进浏览器。
- 英文缩写/网址：URL 不读协议头；英文单词保留，中文模型效果差时提示使用系统语音。
- 标点用于停顿：分句后由播放调度插入静音（逗号 120-180ms、句号 250-350ms、段落 400-600ms），因为 VITS 内部对所有标点使用同一个 pause token，不能依赖模型产生不同停顿。

#### 5.4.3 多音字与自定义词典

正确的层级：

1. **模型词典**（`lexicon.txt`）是唯一直接决定模型发音的输入；长词优先匹配。
2. **自定义词典补丁**：维护 `glossary.json`（人名、地名、术语、书名）→ 生成 sherpa 可读的 lexicon 条目；启动时把基础词典与补丁合并写入 MEMFS，再初始化 TTS。词典更新后需重建 TTS 实例。
3. **pinyin-pro**：用于给 OOV 词生成候选拼音、批量生成补丁、人工校验；不能只在前端把文字换成拼音就假设模型会跟着变。若未来要完全绕过模型词典，需要研究 `phonemeCodepoints` 输入链路，首版不做。
4. 建立 100 句多音字回归集（重/行/长/乐/还/得/地/着/了、姓氏、数字、年份），每次词典/模型变更都跑。

### 5.5 高亮、平滑滚动与点击跳读

#### 5.5.1 高亮实现

- 分句 span 使用统一的 class：`tts-sentence`；当前句加 `tts-active`。
- Highlighter 内部维护 `Map<string, HTMLElement[]>`；一个 sid 可能有多个片段。切换时移除旧 sid 的所有 class，添加新 sid。
- 不做逐字高亮；AI 模式没有时间对齐数据，逐字计时是伪同步。
- 样式只改变背景色/圆角，不改变字号、字重、padding，避免布局抖动；跨列/跨页时用 `box-decoration-break: clone`。

```css
.tts-sentence { display: inline; }
.tts-sentence.tts-active {
  background-color: var(--tts-highlight, rgba(255, 214, 102, .38));
  border-radius: 3px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  transition: background-color 120ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .tts-sentence.tts-active { transition: none; }
}
```

注入样式时使用单独 stylesheet，并在主题切换后重新注入；用 `!important` 只保护结构性属性（`display`、`background`），不要大面积覆盖书籍 CSS。

#### 5.5.2 滚动策略

不用 `scrollIntoView()`。只在高亮句变化时计算一次位置，并做“可视区滞回”：

- 将 iframe 内 `getBoundingClientRect()` 加上 iframe 在父页面的偏移，得到句子在视口中的位置。
- 若句子顶部已进入视口 15%-62% 区域，不滚动；只有当它接近/超出下方 1/3 或跑到上方时才滚动。
- 目标位置：句子顶部落在视口高度约 38% 处；用父级滚动容器的 `scrollTo({ top, behavior: 'smooth' })`；若 iOS 平滑效果差，改为 rAF + easeOutCubic 300ms。
- 用户主动触摸/滚动后，暂停自动跟随 4-5 秒，避免“用户想回看，页面却被拽走”；提供一个“回到朗读位置”按钮。
- 口袋模式下暂停高亮 DOM 更新和滚动（没有人看），只维护当前 sid；退出时再同步一次。
- 页面旋转/字号变化后重新计算；不要按旧矩形滚动。

```ts
function ensureSentenceVisible(rectInViewport: DOMRect, vh: number, scroller: HTMLElement) {
  const top = rectInViewport.top;
  const bottom = rectInViewport.bottom;
  if (top >= vh * 0.15 && bottom <= vh * 0.66) return;
  const desiredTop = scroller.scrollTop + top - vh * 0.38;
  smoothScrollTo(scroller, desiredTop, 300);
}
```

#### 5.5.3 点击跳读与手势冲突

- `touchstart` 记录 `{x, y, t}`；`touchend` 位移 < 10px 且 < 400ms 才视为点击。
- 命中 `a` 时不跳读，走链接逻辑；命中 `.tts-sentence` 时取 `data-sid`。
- 用户正在长按选择文本时不要触发跳读（检测 `selection` 非空）。
- 播放中点击别处：立即暂停当前音频、清空队列、高亮目标句、生成并播放；准备好之前显示“正在准备”状态，不要假装在播放。
- 点击当前句：切换暂停/继续。

#### 5.5.4 分页模式（P1）

若后续要求翻页：

- 使用 `flow: "paginated"`，自定义 iframe 内横向 swipe；不要混用滚动定位。
- 高亮句不在当前页时调用 `rendition.next()` / `prev()`；跨列句子用多个片段高亮。
- 分页会改变“自动滚动”语义，Highlighter 需要单独的 `PageTurnStrategy` 实现，不能复用滚动代码。

### 5.6 播放器状态机与双引擎调度

#### 5.6.1 状态机

```ts
type EngineKind = 'system' | 'sherpa';
type EngineState = 'idle' | 'checking' | 'downloading' | 'initializing' | 'ready' | 'error';
type PlaybackState = 'idle' | 'preparing' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';
type PocketState = 'off' | 'on';
```

| 状态 | 触发 | UI 行为 |
| :--- | :--- | :--- |
| `preparing` | 点击播放/跳句 | 高亮目标句可选，显示加载指示；不提前移动音频时钟 |
| `buffering` | 队列空且下一句未就绪 | 保持当前位置，显示“生成中”；不要跳过句子 |
| `playing` | 首个音频/语音 `start` | 高亮、更新进度、保持 Wake Lock |
| `paused` | 用户暂停/来电/切后台 | 保留位置；AI 可继续预生成下一句；释放 Wake Lock |
| `error` | 初始化/合成失败 | 给出错误码；系统语音可切换；不要静默停止 |
| `ended` | 章末/书末 | 释放 Wake Lock，保存进度，显示重播/下一章 |

#### 5.6.2 双引擎选择

```ts
async function chooseEngine(): Promise<EngineKind> {
  if (!capabilities.sherpa) return 'system';
  if (await modelManager.isReady()) return settings.preferred === 'system' ? 'system' : 'sherpa';
  return settings.alwaysAsk ? await showVoiceSheet() : 'system';
}
```

- 首次使用：弹出极简选择面板：
  - **系统语音**：立即开始，0MB；提示音色取决于手机。
  - **离线 AI 音色**：在音色库里选择山岚（约 146.4MB，仅限非商业）、小雅（约 80.8MB，仅限非商业）、初晴（约 80.8MB，可商用）或 AISHELL-3 精选（约 95.2MB，含 4 个音色，可商用）；首个包包含共享运行时，之后每包只下载模型。
- 每个音色包单独展示许可证与体积，下载前必须可见；同包多音色通过 sid 切换，不重复下载。
- 模型已缓存且能力通过：默认使用已选中音色对应的 AI 包（可被用户设置覆盖）。
- 下载 AI 模型时，允许先用系统语音播放；下载完成后提示“切换到 AI 音色”（首版切换从当前句重新开始，P1 做句间无缝切换）。
- 初始化失败自动回退系统语音，并记录一次本地错误；连续失败 2 次后在设置中隐藏 AI 入口（可手动重试）。

#### 5.6.3 PlaybackController 职责

- 维护跨章节游标：`{ spineIndex, sentenceIndex, sid }`。
- 维护“生成/播放队列”：当前句 + 预取 1-2 句；章末请求 ReaderSession 加载下一章。
- 接收 TTS Driver 的 `sentenceStart` / `sentenceEnd` / `buffering` / `error` 事件，驱动 Highlighter 和进度。
- 处理 `seek`：epoch++，清空音频队列，停止当前源，重新生成目标句。
- 睡眠定时、播放速度、重播当前句、上一句/下一句、章节切换。
- 所有事件带 `epoch`，丢弃旧 epoch 的异步结果，避免“用户已跳到第 10 句，第 3 句的音频才返回”。

### 5.7 系统语音引擎（Web Speech）

#### 封装要点

- 逐句 `SpeechSynthesisUtterance`，每句播放完再发下一句；不要一次把整章塞进 `speak()`，否则无法精确高亮，且 Chrome 存在长 utterance 被截断的已知问题。
- 保留当前 utterance 的引用，防止 Chrome 垃圾回收导致 `onend` 不触发。
- `sentenceStart` 在 `utterance.onstart` 发出；`sentenceEnd` 在 `onend` 发出；`onerror` 映射为错误事件。
- 声音选择：`lang` 以 `zh` 开头；优先 `localService === true`；记录可用声音；没有中文声音时提示安装系统语音包，不静默用英文声音读中文。
- 语速：`utterance.rate`（0.5-2.0，实际范围按平台 clamp）；当前句播放中更改语速，从下一句生效；也可暂停后重新播当前句。
- 暂停/恢复：
  - 优先 `speechSynthesis.pause()/resume()`；部分 Android/微信 WebView 不可靠。
  - 检测失败时用 `cancel()` + 记录当前句，恢复时从当前句开头重读。UI 上接受“恢复后重读本句”的语义，不要假装精确续播。
- `onboundary` 可选做词级高亮，但 iOS Safari 支持不稳定，首版只做句子级；不要把它作为核心依赖。
- 静音开关：系统语音通常受静音开关影响；首播前提示“请确认媒体音量与静音开关”。不能可靠检测声音是否真的输出。

#### iOS 自带音色

- 设备检测：iPhone/iPad UA，另识别 iPadOS 桌面模式（`MacIntel` 且 `maxTouchPoints > 1`）。
- 列出已安装的中文系统音色，标注「增强 / 标准」与「本地 / 联网」，按系统默认 → 普通话 → 增强 → 本地排序；播放时用 `voiceURI` 固定用户选择。
- 试听与「重新检测」都在用户手势内调用 `speechSynthesis`，并在 `speak()` 前 `resume()`，规避 iOS 首次不发声、音色列表延迟加载的怪癖。
- Siri 音色通常不向网页开放；页面只能使用「设置 → 辅助功能 → 朗读内容 → 声音」中已下载的音色。增强音色需用户自行下载，界面给出路径提示，不假装能代装。
- 保存的 `voiceURI` 在音色列表变化后可能失效，检测到不在当前列表时回退「自动选择」，避免出现没有任何选中项的状态。

#### 与 AI 引擎的统一

`PlaybackController` 只依赖统一的 `TtsDriver` 事件：

```ts
interface TtsDriver {
  readonly kind: 'system' | 'sherpa';
  init(opts?: { onProgress?: (p: DownloadProgress) => void }): Promise<TtsInfo>;
  start(cursor: SentenceCursor, provider: SentenceProvider): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(sid: string): Promise<void>;
  setRate(rate: number): Promise<void>;
  stop(): void;
  dispose(): void;
  on(listener: (e: TtsEvent) => void): () => void;
}
```

内部实现可以完全不同：SherpaDriver 使用 Worker + AudioScheduler；WebSpeechDriver 使用 utterance 队列。不要为了“接口统一”强行让系统语音生成假音频缓冲。

### 5.8 Sherpa WASM 运行时改造（关键路径）

#### 已确认的事实

- 官方有 TTS Web 示例与 **Worker** 文件：`sherpa-onnx-tts.worker.js`；通过 `importScripts` 加载 Emscripten 胶水，`tts.generate()` 返回 `{samples: Float32Array, sampleRate}`，并 transfer `samples.buffer`。
- 官方 CMake 构建的 TTS WASM 配置包含：
  - `FORCE_FILESYSTEM=1`
  - `INITIAL_MEMORY=512MB`
  - `ALLOW_MEMORY_GROWTH=1`
  - `--preload-file assets@.`（模型被打进 `.data`）
- 官方 `sherpa-onnx-tts.js` 的 VITS 配置默认按英文示例写死：`model='./model.onnx'`, `tokens='./tokens.txt'`，只有 `usePhonemize=false` 时才设 `lexicon='./lexicon-en-us.txt'`。**不能直接用于中文模型**，必须定制。

#### 定制构建要求

| 项目 | 要求 | 原因 |
| :--- | :--- | :--- |
| 预打包 | 取消 `--preload-file` | 模型由 ModelManager 按需下载/缓存，而不是每次加载上百 MB 的 `.data` |
| 初始内存 | 64MB 或 128MB 起步，`ALLOW_MEMORY_GROWTH=1` | 官方 512MB 初始分配在 iOS 上风险极高 |
| 文件系统 | 导出 `FS`（或启用 `Module.FS`） | Worker 把模型 ArrayBuffer 写入 MEMFS |
| Worker | `-sENVIRONMENT=web,worker`，保持 classic `importScripts` | 不使用 module worker，避免 Emscripten 胶水兼容问题 |
| 线程 | 单线程，不启用 pthreads | 避免 COOP/COEP，微信 WebView 更稳；性能不足时降级 |
| SIMD | 单独构建 `-msimd128` 产物 | Safari 16.4+/Chrome 91+ 可用；不支持则禁用 AI |
| 导出 | `createOfflineTts`、`tts.generate`、`sampleRate`、`FS` | 供自定义 Worker 使用 |
| 构建环境 | Docker 固定 Emscripten 版本 | 产物可复现；CI 记录哈希 |
| 产物 | `.wasm` + 胶水 JS + 自定义 `sherpa-onnx-tts.js` + `tts.worker.js` | 运行时版本化部署 |

#### Worker 初始化顺序

1. 主线程从 Cache 读取模型 3 个文件（ArrayBuffer），校验 SHA-256。
2. 主线程创建 **classic worker**（`new Worker('/wasm/<v>/tts.worker.js')`），把 `{modelBuffers, runtimeBaseUrl, config}` 传过去（Transferable）。
3. Worker 设置 `self.Module`，在 `preRun`/运行时初始化后把文件写入 MEMFS：
   - `/model.onnx`
   - `/lexicon.txt`
   - `/tokens.txt`
4. `importScripts('sherpa-onnx-wasm-main-tts.js')`、`importScripts('sherpa-onnx-tts.js')`（定制版）。
5. 调用定制 `createOfflineTts(Module, { model: '/model.onnx', lexicon: '/lexicon.txt', tokens: '/tokens.txt', sid, lengthScale: 1 })`。
6. 读取 `tts.sampleRate`、`tts.numSpeakers`，生成一条短句做 warmup（如“你好。”），丢弃音频，测量 init/warmup 时间。
7. 发送 `ready`；之后接收 `synth` 请求。

如果 `Module.FS` 在自定义构建中不可用，备选方案是把模型文件通过 `--preload-file` 生成一次 `.data`，用 Service Worker 缓存该 `.data`；但这会牺牲动态模型切换与部分进度控制，且仍需解决初始内存问题。

#### Worker 消息协议

```ts
// main → worker
type MainToWorker =
  | { type: 'init'; runtimeBaseUrl: string; model: ModelFiles; config: { sid: number } }
  | { type: 'synth'; epoch: number; jobId: string; text: string; speed: number }
  | { type: 'cancel'; epoch: number }
  | { type: 'dispose' };

// worker → main
type WorkerToMain =
  | { type: 'ready'; sampleRate: number; numSpeakers: number; initMs: number; warmupMs: number; heapBytes: number }
  | { type: 'result'; epoch: number; jobId: string; samples: Float32Array; sampleRate: number; synthMs: number }
  | { type: 'error'; epoch?: number; code: string; message: string }
  | { type: 'log'; level: 'info' | 'warn'; message: string };
```

设计约束：

- **结果必须带 epoch**；主线程只接受当前 epoch。用户跳句、暂停、切章都会递增 epoch。
- Worker 是单线程，ONNX 推理过程不能中断。保持每句 ≤ 80 字，把单次不可取消的时长限制在可接受范围内；取消只在句子边界生效。
- `samples.buffer` 作为 Transferable 传回，避免复制。主线程创建 `AudioBuffer` 后尽快释放 Float32 引用。
- 若首句延迟仍高，P1 研究 `generateWithCallback` 的流式分块；首版先做整句返回，逻辑简单、音质稳定。

#### 合成后处理

- 首尾静音裁剪：检测低于 -45dBFS 的连续片段，保留约 20ms，避免句间出现长空白。
- 峰值归一化到 -1dBFS；加 5-10ms 淡入/淡出，防止爆音。
- 不改变模型输出的音高/语速；变速通过重新合成（调整 lengthScale）实现，避免 `playbackRate` 变调。
- 单句音频时长、合成耗时、RTF 记录到诊断页，用于优化。

#### 内存与失败处理

- 初始化后记录 `Module.HEAP8.length`；合成若干句后记录峰值（若可获取）。低端机超过阈值时终止 Worker，回退系统语音。
- 捕获 `RangeError: WebAssembly.Memory` / OOM；不要假设 `catch` 一定能捕获所有浏览器崩溃，页面级 `error`/`unhandledrejection` 仅用于记录。
- 暂停 10 分钟后可 `dispose()` 并 terminate Worker 释放内存；再次播放重新初始化（模型从 Cache 读取，通常 1-3s）。
- 提供“清除 AI 离线包并重启”入口，处理模型损坏/版本不兼容。

### 5.9 音频调度（双缓冲）

#### AudioContext 解锁

- 用户首次点击“播放”/“AI 音色”时**同步**创建并 `resume()` AudioContext，然后才开始下载/初始化。不要等 65-146MB 的音色包下载完再创建，否则 iOS 会以“非用户手势”阻止播放。
- 全应用只保留一个 AudioContext；不要每句新建，也不要为每句创建独立 context。
- 初始 `sampleRate` 用设备默认值；AudioBuffer 用模型采样率创建（Web Audio 会重采样），或按实际测试统一到 22050Hz。两条路径都要在 iOS 真机验证延迟与爆音。

#### 队列与预取

```
当前句 [已调度/播放中]
   └── 下一句 [已合成，待调度]
        └── 再下一句 [Worker 生成中]
```

- 低水位：待播队列 < 1 句时立即请求下一句；高水位：预取 2 句或约 15 秒音频，避免内存膨胀。
- 总音频队列不超过 2-3 句；语音音频约 0.4-0.9MB/句，控制在 2MB 左右。
- 生成速度 > 播放速度时，Worker 可短暂空闲；不要无限预生成整章。
- 欠载：下一句未就绪时进入 `buffering`，暂停调度、不要跳句；恢复后从当前句继续。把欠载次数作为质量指标。

#### 调度伪代码

```ts
class AudioScheduler {
  private ctx: AudioContext;
  private master = this.ctx.createGain();
  private nextStart = 0;

  schedule(seg: AudioSegment, gapMs: number) {
    const when = Math.max(this.ctx.currentTime + 0.06, this.nextStart);
    const src = this.ctx.createBufferSource();
    src.buffer = this.toAudioBuffer(seg);
    const gain = this.ctx.createGain();
    // 5ms fade in/out
    src.connect(gain).connect(this.master);
    src.start(when);
    this.nextStart = when + seg.duration + gapMs / 1000;
    return { when, src };
  }
}
```

- 句子开始高亮由**音频时间线**驱动，不依赖 `source.onended`：用 rAF 比较 `ctx.currentTime` 与每句的 `when`，到点发 `sentenceStart`。
- `source.onended` 只用于清理引用；不要用 `setTimeout(duration)` 估算，否则后台/调度抖动会导致高亮漂移。

#### 暂停、恢复、跳转、变速

- **暂停**：优先 `ctx.suspend()`；AudioContext 暂停后 `currentTime` 不前进，已调度的源保持待命；恢复用 `ctx.resume()`，高亮循环随之暂停/恢复。若真机发现 suspend 不可靠，退化为停止源并记录已播放 offset，恢复时从 offset 重新调度。
- **跳转**：`epoch++` → `source.stop()` → 清空音频队列 → 重新合成目标句 → 重新建立 `nextStart`。不能继续使用旧的 `nextStart`，否则会立即播放/重叠。
- **变速**：AI 模式停止当前源、清空队列，用新 speed 重新合成当前句及后续；系统语音从下一句生效。不要用 `playbackRate` 改变音高。
- **章节结束**：等待最后一句播放完，插入约 500-800ms 停顿，切换下一章，重新分句后继续。
- **睡眠定时**：在设定时间前 10s 淡出 masterGain，停止并释放 Wake Lock；不要突然切断。

#### 音频后处理

- 句间静音：根据标点插入 120-600ms 静音（通过调度 gap，不修改 PCM），让朗读有呼吸感。
- 句间加 5ms 淡入/淡出，避免点击声；峰值归一化在 Worker 完成。
- 不对整章做响度压缩，避免不同句子音量抽吸；保持单句一致性即可。

### 5.10 模型管理与离线缓存

**下载**

- 读取 `/models/manifest.json`（短缓存），校验 schema v3、包 ID/音色 ID 唯一、`totalBytes` 与文件字节和一致、runtime 与 license 字段完整。
- 清单本身的读取失败可回退到 localStorage 的上一次 v3 副本；旧 v2 键会被清理。
- 下载单位是**包**：先检查该包的模型 Cache 与共享运行时 Cache；已缓存文件逐个比对字节数和 SHA-256，通过则跳过。
- 缺失文件用 `fetch` + `response.body.getReader()` 流式读取并汇报进度；下载完成后先计算 SHA-256，匹配才写入最终 Cache。中断的文件不会留下半成品缓存。
- 共享运行时只在首次下载任一包时获取；之后下载其他包只查/补模型文件。同一时间只允许一个下载任务。
- 下载完成后请求持久化存储并激活该包；切换音色包需要停止当前播放，重新初始化 Worker，不在播放中热切换模型。
- 未缓存的音色标签仍可点击：空闲时标记该音色并提示“下载并切换到…”，下载完成后直接选用被点的 sid；播放中或下载中点击则提示先暂停/稍候，避免静默无响应。
- 播放中禁止下载/删除音色包，避免 Worker 正在读取模型时文件被清理；这类按钮仍可点击并给出原因提示。

**缓存**

- 共享运行时 Cache：`shusheng-tts-runtime-<runtime.version>`。
- 音色包 Cache：`shusheng-tts-model-<packId>-<pack.version>`；山岚沿用旧包名，升级后不重复下载。
- 每个包独立删除；仅当没有任何模型 Cache 剩余时才删除共享运行时。旧清单中不存在的 `shusheng-tts-*` Cache 会被清理。
- `navigator.storage.persist()` 请求持久化；UI 展示每包与运行时合计大小。
- 不缓存合成音频；音频可重新生成，缓存会迅速膨胀。
- 用户可删除未被选中的音色包；删除后下次播放走系统语音或重新下载。

**失败与中断**

- 下载中断：已完成的文件保留在包 Cache 中，重试时逐个校验并跳过，按文件粒度续传；未完成的文件需重新下载。弱网下建议先下载较小的初晴或小雅包。
- 存储不足：捕获 QuotaExceededError，提示清理旧书/旧音色包；不删除用户书籍，除非用户确认。
- 模型损坏：哈希不匹配时清空该包缓存并提示重新下载；仍失败则回退系统语音。
- 版本升级：新包版本使用新 Cache 名称；旧包只有在清单移除后才清理，失败时仍可回到旧包。

**离线**

- Service Worker 缓存应用壳、字体、WASM 运行时；模型由 Cache API 单独缓存；EPUB 在 IndexedDB。三者齐备时飞行模式可完整听书。
- iOS 可能清理长期不用的站点存储；UI 显示“已离线缓存”，并提供重新下载入口。添加“添加到主屏幕”提示可降低被清理概率，但不能保证。

### 5.11 Wake Lock 与口袋模式

#### Wake Lock

```ts
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return null;
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}
```

- 仅在播放中请求；暂停、结束、页面隐藏时释放。
- 监听 `document.visibilitychange`：页面重新可见且仍在播放时重新请求（浏览器会在切换标签/锁屏时自动释放）。
- 失败时提示：“系统未允许保持亮屏，请调高自动锁屏时间”；不要假装成功。
- Wake Lock 只能防自动熄屏，不能阻止用户手动锁屏，也不能让 JS 在锁屏后继续运行。

#### 口袋模式

- 全屏纯黑遮罩，覆盖 safe-area；`position: fixed; inset: 0; background: #000; z-index: 9999;`。
- 进入：用户点击口袋按钮；可在此刻释放高亮渲染、暂停自动滚动、隐藏阅读器内容（`content-visibility: hidden` 或 `visibility: hidden`）以降低绘制开销；音频继续。
- 防误触：
  - 遮罩上 `touch-action: none; overscroll-behavior: none;`，拦截 `touchstart` 默认行为。
  - 单击只显示一条极简提示，不退出；退出需要**长按 1.5s**（带环形进度）或连续双击两次（可配置）。
  - 可选：双击切换播放/暂停；音量键无法被 Web 捕获，不要承诺。
- 亮度：网页不能调系统亮度；首次进入提示“可手动将亮度调低”。OLED 黑屏可减少像素发光，但屏幕/SoC 仍工作；不要宣传为“接近锁屏功耗”。
- 口袋模式退出时：恢复阅读器、立即同步当前句高亮与滚动位置，避免视觉跳回很久之前的句子。
- 若 Wake Lock 不可用，口袋模式可能因自动锁屏而中断；进入前检测并提示。

#### Media Session（P1/可选）

- 设置 `navigator.mediaSession.metadata`（书名/章节/封面）与 play/pause/next/prev 处理器，改善系统媒体面板体验。
- 但后台/锁屏后 JS 可能被冻结，不能把它当作后台播放保证；主要价值是耳机线控/媒体面板的播放暂停。

### 5.12 PWA、离线与更新

- Web App Manifest：名称、图标、主题色、`display: standalone`、`orientation: portrait`（可选，不锁定）。
- iOS meta：`viewport-fit=cover`、`apple-mobile-web-app-capable`、`apple-mobile-web-app-status-bar-style`、Apple touch icon；使用 `env(safe-area-inset-*)` 适配灵动岛和底部 Home 指示条。
- Service Worker：
  - 预缓存应用壳（HTML/JS/CSS/字体/图标/WASM 运行时）。
  - `/models/` 不放进 precache，由 ModelManager 控制；避免音色包在 SW 与模型 Cache 中各存一份。
  - `registerType: 'prompt'`，播放中不自动刷新；用户确认后 `skipWaiting` + reload。
  - 版本化缓存，激活时清理旧应用壳缓存，但保留当前模型缓存。
- 离线验收：飞行模式下打开应用、打开已导入书籍、系统语音/AI（已缓存）均可工作；未缓存 AI 时明确提示。
- iOS 主屏幕安装引导；微信内提示“在浏览器打开”以获得完整能力。

### 5.13 安全、隐私与合规

- **EPUB 隔离**：iframe `sandbox="allow-same-origin"`，`allowScriptedContent: false`；注入 CSP 禁止脚本；拦截 `javascript:` 链接。
- **远程资源**：默认阻断远程图片/字体，避免跟踪；P1 提供用户开关。
- **压缩炸弹**：单本大小限制 + ZIP 结构校验；拒绝异常解压尺寸；解析异常可恢复。
- **CSP**（示例，按部署平台实测调整）：
  ```
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self' data:;
  connect-src 'self';
  worker-src 'self' blob:;
  frame-src 'self' blob: about:;
  object-src 'none';
  base-uri 'none';
  ```
  `wasm-unsafe-eval` 是 WASM 实例化所需；在 Safari 上验证是否支持该指令，必要时单独兼容。
- **模型完整性**：运行时校验 SHA-256；构建产物在 CI 记录哈希；HTTPS + 同源部署。SRI 对外部脚本不适用（我们不使用外部脚本）。
- **隐私**：书籍内容、阅读进度、语音输入（无麦克风）全部本地；不上传书文本；诊断日志脱敏，禁止记录正文。
- **许可证**：应用内“关于/许可”列出 sherpa-onnx、epub.js、模型来源与数据集许可；商用前完成法务审查。
- **依赖**：固定 lockfile，CI `pnpm audit`/Dependabot；不使用来路不明的模型或脚本。

### 5.14 诊断与可观测性

隐藏诊断页（关于页连点 5 次）展示：

- 能力：SIMD、Worker、AudioContext、Wake Lock、WebSpeech voices、Cache/IndexedDB、PWA、网络状态。
- 模型：模型 ID/版本、缓存大小、SHA 校验、初始化耗时、warmup、heap 大小。
- 性能：单句合成耗时、RTF、首音延迟、欠载次数、平均 FPS、长任务数量。
- 错误：最近 20 条错误码/时间/上下文（不含正文）。
- 操作：清除模型缓存、重建 TTS、导出诊断 JSON（脱敏）。

首版不做远程埋点；如后续需要，只上报错误码/性能指标，明确告知用户，不上传书籍内容。

---

## 6. 接口、状态与约定

### 6.1 核心类型

```ts
type EngineKind = 'system' | 'sherpa';

interface SentenceCursor {
  spineIndex: number;
  sentenceIndex: number;
  sid: string;
}

interface SentenceProvider {
  current(): Sentence | undefined;
  next(): Promise<Sentence | undefined>;     // 可跨章
  seek(sid: string): Promise<Sentence | undefined>;
}

interface TtsEvent {
  type: 'sentenceStart' | 'sentenceEnd' | 'buffering' | 'ended' | 'error' | 'state';
  sid?: string;
  code?: string;
  message?: string;
}

interface DownloadProgress {
  modelId: string;
  phase: 'manifest' | 'download' | 'verify' | 'activate';
  loadedBytes: number;
  totalBytes: number;
  speedBps?: number;
}
```

### 6.2 事件流约定

1. `sentenceStart` 只能在**声音实际开始**时发出；系统语音用 `onstart`，AI 用音频时钟。
2. `sentenceEnd` 后 PlaybackController 才推进游标；不依赖 UI 的动画结束。
3. 任何跳转、暂停、切章、切引擎都会递增 `epoch`；旧 epoch 的合成结果、定时器、事件全部丢弃。
4. 错误必须带稳定错误码（见 6.3），UI 根据码给出可操作提示。
5. 进度保存使用 `sid`，不使用注入 span 后的 CFI。

### 6.3 错误码

| 错误码 | 场景 | 用户提示/处理 |
| :--- | :--- | :--- |
| `E_NO_SIMD` | 浏览器不支持 WASM SIMD | 禁用 AI，推荐系统语音 |
| `E_WASM_INIT` | WASM/Worker 初始化失败 | 重试一次，仍失败回退系统语音 |
| `E_OOM` | 内存不足/WebAssembly OOM | 释放 Worker，回退并建议关闭其他标签页 |
| `E_MODEL_DOWNLOAD` | 下载失败/网络中断 | 重试；可继续系统语音 |
| `E_MODEL_HASH` | 模型哈希不匹配 | 清除缓存并重新下载一次 |
| `E_STORAGE_QUOTA` | 存储不足 | 引导清理旧书/旧模型 |
| `E_SYNTH` | 合成失败 | 重试当前句；连续失败回退 |
| `E_AUDIO_SUSPENDED` | AudioContext 被系统挂起 | 提示点击恢复；重新 resume |
| `E_NO_ZH_VOICE` | 无中文系统语音 | 引导安装系统语音包或下载 AI |
| `E_SPEECH` | 系统语音报错 | 下一句/当前句重试；持续失败改用 AI |
| `E_EPUB` | 书籍损坏/DRM/不支持 | 重新导入可用 EPUB |

---

## 7. 技术验证（Spike）与 Go/No-Go

在正式堆 UI 前，用 2 天时间并行验证以下 5 件事；任何一项失败都要调整架构，而不是硬写代码。

| Spike | 问题 | 时间盒 | 通过标准 | 失败后的备选 |
| :--- | :--- | :--- | :--- | :--- |
| S1 | 定制 Sherpa WASM 能否在 Worker 中初始化并合成中文，iOS 内存是否可接受 | 2 天 | iPhone（iOS 16.4+/17）与中端 Android 均能初始化；峰值内存 < 350MB；单句 RTF < 0.8 | 官方 `.data` 预打包 + SW 缓存；或首版只上系统语音，AI 延后 |
| S2 | 四个音色包的清晰度/自然度是否达标；长句延迟是否可接受；每包许可是否明确 | 1-2 天 | 100 句回归集多音字正确率 ≥ 90%；盲听无明显机械感/爆音；设置页逐包展示许可证与商用标识 | 调整 noiseScale / 自定义词典 / 替换不达标音色包；不得把山岚或小雅标注为可商用 |
| S3 | epub.js `scrolled-doc` 下坐标、滚动、点击、跨章是否可靠；span 注入是否破坏脚注/目录 | 2 天 | 3 本样本书（小说、非虚构、脚注多）无丢字；点击/滚动/章节切换正常 | 改分页模式；或改用 Range + CSS Highlight，不改 DOM |
| S4 | Web Speech 在 iOS Safari/Android Chrome/微信的可用性、暂停、声音列表 | 1 天 | 中文声音可用；能暂停/恢复或可接受重读本句；错误有回调 | 系统语音仅作为“无网络应急”；主推 AI |
| S5 | 音频调度是否无缝、暂停/恢复/跳句是否不重叠/不爆音 | 1 天 | 连续 20 句无欠载/重叠；跳句 < 2s 首音；暂停恢复位置正确 | 简化调度：停止/重启而非 suspend；降低预取 |

### 7.1 Go/No-Go 门

- **G0（Day 2 末）**：S1 + S3 通过。否则不得进入完整 UI 开发。
- **G1（Week 1 末）**：系统语音闭环（导入→分句→播放→高亮→点击→恢复）在 iPhone/Android 真机跑通。
- **G2（Week 2 中）**：AI 单句在真机跑通，模型缓存/离线可验证。
- **G3（Week 2 末）**：AI 连续播放 30 分钟，无持续欠载、内存稳定；否则缩小模型/降低预取/回退。
- **G4（Week 3 末）**：口袋模式、降级、QA 矩阵完成，可发 MVP；生产级另加 1-2 周。

---

## 8. 实施排期（3 周 MVP）

### 8.1 人员假设

- **推荐**：2 名前端（A：阅读器/交互；B：TTS/WASM/音频/存储）+ 0.5 名 QA + 兼职设计。
- **单人**：按 4-5 周排，且 S1 失败时没有并行缓冲。
- 3 周指 **15 个工作日**，不含模型法务审查、App Store 上架（本方案不涉及）和大规模内容导入。

### 8.2 周计划

#### 第 1 周：阅读与系统语音闭环

| 天 | 工作项 | 产出/验收 |
| :--- | :--- | :--- |
| D1 | 工程脚手架、CI、Vue 壳、Pinia、能力检测页；准备 3 本样书 | `pnpm dev/build/lint/test` 可跑；能力页能显示 SIMD/WakeLock/WebSpeech |
| D1-D2 | Spike S1：定制 WASM 构建 + Worker + 中文模型最小合成；Spike S3：epub.js 滚动/坐标 | G0 报告：真机截图/耗时/内存；记录失败点 |
| D3 | EPUB 导入、文件哈希、IndexedDB 书库、封面/元数据、目录 | 导入→书库→打开；重复导入去重；删除可用 |
| D4 | 分句器 v1 + 单测；span 注入；sid 映射；点击命中 | 3 本样书无丢字；纯文本/内联标签/ruby/脚注测试通过 |
| D5 | WebSpeechDriver、播放器状态机、高亮 class、基础进度保存 | 系统语音端到端：播放/暂停/下一句/点击跳读/刷新恢复 |

**周验收**：不依赖 AI，完成“打开书→听→高亮→点句→恢复”。这是产品的可用底线。

#### 第 2 周：AI 引擎与离线

| 天 | 工作项 | 产出/验收 |
| :--- | :--- | :--- |
| D6 | 模型清单、下载进度、Hash 校验、Cache 激活；WASM 定制产物定版 | 断网重开可用；损坏模型可恢复；下载失败可重试 |
| D7 | Worker 协议、模型 MEMFS 挂载、SherpaDriver 首句合成；AudioContext 解锁 | G2：真机首句发声；采样率/初始化耗时记录 |
| D8 | AudioScheduler：预取、双缓冲、暂停/恢复、跳句、epoch 取消 | 连续 20 句不重叠；跳句无旧音频残留；欠载有 UI |
| D9 | 跨章播放、速度切换、warmup、Worker dispose、AI/系统切换 | 章末自动续播；变速重生成；空闲释放内存 |
| D10 | PWA/SW、离线验收、性能基准（RTF/内存/首音）、低端机测试 | G3：30 分钟稳定；形成机型性能表；确定降级阈值 |

**周验收**：AI 音色在真机可连续听 30 分钟；模型缓存在断网后可用；系统语音仍是可靠兜底。

#### 第 3 周：口袋模式、兼容与发布

| 天 | 工作项 | 产出/验收 |
| :--- | :--- | :--- |
| D11 | WakeLockManager、PocketLock、长按退出、口袋模式暂停滚动/高亮 | 播放中屏幕不自动熄灭；长按 1.5s 退出；误触不退出 |
| D12 | iOS safe-area/灵动岛、底部播放器、主题/字号、旋转；微信内提示 | iPhone 刘海/底部条不遮挡；横竖屏切换不丢句 |
| D13 | 错误态、低端机降级、下载断点/重试、系统语音缺失引导 | 关键错误均有可操作提示；低端机自动推荐系统语音 |
| D14 | 全量回归、60 分钟浸泡、内存/欠载/发热测试、安全/CSP 检查 | 通过第 9.4 节验收表；无 P0/P1 未决缺陷 |
| D15 | 生产构建、CDN 头、SW 版本、模型上传校验、发布清单 | 可发布 MVP；监控/诊断入口可用 |

### 8.3 关键路径与缓冲

- **关键路径**：S1 定制 WASM → Worker 合成 → 音频调度/双缓冲 → 真机 30 分钟稳定性。S1 若拖延，整个 AI 链路延后；第 1 天就必须启动。
- **可与主链路并行**：书库/导入 UI、系统语音、高亮/滚动、Pocket UI、PWA。
- **不建议压进 3 周**：分页翻页、AI 句间无缝切换音色、多音色、逐字高亮、锁屏续播。
- **生产级硬化（+1-2 周）**：更多机型/微信、真实网络下载失败、存储清理、60 分钟+发热、语料扩充、模型许可、无障碍、错误上报。

### 8.4 Definition of Done

- 三个样本书在 iPhone + Android 真机完成导入、播放、高亮、跳句、切章、恢复。
- AI 模型下载/校验/离线/删除全流程可用；失败可回退系统语音。
- 口袋模式 + Wake Lock 可用；不承诺锁屏后台并在 UI/帮助中明确说明。
- 所有网络失败、存储不足、模型损坏、无中文语音都有可操作提示。
- 性能达到 0.3 节目标，或明确记录未达标项与降级策略。
- 许可证/隐私/安全清单完成；模型与运行时版本哈希入库。

---

## 9. 测试与验收

### 9.1 测试分层

| 层 | 工具 | 覆盖 |
| :--- | :--- | :--- |
| 单元 | Vitest | 分句边界、归一化、sid 稳定性、模型清单/哈希、播放状态机、调度时间线（假时钟） |
| 集成 | Vitest + fake worker/engine | 主线程 ↔ Worker 协议、epoch 取消、队列低水位、错误码 |
| E2E | Playwright（Chromium/WebKit） | 导入→打开→系统语音→高亮→点击→保存/恢复；下载流程用本地 mock 模型 |
| 真机 | iPhone/Android/微信 | WASM 内存/RTF、AudioContext、Wake Lock、WebSpeech、PWA 离线、口袋模式 |
| 浸泡 | 真机脚本/人工 | 60 分钟连续播放、100 次切章、10 次 Worker 重建、网络切换 |

真实 65-131MB 音色包的 E2E 不放在每次 PR CI（下载慢、成本高），放 nightly/手动流水线；PR 用 1-2MB stub 或 mock worker 验证协议，并覆盖“同包换 sid / 跨包重建 Worker”。

### 9.2 分句测试语料（必须覆盖）

- 中文引号嵌套：`他说：“走。”然后离开。`
- 省略号：`我不知道……也许吧。`
- 数字/小数/日期：`3.14、2026年10月26日、100%、¥35`
- 英文缩写/混排：`AI 与 iPhone 15 Pro 的对比。`
- Ruby 注音：`<ruby>汉<rt>hàn</rt></ruby>字`
- 脚注/尾注、图表题注、诗歌换行、表格单元格
- 长句 100+ 字、无标点长句、纯标点块、空段落
- 内联标签跨越句边界：`<em>前半句，</em>后半句。`
- 幂等：重复执行分句不产生重复 span、不改变文本
- 稳定性：窗口 resize/主题切换后 sid 不变

### 9.3 设备矩阵（最低要求）

| 类别 | 设备 | 目的 |
| :--- | :--- | :--- |
| iOS 低端 | iPhone SE 2/3（3GB） | 内存/WASM OOM 基线 |
| iOS 主流 | iPhone 12/13/15 任一 | 功能/性能主验证 |
| iOS 新系统 | 最新 iOS Safari | 回归 |
| Android 低端 | 4GB 内存中端机 | RTF/降级/发热 |
| Android 主流 | 骁龙 7/8 系 | 功能/性能 |
| 微信 | iOS/Android 微信内置浏览器 | 语音/下载/WakeLock/提示 |
| 桌面 | Chrome/Safari | 开发调试，不作为验收 |

### 9.4 性能与稳定性验收

| 项目 | 通过标准 | 测量方法 |
| :--- | :--- | :--- |
| 首屏 | 4G 中端机 < 2.5s 可交互 | Lighthouse/Performance |
| 打开书籍 | 5MB EPUB < 1.5s 首章可见 | performance.mark |
| 系统语音首句 | 点击后 < 1s | 事件时间差 |
| AI 首音 | 模型 ready 后 < 2s（P95） | Worker init/warmup + 调度 |
| 单句合成 | P95 < 900ms；RTF < 0.8 | Worker 记录 synthMs/音频时长 |
| 欠载 | 30 分钟 < 1 次/10 分钟 | 调度器计数 |
| 高亮同步 | 与音频时间线偏差 < 120ms | 日志/录屏抽样 |
| 内存 | 峰值 < 350MB；60 分钟增长 < 15% | Safari Web Inspector/Chrome DevTools |
| 长任务 | 主线程 > 50ms 长任务 < 5 次/分钟 | PerformanceObserver |
| 滚动 | 平均 > 55fps（中端机） | DevTools/真机 |
| 稳定性 | 60 分钟无崩溃；100 次切章无卡死 | 浸泡测试 |
| 离线 | 飞行模式完整听已缓存书 | 手工 |
| 下载 | 65-146MB 包失败可重试；已下载文件可复用；哈希错误可恢复 | 弱网/中断模拟 |
| 口袋模式 | 屏幕不自动熄灭；长按退出；功耗/温度有记录 | 30 分钟真机 |

### 9.5 验收清单（发布前勾选）

- [ ] 三个样本书无丢字、无重复 span、点击命中准确。
- [ ] 系统语音和 AI 音色都能播放/暂停/恢复/跳句/切章。
- [ ] 四个音色包的下载、校验、缓存、离线、删除、再下载全流程通过。
- [ ] 同包切换 4 个 AISHELL-3 音色时声音正确、无旧音色缓存串音；跨包切换会重建 Worker。
- [ ] 模型/运行时版本、哈希、逐包许可证与商用标识可查。
- [ ] iPhone 刘海/底部条/横屏不遮挡；口袋模式可退出。
- [ ] 微信内打开有明确的能力提示和“在浏览器打开”引导。
- [ ] 无中文语音、无 SIMD、存储不足、模型损坏、网络中断均有提示。
- [ ] CSP/iframe 沙箱/外部链接安全通过检查。
- [ ] 60 分钟浸泡、30 分钟口袋模式、低端机降级通过。
- [ ] 诊断页可导出脱敏日志；无正文/隐私泄漏。
- [ ] Service Worker 更新不会在播放中强制刷新。
- [ ] 关于页包含开源许可与音色来源。

---

## 10. 风险登记

| # | 风险 | 概率/影响 | 触发信号 | 应对/兜底 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 定制 WASM 在 iOS 上初始化失败/内存不够 | 中/高 | 真机 OOM、初始化 > 10s、反复崩溃 | 降低初始内存、单线程、缩短句长；失败则官方 `.data` 方案或首版仅系统语音 |
| 2 | VITS 单句 RTF > 1，双缓冲欠载 | 中/高 | 播放中频繁“生成中”、发热 | 换更小模型（需许可）、降低预取/句长、低端机禁用 AI |
| 3 | 音色许可标注错误/山岚或小雅被误用于商用 | 中/高 | 商业项目使用山岚或小雅、许可证文案缺失 | 逐包展示许可与商用标识；商用默认推荐初晴/AISHELL-3 精选；发布前法务复核 |
| 4 | 多音字/数字发音不达标 | 高/中 | 回归集错误多、用户反馈 | 自定义词典补丁、数字归一化、固定 sid 盲听、模型替换 |
| 5 | epub.js 分句破坏 CFI/脚注/目录 | 中/中 | 脚注跳到错误位置、进度错乱 | 进度改用 sid；目录用 href；Range+CSS Highlight 备选；首周验证 |
| 6 | Web Speech 在微信/iOS 行为不一致 | 高/中 | 不发声、暂停失效、`onend` 不触发 | 逐句 utterance、保留引用、cancel/重读兜底；引导用浏览器打开 |
| 7 | Wake Lock 不支持/自动锁屏 | 中/中 | 口袋模式黑屏后系统锁屏 | 能力检测提示；引导调高自动锁屏时间；不承诺锁屏后台 |
| 8 | iOS 存储清理导致模型/书籍丢失 | 中/中 | 二次打开需重新下载 | `persist()`、版本清单、自动重下、主屏幕安装提示、导入备份引导 |
| 9 | 下载 65-146MB 失败/弱网体验差 | 高/中 | 进度卡住、微信中断 | 真实进度、按文件复用已完成缓存、后台下载时继续系统语音；优先推荐较小的初晴或小雅包 |
| 10 | 用户预期“锁屏也能听” | 高/高 | 投诉/差评 | 首次使用说明口袋模式；帮助页明确边界；不要把纯 Web 宣传成后台播放器 |
| 11 | EPUB 恶意内容/压缩炸弹 | 低/高 | 异常内存、页面卡死 | iframe 沙箱、CSP、大小/结构限制、链接过滤 |
| 12 | 3 周排期过紧 | 高/中 | D2 未过 G0、D10 未过 G3 | 砍 P1（分页/无缝切换/词高亮），保系统语音 + 基础 AI；增加 1-2 周 |
| 13 | 章节切换空档明显 | 中/低 | 章末停顿 1-2s | 章间 500-800ms + 预解析下一章（P1）；UI 提示加载 |
| 14 | 音频爆音/重叠/高亮漂移 | 中/中 | 用户反馈、录屏抽样 | 统一 AudioContext、音频时钟驱动、5ms 淡入淡出、epoch 取消 |

---

## 11. 部署与运维

### 11.1 静态托管

- 纯静态：Vercel/Netlify/对象存储 + CDN 均可；无需应用服务器/GPU。
- HTTPS 必须；二维码指向部署 URL。
- 资源分层：
  - 应用壳：`index.html` 不缓存或短缓存；带 hash 的 JS/CSS `immutable`。
  - WASM 运行时：版本化目录 `/wasm/<runtime-version>/`，`application/wasm`，长缓存。
  - 模型：`/models/<model-id>/<version>/`，长缓存；由 ModelManager 下载并校验；不要随应用包发布。
  - Service Worker：`no-cache`，更新后提示。

### 11.2 建议响应头

```
Cache-Control: public, max-age=31536000, immutable   # /assets, /wasm, /models
Cache-Control: no-cache                              # index.html, sw.js, manifest.json
Content-Type: application/wasm                       # .wasm
Content-Security-Policy: ...                         # 见 5.13
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: screen-wake-lock=(self)
```

FFmpeg? 不需要。不要启用 COOP/COEP（单线程 WASM 不需要，且会影响第三方资源/微信）。

### 11.3 模型发布流程

1. `scripts/fetch-model.mjs` 从官方 release 下载模型包。
2. 解压并只保留运行时需要的 `model.onnx/lexicon.txt/tokens.txt`（按 W2 验证结果决定 FST）。
3. 计算 SHA-256、生成 `manifest.json`；检查许可证文件。
4. 上传 CDN/静态目录；先在 staging 用 `?model=staging` 验证。
5. 更新应用内模型清单版本；旧版本保留至少一个发布周期，支持回滚。
6. 发布后跑真机下载/离线/合成冒烟。

### 11.4 更新与回滚

- 应用版本与模型版本解耦；模型清单包含 `minRuntimeVersion`，不兼容时禁用新模型。
- Service Worker 更新提示“新版本已就绪，是否重启”；播放中不自动 reload。
- 回滚：静态托管回退到上一构建；模型文件不可变保留；清理 Cache 时保留当前激活模型。
- 提供“清除离线数据”按钮，处理模型/书本缓存损坏。

### 11.5 流量与成本

- 首次 AI 使用一个音色包 65.5-131.1MB，另加一次 15.3MB 共享运行时；之后命中本地缓存，理论 0 流量。用户下载多个包才产生多份模型流量。
- 无 GPU/后端推理成本；主要成本是静态托管 CDN 出网流量。按“新增用户数 × 首个包体积（约 81-146MB）”估算峰值；可通过 CDN 缓存、版本化资源降低回源。
- 不在首版做整章/整本音频缓存，避免存储与流量翻倍。

---

## 12. 待确认决策（进入编码前）

| # | 决策 | 推荐 | 影响 |
| :--- | :--- | :--- | :--- |
| 1 | 是否商用 | 山岚与小雅仅限非商用；初晴与 AISHELL-3 精选可商用 | 决定默认推荐音色、许可文案与下载体验 |
| 2 | 首版阅读布局 | 纵向 `scrolled-doc` | 决定高亮/滚动实现；分页 P1 |
| 3 | 是否要求锁屏续播 | 不要求（纯 Web 边界） | 若要求，需原生壳/预渲染，方案需重做 |
| 4 | 最低支持机型 | iOS 16.4+ / Android 4GB RAM；AI 建议 iOS 17+ | 决定降级策略与测试范围 |
| 5 | 微信内体验等级 | 支持基础播放 + 引导浏览器打开 | 决定 WebSpeech/WakeLock/下载降级 |
| 6 | 默认引擎 | 未缓存模型时系统语音；已缓存时 AI | 决定首次体验与下载转化 |
| 7 | 音色选择范围 | 山岚/小雅/初晴各 1 个，AISHELL-3 精选盲听后保留 4 个 sid；默认山岚 | 决定音色 QA 基线与设置页 UI |
| 8 | 音色包下载交互 | 音色库按包下载；可边用系统语音边下载；播放中禁止下载/删除 | 决定音色库/下载 UI 与状态机 |
| 9 | 书籍导入 | 仅本地文件，≤100MB | URL/云端书库不做 |
| 10 | 分析/错误上报 | 首版仅本地诊断，不上传正文 | 隐私/合规 |

---

## 13. 参考资料

- Sherpa-onnx 仓库与 WASM TTS 示例：https://github.com/k2-fsa/sherpa-onnx/tree/master/wasm/tts
- Sherpa-onnx TTS 预训练模型（含 VITS 说明）：https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html
- Sherpa-onnx TTS 模型发布页（模型体积/包）：https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
- AISHELL-3（OpenSLR 93，Apache-2.0）：https://www.openslr.org/93/
- AISHELL-3 Piper 社区模型（Apache-2.0）：https://huggingface.co/writeAPoemForYou/piper-voices-zh-AISHELL-3
- Piper 音色库（MIT）初晴模型：https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/chaowen/medium
- Piper 音色库（MIT）小雅模型（包内 `MODEL_CARD` 标注 BZNSYP 非商用）：https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/xiao_ya/medium
- Chaowen 数据集（CC0）：https://github.com/OHF-Voice/voice-datasets
- BZNSYP（标贝女声）数据集主页：https://huggingface.co/openspeech/BZNSYP
- 本项目的三方许可说明：`public/sherpa/NOTICE.md`、`public/models/NOTICE.md`
- epub.js：https://github.com/futurepress/epub.js
- MDN Screen Wake Lock API：https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- MDN Web Speech API：https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
- MDN Cache API：https://developer.mozilla.org/en-US/docs/Web/API/Cache
- MDN Intl.Segmenter：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
- Web Audio API 规范：https://www.w3.org/TR/webaudio/
- web.dev 持久化存储：https://web.dev/articles/persistent-storage

---

## 附录 A：首版验收的最小闭环

1. 导入《三体》样章（或任一中文 EPUB）。
2. 点击播放 → 系统语音从当前句开始 → 当前句高亮 → 自动滚动。
3. 点击第 10 句 → 从第 10 句重新开始，旧声音停止，高亮正确。
4. 暂停 30 秒 → 恢复 → 从正确位置继续（AI）或按约定重读本句（系统语音）。
5. 下载 AI 音色 → 断网 → 重新打开 → 仍能 AI 播放。
6. 进入口袋模式 30 分钟 → 屏幕不自动熄灭 → 长按退出 → 高亮回到当前句。
7. 刷新页面 → 恢复书、章节、句子、音色、语速，但不自动播放。
8. iPhone 刘海/底部条/微信内打开均无遮挡和致命错误。

以上全部通过，才认为“首版可用”；音色主观质量和逐字高亮不属于首版阻塞项。
