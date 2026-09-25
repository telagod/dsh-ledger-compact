import test from "node:test";
import assert from "node:assert/strict";
import { estTokensUtf8, clampUtf8, compactableTokens, iconFill, FILL_SOFT_TOKENS } from "./tokens.js";
import { resolveVisionRoute } from "./vision.js";
import { excerptNotice, isPlaceholder, isPersistReadback, isRereadableTool, isSkillLoad, persistIngressText, persistRetentionLabel, snapExcerpt, collectText, tokenDigest, toolSourceLabel, PERSIST_DIR_DEFAULT, PERSIST_TTL_MS, readPersistText, skipIngressTool } from "./excerpt.js";
import { retrieveToolDefinition } from "./retrieve-tool.js";
import { shapeIngress, shapeCurrentTurnIngress, resetReplaceOpShape, usesLegacyReplaceKeys } from "./ingress.js";
import { buildFold, foldSummary, foldReport, inspectMessages, carriedFromFold, formatFoldNotice, formatTokenCount, collectSummaryText, parseFoldNotice, FOLD_CARD_MARKER } from "./fold.js";
import { apply, parseCommand } from "./index.js";
import { hookMechanicalSummarizer, hookStats, withMechanicalFold, isMechanicalAgent, setReplaceDefault } from "./hook.js";
import { resolveCompactionEngine, collectCompactionEngines } from "./resolve.js";
import { raster, rasterGrid, resolveShape, lookup8, estImageTokens, familyOf, deepseekImageTokens, previewSize, REQUEST_PIXEL_BUDGET, parseAsciiAtlas, setAsciiAtlas, setDigitAtlas } from "./snapfont.js";
import { planGrid, buildGrid, cellLength, wrapCell } from "./layout.js";
import { usdFor, formatUsd, priceFor, requestPreviewSize } from "./pricing.js";
import { encodePngGray, encodePngPalette } from "./png.js";
import { settingsSchema, FIELDS, VERSION } from "./config.js";
import { buildObjectEnvelope, flattenObjectEnvelope } from "./schema-envelope.js";
import { sessionEvent } from "./ctx.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function user(text) {
  return { role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}
function assistant(blocks) {
  return { role: "assistant", content: blocks, source: { kind: "model", provider: "x", model: "y" } };
}
function toolCall(id, name, args) {
  return { type: "tool-call", id, name, arguments: JSON.stringify(args) };
}
function toolResult(id, text, isError) {
  return {
    role: "user",
    source: { kind: "tool", callId: id },
    content: [{ type: "tool-result", toolCallId: id, isError: isError === true, content: [{ type: "text", text }] }]
  };
}

test("estTokensUtf8 counts ascii cheaper than wide glyphs", () => {
  assert.ok(estTokensUtf8("abcd") <= 1);
  assert.ok(estTokensUtf8("你好世界") >= 4);
});

test("compactableTokens drops the newest node", () => {
  assert.equal(compactableTokens({ nodes: [] }), 0);
  assert.equal(compactableTokens({ nodes: [{ tokens: 90 }] }), 0);
  assert.equal(compactableTokens({ nodes: [{ tokens: 40 }, { heuristicTokens: 10 }, { tokens: 999 }] }), 50);
});

test("iconFill prefers context pressure then foldable mass", () => {
  assert.equal(iconFill(0, 0, 0), 0);
  assert.equal(iconFill(40, 100, 9999), 0.4);
  assert.equal(iconFill(0, 0, FILL_SOFT_TOKENS), 1);
  assert.ok(iconFill(0, 0, FILL_SOFT_TOKENS / 2) > 0.49);
  assert.ok(iconFill(0, 0, FILL_SOFT_TOKENS / 2) < 0.51);
});

test("clampUtf8 does not split a multibyte char", () => {
  const s = clampUtf8("你好", 2);
  assert.equal(Buffer.from(s, "utf8").length <= 2, true);
});

test("ingress vision requires snapImages and explicit image modality", () => {
  assert.equal(resolveVisionRoute({
    mainModel: "grok-4.6",
    snapImages: true
  }).ingressVision, false);
  assert.equal(resolveVisionRoute({
    mainModel: "claude-sonnet-4",
    inputModalities: ["text"],
    snapImages: true
  }).ingressVision, false);
  assert.equal(resolveVisionRoute({
    mainModel: "custom-model",
    inputModalities: ["text", "image"],
    snapImages: false
  }).ingressVision, false);
  assert.equal(resolveVisionRoute({
    mainModel: "custom-model",
    inputModalities: ["text", "image"],
    snapImages: true
  }).ingressVision, true);
});

test("settings keep an explicit enabled key and only honour legacy ingress without one", () => {
  // A stored `enabled` always wins, so the UI switch can turn ingress back on.
  assert.equal(settingsSchema({ enabled: true, ingress: false }).enabled, true);
  // The retired sidecar key still decides for documents that never wrote `enabled`.
  assert.equal(settingsSchema({ ingress: false }).enabled, false);
  assert.equal(settingsSchema({ enabled: false, ingress: true }).enabled, false);
  const collapsed = settingsSchema({ enabled: true, visionModel: "gpt-4o" });
  assert.equal(collapsed.snapImages, false);
  assert.equal(collapsed.confirmFold, true);
  assert.equal(collapsed.replaceDefault, false);
  assert.equal("visionModel" in collapsed, false);
  assert.equal(settingsSchema({ snapImages: true }).snapImages, true);
  assert.equal(settingsSchema({ confirmFold: false }).confirmFold, false);
  assert.equal(settingsSchema({ replaceDefault: true }).replaceDefault, true);
  assert.equal(settingsSchema({ minSnapTokens: 10 }).minSnapTokens, 200);
  const fields = flattenObjectEnvelope(settingsSchema.toJSON());
  assert.equal(fields.enabled.type, "boolean");
  assert.equal(fields.confirmFold.meta.default, true);
  assert.equal(fields.replaceDefault.meta.default, false);
});

test("snapExcerpt keeps head and tail and names the re-read contract", () => {
  const lines = Array.from({ length: 40 }, (_, i) => "L" + i);
  const out = snapExcerpt(lines.join("\n"));
  assert.ok(out.includes("L0"));
  assert.ok(out.includes("L39"));
  assert.equal(out.includes("L20"), false);
  assert.ok(out.includes("re-read with offset/limit"));
});

test("the re-read promise is only made where it can be kept", () => {
  const lines = Array.from({ length: 60 }, (_, i) => "L" + i).join("\n");
  const readable = snapExcerpt(lines, { rereadable: true });
  const notReadable = snapExcerpt(lines, { rereadable: false });
  assert.ok(readable.includes("re-read with offset/limit"));
  assert.equal(notReadable.includes("offset/limit"), false);
  assert.ok(notReadable.includes("cannot be re-read"));
  // 默认保持旧措辞，别的调用点不受影响
  assert.ok(snapExcerpt(lines).includes("re-read with offset/limit"));
});

test("a long-line result keeps the notice that says it was cut", () => {
  // 165 字符/行时，头 16 行就超过 2400 字节上限：窗口先定尺寸的话，从尾部截断会把注记
  // 连同尾部一起切掉，模型拿到的是一段"看起来完整"的开头。
  const lines = Array.from({ length: 200 }, (_, i) => "line-" + i + " " + "abcd".repeat(40));
  const out = snapExcerpt(lines.join("\n"));
  assert.ok(out.includes("lines elided"), "注记必须在场");
  assert.ok(Buffer.byteLength(out, "utf8") <= 2400);
  assert.ok(out.startsWith("line-0 "), "头部仍在");
  assert.ok(out.includes("line-19"), "尾部仍在");
});

test("isRereadableTool only trusts a file read", () => {
  assert.equal(isRereadableTool("read"), true);
  assert.equal(isRereadableTool("READ"), true);
  assert.equal(isRereadableTool("run_code"), false);
  assert.equal(isRereadableTool("bash"), false);
  assert.equal(isRereadableTool("web_fetch"), false);
  assert.equal(isRereadableTool(undefined), false);
});

