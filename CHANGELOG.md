# Changelog

## 0.14.2

A skill body reaches the model whole again under ptc. Both exemptions were written for a
deployment where the skill arrives under its own tool name; under this one it arrives inside
a `run_code` result, so neither could fire and a SKILL.md past the threshold lost its middle
without saying so.

### Fixed

- **A skill loaded through `run_code` is exempt from ingress shaping.** The tool-name guard
  never sees it — the wrapper's name is what reaches the pass — and the content guard needs a
  `<skill_content>` tag that only a direct skill call carries. The call itself is now the
  locator, the same way a `snap_retrieve` redemption is exempted: matched on the program's
  arguments, so the body survives whether the model prints it whole or a slice of it.

### Changed

- **`skipIngressTool` covers `open_skill` and `find_skills`.** The session catalogue points the
  model at `open_skill` for everything it does not list, and both hand back instruction text;
  neither was exempt even where the tool name does arrive under its own name.
- **The settings surface follows DSH 0.1.7's Config-derived namespaces.** The browser half binds
  the `configForms` service (the `settingsScope` binder is gone) and the host half exports a
  volatile `Config` schema instead of claiming a namespace through `settings.register`; the
  profile's own plugin configuration is the single store, every read tracks the live reference,
  and the `/fast-compact` card reads and writes again on 0.1.7. The strict typert codecs also
  carry the `create()` factory the 0.1.7 registry validates.

## 0.14.1

The ingress stops promising recoveries it cannot deliver, and says what it did instead. Under a
ptc deployment every call arrives as `run_code`, so the readability whitelist never matched and
an elided middle was gone for good.

### Added

- **`persistIngressText()`**, plus a `savedPath` branch in the elision notice: the full text of a
  result that no `offset`/`limit` re-read can reach is written down before it is elided, and the
  notice names the file. Off by default (`persistIngress` / `persistDir`) — it writes files, so a
  deployment opts in rather than inheriting the behaviour.
- **An auditable, addressable fold**: the excerpt header carries the call identity
  (`[Snapcompact: N tokens → excerpt · run_code <description>]`), the dropped middle stays
  retrievable by handle, and the settings layer degrades instead of taking the plugin down.

### Fixed

- **No promise of a re-read that command output cannot honour.** Only a file read can keep it; a
  `bash` result now says the bytes are unreachable instead of pointing at them.
- **The elision notice survives long lines**, and a wrapper tool is labelled by its description
  rather than by its wrapper name alone.

## 0.14.0

Where the compression actually loses information, measured without a model. The fidelity bench
cannot answer this: `fixtures.mjs` puts every answer inside the first 39 lines on purpose, so it
can never price a deep line. No `lib/` change.

### Added

- **`bench/coverage-audit.mjs`**: five equal-budget arms (`head-tail`, `head-tail+digest`,
  `signal-first`, `rare-first`, `even-sample`) plus two controls (`all`, `head-extend`), scored by
  whether each original line survives the compression, banded by position. 200 model-free checks
  across the five fixtures.

### Measured

- **Coverage is set by the line budget, not by the choosing.** Every selective arm lands at 0–3%
  in the middle and late bands. The controls say why: `all` scores 100% everywhere (the
  measurement is right), and **`head-extend` — which is not clever at all, just four more head
  lines — beats every clever arm in the early band, 67% against 4%.**
- **The first version of this audit put `rare-first` at 67% in the early band, and it was an
  artifact.** On homogeneous data every template ties, and ordering ties by index silently
  degrades that arm into "extended head". Spreading ties with a fixed hash dropped it to 4%,
  level with blind sampling. The control arm is what caught it.
- **Signal-first is no rescue either**: `access-log` holds about 54 rows at status 503, so 16 slots
  buy 2% of the middle band. Sparse signals are not sparse enough.
- **The ceiling is arithmetic**: 40 kept lines out of 2 000 is 2%, whatever chose them. A decider
  wired into the ingress can only pick a better 16 lines out of 2 000 — 0.8% — so at this layer
  its accuracy is not the constraint. This is the measured answer to "should the decider move to
  ingress shaping": no, and not because it is inaccurate.
