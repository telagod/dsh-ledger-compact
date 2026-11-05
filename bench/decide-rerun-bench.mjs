#!/usr/bin/env node
/**
 * rerun 问句对照：检验「可重跑」这一半能否区分「内容事后仍可寻」与「已无处可寻」。
 *
 * 为什么单独测 rerun：2026-10-04 真实会话实测，现役 Q_RERUN 对读文件/加载 skill 类结果
 * 概率恒在 0.85 以上，于是四象限的 keep 格（needed 且不可重跑 = 判定器唯一能把内容
 * 捞回卡片的动作）在结构上不可达 —— 实测 12 条候选全部落 truncate，keep 0 条。
 * fold.js 只对 keep 做内容恢复，truncate/drop 的卡片与机械折页逐字相同，
 * 所以「keep 为 0」等于判定式折页在真实会话上零收益。
 *
 * gold：折页点之后该目标是否又被独立重取(可寻)或被改动(已无处可寻)。
 * 局限：事后没重取不等于不可重跑，gold 是分类能力的下界，不是逐字真值。
 *
 * 用法: node bench/decide-rerun-bench.mjs <session.jsonl.zstd> [更多会话...]
 */
import { execSync } from "node:child_process";
import { inspectMessages } from "../lib/fold.js";
import { pickCandidates, verdictState, verdictAction, DECIDE_FOLD_DEFAULTS } from "../lib/decide-fold.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);
const MIN_TOKENS = Number(process.env.MIN_TOKENS || 200);
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 12);

const NEEDED_FIXED = "The contents of this tool result are still needed to finish the current task.";

const VARIANTS = [
  {
    id: "R0-current",
    salt: "rerun baseline: can the same tool call reproduce it",
    rerun: "If this tool result were dropped, could the same information be obtained again by re-running the same tool call?"
  },
  {
    id: "R1-cost",
    salt: "rerun criterion: a full agent turn versus context lines",
    rerun: "Getting this result back later would cost a full agent turn — a tool round trip plus re-reading and re-deriving — whereas keeping it costs only the context lines it occupies."
  },
  {
    id: "R2-onceoff",
    salt: "rerun criterion: state a re-run would not reproduce",
    rerun: "The information in this result is one-off: it reflects transient state that a re-run would not reproduce, such as an identifier printed once, a value already superseded on disk, or an observation made at one moment."
  },
  {
    id: "R3-unique",
    salt: "rerun criterion: an artefact no other step captured",
    rerun: "No other step in this span captured this exact content, so a later reader could only recover it by re-running the tool, and only if the underlying source has not changed since."
  },
  {
    id: "R4-cheap",
    salt: "rerun criterion: cost measured in agent steps",
    rerun: "Re-running this tool later is cheap: one call, unchanged inputs, and the same output. The result is easy to obtain again on demand."
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

function laterContextOf(entry, list) {
  const others = list.filter((o) => o !== entry).slice(0, 8)
    .map((o) => (o.name || "tool") + " on " + String(o.target || "").slice(0, 60));
  return others.length
    ? "Steps in the same span also touched: " + others.join("; ") + "."
    : "No earlier step in the span says anything about this result.";
}

function stateFor(entry, task, salt, index, list) {
  const base = verdictState({ ...entry, laterContext: laterContextOf(entry, list) }, { task });
  return base + NL + "Variant: " + salt + " (candidate " + (index + 1) + " of " + list.length + ")";
}

async function askOnce(state, needed, rerun, key, timeoutMs = 3500) {
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
          rerunnable: { type: "noul", instructions: rerun, criteria: { true: "cheap to obtain again", false: "one-off to obtain again" } }
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
  console.error("用法: node bench/decide-rerun-bench.mjs <session.jsonl.zstd> [更多会话...]");
  process.exit(2);
}

const key = decideKey();
const stats = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));

