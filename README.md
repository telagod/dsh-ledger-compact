# dsh-ledger-compact

English · [中文](README.zh.md)

**dsh-plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Large tool results are shaped **before** they reach the model. An optional local fold can replace DSH’s LLM `/compact`.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-111111)](https://github.com/topics/dsh-plugin)
[![test](https://github.com/telagod/dsh-ledger-compact/actions/workflows/test.yml/badge.svg)](https://github.com/telagod/dsh-ledger-compact/actions/workflows/test.yml)

---

## Why

Long agent turns dump huge `tool_result` blocks into the next request. DSH already has an excellent LLM compact (`@deepseek-ai/dsh-compaction-basic`), but it costs an extra model call and runs *after* pressure builds.

This plugin does two cheaper things first, and optionally a third:

1. **Ingress shaping** — freeze oversized *unsent* tool results into a head/tail excerpt on the idle pre-step. Only the step that just finished is touched: its first request is the one being prepared, so a rewrite never invalidates a provider-cached prefix.
2. **Mechanical fold** — `/fast-compact` and the input-bar bolt collapse older history into a short ledger card. No model call.
3. **Replace default compact** *(off)* — reuse the official engine’s `summarize` hook so `/compact`, auto-compaction, and overflow recovery also skip the LLM.

Keep `dsh-compaction-basic` mounted. This plugin does not replace the engine.

## Install

Requires **dsh ≥ 0.1.2-rc.1**; verified on **0.1.5-rc.1**. Both API renames in that range are handled: `session.events` → `session.eventAt(seq)` and the positional replace keys `start/end` → `startSeq/endSeq`.

```bash
dsh plugin --profile web add github:telagod/dsh-ledger-compact
```

Restart the web profile after install. The bundle patch inserts plugin id `dsh-ledger-compact`.

From a local checkout:

```bash
git clone https://github.com/telagod/dsh-ledger-compact.git
dsh plugin --profile web add ./dsh-ledger-compact
```

## What you get

| Layer | When | Model call | What changes |
| --- | --- | --- | --- |
| Ingress shaping | Idle `agent/pre-step` | No | Current unsent `tool_result` only |
| Bolt / `/fast-compact` | You click or type it | No | Older history → mechanical fold card |
| Replace default compact | `/compact`, auto, overflow | No | Same official transaction; local summarizer |
| Official `/compact` | Default DSH path | Yes | LLM `<compacted-summary>` checkpoint |

The input-bar **bolt** is a context-pressure meter. By default it needs a second click before folding (can be turned off). After a fold, the chat shows an expandable row in the same style as the official compact line; the open view is a slim left-axis timeline, not a model essay.

## Settings

Open **Settings → 快速压缩**. Changes write through to the Host document immediately. The page is tabbed:

- **入境** — the four shaping settings below.
- **折页** — fold confirmation, replace-default, and a live preview of the fold card.
- **诊断** — plugin version, the session-event accessor this DSH exposes, ingress counters and the last failure, and how many compaction engines are hooked (plus any engine that would silently fall back to a model call).

| Setting | Default | Meaning |
| --- | --- | --- |
| Ingress shaping (`enabled`) | on | Excerpt large unsent `tool_result` blocks before the next request |
| Allow dense PNG (`snapImages`) | off | Attach a bitmap only when the main model lists `image` in `inputModalities` **and** the image is cheaper than the original |
| Confirm before fold (`confirmFold`) | on | Bolt requires a second click |
| Replace default compact (`replaceDefault`) | **off** | `/compact`, automatic pressure compaction, and overflow recovery use the mechanical summarizer |
| Ingress threshold (`minSnapTokens`) | `3000` | Approximate tokens before an excerpt (or PNG) is considered. Range 200–200000 |
| PNG savings (`savingsRatio`) | `0.85` | Excerpt + estimated image tokens must be ≤ this fraction of the original |

Turn **Replace default compact** off at any time to restore DSH’s LLM checkpoint. `/fast-compact` stays mechanical either way.

## Commands

```
/fast-compact
/fast-compact status
```

There is no vision sidecar. `/fast-compact vision …` was removed.

`/compact` remains the official DSH command. With replace-default **off**, it still calls the model. With it **on**, the same command runs the mechanical fold through the existing engine.

`/fast-compact status` also reports health: ingress shaped/snapped/saved counters, the last ingress error when one is repeating, and any compaction engine that lacks a `summarize` hook (with replace-default on, such an engine would silently call the model).

## Ingress excerpt

Default is text only — no PNG, no LLM. Only results from the **immediately preceding step** of the current turn are candidates; everything already sent stays byte-identical, which is what keeps the provider prefix cache intact. Already-shaped placeholders are not rewritten. `skill` and `context` tool results are skipped. If `tokenMeter` is missing, ingress is skipped so the plugin never `replace`s without writing `compaction/prune`.

```
[Snapcompact: N tokens → excerpt]
first 16 lines
… (K lines elided; see image if attached. To inspect or edit exact bytes, re-read with offset/limit) …
last 8 lines
```

A PNG is attached only when all of these hold:

- “Allow dense PNG” is on
- the routed model’s `inputModalities` **explicitly includes `image`** (names like `gpt-4o` are never guessed)
- excerpt + estimated image tokens ≤ original × savings ratio (default 15% cheaper)
- the text actually drawn into the image must be **more expensive as text** than the image itself (default: image ≤ text × 0.85). Three thousand lines of three characters each lose money as a PNG, so only the excerpt ships

### Dense-image layout

The canvas is billed by area (512px tile bands — a full band and a blank one cost the same), so the layout has exactly one job: **fill the canvas that has already been paid for**.

- **The canvas cap is tile-aligned**: openai-family frames are `1024×2048`, not `1024×1540`. Same 1445 tokens, 93 text rows instead of 70 (+33%) — the old height crossed into a paid band for four pixels.
- **Short lines pack into columns.** The planner tries 1–24 columns and keeps the highest occupancy; a candidate is dropped as soon as more than 2% of its cells would wrap, so one-line-per-cell holds whenever it can, and only content wider than the whole canvas wraps inside a cell. `seq 1 3000` becomes a 20-column numeric grid: 1860 source lines for the price of 93.
- **Line ruler**: from 50 source lines up, the left gutter prints the source line number every 5 grid rows next to a faint rule. That makes the image addressable — a model that spots a bad row can `offset/limit` its way back to exact bytes instead of guessing.
- **Layered ink**: body `16`, column rules `205`, ruler `150`, paper `245`. Hierarchy costs no tokens; it only costs pixels, and the pixels are already paid for.
- The excerpt notice names the layout: `[Snapcompact: 3480 tokens → 1024x624 PNG ~434 tokens · 20 cols · line ruler]`, so the model never has to guess whether it is reading one column or twenty.

### Cost and fidelity (deepseek-flash)

A dense image is billed as **input tokens**, at the published DeepSeek rates (api-docs.deepseek.com, read 2026-09-10):

| | peak | off-peak |
| --- | --- | --- |
| input, cache hit /1M | $0.006 | $0.003 |
| input, cache miss /1M | $0.30 | $0.15 |
| output /1M | $1.20 | $0.60 |

Two things below are measured, not assumed:

- **Draw inside the request pixel budget.** The request pipeline resizes any frame above `640000` px before dispatch, and the provider both bills and reads the resized image. Measured on identical content: drawing `1024x2046` (sent as `566x1131`) answered 1–2 of 10 questions; drawing `1024x624` (no resize) answered 8. DeepSeek routes therefore use the `8on16-budget 1024x624` geometry (39 rows).
- **The image-token curve is measured too**: `≈ clamp(70 + 5.7e-4·px, 213, 1043)` on the resized dimensions. The published "one image caps at 384 tokens" calculator does not match live `usage`; this fit is within ~3% (est 434 vs measured 446, the gap being the prompt text).
- **Counting happens in text, not in the picture.** The notice ends with `whole-file totals: PASS×1484 · FAIL×16 · …` — the repeated values of the whole result, counted mechanically, 50 tokens, no model. Paired over 168 questions it takes structure accuracy from **35% to 78%** (net +22, p=0.0007) and leaves exact-value reading unchanged (−1 of 114); a picture cannot count a 2000-line file, and neither can an excerpt.
- A full frame costs about **$0.00013**; the same content as raw text costs $0.001–$0.014 — **10–100x more**.
- Fidelity has a ceiling, and it is measured from both sides. From the image alone, exact-value questions are answered **70%** of the time, and the misses are not a rate but a wall: a 5+ digit value, or a field at the end of a dense line, is 0/6 across every repeat — while matching a literal key and reading a short field beside it is 5-6/6. Adding the head/tail excerpt the plugin already sends lifts value accuracy to **91%** (+21 points, net +12 of 57, p=0.002) for 1000 tokens per answer, still 3.5x cheaper than the same content as text. Six rendering fixes aimed at the same class — row shading, bolder digits, a bigger digit box, two kinds of digit grouping, and a 32-line excerpt window — moved nothing. Hence the design: the image carries bulk and structure, exact bytes travel as text, and the `re-read with offset/limit` contract recovers any byte from the source.

`bench/report.md` holds the raw run (fixtures × layout variants × checkable questions, answers and `usage` cached); `bench/FINDINGS.md` holds the method, the noise floor and a verdict per axis. In short:

- **Draw inside the request pixel budget**: identical content answered 1–2 of 10 when the pipeline resized it, 8 of 10 drawn natively, for the same bill.
- **Packing** carries ~20x more lines per frame at equal accuracy.
- **A source line number on every row** lifted exact-value accuracy from 73% to 87% at no token or capacity cost — it aims straight at the dominant error class, reading the wrong line.
- **Colour was tried and rejected**: four palettes, paired 3-repeat run over 60 samples each — grayscale 46/60, colour 44/60, value accuracy identical. The encoder (`encodePngPalette`) and per-cell/per-digit ink stay in the library, off by default.
- **The glyphs were tried both ways and neither matters**: at a fixed 8x13 box, four atlases (X.org and TTF renders of DejaVu/JetBrains) came out **46/60 vs 46/60** paired; a *larger* box — 8x16 at the identical `1024x624`/39-row geometry and 434-token bill, +56% ink per character — also came out **46/60 vs 46/60**. Re-asking one unchanged variant three times scores 14, 15 and 17 out of 20: that is the size of every screening "lead" this axis has produced. Above the legibility floor, pixels buy capacity, not accuracy. `tools/make-atlas.py` stays (any box, any font FreeType can open, `--show` to eyeball a glyph).
- **Accuracy follows effective pixels per glyph, not canvas size or token count**: halving the resolution of identical content scored 9/20 against the control's 14/20, and downscaling then upscaling back to the *same dimensions and the same bill* still scored 12/20. Bigger canvases buy capacity, not accuracy; below ~5 px per glyph accuracy collapses.
- **Do not raise the request-image budget**: `llm-deepseek`'s `imagePixelBudget` (640000 by default) is configurable, but 1.3M measured the same accuracy at twice the money and 2.1M collapsed to 33%. The plugin's 传图像素预算 setting only needs to follow the deployment's value — and must, if it is set to `"low"`, or every frame gets resized into the 1–2/10 failure mode.
- **Ceiling**: about a quarter of exact-value questions are still misread in the best configuration. The image is an index, not a notary — exact bytes travel as text, in the fold card, or through `offset/limit` re-reads.

- **There is no compression ratio to trade**: the frame is a fixed ~434-token bill and the excerpt is capped at 16 head + 8 tail lines, so the request does not grow with the file — `frame + 24 lines + the answer`, against *every* line as text. That measures **15.5x cheaper per correct answer** overall, from 6.0x (3001 four-character lines) to 25.4x (2000 hundred-byte lines): the ratio is a property of the input, not a dial. Every accuracy gain measured so far came from text — the excerpt (+21 points of value) and the digest (+43 points of structure) — and no pixel-side change moved accuracy above the legibility floor.
- **The misses are a confabulation channel, not a noise channel** (`bench/miss-audit.mjs`, no model calls): of 53 wrong answers in 336, **52 are well-formed and plausible** — 47 are values that occur verbatim in the file asked about and 51 have the same digit width as the truth (`1001110` → `1001147`, `261` → `$268`, `29` → `42`). Exactly one refutes itself with a shape or range check. A lossy codec garbles and announces it; this channel substitutes a real value and leaves no signal, so `$/correct` prices a wrong answer here below what it costs.
- **The re-read the notice promises works, and nothing cheap makes the model take it** (`read: true` arms, paired 3-repeat, 84 answers per arm against the frozen control in the same run): with the read simply available the model asks on **8%** of answers and scores 66/84 against the frozen 71/84; one extra notice line naming the coordinates — the gutter labels are source line numbers, `read_result(offset=N)` returns those bytes — triples the ask rate to **29%** and still scores 69/84, for 41–83% more tokens. The reads themselves are good: **17 of 18 aimed reads were right**, and the 7-digit id that is a wall from the image goes **0/3 → 2/3**. The arm loses anyway, because the extra asking also lands on the counting questions, where a window of text is worse than the whole-file digest. The re-read itself is nearly free: 75–85% of the re-sent prefix comes back as a cache hit, so the extra rounds add 2–9%, not 41–83%.
- **The bench's own scorer had three silent escaping bugs** — a doubled backslash inside three regex literals, so the whitespace strip never fired, the number-prefix branch was dead, and the 5xx retry never retried on a 5xx. Re-deciding all 336 stored answers changes no verdict (the model happened to answer `52ms` where `52ms` was expected), but the matcher now lives in `bench/match.mjs` and `bench/miss-audit.mjs` recomputes every verdict rather than trusting the stored flag.
- **A written summary loses to the frame, and how it loses is the interesting part** (`absorb` / `absorb-digest` arms: blind chunked summarisation under `acp-kernel`'s tier-1 rules, sent in place of the image — this is what `billion-context`'s `absorb` leaves on the wire): 57/84 and 56/84 against the frame's 71/84, paired nets **−14 (p=0.0066)** and **−15 (p=0.0007)**, carrying *more* tokens per later request (1250 / 1300 against 1097) and costing 3x. It wins where the file is **rule-generated** — `seq-3000`, the integers 1..3000, scores 15/15 against the frame's 14/15 for 230 tokens against 542 — and loses where the question names an arbitrary instance: on `test-log` the summary found the generator ("durations step by 13 ms") and then answered `13ms` where the truth was `52ms`. **It applies the rule instead of reading the row.** Its misses are 27–28 against 13, with the same 100% silence — the image invents a value that was in the file, the summary invents one that was never anywhere.

## Fold card

Mechanical, no model. Prior fold text is never nested, but it is not lost either: files, intents and errors recovered from an earlier `[Snapcompact]` card are carried forward into the new one (files only fill capacity the new span left over).

```
[Snapcompact] Fold ~N tok. Exact file bytes are not stored — re-read with offset/limit if a detail matters.
FILES
- [edit] path
- [read] path
INTENTS
- recent user goals
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

This is cheaper and more predictable than an LLM checkpoint. It also keeps less prose: paths, intents, tool counts, and a short excerpt — not a narrative of *why*.

## Working with DSH compact

Do **not** unmount `@deepseek-ai/dsh-compaction-basic`.

- Pressure, range selection, shrink checks, and durable `compaction/*` events stay on the official engine.
- This plugin only wraps `summarize()`.
- `/fast-compact` marks the current agent for one `compactNow()` so other sessions keep the LLM path.
- Replace-default is a live setting: every hooked engine uses the mechanical summarizer until you turn it off (or unload the plugin).

On web, compaction lives in the preset isolate. Host code reads it with `agentPresets.serviceFor(agent, "compaction")`, not `inject: ['compaction']`.

## Develop

```bash
node --test lib/ledger.test.js

# per-fixture layout economics: text vs image tokens, lines carried, canvas occupancy.
# Pure arithmetic, no model calls.
node bench/layout-bench.mjs

# fidelity + real billing: fixtures x layout variants x checkable questions, cached in bench/.cache
node bench/fidelity-bench.mjs

# what the misses are and what the money buys: re-reads the recorded run, no model calls
node bench/miss-audit.mjs

# the re-read arms: the model gets read_result(offset, limit), and the run records what it
# does with it, aimed where, and what the repeat rounds cost
node bench/fidelity-bench.mjs --variants excerpt-digest,reread-base,reread-address,reread-hint --repeats 3

# the competing channel: the model writes the summary that replaces the result, as
# billion-context's absorb does — measured head to head with the frame in one run
node bench/fidelity-bench.mjs --variants excerpt-digest,absorb,absorb-digest --repeats 3

# one test binds a real dsh-session; point it at the installed package to run it
DSH_SESSION_MODULE="$DSH/node_modules/@deepseek-ai/dsh-session/lib/index.js" \
DSH_SCHEMASTER_MODULE="$DSH/node_modules/@deepseek-ai/schemastery/lib/index.mjs" \
  node --test lib/ledger.test.js
```

| File | Role |
| --- | --- |
| `lib/ctx.js` | Optional service lookup + version-tolerant session event access |
| `lib/schema-envelope.js` | Canonical Schemastery `{uid, refs}` settings envelope |
| `lib/ingress.js` | Previous-step `tool_result` shaping (cache-safe by construction) |
| `lib/vision.js` | Dense PNG gated by `inputModalities` + settings |
| `lib/excerpt.js` / `lib/fold.js` / `lib/snapfont.js` | Excerpt, fold card, bitmap and grid raster |
| `lib/layout.js` | Dense-image layout: column packing, in-cell wrap, line ruler, occupancy |
| `lib/hook.js` | Mechanical `summarize` hook |
| `lib/resolve.js` | Find isolated compaction engines |
| `lib/index.js` | Command, settings, pre-step |
| `lib/client.js` | Bolt, fold row, settings page |

## License

MIT. Bitmap fonts under `lib/fonts/` are documented in [`lib/fonts/README.md`](lib/fonts/README.md).

## Model Experience

### Tool-result shaping before the model sees it

#### What the model sees

到达模型前已被整形/剪枝的大工具结果，以及被剪内容的回读地址（ledger）。

#### Token effect

Replaced — 用摘要替换原始长结果，总量随被剪内容规模变化（省幅见本包基准）。

#### KV Cache effect

Replacing — 剪枝改变历史消息内容，会使此前可复用的前缀失效。

## Known Limitations and Deferred Work

- **压缩有损** — 摘要可能丢掉后续轮次真正需要的细节，需依赖回读路径取回；回读不可用时信息不可恢复。