- The two things that do move coverage are keeping the re-read channel honest (`read` with
  offset/limit, `bash` re-run — what `b742844` fixed) and changing the representation, which is
  what the dense image does.

## 0.13.4

The one competing design that runs at this plugin's layer is `billion-context`'s `absorb`: hand
a tool result to the model with rules saying what must survive verbatim, and let the summary it
writes replace the original. It can be put on this bench, so it was. No `lib/` change.

### Added

- **`absorb` / `absorb-digest` arms**: blind chunked summarisation (16 KB chunks, 900-token
  target) under the load-bearing half of `acp-kernel`'s tier-1 rules (MIT,
  `src/compression-rules.ts`), sent in place of the frame — no image, no excerpt, and for
  `absorb-digest` the whole-file counts added back. The summariser never sees the questions.
- **A channel comparison** in `bench/miss-audit.mjs`: carrying tokens per answer, amortised
  production cost, per-fixture wins, and the silent-miss profile per arm.

### Measured

- **The written summary loses on every axis at once.** Paired 3-repeat, 84 answers per arm:
  57/84 and 56/84 against the frame's 71/84 (nets −14 p=0.0066, −15 p=0.0007), carrying **more**
  tokens per later request (1250 / 1300 against 1097) and costing 3x. Amortise the summary's
  production to zero and it is still more expensive to carry ($0.000375 against $0.000329),
  because it is bigger than what it replaced.
- **It wins where the file is rule-generated and loses where the question names an instance.**
  `seq-3000` (the integers 1..3000): 15/15 against the frame's 14/15, for 230 tokens against 542.
  `id-grid` (1500 near-identical rows): 1/15 against 6/15. `test-log`: the summary found the
  generator — "durations step by 13 ms" — and then answered `13ms`/`143ms` where the truth was
  `52ms`/`156ms`. **It applies the rule instead of reading the row.**
- **The error channel multiplies rather than improving**: 27–28 misses against 13, with the same
  100% silence. This is the failure `billion-context` was itself bitten by, when a session stored
  a fabricated verbatim user quote as a live "CURRENT TASK" and the work relapsed into a loop.
- Not measured: task-aware compression. The arm summarises blind; their `compress` runs inside a
  live session and distils again in tiers. That difference is real and is stated as a limit.

### Unchanged

- `lib/` is untouched. The frame remains the shipped channel, with the written summary recorded
  as the complement it is: better exactly when the content is a rule rather than a record.

## 0.13.3

The re-read contract the plugin has always advertised — "re-read with offset/limit", with the
frame's gutter printing source line numbers — had never been tested, because the bench had no
read tool. It does now. No `lib/` change.

### Added

- **`read: true` arms** in `bench/fidelity-bench.mjs`: the model gets `read_result(offset, limit)`
  over the same source, and the run records how often it asks, which lines it asks for, how many
  rounds it takes, and the provider's own cache split for the repeats.
- **`bench/match.mjs`**: the right-or-wrong matcher, shared by the bench and the audit.
  `miss-audit.mjs` now **recomputes every verdict** from the stored answers instead of trusting
  the stored flag, and reports how many it corrected.
- **`bench/results.json`**: the raw rows of the last paid run, tracked. The call cache is
  gitignored and costs money to reproduce, so this is the only copy of the answers that survives
  a clone. A `--dump` pass no longer overwrites the results or the report (it used to wipe both).

### Measured

- **The reads work and nothing cheap makes the model take them.** Paired 3-repeat, 84 answers
  per arm against the frozen control (71/84): the same notice with a read available 66/84
  (asked on 8% of answers), plus one line naming the coordinates 69/84 (**asked on 29%**), plus
  the trust hint 66/84. Nets −5, −2, −5 (p=0.38, 0.79, 0.33) for 41–83% more tokens.