test("shapeIngress stops promising a re-read for command output", () => {
  // 行要短到让摘录落在 2400 字节上限内：更长的行会把省略注记整个挤掉（那是另一个问题）。
  const text = Array.from({ length: 200 }, (_, i) => "line-" + i + " " + "ab".repeat(10)).join("\n");
  const viaRead = shapeIngress(text, { vision: false, minSnapTokens: 100, toolName: "read" });
  const viaRun = shapeIngress(text, { vision: false, minSnapTokens: 100, toolName: "run_code" });
  assert.ok(viaRead.text.includes("re-read with offset/limit"));
  assert.equal(viaRun.text.includes("offset/limit"), false);
  assert.ok(viaRun.text.includes("cannot be re-read"));
});

test("shapeIngress leaves small blobs and placeholders alone", () => {
  assert.equal(shapeIngress("short").changed, false);
  assert.equal(shapeIngress("[Snapcompact: 9 tokens → excerpt]\nalready").changed, false);
  assert.equal(shapeIngress("x".repeat(20000), { toolName: "skill" }).changed, false);
});

test("shapeIngress excerpts large text without vision and never attaches an image", () => {
  const text = Array.from({ length: 200 }, (_, i) => "line-" + i + " " + "abcd".repeat(40)).join("\n");
  const shaped = shapeIngress(text, { vision: false, minSnapTokens: 100 });
  assert.equal(shaped.changed, true);
  assert.equal(shaped.snapped, false);
  assert.equal(shaped.excerpted, true);
  assert.ok(shaped.tokensSaved > 0);
  assert.equal(shaped.image, undefined);
  assert.ok(shaped.text.startsWith("[Snapcompact:"));
});

test("tokenDigest counts repeated values and ignores singletons", () => {
  const text = [
    "PASS case-0 dur=0ms",
    "FAIL case-1 dur=13ms",
    "PASS case-2 dur=26ms",
    "PASS case-3 dur=39ms",
    "a-very-long-token-that-is-structure-not-a-value PASS"
  ].join("\n");
  assert.equal(tokenDigest(text), "whole-file totals: PASS×4", "FAIL appears once, so it is not a total");
  assert.equal(tokenDigest("alpha beta gamma"), "", "no repeats, no line");
  // Whole-line junk never makes the cut, and the top list is capped.
  const many = Array.from({ length: 40 }, (_, i) => "t" + i + " " + "t" + i + " " + "t" + i).join("\n");
  assert.equal(tokenDigest(many).split("·").length, 8);
});

test("the notice carries the digest, and shapeIngress passes the whole text to it", () => {
  const notice = excerptNotice(100, "head", "1024x624 PNG", "whole-file totals: PASS×4");
  assert.ok(notice.endsWith("\nwhole-file totals: PASS×4"));
  assert.equal(excerptNotice(100, "head", "1024x624 PNG"), "[Snapcompact: 100 tokens → 1024x624 PNG]\nhead");
  const text = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? "FAIL" : "PASS") + " case-" + i + " " + "x".repeat(60)).join("\n");
  const shaped = shapeIngress(text, { vision: false, minSnapTokens: 100 });
  assert.equal(shaped.snapped, false);
  assert.ok(shaped.text.includes("whole-file totals: PASS×355 · FAIL×45"), shaped.text.slice(-120));
});

test("shapeIngress with vision still falls back when the image is not cheaper", () => {
  const text = Array.from({ length: 80 }, (_, i) => "n" + i).join("\n");
  const shaped = shapeIngress(text, { vision: true, model: "claude-sonnet-4", minSnapTokens: 10, savingsRatio: 0.01 });
  assert.equal(shaped.snapped, false);
});

test("shapeCurrentTurnIngress does not rewrite without a token meter", async () => {
  const session = { surface: { nodes: [1] }, events: { 1: { type: "tool/result" } }, append() { throw new Error("must not append"); } };
  const report = await shapeCurrentTurnIngress(session, { get() { return undefined; } }, { turn: 1, step: 2 });
  assert.equal(report.shaped, 0);
});

test("fold card keeps files/intents and drops prior checkpoints", () => {
  const ledger = buildFold([
    user("This is an automatically generated checkpoint\n\n<compacted-summary>\nOld atlas\n</compacted-summary>"),
    user("Keep going with the plugin"),
    assistant([
      { type: "text", text: "I will inspect the repo." },
      toolCall("c1", "read", { file_path: "lib/index.js" }),
      toolCall("c2", "bash", { command: "ls -la" })
    ]),
    toolResult("c1", "     1| export function apply() {}"),
    toolResult("c2", "file-a\nfile-b\n[exit code: 0]")
  ]);
  assert.ok(ledger.includes("[Snapcompact]"));
  assert.ok(ledger.includes("Keep going with the plugin"));
  assert.equal(ledger.includes("Old atlas"), false);
  assert.ok(ledger.includes("lib/index.js"));
  assert.ok(ledger.includes("ls -la"));
  assert.equal(ledger.includes("export function apply()"), false);
});

test("inspectMessages records grep/glob paths and failed commands", () => {
  const snapshot = inspectMessages([
    user("fix it"),
    assistant([
      toolCall("c3", "edit", { file_path: "lib/index.js" }),
      toolCall("c4", "grep", { path: "lib", pattern: "apply" }),
      toolCall("c5", "glob", { pattern: "lib/*.js" })
    ]),
    toolResult("c3", "SyntaxError: unexpected token\n[exit code: 1]", true),
    toolResult("c4", "lib/index.js:1"),
    toolResult("c5", "lib/index.js\nlib/fold.js")
  ]);
  assert.equal(snapshot.edits.includes("lib/index.js"), true);
  assert.equal(snapshot.reads.includes("lib"), true);
  assert.equal(snapshot.reads.includes("lib/*.js"), true);
  assert.equal(snapshot.errors.length, 1);
  assert.deepEqual(snapshot.tools.map((item) => item.name).sort(), ["edit", "glob", "grep"]);
});

test("formatFoldNotice embeds a structured card instead of the raw excerpt", () => {
  assert.equal(formatTokenCount(68055), "68,055");
  assert.equal(collectSummaryText([{ type: "text", text: "alpha" }, { type: "image" }]), "alpha");
  const text = formatFoldNotice({
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 68055,
    summary: [{ type: "text", text: "[Snapcompact] Fold ~68055 tok.\nFILES\n- [edit] lib/index.js\nINTENTS\n- keep going\nTOOLS\n- read 4\nEXCERPT\n[user] dumped" }]
  });
  assert.equal(text.startsWith("已折页 3 条历史（约 68,055 tokens）"), true);
  assert.ok(text.includes(FOLD_CARD_MARKER));
  assert.equal(text.includes("\nEXCERPT\n"), false);
  const parsed = parseFoldNotice(text);
  assert.deepEqual(parsed.card.edits, ["lib/index.js"]);
  assert.deepEqual(parsed.card.intents, ["keep going"]);
  assert.deepEqual(parsed.card.tools, [{ name: "read", n: 4 }]);
  assert.deepEqual(parsed.card.excerpt, ["[user] dumped"]);
  assert.equal(parsed.card.items, 3);
  assert.equal(parsed.card.tokens, 68055);
});

test("foldSummary is unmarked local output", () => {
  const result = foldSummary({ messages: [user("Ship it")] });
  assert.equal(result.provider, "dsh-ledger-compact");
  assert.equal(result.llmStreamCall, undefined);
  assert.ok(result.summary[0].text.includes("Ship it"));
});

