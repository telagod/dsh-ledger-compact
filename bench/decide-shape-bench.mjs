#!/usr/bin/env node
/**
 * 问句形状对照：在同一批真实候选上比较不同 needed 问句的判定力。
 *
 * 为什么要对照：现役 Q_NEEDED 问的是「还需要吗以完成当前任务」，但 state 里的
 * 当前任务常常是「继续」这类无指称对象的续接消息，判定器只能给低 margin
 * (2026-10-04 实测真实会话 needed margin 中位数 ~0.10, minMargin=0.15, 75% 退回 mechanical)。
 * 改阈值是拍脑袋; 改问句形状才是可证伪的改动。本脚本让每个变体拿到真实新判定
 * (state 里加一行中性 Variant 描述, 绕开服务端幂等台账), 再用重取 gold 校验准不准。
 *
 * 用法: node bench/decide-shape-bench.mjs <session.jsonl.zstd> [更多会话...]
 */
import { execSync } from "node:child_process";
import { inspectMessages } from "../lib/fold.js";
import { pickCandidates, verdictState, verdictAction, DECIDE_FOLD_DEFAULTS } from "../lib/decide-fold.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);
const MIN_TOKENS = Number(process.env.MIN_TOKENS || 200);
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 12);

const Q_RERUN_BASE = "If this tool result were dropped, could the same information be obtained again by re-running the same tool call?";

const VARIANTS = [
  {
    id: "A-current",
    salt: "baseline: necessity anchored on the current task",
    needed: "The contents of this tool result are still needed to finish the current task."
  },
  {
    id: "B-evidence",
    salt: "criterion: a later step names a concrete artifact carried by this result",
    needed: "A later step in this session refers to a concrete artifact carried by this result (a specific path, identifier, value, or passage), and that reference is not satisfiable without this exact result."
  },
  {
    id: "C-relative",
    salt: "criterion: relative load-bearing compared with the other results",
    needed: "Compared with the other tool results in this session, this one is unusually load-bearing: a later step is more likely to depend on it than on them."
  },
  {
    id: "D-costaware",
    salt: "criterion: cost of restoring later versus cost of keeping it",
    needed: "Getting this result back later would cost a full tool round trip or would silently change what a later step does, while keeping it costs only context space."
  }
];

function decideKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync("ga-keys get LITELLM_MASTER_KEY", { encoding: "utf8" }).trim();
}

function messagesOf(raw) {
  const messages = [];
  for (const line of raw.split(NL)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!MESSAGE_TYPES.has(event.type)) continue;
    const message = event.data && event.data.message ? event.data.message : event.data;
    if (message && typeof message === "object") messages.push(message);
  }
  return messages;
}

function taskOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const kind = message.source && message.source.kind;
    if (kind && kind !== "user") continue;
    const text = (message.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join(NL).trim();
    if (text) return text;
  }
  return "";
}

/** 折页点之后同批候选动了什么。控制变量用: 所有变体拿到同一段 later context。 */
function laterContextOf(entry, list) {
  const others = list
    .filter((other) => other !== entry)
    .slice(0, 8)
    .map((other) => (other.name || "tool") + " on " + String(other.target || "").slice(0, 60));
  return others.length
    ? "Steps in the same span also touched: " + others.join("; ") + "."
    : "No earlier step in the span says anything about this result.";
}

function stateFor(entry, task, salt, index, list) {
  const base = verdictState({ ...entry, laterContext: laterContextOf(entry, list) }, { task });
  return base + NL + "Variant: " + salt + " (candidate " + (index + 1) + " of " + list.length + ")";
}

async function askOnce(state, needed, key, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DECIDE_FOLD_DEFAULTS.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      signal: controller.signal,
      body: JSON.stringify({
        state,
        questions: {
          needed: { type: "noul", instructions: needed, criteria: { true: "yes", false: "no" } },
          rerunnable: { type: "noul", instructions: Q_RERUN_BASE, criteria: { true: "reproduces it", false: "one-off" } }
        }
      })
    });
    if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "no response"));
    const json = await res.json();
    const inner = json && json.result && typeof json.result === "object" ? json.result : json;
    const answers = inner && inner.answers && typeof inner.answers === "object" ? inner.answers : inner;
    const n = answers && answers.needed ? answers.needed : {};
    const r = answers && answers.rerunnable ? answers.rerunnable : {};
    return { p: Number(n.probability), m: Number(n.margin), rp: Number(r.probability), rm: Number(r.margin) };
  } finally {
    clearTimeout(timer);
  }
}