- **17 of 18 aimed reads were right**, across every fixture: the 7-digit id on the row whose
  user is u30 goes **0/3 frozen → 2/3** with the address line, the u17 qty 2/3 → 3/3, and the
  byte counts and timings are right whenever asked. The wall is breakable; the arm still loses,
  because the extra asking also puts reads in front of the counting questions, where a window of
  text is worse than the whole-file digest ("four rows with qty above 100": 1/3 frozen, **0/3
  while asking on all three**).
- **A re-read costs 2–9%, not 41–83%.** 75–85% of the prompt tokens in a read conversation come
  back as cache hits, so the re-sent image and excerpt are not paid for twice; the all-miss
  convention in the table is an upper bound.
- **The scorer had three silent escaping bugs** (a doubled backslash in three regex literals: the
  whitespace strip never fired, the number-prefix branch was dead, the 5xx retry never retried on
  a 5xx). Re-deciding all 336 stored answers of the 0.13.2 run changes **no verdict** — the model
  happened to answer `52ms` where the expectation was `52ms`. Fixed and extracted anyway.

### Unchanged

- `lib/` is untouched. Every rendering and notice decision measured above is the shipped one.

## 0.13.2

Two questions the scoreboard could not answer, both settled from the recorded run — no
model calls, no `lib/` change.

### Added

- **`bench/miss-audit.mjs`**: re-reads `.cache/last-results.json` and reports what the
  misses actually are, plus what the money actually buys. `--variant` audits one arm.
- The bench fixtures moved to **`bench/fixtures.mjs`** so the audit and the bench rebuild the
  same five sources from one place. The extraction is byte-identical: all five fixture
  hashes (name, line count, question count, sha256 of the text) match before and after.

### Measured

- **There is no ratio to trade.** The frame is a fixed ~434-token bill and the excerpt is
  capped at 24 lines, so the plugin's cost is `frame + 24 lines + the answer` whatever the
  file weighs, against every line as text: **15.5x cheaper per correct answer** overall, and
  between 6.0x (`seq-3000`, 3001 four-character lines) and 25.4x (`access-log`, 2000
  hundred-byte lines) by fixture. The compression ratio is a property of the input, not a
  dial — and every accuracy gain measured so far came from text, none from pixels.
- **The misses are a confabulation channel, not a noise channel.** Of 53 wrong answers in
  336, **52 are well-formed and plausible**: 47 are values that occur verbatim in the file
  asked about, 51 have the same digit width as the truth (`1001110` → `1001147`, `261` →
  `$268`, `221` → `234`, `29` → `42`). Exactly one refutes itself with a shape or range
  check. A lossy codec garbles and announces it; this channel substitutes a real value and
  leaves no signal — so `$/correct` prices a silent substitution the same as a caught error
  and a caller cannot.

### Unchanged

- `lib/` is untouched. The rendering path is byte-for-byte the 0.13.1 that the numbers above
  were measured on; `excerpt-blocks` stays in the bench as the record.

## 0.13.1

### Measured

- **Prefix totals in the notice are a wash and did not ship.** `excerpt-blocks` adds
  `lines 1-10:` / `lines 1-20:` token totals under the whole-file line: paired 6-repeat,
  142/168 against 141/168 (net +1, p=1.00) for +39 tokens. The mechanism is visible in the
  detail rather than the aggregate — "among cases 0 through 19, how many are PASS" goes
  0/6 → **6/6** because `lines 1-20: PASS×19 · FAIL×1` *is* the answer, while a cjk count
  goes 6/6 → 1/6 because the token `0` appears four times in the first ten lines (bracket,
  batch number, queue field) and the block line says `0×4` where the answer is `1`.
- **A token count is role-blind.** The whole-file line survives the same blindness because
  `0×86` cannot be mistaken for a range answer; a prefix count of 4 can. Digest numbers help
  when they *are* the answer and hurt when they are only plausible — the arm stays in the
  bench as the record.

## 0.13.0

The last coherent failure class was counting — how many FAILs, how many 503s, how many of
the first ten. A picture cannot count a 2000-line file and neither can an excerpt, but the
plugin holds the text, so it now counts it and says so.