test("toolSourceLabel names the call and the argument that locates it", () => {
  assert.equal(toolSourceLabel("read", { file_path: "src/a.ts" }), "read src/a.ts");
  assert.equal(toolSourceLabel("bash", { command: "ls -la\n  extra" }), "bash ls -la extra");
  assert.equal(toolSourceLabel("grep", { pattern: "needle", path: "src" }), "grep src");
  assert.equal(toolSourceLabel("read", undefined), "read");
  assert.equal(toolSourceLabel("", { path: "src" }), "src");
  assert.equal(toolSourceLabel("read", { unrelated: 1 }), "read");
  // The weakest locator, and the only one a wrapper tool can offer.
  assert.equal(toolSourceLabel("run_code", { description: "Read failing test" }), "run_code Read failing test");
  assert.equal(toolSourceLabel("run_code", { code: "x".repeat(500) }), "run_code");
});

test("toolSourceLabel flattens and bounds an overlong argument", () => {
  const label = toolSourceLabel("read", { file_path: "x".repeat(200) });
  assert.ok(label.startsWith("read "));
  assert.ok(label.length <= 65);
  assert.ok(label.endsWith("…"));
});

test("excerptNotice carries a source label and is unchanged without one", () => {
  assert.equal(excerptNotice(9000, "body", "", "").split("\n")[0], "[Snapcompact: 9000 tokens → excerpt]");
  assert.equal(
    excerptNotice(9000, "body", "", "", "read src/a.ts").split("\n")[0],
    "[Snapcompact: 9000 tokens → excerpt · read src/a.ts]"
  );
  assert.equal(
    excerptNotice(9000, "body", "1024x624 PNG ~540 tokens", "", "read src/a.ts").split("\n")[0],
    "[Snapcompact: 9000 tokens → 1024x624 PNG ~540 tokens · read src/a.ts]"
  );
});

test("shapeIngress puts the source label on the excerpt it emits", () => {
  const text = Array.from({ length: 200 }, (_, i) => "line-" + i + " " + "abcd".repeat(40)).join("\n");
  const shaped = shapeIngress(text, { vision: false, minSnapTokens: 100, source: "read src/a.ts" });
  assert.equal(shaped.changed, true);
  assert.ok(shaped.text.split("\n")[0].includes("· read src/a.ts"));
  assert.ok(shaped.tokensSaved > 0);
});

test("foldSummary reports the fold through rawOutput without claiming an LLM call", () => {
  const result = foldSummary({
    messages: [user("Ship it"), assistant([toolCall("c1", "read", { file_path: "src/a.ts" })]), toolResult("c1", "body")]
  });
  assert.equal(result.llmStreamCall, undefined);
  assert.equal(Array.isArray(result.rawOutput), true);
  assert.equal(result.rawOutput.length, 2);
  assert.ok(result.rawOutput[0].text.startsWith("dsh-ledger-compact fold"));
  const payload = JSON.parse(result.rawOutput[1].text);
  assert.equal(payload.spanMessages, 3);
  assert.equal(payload.reads, 1);
  assert.deepEqual(payload.tools, [{ name: "read", n: 1 }]);
  assert.ok(payload.discardedTokens > 0);
  assert.ok(payload.cardLines > 0);
});

test("foldReport is exported and honours an explicit token count", () => {
  const report = foldReport([user("goal"), toolResult("c9", "body")], "card", { discardedTokens: 12 });
  assert.equal(JSON.parse(report[1].text).discardedTokens, 12);
});

test("foldSummary can skip the report when only the summary is wanted", () => {
  const result = foldSummary({ messages: [user("Ship it")] }, { report: false });
  assert.equal(result.rawOutput, undefined);
});

test("apply keeps shaping when the settings layer cannot be registered", async () => {
  const warnings = [];
  let service;
  const ctx = {
    settings: {
      register() {
        throw new Error("namespace dsh-ledger-compact is already registered");
      }
    },
    provide: (name, value) => { service = value; },
    typert: { register: () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    effect: (fn) => { const dispose = fn(); return () => (typeof dispose === "function" ? dispose() : undefined); },
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
    get: () => undefined
  };
  await apply(ctx);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("settings layer unavailable"));
  const health = service.getHealth();
  assert.equal(health.settings.ok, false);
  assert.ok(health.settings.error.includes("already registered"));
  // Defaults still drive shaping, and a save reports the degradation instead of throwing.
  assert.equal(health.config.enabled, true);
  assert.equal(health.config.replaceDefault, false);
  await assert.rejects(() => service.saveConfig({ enabled: false }), /settings layer unavailable/);
});

test("parseCommand accepts status and rejects vision sidecar routing", () => {
  assert.deepEqual(parseCommand(""), { op: "fold" });
  assert.deepEqual(parseCommand("status"), { op: "status" });
  assert.equal(parseCommand("vision off").op, "error");
  assert.equal(parseCommand("vision openai gpt-4o").op, "error");
});

test("mechanical hook only intercepts the marked agent", async () => {
  let originalCalled = 0;
  const engine = {
    summarize: async () => {
      originalCalled += 1;
      return { summary: [{ type: "text", text: "llm" }], provider: "llm", model: "big" };
    }
  };
  const marked = { id: "fold" };
  const other = { id: "compact" };
  hookMechanicalSummarizer(engine);
  const llm = await engine.summarize({ messages: [user("Keep LLM")] }, other);
  assert.equal(llm.provider, "llm");
  const local = await withMechanicalFold(engine, marked, () => engine.summarize({ messages: [user("Ship the plugin")] }, marked));
  assert.equal(originalCalled, 1);
  assert.equal(local.provider, "dsh-ledger-compact");
  assert.equal(local.model, "local-ledger");
  assert.ok(local.summary[0].text.includes("Ship the plugin"));
  assert.equal(isMechanicalAgent(marked), false);
  const after = await engine.summarize({ messages: [user("Keep LLM")] }, marked);
  assert.equal(after.provider, "llm");
  assert.equal(originalCalled, 2);
});

test("replaceDefault intercepts unmarked agents and stays live", async () => {
  let originalCalled = 0;
  let replace = false;
  setReplaceDefault(() => replace);
  try {
    const engine = {
      summarize: async () => {
        originalCalled += 1;
        return { summary: [{ type: "text", text: "llm" }], provider: "llm", model: "big" };
      }
    };
    const agent = { id: "auto" };
    hookMechanicalSummarizer(engine);
    const before = await engine.summarize({ messages: [user("Keep LLM")] }, agent);
    assert.equal(before.provider, "llm");
    replace = true;
    const local = await engine.summarize({ messages: [user("Ship the plugin")] }, agent);
    assert.equal(originalCalled, 1);
    assert.equal(local.provider, "dsh-ledger-compact");
    replace = false;
    const after = await engine.summarize({ messages: [user("Keep LLM")] }, agent);
    assert.equal(after.provider, "llm");
    assert.equal(originalCalled, 2);
  } finally {
    setReplaceDefault(() => false);
  }
});

test("snapfont loads 8x13 and rasters ascii", () => {
  assert.ok(lookup8(65));
  const frame = raster("ABC", resolveShape("gpt-4o"), 4);
  assert.ok(frame);
  assert.ok(frame.w > 0 && frame.h > 0);
  const png = encodePngGray(frame.pixels, frame.w, frame.h);
  assert.equal(png[0], 137);
  assert.ok(png.length > 32);
});

test("collectText walks nested tool-result blocks", () => {
  assert.equal(collectText([{ type: "tool-result", content: [{ type: "text", text: "hi" }] }]), "hi");
});

test("resolveCompactionEngine uses agentPresets.serviceFor for isolated engines", () => {
  const engineA = { compactNow() {} };
  const engineB = { compactNow() {} };
  const store = {};
  store[Symbol("a")] = { name: "compaction", value: engineA, fiber: { state: 2 } };
  store[Symbol("b")] = { name: "compaction", value: engineB, fiber: { state: 2 } };
  const agent = { ctx: { get() { return undefined; }, reflect: { store } } };
  const ctx = {
    get(name) {
      if (name === "agentPresets") {
        return { serviceFor(target, service) {
          assert.equal(target, agent);
          assert.equal(service, "compaction");
          return engineB;
        } };
      }
      return undefined;
    },
    reflect: { store }
  };
  assert.equal(resolveCompactionEngine(ctx, agent), engineB);
});