for (const file of files) {
  const raw = execSync("zstd -dc " + JSON.stringify(file), { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const messages = messagesOf(raw);
  const snapshot = inspectMessages(messages);
  const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
  const candidates = pickCandidates(entries, { maxEntries: MAX_ENTRIES, minEntryTokens: MIN_TOKENS });
  const task = taskOf(messages);
  console.log("会话 " + file.split("/").slice(-2)[0].slice(8, 16)
    + " · 工具结果 " + entries.length + " · 候选 " + candidates.length
    + " · 可寻 " + candidates.filter((e) => goldOf(e, messages, Math.floor(messages.length * 0.6)).recoverable).length
    + " / 不可寻 " + candidates.filter((e) => !goldOf(e, messages, Math.floor(messages.length * 0.6)).recoverable).length);

  const cutIndex = Math.floor(messages.length * 0.6);
  for (let i = 0; i < candidates.length; i += 1) {
    const entry = candidates[i];
    const gold = goldOf(entry, messages, cutIndex);
    const cells = [];
    for (const variant of VARIANTS) {
      try {
        const out = await askOnce(stateFor(entry, task, variant.salt, i, candidates), NEEDED_FIXED, variant.rerun, key);
        const action = verdictAction({
          pNeeded: out.p, pRerun: out.rp,
          neededMargin: out.m, rerunMargin: out.rm,
          minMargin: DECIDE_FOLD_DEFAULTS.minMargin
        });
        stats[variant.id].push({ ...out, action, recoverable: gold.recoverable });
        cells.push((action === "mechanical" ? " M  " : " *  ") + " r=" + out.rp.toFixed(2) + " m=" + out.rm.toFixed(2));
      } catch (error) {
        cells.push(" err ");
      }
    }
    console.log("  " + String(entry.tokens).padStart(6) + "  " + cells.join(" |")
      + "   可寻=" + (gold.recoverable ? "Y" : "n") + "  " + entry.target.slice(0, 34));
  }
  console.log("");
}

console.log("=".repeat(86));
console.log("变体          样本 keep drop trunc mech | 判「不可重跑」的条目里 gold 不可寻 | gold 不可寻中被判不可重跑");
console.log("                              (精确率 = 该问句挑得准不准)              (召回率 = 该问句漏不漏)");
for (const variant of VARIANTS) {
  const rows = stats[variant.id].filter(Boolean);
  if (!rows.length) { console.log(variant.id.padEnd(14) + " 全部失败"); continue; }
  const cnt = (a) => rows.filter((r) => r.action === a).length;
  const negs = rows.filter((r) => (r.rp === null ? 0 : r.rp) < 0.5);
  const negTrue = negs.filter((r) => r.recoverable === false).length;
  const goldNeg = rows.filter((r) => r.recoverable === false);
  const goldNegHit = goldNeg.filter((r) => (r.rp === null ? 0 : r.rp) < 0.5).length;
  const prec = negs.length ? (Math.round(100 * negTrue / negs.length) + "%") : "—";
  const rec = goldNeg.length ? (Math.round(100 * goldNegHit / goldNeg.length) + "%") : "—";
  console.log(variant.id.padEnd(14)
    + String(rows.length).padStart(5)
    + String(cnt("keep")).padStart(5)
    + String(cnt("drop")).padStart(5)
    + String(cnt("truncate")).padStart(6)
    + String(cnt("mechanical")).padStart(5)
    + "  | " + negTrue + "/" + negs.length + " " + prec.padStart(5)
    + "                    | " + goldNegHit + "/" + goldNeg.length + " " + rec.padStart(5));
}
console.log("");
console.log("读法：keep 是唯一会把内容捞回卡片的动作（fold.js 只对 keep 恢复 14 行）。");
console.log("      判「不可重跑」= rerun 概率 < 0.5，即判定器认为重取代价高或不可重取。");
console.log("      gold 不可寻 = 折页点之后该目标既没被重取也没被改写，内容已无处可寻。");