### Added

- **`tokenDigest`** in `lib/excerpt.js`, wired into both notice paths: the notice now ends
  with `whole-file totals: PASS×1484 · FAIL×16 · …` — tokens of 16 characters or fewer
  appearing at least three times anywhere in the result, top eight by count. 50 tokens, no
  model involved.

### Measured

- **+13.1 points overall, and +42.6 points on structure questions** (paired 6-repeat, 168
  questions per arm: 119/168 → 141/168, net +22, 95% CI [+6.0, +20.2], p=0.0007) for +50
  tokens per call. The three whole-file count questions go 0/6 → 6/6 each; exact-value
  accuracy is unchanged within ±7 points (−1 of 114, p=1.00).
- A line-numbered excerpt (`excerpt-lines`, so ranges align with the image's ruler) measured
  neutral (+0 of 84, p=1.00) and did not ship. It stays as a bench arm.
- The bench's `access-log` fixture now writes four-digit byte counts, so a status code can
  never be counted twice by a token digest; the whole-file questions about 503s and 200s are
  therefore exact.

## 0.12.0

The residual exact-value class was attacked directly, with the six rendering fixes that
looked most plausible. None of them moved it. What does move it — the head/tail excerpt the
plugin already sends — had never been measured, and now is: **+21 points of value
accuracy**.

### Added

- **`id-grid` fixture** — 1500 near-identical `id=1000074 user=u2 qty=26 unit=$114` rows,
  so "find the row and read the value" is measurable separately from "read the picture".
  It is the hardest fixture in the bench, and it shows the class as a wall rather than a
  rate: 7-digit values 0/6, `seed=48213` 0/6, while literal-key questions are 5–6/6.
- **A digits-only atlas seam** (`setDigitAtlas`) and **row banding** (`rasterGrid`'s
  `rowPaper`), plus `--bold-range` in `tools/make-atlas.py` — off by default, tested, and
  the arms that used them are in the bench even though they were rejected.
- **`excerpt` / `excerpt-32` bench arms**: the bench can now measure the configuration the
  plugin actually sends (notice + excerpt + image) instead of only the image.

### Measured

- **Seven fixes for the residual class all landed inside the noise**: row shading (net
  −7/150), bolder digits (+3/150; value +5/114, p=0.36), a bigger digit box (16/25 vs
  16/25), whitespace digit grouping (15/25 vs 16/25), comma grouping (48/75 vs 52/75 — and
  it broke two questions the control answered 3/3), a 32-line excerpt head (+1/75), and a
  prompt line saying which channel to trust (+2/75, p=0.75).
- **The shipped excerpt is worth +21.1 points of value accuracy** (70% → 91%; net +12 of 57,
  95% CI [+9.4, +32.7], p=0.002) for 447 → 1000 measured tokens per answer — still 3.5x
  cheaper than the same content as text. It rescues exactly the questions the image fails:
  `seed=48213`, the `items/5` byte count, the `items/5` client IP, each 0/3 from the image
  and 3/3 with the excerpt.
- **A wider excerpt window is not worth its tokens**: a 32-line head buys +1 of 75 (p=1.00)
  for 13% more. `SNAP_HEAD_LINES` stays 16.

## 0.11.0

The other half of the font question was measured and answered: a **larger glyph box** does
not move accuracy either. No atlas ships — but the format and the tooling did change.

### Added

- **Atlases carry their own glyph box.** The shipped atlas is now an `FGATLAS1` atlas:
  width and height in the header, one bit row per pixel row, free of the old 8x13
  assumption. `lib/fonts/README.md` documents the format.
- **`tools/make-atlas.py` packs any box and reads any font FreeType can open** — TTF, OTF,
  and X.org PCF, which is how the shipped 8x13 face is reproduced for the first time
  (`--check-legacy` re-derives it glyph for glyph: 3385/3385 non-combining glyphs match;
  `--upgrade` migrates an old atlas without re-rendering). `--cell WxH`, `--cps-from`,
  `--show` to eyeball a glyph as ASCII art.
- **The layout follows the atlas**: `resolveShape` grows the cell to hold the declared box
  and re-derives the column count from the request pixel budget, so a swapped-in atlas can
  neither bleed into the next cell nor overflow the budget.
- **`bench/fidelity-bench.mjs --dump`** writes every variant's frame to `bench/.cache/dump`
  with its ink coverage, so a font question can be *looked at* before it is asked.
- `bench/atlas/xorg-8x16.bin`, `bench/atlas/xorg-9x15.bin` and three `glyph-*` variants.

### Measured

- **A larger glyph box at the same geometry is neutral.** `glyph-8x16` keeps the control's
  `1024x624`, 39 rows and 434-token bill, and lifts ink per printable glyph from 15.8 to
  24.6 (+56%). Screening: 17/20 against 14/20. Paired 3-repeat (n=60 each): **46/60 vs
  46/60**, value accuracy 34/45 vs 35/45.
- Re-asking the *same* variant three times scores **14, 15 and 17 out of 20** — the size of
  the screening lead, and of every lead a screening has produced on this axis.
- `9x15` (+18% ink, −7% capacity) screened 10/20, also inside that spread.

### Changed

- `lib/fonts/font8x13.bin` migrated to `FGATLAS1`. The glyphs are unchanged: the migration
  was verified by re-rendering a reference frame byte for byte against the previous build,
  and the regeneration is checked against the old file glyph for glyph.

## 0.10.0

Fonts were tried. The shipped glyphs did not change, because measuring said not to.

### Added

- **`tools/make-atlas.py`** — renders a TTF into the plugin's F8X13 bitmap atlas
  (`--show` dumps glyphs as ASCII art), so the font question is reproducible rather than
  folklore.
- **`setAsciiAtlas` / `parseAsciiAtlas`** — a seam to render ASCII from an alternative
  atlas; used by the bench, available to tests.
- Candidate atlases under `bench/atlas/` (DejaVu Sans Mono 11 regular and bold, JetBrains
  Mono 11) and three `font-*` bench variants.

### Measured

- **A different glyph design at the same 8x13 size is neutral.** Screening (n=20) put
  DejaVu Bold three answers ahead; the paired 3-repeat confirmation (n=60 each) came out
  **46/60 vs 46/60**. Value accuracy 76% vs 78%. The shipped X.org atlas stays.
- Why: at a fixed cell the design trades shape for ink, and the encoder reads pixels per
  glyph. The untested half of the idea — a *larger* glyph, e.g. 10x16 in a 10x18 cell —
  costs 29% of capacity for 44% more glyph pixels, and now takes one bench run to settle.

## 0.9.0

The request-image budget became a setting, because it turned out to be a knob worth
measuring rather than a constant to hard-code.

### Added

- **`imagePixelBudget` setting** (200000–4000000, default 640000) plus its control in the
  入境 tab. The canvas is planned to fit it, so it has to match `llm-deepseek`'s per-model
  `imagePixelBudget`; the plugin cannot read that value at runtime (`resolveModelInfo`
  returns input modalities only).

### Measured

- **Raising the budget does not pay.** 1.3M px answered 14/20 for twice the money of
  640k's 14/20; 2.1M px collapsed to 6/20 as the provider projected the frame onto its own
  vision grid. Keep the default.
- The setting still matters in the other direction: a deployment on `"low"` (262144 px)
  would have every 640k frame resized — the failure mode measured at 1–2/10.

### Clarified

- **Resolution, not canvas size, is what the accuracy hangs on.** Isolating it: identical
  content at half the linear resolution scored 9/20 against the control's 14/20; downscaled
  0.5 and upscaled back to the *same dimensions and the same token bill* still scored 12/20;
  the same rows on a 2048px canvas (which the pipeline then resized) scored 4/20. Extra
  pixels above the legibility threshold buy capacity, not accuracy.

### Changed

- The budget travels with the shape, so `resolveShape`, `estImageTokens`, `previewSize`
  and `maxRows` all agree on the same number: canvas, estimate, economy gate and notice
  can no longer disagree about what the provider will receive.

## 0.8.0

An exploration loop around the layout, and the measured answer to "can we do better?".

### Added

- **`bench/FINDINGS.md`** — method, noise floor and verdicts for every axis tried.
- **`--repeats N`** in the fidelity bench: the endpoint is stochastic, so one sample per
  question cannot resolve an effect below ~15%; paired repeats can.
- **`encodePngPalette`** (colour-type-3 PNG, same byte-per-pixel payload as the gray
  encoder) plus per-cell and per-digit ink options on `rasterGrid`. The colour channel is
  wired and tested; it is simply not enabled, because it measured as no gain.
- A degenerate-frame guard in the bench: a frame that lost its ink now fails loudly
  instead of being scored as a fidelity failure.

### Changed

- **The source-line ruler now prints on every grid row** (`gutterEvery: 1`). It cost
  nothing in tokens or capacity and lifted exact-value accuracy from 73% to 87% in the
  round that introduced it — consistent with the dominant error class, reading the wrong
  line.

### Measured, not shipped

- **Colour**: blue rules, blue digits, red alert lines, in four palettes. Paired
  3-repeat run over 60 samples: grayscale 46/60, colour 44/60, value accuracy identical.
  Rejected — no gain, added provider risk.
- **Prompt legend**, **roomier cells**, **single column as default**: each measured, none
  earned its cost.
- **Residual ceiling**: ~76% of exact-value questions are answered correctly even in the
  best configuration. The image is an index, not a notary; exact bytes stay in the text
  excerpt, the fold card and the re-read path.

## 0.7.0

Priced against the model that actually reads the frames (deepseek-flash), and measured.

### Added

- **`lib/pricing.js`** — the published DeepSeek table (peak/off-peak cache-hit, cache-miss and output rates for `deepseek-flash` and `deepseek-v4-pro`), plus `requestPreviewSize`, which reproduces the request pipeline's resize onto the model's image pixel budget (640000 px).
- **`bench/fidelity-bench.mjs`** — fixtures × layout variants × checkable questions against the live endpoint. It measures two things instead of assuming either: correctness from the picture, and the provider's own `usage.prompt_tokens` priced with the table. Every call is cached by content hash.
- **Measured DeepSeek v4 image accounting** (`deepseekImageTokens`): `≈ clamp(70 + 5.7e-4·px, 213, 1043)` on the resized dimensions. The published "one image caps at 384 tokens" calculator does not match live usage.
- `bench/report.md`, the raw result of a full matrix run.

### Changed

- **DeepSeek routes now draw inside the request pixel budget**: `8on16-budget 1024x624` (39 rows) instead of a 1024x2048 canvas that the pipeline resized to 566x1131. The resample, not the layout, was destroying legibility — the same content scored 1–2/10 answers when resized against 8/10 drawn natively, at the same ~430-token bill.
- **Image token estimates for DeepSeek are taken on the preview size**, so a full frame estimates 434 instead of 1445. The excerpt notice reports the preview when (and only when) the pipeline will resize.
- The layout bench now runs against `deepseek-flash` and reports money per frame next to the raw-text price.

## 0.6.0

Dense-image layout: the PNG now fills the tile bands it pays for.

### Added

- **`lib/layout.js`** — pure grid planner for the ingress image: column packing, in-cell wrapping, the source-line ruler, and an occupancy measure that charges gutters and gaps to the layout that asks for them.
- **Line ruler** in the raster: from 50 source lines up, the left gutter prints the source line number every 5 grid rows. An image stays addressable — a model that spots a bad row can `offset/limit` back to exact bytes instead of treating the picture as a dead end.
- **Layered ink** in the raster: body `16`, column rules `205`, ruler `150` on paper `245`. Hierarchy that costs no image tokens, only pixels that are already paid for.
- **`bench/layout-bench.mjs`** — per-fixture layout economics (text tokens, image tokens, lines carried, occupancy). Pure arithmetic, no model calls.
- Layout tests: tile-band cap, column packing, wrap guard, wrapped outliers, ruler ink levels, and the economy gate.

### Changed

- **The canvas cap is tile-aligned.** openai-family frames are `1024×2048` instead of `1024×1540`; at 1540 the last 512px band bought four usable pixels. Same bill (1445 tokens), 93 text rows instead of 70.
- **Short lines pack into columns.** The planner tries 1–24 columns and keeps the highest occupancy, rejecting any candidate that would wrap more than 2% of its cells. On a 3000-line numeric dump the same 1445 tokens now carry 1860 source lines instead of 93; a two-column layout doubles what a 60-character log fits.
- **The image must beat the text it renders** (`IMAGE_ECONOMY = 0.85`). If the drawn text would have been cheaper as text, ingress falls back to the excerpt — the case where a nearly blank PNG was attached for very short lines is now refused.
- The excerpt notice names the layout (`… PNG ~1445 tokens · 20 cols · line ruler`), so the model knows how the page is arranged.

### Fixed

- `wrapCell` no longer grows an empty trailing row when a line ends exactly on a cell edge.

## 0.5.0

### Added

- **Tabbed settings page** (入境 / 折页 / 诊断) with per-row icons, a denser 12.5 px layout, and a live fold-card preview in the 折页 tab.
- **诊断 tab backed by a new `getHealth()` host RPC**: plugin version, the session-event accessor this DSH actually exposes (`eventAt` or the legacy `events`), ingress counters (shaped / snapped / saved / failures plus the last error), and compaction-engine hook wiring.
- `VERSION` in `lib/config.js`, guarded by a test that compares it with `package.json`.

### Changed

- `settingsSchema.toJSON()` now emits the **canonical Schemastery `{uid, refs}` envelope** instead of a flat `{type, meta, dict}` document. Nested nodes keep their methods (`simplify`, …) after rehydration; a test compares the envelope field-by-field against a reference schema built with the real library when one is resolvable.
- The health snapshot records the session-event accessor observed at runtime, so a DSH upgrade that renames it again shows up in the UI instead of failing silently.

## 0.4.0

Compatibility and hardening release. Verified against the DSH 0.1.5-rc.1 API and the 0.1.1-rc.2 shapes it replaced.

### Fixed

- **Ingress shaping never ran on DSH 0.1.5-rc.1.** The public `session.events` accessor became `session.eventAt(seq)`, so every pre-step pass threw before appending anything, and `inventory()` broke `/fast-compact status` plus the input-bar pressure meter. Session events are now read through one version-tolerant helper.
- **The positional replace keys were renamed** (`start`/`end` → `startSeq`/`endSeq`). The rewrite emits the current names and retries the older ones once, remembering the shape for the process.

### Changed

- Ingress touches **only the immediately preceding step** of the current turn. That result's first request is the one being prepared, so a rewrite cannot invalidate a provider-cached prefix even when an earlier pass was skipped or failed.
- Rejected appends are counted and surfaced instead of swallowed: `/fast-compact status` prints `ingress FAILING (n): <message>`, and the first occurrence of each distinct message is logged once.
- Fold cards **carry earlier generations forward**: files, intents and errors recovered from a previous `[Snapcompact]` card are merged into the new one instead of being dropped.
- Engines without a `summarize` method are named in `/fast-compact status` — with replace-default on they would otherwise fall back to a model call silently.
- The retired `ingress: false` sidecar only decides while `enabled` was never written, so the settings switch can turn ingress back on.
- Client: the pressure poll reschedules itself, backs off to 30 s on failure, skips hidden tabs, and tints the bolt when the meter is unavailable. The settings-nav icon observer coalesces mutations into one frame and only runs while a settings dialog is open.
- `replaceToolResultContent` no longer deep-clones the whole tool message.

### Tests

32 tests via `node --test lib/ledger.test.js`, including a real `dsh-session` end-to-end rewrite when `DSH_SESSION_MODULE` points at the installed package.