test("resolveCompactionEngine uses the only active isolated engine", () => {
  const engine = { compactNow() {} };
  const store = {};
  store[Symbol("c")] = { name: "compaction", value: engine, fiber: { state: 2 } };
  const ctx = { get() { return undefined; }, reflect: { store } };
  assert.equal(resolveCompactionEngine(ctx, { ctx: { get() { return undefined; } } }), engine);
});

test("collectCompactionEngines returns every active engine", () => {
  const engineA = { compactNow() {} };
  const engineB = { compactNow() {} };
  const store = {};
  store[Symbol("a")] = { name: "compaction", value: engineA, fiber: { state: 2 } };
  store[Symbol("b")] = { name: "compaction", value: engineB, fiber: { state: 2 } };
  const ctx = { get() { return undefined; }, reflect: { store } };
  const found = collectCompactionEngines(ctx);
  assert.equal(found.length, 2);
  assert.ok(found.includes(engineA));
  assert.ok(found.includes(engineB));
});

test("resolveCompactionEngine does not guess among multiple isolated engines", () => {
  const store = {};
  store[Symbol("a")] = { name: "compaction", value: { compactNow() {} }, fiber: { state: 2 } };
  store[Symbol("b")] = { name: "compaction", value: { compactNow() {} }, fiber: { state: 2 } };
  const ctx = { get() { return undefined; }, reflect: { store } };
  assert.equal(resolveCompactionEngine(ctx, { ctx: { get() { return undefined; } } }), undefined);
});

test("isPlaceholder covers snapcompact and prune markers", () => {
  assert.equal(isPlaceholder("[Snapcompact: 3000 tokens → excerpt]"), true);
  assert.equal(isPlaceholder("[... tool result middle pruned ...]"), true);
  assert.equal(isPlaceholder("real tool output"), false);
});

/** The message-producing types a DSH surface folds. A `tool/call` is log-only. */
const SURFACE_EVENT_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

/** Minimal stand-in for the DSH 0.1.5 Session surface API. */
function fakeSession(events, options = {}) {
  const log = events.map((event) => ({ ...event }));
  // The real surface folds message-producing events only: a `tool/call` stays in the log
  // and never becomes a node, which is exactly what a tool-name lookup has to survive.
  const nodes = events.filter((event) => SURFACE_EVENT_TYPES.has(event.type)).map((event) => event.seq);
  const surface = { nodes };
  return {
    surface,
    log,
    get seq() {
      return log.length;
    },
    snapshotEvents(from = 0, to = log.length) {
      return log.slice(from, to);
    },
    eventAt(seq) {
      return log.find((event) => event.seq === seq);
    },
    append(type, data, opts) {
      const op = opts?.surfaceOp;
      if (op !== undefined && op !== "append") {
        const modern = op && typeof op === "object" && "startSeq" in op && "endSeq" in op;
        const legacy = op && typeof op === "object" && "start" in op && "end" in op;
        const accepted = options.legacyKeys ? legacy : modern;
        if (!accepted || op.op !== "replace") {
          throw new Error('session event "' + type + '" carries an invalid replace surfaceOp');
        }
      }
      const event = { type, seq: log.length, data, ...(opts ?? {}) };
      log.push(event);
      if (op === "append") nodes.push(event.seq);
      else if (op && typeof op === "object") {
        const start = op.startSeq ?? op.start;
        const end = op.endSeq ?? op.end;
        nodes.splice(nodes.indexOf(start), nodes.indexOf(end) - nodes.indexOf(start) + 1, event.seq);
      }
      return event;
    }
  };
}

function textOfEvent(event) {
  return collectText(event?.data?.message?.content);
}

const BIG_TEXT = Array.from({ length: 200 }, (_, i) => "line-" + i + " " + "abcd".repeat(40)).join("\n");

test("sessionEvent prefers eventAt and falls back to the legacy events array", () => {
  const event = { seq: 7, type: "tool/result" };
  assert.equal(sessionEvent({ eventAt: (seq) => (seq === 7 ? event : undefined) }, 7)?.seq, 7);
  assert.equal(sessionEvent({ events: [0, 1, 2, 3, 4, 5, 6, event] }, 7)?.seq, 7);
  assert.equal(sessionEvent({ events: { 7: event } }, 7)?.seq, 7);
  assert.equal(sessionEvent(null, 7), undefined);
  assert.equal(sessionEvent({ events: undefined }, 7), undefined);
});

