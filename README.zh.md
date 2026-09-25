# dsh-ledger-compact

[English](README.md) · 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **dsh-plugin**。大工具结果在进模型前定形；可选的本地折页也能顶替 DSH 的 LLM `/compact`。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-111111)](https://github.com/topics/dsh-plugin)
[![test](https://github.com/telagod/dsh-ledger-compact/actions/workflows/test.yml/badge.svg)](https://github.com/telagod/dsh-ledger-compact/actions/workflows/test.yml)

---

## 为什么要它

长回合会把巨大的 `tool_result` 塞进下一次请求。DSH 自带的 LLM 压缩（`@deepseek-ai/dsh-compaction-basic`）很好，但要多打一次模型，而且往往等压力上来才动。

本插件先做两件更便宜的事，第三件可选：

1. **入境定形** — 空闲步进时，把**尚未发送**的超大工具结果冻成头尾摘录。只看刚结束的那一步：它的第一次请求正是眼下要发的这一次，所以重写永远不会让已缓存的前缀失效。
2. **机械折页** — `/fast-compact` 和输入栏闪电把较旧历史折成一张短账卡，不调模型。
3. **替换默认压缩**（默认关） — 挂在官方引擎的 `summarize` 钩子上，让 `/compact`、自动压缩、溢出恢复也不再调模型。

不要卸 `dsh-compaction-basic`。本插件不换引擎。

## 安装

需要 **dsh ≥ 0.1.2-rc.1**；已在 **0.1.5-rc.1** 上验证。这一区间的两次 API 改名都已兼容：`session.events` → `session.eventAt(seq)`，以及定位替换键 `start/end` → `startSeq/endSeq`。

```bash
dsh plugin --profile web add github:telagod/dsh-ledger-compact
```

装完重启 web profile。bundle patch 会插入插件 id `dsh-ledger-compact`。

本地开发：

```bash
git clone https://github.com/telagod/dsh-ledger-compact.git
dsh plugin --profile web add ./dsh-ledger-compact
```

## 三层分别干什么

| 层 | 何时 | 调模型 | 改什么 |
| --- | --- | --- | --- |
| 入境定形 | 空闲 `agent/pre-step` | 否 | 只动当前尚未发送的 `tool_result` |
| 闪电 / `/fast-compact` | 你点或你敲 | 否 | 较旧历史 → 机械折页卡 |
| 替换默认压缩 | `/compact`、自动、溢出 | 否 | 仍走官方事务，只换成本地摘要 |
| 官方 `/compact` | DSH 默认路径 | 是 | LLM `<compacted-summary>` checkpoint |

输入栏**闪电**是上下文压力表。默认再点一次才折页（可关）。成功后会话里是一行可展开的提示，样式对齐官方压缩行；展开是左侧细轴时间线，不是模型写的长摘要。

## 设置

打开 **设置 → 快速压缩**。改动即时写入 Host 文档。页面分三个 tab：

- **入境** —— 下面四项定形设置。
- **折页** —— 折页二次确认、替换默认压缩，以及一张折页卡的实时预览。
- **诊断** —— 插件版本、这台 DSH 实际暴露的会话事件读取方式、入境计数与最近失败、压缩引擎钩住数量（以及哪些引擎会静默退回模型调用）。

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| 入境定形 (`enabled`) | 开 | 下一轮请求前裁当前回合尚未发送的大 `tool_result` |
| 允许密图 (`snapImages`) | 关 | 仅当主模型 `inputModalities` **明确含 `image`**，且图比原文更省时才贴 PNG |
| 折页二次确认 (`confirmFold`) | 开 | 输入栏闪电需再点一次 |
| 替换默认压缩 (`replaceDefault`) | **关** | `/compact`、自动压缩、溢出恢复都走机械摘要 |
| 入境阈值 (`minSnapTokens`) | `3000` | 大约这么多 token 才摘录或贴图。范围 200–200000 |
| 密图节省 (`savingsRatio`) | `0.85` | 摘录 + 估图 token 必须 ≤ 原文的这个比例 |

随时关掉「替换默认压缩」即可恢复 DSH 的 LLM checkpoint。`/fast-compact` 无论开关都走机械折页。

机械折页免费、即时，但只留路径、意图、工具次数和短摘录，语义比官方 checkpoint 粗。不想丢叙事摘要，就保持这项关闭。

## 命令

```
/fast-compact
/fast-compact status
```

没有 vision sidecar。旧的 `/fast-compact vision …` 已删除。

`/compact` 仍是官方命令。替换默认压缩**关**时照旧调模型；**开**时同一条命令经现有引擎走机械折页。

`/fast-compact status` 还会报健康状态：入境定形的 shaped/snapped/节省计数、持续失败时的最后一条错误，以及缺少 `summarize` 钩子的压缩引擎（开着替换默认压缩时，那种引擎会静默改调模型）。

## 入境摘录

默认只出文本：不打图、不调模型。候选只有**当前回合紧邻上一步**的结果；其余已经发送过的节点保持逐字节不变——这正是前缀缓存不被破坏的原因。已经是占位符的结果不会再改。`skill`、`context` 工具结果会跳过。没有 `tokenMeter` 时整段入境跳过，避免只 `replace` 却写不出 `compaction/prune`。

```
[Snapcompact: N tokens → excerpt · read src/config.ts]
前 16 行
… (K lines elided; see image if attached. To inspect or edit exact bytes, re-read with offset/limit) …
后 8 行
```

「可回读」只对**文件读取**成立。命令行输出没有任何 `offset/limit` 入口，省略的中段就是丢了，
所以对这类结果换一句实话——`These bytes cannot be re-read from here — repeat the call if you
need the full text`——而不是把模型引向一个到不了的地方。判定规则是白名单：只有 `read` 算可回读，
未知工具一律按不可回读处理（承诺做不到比少一个便利更贵）。

贴 PNG 必须同时满足：

- 勾了「允许密图」
- 当前路由模型的 `inputModalities` **明确包含 `image`**（绝不按 `gpt-4o` 这类名字猜）
- 摘录 + 估图 token ≤ 原文 × 节省比例（默认至少省 15%）
- 图中真正画进去的文本，按文本计价必须**比这张图更贵**（默认 图 ≤ 文本 × 0.85）。一行三个字符、三千行的输出，贴图反而亏，这时只出摘录

### 密图排版

画布按面积计价（512px tile 带，画满和画空一个价），所以排版只干一件事：**把有信息的格子塞满已经付过钱的画布**。

- **画布对齐 tile 边界**：openai 系画布是 `1024×2048` 而不是 `1024×1540`。同样的 1445 token，正文从 70 行变 93 行（+33%）——旧高度里有 4 个像素跨进了下一条付费带。
- **短行自动分栏**：按行长分布试 1–24 栏，取占用率最高者；候选只要换行率超过 2% 就淘汰，所以「一行一格」的承诺在能守住时一定守住，只有整行宽过画布的内容才在格内折行。`seq 1 3000` 会排成 20 栏数字阵，同价从 93 行变 1860 行。
- **行号尺**：源行数 ≥ 50 时左侧留 gutter，每 5 个网格行标一次**源行号**，并画一条淡竖线。图因此是可寻址的：模型看到异常行，可以直接 `offset/limit` 回读精确字节，而不是只能猜。
- **灰阶层级**：正文 `16`、栏线 `205`、行号 `150`、纸面 `245`。层级不花 token，花的是已经付过钱的像素。
- 摘录提示会写明版面：`[Snapcompact: 3480 tokens → 1024x624 PNG ~434 tokens · 20 cols · line ruler]`，模型不必猜自己看的是一栏还是二十栏。

### 计费与保真（deepseek-flash）

密图按**输入 token** 计价，用官方价目（api-docs.deepseek.com，2026-09-10）：

| | 高峰 | 低谷 |
| --- | --- | --- |
| 输入 缓存命中 /1M | $0.006 | $0.003 |
| 输入 缓存未命中 /1M | $0.30 | $0.15 |
| 输出 /1M | $1.20 | $0.60 |

下面两条是实测出来的，不是估的：

- **画布必须画在请求像素预算内**。请求管线会把超过 `640000` px 的图缩到预算内再发，provider 按缩后的图计费、也按缩后的图识读。同一份内容实测：画 `1024x2046`（被缩到 `566x1131`）10 道题只对 1–2 道；直接画 `1024x624`（不触发缩放）对 8 道。所以 deepseek 路由的几何是 `8on16-budget 1024x624`（39 行）。
- **图片 token 曲线也是实测的**：`≈ clamp(70 + 5.7e-4·px, 213, 1043)`（先缩到预算再算）。官方文档那个「单图封顶 384 token」的算法对不上线上 `usage`，插件按实测曲线估，误差约 3%（估算 434 vs 实测 446，差值是提示文本本身）。
- **计数交给文本，不去图里找数**。notice 末尾是 `whole-file totals: PASS×1484 · FAIL×16 · …`——整份结果里重复出现的值，机械统计，50 token，不调模型。168 题配对实测：结构类准确率 **35% → 78%**（净 +22，p=0.0007），精确值读取不受影响（114 题里 −1）。图数不了 2000 行的文件，摘录也数不了。
- 满帧约 **$0.00013**；同样内容按文本计价是 $0.001–$0.014，**便宜 10–100 倍**。
- 保真度有上限，而且是从两侧量出来的。**只看图**时，精确值问题答对率 **70%**，而且失手不是概率而是墙：5 位以上的数字、或密集行尾的字段，在每一次重复里都是 0/6；而"按字面量找到行、读它旁边一个短字段"是 5–6/6。把插件本来就会发的首尾文本摘录加回去，值类准确率升到 **91%**（+21 个百分点，57 题净 +12，p=0.002），每次回答 1000 token，仍比同样内容走纯文本便宜 3.5 倍。针对同一类错误的六个渲染改法——行底纹、加粗数字、更大字号的数字、两种数字分组、以及 32 行摘录窗口——全部无效。所以设计成立：图负责体量与结构，精确字节走文本，`re-read with offset/limit` 契约负责从源文件取回任意字节。

`bench/report.md` 是原始结果（fixtures × 版面变体 × 可判定问答，答案与 `usage` 全部缓存）；`bench/FINDINGS.md` 是方法与逐项裁决。要点：

- **必须画在请求像素预算内**：同一内容被管线缩放后只对 1–2/10，原生绘制对 8/10，而两者的账单一样。
- **分栏**：准确率不变的前提下，每帧多装约 20 倍行数。
- **每行都标源行号**：值类准确率 73% → 87%，且不花 token、不占容量（错误类型主要是"读错行"，这条正对着它）。
- **颜色试过并否掉了**：4 套配色、配对 3 次重复共 60 样本，灰度 46/60 vs 彩色 44/60，值类准确率完全相同。编码器（`encodePngPalette`）与逐格/逐位墨色能力保留在库里备用，但不默认开。
- **提示图例 / 更宽的格子 / 单栏默认**：都测了，都没赚回成本。
- **字形两个方向都试过了，都不影响正确率**：同尺寸换设计（X.org vs DejaVu/JetBrains 的 TTF 渲染）配对 60 样本打平 **46/60 vs 46/60**；换更大的字（8x16 配同样的 `1024x624`/39 行几何、同样的 434 token 账单，每字符墨量 +56%）同样打平 **46/60 vs 46/60**。同一个变体重问三遍的得分是 14、15、17 / 20——这就是这条轴上每一次"筛选轮领先"的真实尺度。越过可读阈值之后，像素买的是容量，不是准确率。字库生成器 `tools/make-atlas.py` 保留（任意字格、任何 FreeType 能开的字体、`--show` 直接看字形）。
- **正确率的主因是"每字符有效像素"，不是画布大小、也不是 token 数**：把同内容缩到一半分辨率，14/20 → 9/20；先缩一半再放大回原尺寸（尺寸与账单和对照一模一样），仍掉到 12/20。所以"画得更大"只买容量，不买准确率；一旦有效分辨率掉到阈值以下（约每字符 5px），准确率立刻崩。
- **传图像素预算别调大**：`llm-deepseek` 的 `imagePixelBudget`（默认 640000）确实可配，但实测 1.3M 同准确率、价格翻倍；2.1M 掉到 33%。插件里的「传图像素预算」设置只在部署改了 DSH 那个值时才需要跟着改——尤其是调成 `"low"` 时必须改，否则画大的帧会被缩，正是那套 1–2/10 的失效模式。
- **天花板**：最优配置下精确值问题仍有约四分之一会读错。图是索引，不是公证人 —— 精确字节走文本摘录、折页卡与 `offset/limit` 回读。

- **不存在「压缩比」这个旋钮**：帧是固定的 ~434 token 账单，摘录固定 16 头 + 8 尾，所以请求开销是 `帧 + 24 行 + 答案`，与文件有多少行无关；而同样内容走文本是*每一行*。实测每个正确答案便宜 **15.5 倍**，按 fixture 落在 6.0 倍（3001 行四字符）到 25.4 倍（2000 行百字节）之间——比值由输入决定，不是可调参数。至今所有准确率增益都来自文本（摘录 +21 点值类、摘要 +43 点结构类）；越过可读阈值后，像素侧没有任何改动提升过准确率。
- **错答是「编造」而不是「噪声」**（`bench/miss-audit.mjs`，不调模型）：336 个答案里 53 个错，其中 **52 个格式良好、看似合理**——47 个错值在它所针对的文件里真实存在，51 个与正确答案位数相同（`1001110` → `1001147`、`261` → `$268`、`29` → `42`）。只有 1 个能被形状或范围检查一眼证伪。有损编码会花屏并自我暴露，这条通道则是「换一个真实的值」，不留任何信号——所以 `$/correct` 低估了这里犯错的代价。
- **通知里承诺的「回读」是有效的，只是没有便宜的办法让模型真的去用**（声明 `read: true` 的臂，同一次运行内配对 3 次重复、每臂 84 个答案）：只是把读工具摆在那儿，模型只在 **8%** 的答案上发起回读，得分 66/84，冻结核对的对照是 71/84；而多写一行点明坐标——左栏数字就是源行号、`read_result(offset=N)` 返回那几行原文——把发起率抬到 **29%**，得分仍是 69/84，token 却多花 41–83%。读本身是好的：**18 次命中答案行的回读里 17 次答对**，图上看是天墙的 7 位 id 从 **0/3 变成 2/3**。整臂仍然亏，因为多出来的回读也落在了计数类问题上，而那里「读一个窗口」比整文件摘要更差。回读本身接近免费：重发的前缀有 75–85% 命中缓存，额外轮次只加 2–9%，不是 41–83%。
- **压测自己的判分器里有三处静默转义 bug**——三个正则字面量里写了双反斜杠，于是去空白从未生效、数字前缀分支是死代码、5xx 重试遇到 5xx 从不重试。用修好的判分器重判 0.13.2 那一轮全部 336 个答案，**没有任何一个判定改变**（模型恰好回答了 `52ms` 而期望就是 `52ms`）；判分器现在独立在 `bench/match.mjs`，`bench/miss-audit.mjs` 一律重算判定而不信任存档标记。
- **让模型写摘要会输给图，而输的方式才是重点**（`absorb` / `absorb-digest` 臂：按 `acp-kernel` tier-1 规则分块盲摘要，直接取代图——这就是 `billion-context` 的 `absorb` 留在 wire 上的东西）：57/84 与 56/84，对照图的 71/84，配对净差 **−14（p=0.0066）** 与 **−15（p=0.0007）**；每轮**带着更多 token**（1250 / 1300 vs 1097），总价 3 倍。它赢在内容**由规则生成**时——`seq-3000`（整数 1..3000）15/15 对图的 14/15，且只要 230 token 对 542——输在问题指向某个任意实例时：`test-log` 上摘要自己找出了生成规则（"耗时每步 13ms"），然后把答案写成 `13ms`，而真值是 `52ms`。**它是拿规则去套，而不是去读那一行。** 它的错答 27–28 个对 13 个，静默率同样 100%——图编造的是**文件里有过**的值，摘要编造的是**从不存在**的值。

## 折页卡

纯机械，不调模型。旧折页文本不会被套娃，但也不会丢：从上一张 `[Snapcompact]` 卡里解析出的文件、意图和错误会延续到新卡（文件只占用新跨度没用完的额度）。

```
[Snapcompact] Fold ~N tok. Exact file bytes are not stored — re-read with offset/limit if a detail matters.
FILES
- [edit] 路径
- [read] 路径
INTENTS
- 最近的用户目标
TOOLS
- read 4
COMMANDS
- …
ERRORS
- …
EXCERPT
[user] …
[tool] …
```

文件字节不进卡。细节要对，用 `offset` / `limit` 再读一遍。

## 和官方压缩怎么配合

**不要卸** `@deepseek-ai/dsh-compaction-basic`。

- 压力、选段、缩水校验、持久化的 `compaction/*` 事件仍由官方引擎负责。
- 本插件只包一层 `summarize()`。
- `/fast-compact` 只把当前 agent 标进一次 `compactNow()`，其它会话继续走 LLM。
- 「替换默认压缩」是即时设置：勾上后已钩住的引擎都改走机械摘要，关掉或卸载插件即恢复。

Web 上 compaction 在 preset isolate 里。Host 侧用 `agentPresets.serviceFor(agent, "compaction")` 读该会话的引擎，不要 `inject: ['compaction']`。

### 改代码前必读：本插件依赖的 DSH 契约

四处机制写在官方件里，改动前先确认它们没变：

1. **`summarize()` 是唯一的定制钩子，引擎只在 preset 隔离域里挂载**。standard preset 把 `compaction-basic` 装在带 isolate realm 的 compaction group 里，`ctx.get("compaction")` 与 `agent.ctx.get("compaction")` 都读不到它，`agentPresets.serviceFor(agent, "compaction")` 是官方支持的宿主侧读法（`lib/resolve.js`）。本插件因此用运行时包裹而不是子类化替换：替换 `ctx.compaction` 会重复注册自动压缩监听器。
2. **`SummaryResult.rawOutput` 对模板类总结器是可选字段，`llmStreamCall` 必须缺省**（官方 `@deepseek-ai/dsh-compaction-basic` 的 `lib/types/summarizer.d.ts`）。折页报告就走这个字段：第一个文本块给人读，第二个是同样数字的 JSON，供 `bench/` 与日志解析。它不会回填进模型上下文——回填的只有 `summary`。
3. **`tool/call` 事件只存在于日志，surface 不携带它**。它的 `data.arguments` 是模型产出的**未解析 JSON 字符串**，可能不合法；工具名与定位参数因此只能从完整事件日志（`snapshotEvents` / `eventAt`）反查，且解析失败只能退化成「没有来源标注」，不允许中断入境（`lib/ingress.js`）。
4. **前缀缓存划定入境层的边界**：已发送的节点逐字节不变，只有当前回合紧邻上一步的 `tool_result` 可被替换。这是结构约束，不是保守选择（`lib/ingress.js` 顶部）。

客户端侧：DSH 用 loader 行的 specifier 定位插件的 client 半身，且**只接受包根 specifier**（子路径会让宿主加载成功却不贡献前端），所以 `cordis.patch.yml` 的 `name` 必须是包名本身；客户端入口由 `package.json` 的 `dsh.client`（`platform: web` 与 `inject`）声明。

## 开发

```bash
node --test lib/ledger.test.js

# 版面经济性：每个 fixture 的文本/图像 token、承载行数、画布占用率。纯算术，不调模型
node bench/layout-bench.mjs

# 保真度 + 真实计费：fixtures × 版面变体 × 可判定问答，结果与 usage 缓存进 bench/.cache
node bench/fidelity-bench.mjs

# 错答到底是什么、钱花在了哪里：重读已记录的运行结果，不调模型
node bench/miss-audit.mjs

# 回读臂：把 read_result(offset, limit) 交给模型，记录它是否用、瞄向哪、重复轮次花了多少
node bench/fidelity-bench.mjs --variants excerpt-digest,reread-base,reread-address,reread-hint --repeats 3

# 竞争通道：让模型写摘要来取代工具结果（即 billion-context 的 absorb），与图在同一次运行里正面对撞
node bench/fidelity-bench.mjs --variants excerpt-digest,absorb,absorb-digest --repeats 3

# 有一个用例绑定真实 dsh-session，指向已安装包才会运行
DSH_SESSION_MODULE="$DSH/node_modules/@deepseek-ai/dsh-session/lib/index.js" \
DSH_SCHEMASTER_MODULE="$DSH/node_modules/@deepseek-ai/schemastery/lib/index.mjs" \
  node --test lib/ledger.test.js
```

| 文件 | 职责 |
| --- | --- |
| `lib/ctx.js` | 可选服务查找 + 跨版本 session 事件读取 |
| `lib/schema-envelope.js` | 规范 Schemastery `{uid, refs}` 设置信封 |
| `lib/ingress.js` | 上一步 `tool_result` 定形（结构上缓存安全） |
| `lib/vision.js` | 密图：`inputModalities` + 设置双门 |
| `lib/excerpt.js` / `lib/fold.js` / `lib/snapfont.js` | 摘录、折页卡、点阵与网格光栅化 |
| `lib/layout.js` | 密图排版：选栏、格内折行、行号尺、占用率 |
| `lib/hook.js` | 机械 `summarize` 钩子 |
| `lib/resolve.js` | 查找 isolate 里的压缩引擎 |
| `lib/index.js` | 命令、设置、pre-step |
| `lib/client.js` | 闪电、折页行、设置页 |

## 许可

MIT。`lib/fonts/` 里的点阵字体见 [`lib/fonts/README.md`](lib/fonts/README.md)。