/** gold: 折页点之后该目标是否又被独立重取(可寻)或被改动(丢了就找不回)。 */
function goldOf(entry, messages, cutIndex) {
  const needle = String(entry.target || "").trim();
  const stem = needle.length > 24 ? needle.slice(0, 24) : needle;
  let rereads = 0;
  let edits = 0;
  for (let i = cutIndex; i < messages.length; i += 1) {
    const message = messages[i];
    const text = JSON.stringify(message && message.content ? message.content : message);
    if (stem && text.includes(stem)) {
      if (/"name":"(write|edit|apply_patch)"/.test(text)) edits += 1;
      else rereads += 1;
    }
  }
  return { rereads, edits, recoverable: rereads + edits > 0 };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node bench/decide-shape-bench.mjs <session.jsonl.zstd> [更多会话...]");
  process.exit(2);
}

const key = decideKey();
const perVariant = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));
const perVariantGold = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));
let totalCandidates = 0;

for (const file of files) {
  const raw = execSync("zstd -dc " + JSON.stringify(file), { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const messages = messagesOf(raw);
  const snapshot = inspectMessages(messages);
  const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
  const candidates = pickCandidates(entries, { maxEntries: MAX_ENTRIES, minEntryTokens: MIN_TOKENS });
  const task = taskOf(messages);
  totalCandidates += candidates.length;
  console.log("会话 " + file.split("/").slice(-2)[0].slice(8, 16)
    + " · 工具结果 " + entries.length
    + " · 候选 " + candidates.length
    + " · 请求「" + task.replace(/\s+/g, " ").slice(0, 24) + "」");

  const cutIndex = Math.floor(messages.length * 0.6);
  for (let i = 0; i < candidates.length; i += 1) {
    const entry = candidates[i];
    const gold = goldOf(entry, messages, cutIndex);
    const cells = [];
    for (const variant of VARIANTS) {
      let cell;
      try {
        const out = await askOnce(stateFor(entry, task, variant.salt, i, candidates), variant.needed, key);
        const action = verdictAction({
          pNeeded: out.p, pRerun: out.rp,
          neededMargin: out.m, rerunMargin: out.rm,
          minMargin: DECIDE_FOLD_DEFAULTS.minMargin
        });
        perVariant[variant.id].push({ ...out, action });
        perVariantGold[variant.id].push(gold.recoverable);
        cell = (action === "mechanical" ? " M  " : " *  ") + " n=" + out.p.toFixed(2) + " m=" + out.m.toFixed(2);
      } catch (error) {
        cell = " err ";
      }
      cells.push(cell);
    }
    console.log("  " + String(entry.tokens).padStart(6) + "  " + cells.join(" |")
      + "   可寻=" + (gold.recoverable ? "Y" : "n") + "  " + entry.target.slice(0, 36));
  }
  console.log("");
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

console.log("=".repeat(80));
console.log("问句形状汇总 · 候选总数 " + totalCandidates + " · minMargin=" + DECIDE_FOLD_DEFAULTS.minMargin);
console.log("变体         有效动作 keep drop trunc  中位needed-margin  判drop中可寻/不可寻");
for (const variant of VARIANTS) {
  const rows = perVariant[variant.id].filter(Boolean);
  if (!rows.length) { console.log(variant.id.padEnd(13) + " 全部失败"); continue; }
  const live = rows.filter((r) => r.action !== "mechanical");
  const drops = rows.map((r, i) => ({ r, g: perVariantGold[variant.id][i] })).filter((x) => x.r.action === "drop");
  const dropUnsafe = drops.filter((x) => x.g === false).length;
  console.log(variant.id.padEnd(13)
    + String(live.length + "/" + rows.length).padStart(8)
    + String(live.filter((r) => r.action === "keep").length).padStart(5)
    + String(drops.length).padStart(5)
    + String(live.filter((r) => r.action === "truncate").length).padStart(6)
    + String(median(rows.map((r) => r.m)).toFixed(3)).padStart(16)
    + String((drops.length - dropUnsafe) + "/" + dropUnsafe).padStart(14));
}
console.log("");
console.log("读法: 「有效动作」= 非 mechanical 占比, 即判定真正生效的比例;");
console.log("      「判drop中可寻/不可寻」= 判 drop 的条目里, 内容事后仍可独立重取 / 已无处可寻。");
console.log("      后者是误删风险的下界: 右列为 0 表示无误删风险, 非 0 需逐条人工看。");