test("ingress rewrites only the immediately preceding step and uses the 0.1.5 surface op", async () => {
  resetReplaceOpShape();
  const session = fakeSession([
    { seq: 0, type: "user/message", data: { turn: 1, step: 1, message: user("go") } },
    { seq: 1, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", BIG_TEXT) } },
    { seq: 2, type: "tool/result", data: { turn: 1, step: 2, message: toolResult("c2", BIG_TEXT) } },
    { seq: 3, type: "tool/result", data: { turn: 1, step: 3, message: toolResult("c3", BIG_TEXT) } }
  ]);
  const ctx = { get: (name) => (name === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 4, vision: false, minSnapTokens: 100 });
  assert.equal(report.failed, 0);
  assert.equal(report.shaped, 1, "exactly the step-3 result is unsent");
  const prune = session.log.find((event) => event.type === "compaction/prune");
  assert.equal(prune.data.shadowedTokenCount, 4242);
  assert.deepEqual(prune.data.shadowedSeqs, [3]);
  const replacement = session.log.find((event) => event.type === "tool/result" && event.surfaceOp?.op === "replace");
  assert.deepEqual(replacement.surfaceOp, { op: "replace", startSeq: 3, endSeq: 3 });
  assert.deepEqual(replacement.sourceEventSeqs, [3]);
  assert.ok(textOfEvent(replacement).startsWith("[Snapcompact"));
  // Already-sent earlier steps stay byte-identical: their prefix is provider-cached.
  assert.equal(textOfEvent(session.eventAt(1)), BIG_TEXT);
  assert.equal(textOfEvent(session.eventAt(2)), BIG_TEXT);
  assert.deepEqual(session.surface.nodes, [0, 1, 2, replacement.seq]);
});

/**
 * Drive one ingress pass over a single run_code call, the way this deployment delivers it.
 *
 * The program the call runs is what the pass inspects, so each case states its program and the
 * fate it expects; the session, the meter and the step arithmetic are the same every time.
 */
async function runCodeIngress(code, description) {
  resetReplaceOpShape();
  const session = fakeSession([
    { seq: 0, type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "run_code", arguments: JSON.stringify({ code, description }) } },
    { seq: 1, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", BIG_TEXT) } }
  ]);
  const ctx = { get: (name) => (name === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
  return { session, report };
}

test("a call that reads back a persisted result is never shaped again", async () => {
  const { session, report } = await runCodeIngress(
    'await tools.snap_retrieve({ hash: "898c69ab8636" })',
    "Read back the elided bytes"
  );
  assert.equal(report.shaped, 0, "the read-back keeps every byte");
  assert.equal(report.failed, 0);
  assert.equal(session.log.length, 2, "no rewrite event was appended");
  assert.equal(textOfEvent(session.eventAt(1)), BIG_TEXT);
});

test("a run_code call that does not name the persist directory is still shaped", async () => {
  const { report } = await runCodeIngress("await tools.bash({ command: 'ls src' });", "List sources");
  assert.equal(report.shaped, 1, "an ordinary call is shaped as before");
  assert.equal(report.failed, 0);
});

test("a run_code call that loads a skill keeps every byte", async () => {
  const { session, report } = await runCodeIngress(
    'const s = await tools.skill({ name: "typed-decide" }); console.log(s.content);',
    "Load typed-decide skill"
  );
  assert.equal(report.shaped, 0, "the skill body keeps every byte");
  assert.equal(report.failed, 0);
  assert.equal(session.log.length, 2, "no rewrite event was appended");
  assert.equal(textOfEvent(session.eventAt(1)), BIG_TEXT);
});

test("the retention label reads as a span an operator can act on", () => {
  assert.equal(persistRetentionLabel(PERSIST_TTL_MS), "24h");
  assert.equal(persistRetentionLabel(30 * 60 * 1000), "30m");
  assert.equal(persistRetentionLabel(3 * 24 * 60 * 60 * 1000), "3d");
});

test("the notice names a redeem handle instead of a path", () => {
  const text = Array.from({ length: 300 }, (_, i) => "line-" + i + " " + "x".repeat(60)).join(String.fromCharCode(10));
  const excerpt = snapExcerpt(text, { savedHash: "7f3a91c2", rereadable: false, persistTtlMs: PERSIST_TTL_MS });
  assert.match(excerpt, /snap_retrieve\("7f3a91c2"\)/, "the marker names the call that redeems it");
  assert.equal(/Full text saved to/.test(excerpt), false, "no absolute path is spent on every request");
});

test("expired copies are dropped even when the directory is far below its cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-ttl-"));
  try {
    // A copy old enough to expire, and one written now.
    const stale = join(dir, "stale-call.txt");
    writeFileSync(stale, "old bytes", "utf8");
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, past, past);
    const fresh = persistIngressText("new bytes", dir, "fresh", 60 * 60 * 1000);
    assert.ok(fresh, "the fresh copy is written");

    // prune runs every 25th write; drive it to the threshold with expired files.
    for (let i = 0; i < 25; i += 1) persistIngressText("x", dir, "filler" + i, 60 * 60 * 1000);
    const left = readdirSync(dir);
    assert.equal(left.includes("stale-call.txt"), false, "the expired copy is gone");
    assert.equal(left.includes(fresh.split("/").pop()), true, "the fresh copy survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isPersistReadback recognises the redeem call and nothing else", () => {
  assert.equal(isPersistReadback({ code: "await tools.snap_retrieve({ hash: \"7f3a91c2\" })" }), true, "the redeem call is recognised by tool name");
  assert.equal(isPersistReadback({ code: "grep -rn ledger-ingress docs/" }), false, "a bare directory mention is not a redemption");
  assert.equal(isPersistReadback({ file_path: "/tmp/elsewhere/abc.txt" }), false);
  assert.equal(isPersistReadback({}), false);
  assert.equal(isPersistReadback(undefined), false);
});

test("isSkillLoad recognises the call that pulls a skill in through the ptc wrapper", () => {
  assert.equal(isSkillLoad({ code: 'const s = await tools.skill({ name: "typed-decide" });' }), true, "the documented call shape");
  assert.equal(isSkillLoad({ code: 'await tools["open_skill"]({ name: "x" })' }), true, "bracket access is the same call");
  assert.equal(isSkillLoad({ code: "const s = await tools.open_skill({ name: 'x' });" }), true);
  assert.equal(isSkillLoad({ code: "await tools.find_skills({ query: 'pdf' })" }), true, "the catalogue is instruction text too");
  assert.equal(isSkillLoad({ code: "await tools.bash({ command: 'ls src' });" }), false, "an ordinary call is shaped as before");
  assert.equal(isSkillLoad({ code: "await tools.read({ file_path: '/tmp/a.md' })" }), false);
  assert.equal(isSkillLoad({ file_path: "/tmp/elsewhere/abc.txt" }), false);
  assert.equal(isSkillLoad({}), false);
  assert.equal(isSkillLoad(undefined), false);
});

test("a redeemed copy is skipped by name, the way skill and context are", () => {
  assert.equal(skipIngressTool("snap_retrieve"), true, "native mode delivers the redemption under its own name");
  assert.equal(skipIngressTool("skill"), true);
  assert.equal(skipIngressTool("open_skill"), true, "the loader the catalogue points at is the same contract");
  assert.equal(skipIngressTool("find_skills"), true);
  assert.equal(skipIngressTool("read"), false);
});

test("ingress exempts skill and context results whose tool/call never reaches the surface", async () => {
  resetReplaceOpShape();
  for (const tool of ["skill", "context"]) {
    const session = fakeSession([
      { seq: 0, type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: tool, arguments: "{}" } },
      { seq: 1, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", BIG_TEXT) } }
    ]);
    assert.deepEqual(session.surface.nodes, [1], "a tool/call is log-only, never a surface node");
    const ctx = { get: (service) => (service === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined) };
    const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
    assert.equal(report.failed, 0);
    assert.equal(report.shaped, 0, tool + " results are never shaped");
    assert.equal(session.log.some((event) => event.type === "compaction/prune"), false, "nothing is shadowed");
    assert.equal(textOfEvent(session.eventAt(1)), BIG_TEXT, "the result stays byte-identical");
  }
  resetReplaceOpShape();
});

test("ingress still shapes a result whose name resolves from a log-only tool/call", async () => {
  resetReplaceOpShape();
  const session = fakeSession([
    { seq: 0, type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } },
    { seq: 1, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", BIG_TEXT) } }
  ]);
  const ctx = { get: (service) => (service === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
  assert.equal(report.shaped, 1, "a non-exempt tool keeps its ingress shaping");
  const replacement = session.log.find((event) => event.type === "tool/result" && event.surfaceOp?.op === "replace");
  assert.ok(textOfEvent(replacement).startsWith("[Snapcompact"));
  resetReplaceOpShape();
});

test("ingress leaves instruction text whole even on a non-exempt tool", async () => {
  resetReplaceOpShape();
  const session = fakeSession([
    { seq: 0, type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } },
    { seq: 1, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", '<skill_content name="x">\n' + BIG_TEXT) } }
  ]);
  const ctx = { get: (service) => (service === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
  assert.equal(report.shaped, 0, "instruction text is a command to follow, not data to sample");
  resetReplaceOpShape();
});

test("ingress retries the pre-0.1.5 replace keys once and remembers the shape", async () => {
  resetReplaceOpShape();
  const session = fakeSession([
    { seq: 0, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", BIG_TEXT) } }
  ], { legacyKeys: true });
  const ctx = { get: (name) => (name === "tokenMeter" ? { estimateMessage: () => 7 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
  assert.equal(report.failed, 0);
  assert.equal(report.shaped, 1);
  assert.equal(usesLegacyReplaceKeys(), true);
  const replacement = session.log.find((event) => event.type === "tool/result" && event.surfaceOp?.op === "replace");
  assert.deepEqual(replacement.surfaceOp, { op: "replace", start: 0, end: 0 });
  resetReplaceOpShape();
});

test("ingress reports a rejected append instead of throwing", async () => {
  resetReplaceOpShape();
  const session = fakeSession([
    { seq: 0, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", BIG_TEXT) } }
  ]);
  session.append = () => {
    throw new Error("surface replace: node is gone");
  };
  const ctx = { get: (name) => (name === "tokenMeter" ? { estimateMessage: () => 7 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
  assert.equal(report.shaped, 0);
  assert.equal(report.failed, 1);
  assert.match(report.error, /node is gone/);
});

test("a later fold carries files, intents and errors forward instead of dropping them", () => {
  const priorCard = user([
    "[Snapcompact] Fold ~50000 tok. Exact file bytes are not stored — re-read with offset/limit if a detail matters.",
    "FILES",
    "- [edit] lib/ancient-module.js",
    "- [read] lib/old-config.js",
    "INTENTS",
    "- 修复 SSH 插件的显示",
    "ERRORS",
    "- bash: boom",
    "EXCERPT",
    "[user] 看ssh拓展"
  ].join("\n"));
  const out = buildFold([
    priorCard,
    user("现在做快压插件的审查"),
    assistant([toolCall("c1", "read", { file_path: "lib/ingress.js" })]),
    toolResult("c1", "     1| export function shapeIngress() {}")
  ]);
  assert.ok(out.includes("Carried forward from earlier folds"));
  assert.ok(out.includes("lib/ancient-module.js"), "carried file survives");
  assert.ok(out.includes("修复 SSH 插件的显示"), "carried intent survives");
  assert.ok(out.includes("bash: boom"), "carried error survives");
  assert.ok(out.includes("lib/ingress.js"), "new file still recorded");
  assert.ok(out.includes("现在做快压插件的审查"), "new intent still recorded");
  const carried = carriedFromFold(priorCard.content[0].text);
  assert.deepEqual(carried.files.map((item) => item.path), ["lib/ancient-module.js", "lib/old-config.js"]);
  assert.deepEqual(carried.intents, ["修复 SSH 插件的显示"]);
});

test("apply wires the service, the command and the pre-step health counters", async () => {
  const { apply } = await import("./index.js");
  const registered = { listeners: {} };
  const big = Array.from({ length: 200 }, (_, i) => "line-" + i + " " + "abcd".repeat(40)).join("\n");
  const log = [
    { seq: 0, type: "user/message", data: { turn: 1, step: 1, message: user("go") } },
    { seq: 1, type: "tool/result", data: { turn: 1, step: 1, message: toolResult("c1", big) } }
  ];
  const nodes = [0, 1];
  const session = {
    surface: { nodes },
    eventAt: (seq) => log.find((event) => event.seq === seq),
    requestHeader: () => ({ config: { provider: "deepseek-official", model: "deepseek-flash" } }),
    append(type, data, opts) {
      const op = opts?.surfaceOp;
      if (op && typeof op === "object" && !("startSeq" in op)) {
        throw new Error('session event "' + type + '" carries an invalid replace surfaceOp');
      }
      const event = { type, seq: log.length, data, ...(opts ?? {}) };
      log.push(event);
      if (op === "append") nodes.push(event.seq);
      else if (op && typeof op === "object") nodes.splice(nodes.indexOf(op.startSeq), 1, event.seq);
      return event;
    }
  };
  const settingsValue = { enabled: true, snapImages: true, minSnapTokens: 3000, savingsRatio: 0.85, confirmFold: true, replaceDefault: false };
  const ctx = {
    settings: { register: () => ({ get: () => settingsValue, replace: async () => {} }) },
    provide: (name, service) => { registered.service = service; },
    typert: { register: (typert) => { registered.typert = typert; } },
    commands: { register: (command) => { registered.command = command; return () => {}; } },
    tools: { register: (tool) => { registered.tool = tool; return () => {}; } },
    on: (name, handler) => { registered.listeners[name] = handler; return () => {}; },
    effect: (fn) => { const dispose = fn(); return () => (typeof dispose === "function" ? dispose() : undefined); },
    logger: { info: () => {}, warn: () => {} },
    get: (name) => (name === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined)
  };
  await apply(ctx);
  assert.deepEqual(Object.keys(registered.service).sort(), ["getHealth", "getPressure", "getState", "getStatus", "saveConfig", "typertRemote"].sort());
  assert.deepEqual(registered.typert.invocations.map((item) => item.method).sort(), ["getHealth", "getPressure", "getState", "getStatus", "saveConfig"].sort());
  assert.equal(registered.command.name, "fast-compact");
  assert.equal(registered.service.getHealth().sessionApi, "unknown");
  await registered.listeners["agent/pre-step"]({ agent: { session, options: {} }, turn: 1, step: 2, signal: new AbortController().signal }, async () => {});
  const health = registered.service.getHealth();
  assert.equal(health.version, VERSION);
  assert.equal(health.sessionApi, "eventAt");
  assert.equal(health.ingress.shaped, 1);
  assert.equal(health.ingress.failures, 0);
  assert.ok(health.ingress.savedTokens > 0);
  assert.equal(session.surface.nodes.length, 2);
  assert.ok(collectText(session.eventAt(session.surface.nodes.at(-1)).data.message.content).startsWith("[Snapcompact"));
});

async function loadSchemastery() {
  const candidates = [process.env.DSH_SCHEMASTER_MODULE, "@deepseek-ai/schemastery", "schemastery"].filter(Boolean);
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const schema = mod?.default ?? mod;
      if (typeof schema === "function" && typeof schema.object === "function") return schema;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

test("settings envelope uses the canonical {uid, refs} form", () => {
  const envelope = settingsSchema.toJSON();
  assert.deepEqual(Object.keys(envelope).sort(), ["refs", "uid"]);
  assert.equal(typeof envelope.uid, "number");
  const flat = flattenObjectEnvelope(envelope);
  assert.deepEqual(Object.keys(flat), Object.keys(FIELDS));
  for (const [key, field] of Object.entries(FIELDS)) {
    assert.equal(flat[key].type, field.type, key + " type");
    assert.deepEqual(flat[key].meta, field.meta, key + " meta");
  }
});

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("the canonical envelope rehydrates in the real schemastery", async (t) => {
  const schemaLib = await loadSchemastery();
  if (!schemaLib) {
    t.skip("schemastery is not resolvable here; set DSH_SCHEMASTER_MODULE to run this test");
    return;
  }
  const rehydrated = new schemaLib(settingsSchema.toJSON());
  const resolved = rehydrated({ minSnapTokens: 500 });
  assert.equal(resolved.minSnapTokens, 500);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.replaceDefault, false);
  // Nested nodes keep their methods; the flat envelope used to lose them.
  assert.equal(typeof rehydrated.dict.minSnapTokens.simplify, "function");
  const reference = schemaLib.object({
    enabled: schemaLib.boolean().default(true),
    snapImages: schemaLib.boolean().default(false),
    imagePixelBudget: schemaLib.number().step(1000).min(200000).max(4000000).default(640000),
    minSnapTokens: schemaLib.number().step(1).min(200).max(200000).default(3000),
    savingsRatio: schemaLib.number().min(0.05).max(1).default(0.85),
    confirmFold: schemaLib.boolean().default(true),
    replaceDefault: schemaLib.boolean().default(false),
    persistIngress: schemaLib.boolean().default(false),
    persistDir: schemaLib.string().default(""),
    persistTtlHours: schemaLib.number().step(1).min(0).max(8760).default(24)
  });
  assert.deepEqual(flattenObjectEnvelope(settingsSchema.toJSON()), flattenObjectEnvelope(reference.toJSON()));
});

test("hook diagnostics name engines without summarize", () => {
  class WeirdEngine {
    compactNow() {}
  }
  const before = hookStats();
  hookMechanicalSummarizer(new WeirdEngine());
  const after = hookStats();
  assert.ok(after.unsupportedEngines.includes("WeirdEngine"));
  assert.equal(after.unsupported, before.unsupported + 1);
});

async function loadRealSession() {
  const candidates = [process.env.DSH_SESSION_MODULE, "@deepseek-ai/dsh-session", "dsh-session"].filter(Boolean);
  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

test("a real dsh-session accepts the ingress rewrite end to end", async (t) => {
  const mod = await loadRealSession();
  const Session = mod?.Session;
  if (typeof Session !== "function") {
    t.skip("dsh-session is not resolvable here; set DSH_SESSION_MODULE to run this test");
    return;
  }
  resetReplaceOpShape();
  const session = Session.create("ingress-integration");
  session.append("user/message", { role: "user", id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "go" }] }, { surfaceOp: "append" });
  session.append("tool/result", {
    turn: 1,
    step: 1,
    message: { role: "user", id: "m2", source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: BIG_TEXT }] }] }
  }, { surfaceOp: "append" });
  const ctx = { get: (name) => (name === "tokenMeter" ? { estimateMessage: () => 4242 } : undefined) };
  const report = await shapeCurrentTurnIngress(session, ctx, { turn: 1, step: 2, vision: false, minSnapTokens: 100 });
  assert.equal(report.failed, 0, report.error);
  assert.equal(report.shaped, 1);
  const node = session.surface.nodes.at(-1);
  assert.ok(textOfEvent(session.eventAt(node)).startsWith("[Snapcompact"));
});

test("the canvas cap lands on a whole tile band", () => {
  const shape = resolveShape("gpt-4o");
  const rows = Math.floor(shape.frameH / shape.cellH);
  const h = rows * shape.cellH;
  const bands = Math.ceil(h / 512);
  assert.ok(512 * bands - h < shape.cellH, "the cap must not waste most of a paid band");
  // Same bill as the old 70-row frame, one third more text rows.
  assert.equal(estImageTokens(shape.frameW, h, shape.family), estImageTokens(shape.frameW, 70 * shape.cellH, shape.family));
  assert.ok(rows > 70);
});

test("short lines pack into columns and buy back blank paper", () => {
  const shape = resolveShape("gpt-4o");
  const lines = Array.from({ length: 3000 }, (_, i) => String(i + 1));
  const plan = planGrid(lines, shape);
  assert.ok(plan.columns >= 10, "a numeric dump must pack wide");
  assert.equal(plan.rows[0].cells.length, plan.columns);
  assert.equal(plan.rows[0].startLine, 1);
  assert.equal(plan.rows[1].startLine, plan.columns + 1);
  const single = buildGrid(lines, { columns: 1, cellCols: shape.cols, gapCols: 2, cols: shape.cols, gutterCols: plan.gutterCols, gutterEvery: 5 });
  assert.ok(plan.occupancy > single.occupancy * 10);
});

test("cells keep one source line each while that is possible", () => {
  const shape = resolveShape("gpt-4o");
  const lines = Array.from({ length: 300 }, (_, i) => "x".repeat(97) + i);
  const plan = planGrid(lines, shape);
  assert.equal(plan.columns, 1);
  assert.equal(plan.wrapShare, 0);
});

test("a wrapped outlier only costs the row it sits in", () => {
  const shape = resolveShape("gpt-4o");
  const lines = Array.from({ length: 100 }, (_, i) => "n" + i);
  lines[40] = "y".repeat(300);
  const plan = planGrid(lines, shape);
  assert.equal(plan.rows.filter((row) => row.subRows > 1).length, 1);
  assert.ok(plan.rows.every((row) => row.cells.length <= plan.columns));
});

test("cellLength and wrapCell agree about wide glyphs", () => {
  assert.equal(cellLength("ab中"), 4);
  assert.deepEqual(wrapCell("abcdef", 4), ["abcd", "ef"]);
  assert.deepEqual(wrapCell("abcdefgh", 4), ["abcd", "efgh"], "exact fit must not grow a blank row");
  assert.deepEqual(wrapCell("中文中", 4), ["中文", "中"]);
  assert.deepEqual(wrapCell("", 4), [""]);
});

test("the raster carries a line ruler and layered ink", () => {
  const shape = resolveShape("gpt-4o");
  const lines = Array.from({ length: 600 }, (_, i) => "row " + i);
  const plan = planGrid(lines, shape);
  assert.ok(plan.gutterCols >= 3);
  const framed = rasterGrid(plan, shape, 40);
  assert.equal(framed.rows, 40);
  assert.equal(framed.h, 40 * shape.cellH);
  assert.equal(framed.gutterCols, plan.gutterCols);
  const inks = new Set(framed.pixels);
  assert.ok(inks.has(245), "paper");
  assert.ok(inks.has(16), "body ink");
  assert.ok(inks.has(205), "column rules");
  assert.ok(inks.has(150), "ruler ink");
  assert.ok(framed.renderedText.includes("row 0"));
  assert.equal(encodePngGray(framed.pixels, framed.w, framed.h)[0], 137);
});

test("packing draws an order of magnitude more source lines for the same bill", () => {
  const shape = resolveShape("gpt-4o");
  const text = Array.from({ length: 3000 }, (_, i) => String(i + 1)).join("\n");
  const rows = Math.floor(shape.frameH / shape.cellH);
  const framed = rasterGrid(planGrid(text.split("\n"), shape), shape, rows);
  const legacy = raster(text, shape, rows);
  assert.equal(estImageTokens(framed.w, framed.h, shape.family), estImageTokens(legacy.w, legacy.h, shape.family));
  assert.ok(framed.gridRows * framed.columns > legacy.rows * 10);
});

test("deepseek image accounting follows the measured curve and the request budget", () => {
  assert.equal(familyOf("deepseek-flash"), "deepseek");
  // Measured against the live endpoint; see bench/report.md for the raw points.
  assert.equal(deepseekImageTokens(100, 100), 213);
  assert.equal(deepseekImageTokens(1024, 2046), 1043);
  const preview = previewSize(1024, 2046, "deepseek");
  assert.equal(preview.resized, true);
  assert.equal(preview.width + "x" + preview.height, "566x1131");
  // The request pipeline resizes before dispatch, and the provider bills what it gets.
  assert.equal(estImageTokens(1024, 2046, "deepseek"), deepseekImageTokens(566, 1131));
  assert.ok(estImageTokens(1024, 2046, "deepseek") < 500);
  // A frame already inside the budget is billed exactly as drawn.
  assert.equal(estImageTokens(560, 1122, "deepseek"), deepseekImageTokens(560, 1122));
});

test("the canvas follows the deployment's image pixel budget", () => {
  const wide = resolveShape("deepseek-flash", { imagePixelBudget: 1300000 });
  assert.ok(wide.frameW * wide.frameH <= 1300000);
  assert.ok(wide.frameH > resolveShape("deepseek-flash").frameH, "a larger budget buys more rows");
  assert.equal(previewSize(wide.frameW, wide.frameH, "deepseek", wide.pixelBudget).resized, false);
  const low = resolveShape("deepseek-flash", { imagePixelBudget: 262144 });
  assert.ok(low.frameW * low.frameH <= 262144);
  assert.equal(previewSize(low.frameW, low.frameH, "deepseek", low.pixelBudget).resized, false);
  assert.equal(settingsSchema({}).imagePixelBudget, 640000);
  assert.equal(settingsSchema({ imagePixelBudget: 1000 }).imagePixelBudget, 200000);
  assert.equal(settingsSchema({ imagePixelBudget: 99999999 }).imagePixelBudget, 4000000);
  assert.ok(FIELDS.imagePixelBudget, "the field must reach the settings envelope");
});

/** Build an FGATLAS1 buffer by hand: entries are [codepoint, rows of rowBytes bytes]. */
function atlasBuffer(w, h, entries) {
  const rowBytes = Math.ceil(w / 8);
  const header = Buffer.alloc(16);
  header.write("FGATLAS1", 0, "binary");
  header[8] = w;
  header[9] = h;
  header.writeUInt32LE(entries.length, 12);
  const cps = Buffer.alloc(entries.length * 4);
  const bits = Buffer.alloc(entries.length * rowBytes * h);
  entries.forEach(([cp, rows], i) => {
    cps.writeUInt32LE(cp, i * 4);
    rows.forEach((row, r) => row.forEach((byte, j) => { bits[i * rowBytes * h + r * rowBytes + j] = byte; }));
  });
  return Buffer.concat([header, cps, bits]);
}

test("an alternative ASCII atlas can be parsed and installed", () => {
  const atlas = parseAsciiAtlas(readFileSync(new URL("./fonts/font8x13.bin", import.meta.url)));
  assert.equal(atlas.w, 8);
  assert.equal(atlas.h, 13);
  assert.equal(atlas.rowBytes, 1);
  assert.ok(atlas.glyphs.size > 100);
  const before = lookup8(65);
  setAsciiAtlas(atlas);
  try {
    assert.ok(lookup8(65));
    const frame = raster("A0", resolveShape("deepseek-flash"), 2);
    assert.ok(frame.w > 0);
  } finally {
    setAsciiAtlas(null);
  }
  assert.equal(lookup8(65), before, "the default atlas comes back");
});

test("the atlas box is honored and centered in the cell", () => {
  const solid = (w) => {
    let byte = 0;
    for (let c = 0; c < w; c++) byte |= 1 << (7 - c);
    return byte;
  };
  const narrow = parseAsciiAtlas(atlasBuffer(4, 5, [[0x41, Array.from({ length: 5 }, () => [solid(4)])]]));
  assert.equal(narrow.rowBytes, 1);
  setAsciiAtlas(narrow);
  try {
    const shape = resolveShape("deepseek-flash"); // cell 8x16
    const frame = raster("A", shape, 1);
    const ink = (x, y) => frame.pixels[y * frame.w + x] === 16;
    // ox = (8-4)/2 = 2, oy = (16-5)/2 = 5
    assert.ok(ink(2, 5) && ink(5, 9), "the 4x5 box is drawn where it belongs");
    assert.equal(ink(1, 5), false, "no ink left of the box");
    assert.equal(ink(2, 4), false, "no ink above the box");
    assert.equal(ink(6, 5), false, "no ink right of the box");
  } finally {
    setAsciiAtlas(null);
  }
  // Two bytes per row must map to columns 8..11, not wrap into the first byte.
  const wide = parseAsciiAtlas(atlasBuffer(12, 1, [[0x41, [[0b10000000, 0b10000000]]]]));
  assert.equal(wide.rowBytes, 2);
  setAsciiAtlas(wide);
  try {
    const shape = { ...resolveShape("deepseek-flash"), cellW: 12, cols: 4, frameW: 48 };
    const frame = raster("A", shape, 1);
    const ink = (x, y) => frame.pixels[y * frame.w + x] === 16;
    // A 12-wide box in a 12-wide cell: ox = 0, oy = (16-1)/2 = 7.
    assert.ok(ink(0, 7) && ink(8, 7), "the second byte covers columns 8..15");
    assert.equal(ink(1, 7), false);
  } finally {
    setAsciiAtlas(null);
  }
});

test("digits can be drawn from their own atlas", () => {
  const countInk = (frame) => frame.pixels.reduce((n, v) => n + (v === 16 ? 1 : 0), 0);
  const shape = resolveShape("deepseek-flash");
  const before = countInk(raster("0", shape, 1));
  const digits = parseAsciiAtlas(atlasBuffer(8, 8, [[0x30, Array.from({ length: 8 }, () => [0xff])]]));
  assert.equal(digits.h, 8);
  setDigitAtlas(digits);
  let after;
  try {
    after = countInk(raster("0", shape, 1));
  } finally {
    setDigitAtlas(null);
  }
  assert.equal(after, 64, "the digit is the solid 8x8 box from its own atlas");
  assert.ok(before > 0 && before !== 64, "the shipped digit is a different shape");
  assert.equal(countInk(raster("0", shape, 1)), before, "the shipped digit comes back");
});

test("alternate grid rows can be shaded without moving a cell", () => {
  const shape = resolveShape("deepseek-flash");
  const lines = Array.from({ length: 40 }, (_, i) => "row-" + i + " value=" + i * 37);
  const plan = planGrid(lines, shape, { gutterEvery: 1 });
  const plain = rasterGrid(plan, shape, 40);
  const shaded = rasterGrid(plan, shape, 40, { rowPaper: (r) => (r % 2 ? 236 : undefined) });
  assert.equal(shaded.w, plain.w);
  assert.equal(shaded.h, plain.h);
  const count = (frame, value) => frame.pixels.reduce((n, v) => n + (v === value ? 1 : 0), 0);
  assert.equal(count(plain, 236), 0);
  assert.ok(shaded.gridRows > 2, "the fixture has to pack more than one grid row");
  const band = Math.floor(shaded.gridRows / 2) * shape.cellH * shaded.w; // rows 1, 3, 5, ...
  assert.ok(count(shaded, 236) > band * 0.8, "the shaded bands survive the ink drawn over them");
  assert.equal(count(shaded, 16), count(plain, 16), "glyph ink is untouched");
});

test("the palette encoder emits a colour-type-3 PNG", () => {
  const pixels = new Uint8Array(4 * 2).fill(0);
  pixels[0] = 1;
  pixels[3] = 2;
  const png = encodePngPalette(pixels, 4, 2, [[255, 255, 255], [0, 0, 0], [255, 0, 0]]);
  assert.equal(png[0], 137);
  assert.ok(png.includes(Buffer.from("PLTE", "ascii")));
  const ihdr = png.indexOf(Buffer.from("IHDR", "ascii"));
  assert.equal(png[ihdr + 4 + 8], 8, "8-bit");
  assert.equal(png[ihdr + 4 + 9], 3, "palette colour type");
});

test("per-cell and digit ink reach the raster", () => {
  const shape = resolveShape("deepseek-flash");
  const lines = Array.from({ length: 80 }, (_, i) => "case-" + i + " dur=" + (i * 13 % 400) + "ms");
  const plan = planGrid(lines, shape);
  const framed = rasterGrid(plan, shape, 20, {
    paper: 0,
    rule: 2,
    gutterInk: 3,
    digitInk: 4,
    cellInk: (cell) => (/dur=143ms/.test(cell.join("")) ? 5 : 1)
  });
  const inks = new Set(framed.pixels);
  for (const level of [0, 1, 3, 4, 5]) assert.ok(inks.has(level), "missing ink level " + level);
});

test("the deepseek canvas is drawn inside the request pixel budget", () => {
  const shape = resolveShape("deepseek-flash");
  assert.equal(shape.family, "deepseek");
  assert.ok(shape.frameW * shape.frameH <= REQUEST_PIXEL_BUDGET, shape.frameW + "x" + shape.frameH + " exceeds the budget");
  assert.equal(previewSize(shape.frameW, shape.frameH, "deepseek").resized, false);
  assert.equal(shape.frameH % shape.cellH, 0);
  assert.ok(shape.frameH / shape.cellH >= 36, "the budget frame must still carry a page of text");
});

test("pricing uses the published deepseek table", () => {
  assert.equal(usdFor(1_000_000, "cacheMiss", "deepseek-flash"), 0.3);
  assert.equal(usdFor(1_000_000, "cacheHit", "deepseek-flash"), 0.006);
  assert.equal(usdFor(1_000_000, "output", "deepseek-flash"), 1.2);
  assert.equal(usdFor(1_000_000, "cacheMiss", "deepseek-flash", { offPeak: true }), 0.15);
  assert.equal(usdFor(1_000_000, "cacheMiss", "deepseek-v4-pro"), 1.32);
  assert.equal(priceFor("deepseek-v4-pro").vision, false);
  assert.equal(requestPreviewSize(640, 1000, "deepseek-flash").resized, false);
  assert.equal(priceFor("deepseek-flash").requestPixelBudget, 640000);
  assert.equal(formatUsd(0), "$0");
  assert.ok(formatUsd(0.000131).startsWith("$0.0001"));
});

test("the shipped deepseek notice needs no preview: the frame already fits", () => {
  const text = Array.from({ length: 2000 }, (_, i) => "2026-09-10T19:00:00Z INFO worker=" + (i % 16) + " job=" + i + " ok ms=" + (i % 997)).join("\n");
  const shaped = shapeIngress(text, { vision: true, model: "deepseek-flash", minSnapTokens: 100 });
  assert.equal(shaped.snapped, true);
  assert.equal(shaped.text.includes("(preview "), false, "a budgeted canvas is never resized");
  assert.ok(shaped.text.includes("1024x624"), shaped.text.split("\n")[0]);
});

test("the image only ships when it beats the text it renders", () => {
  const dense = Array.from({ length: 2000 }, (_, i) => "2026-09-10T19:00:00Z INFO worker=" + (i % 16) + " job=" + i + " ok ms=" + (i % 997)).join("\n");
  assert.equal(shapeIngress(dense, { vision: true, model: "gpt-4o", minSnapTokens: 100 }).snapped, true);
  const sparse = Array.from({ length: 3200 }, (_, i) => String(i % 100)).join("\n");
  const shaped = shapeIngress(sparse, { vision: true, model: "gpt-4o", minSnapTokens: 100 });
  assert.equal(shaped.snapped, false);
  assert.equal(shaped.excerpted, true);
});

