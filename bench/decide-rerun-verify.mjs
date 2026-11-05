#!/usr/bin/env node
/**
 * 落地前验证：用最终生产问句（criteria 自洽、salt 中性）复验 keep 格是否可达。
 *
 * 为什么重验：decide-shape-bench 里每个变体带语义化 salt，而 DECIDE-FINDINGS 实测措辞
 * 效应量 0.32 —— salt 本身会扰动判定。本脚本对所有臂用中性、无方向的区分串，
 * 让差异只来自问句本身与 criteria 方向。
 *
 * 用法: node bench/decide-rerun-verify.mjs <session.jsonl.zstd> [更多会话...]
 */
import { execSync } from "node:child_process";
import { inspectMessages } from "../lib/fold.js";
import { pickCandidates, verdictState, verdictAction, DECIDE_FOLD_DEFAULTS } from "../lib/decide-fold.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);
const MIN_TOKENS = Number(process.env.MIN_TOKENS || 200);
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 12);

const NEEDED_PROD = "The contents of this tool result are still needed to finish the current task.";

const VARIANTS = [
  {
    id: "P0-current",
    salt: "verification index: 4",
    rerun: "If this tool result were dropped, could the same information be obtained again by re-running the same tool call?",
    crit: { true: "reproduces it", false: "one-off" }
  },
  {
    id: "F1-cheap",
    salt: "verification index: 5",
    rerun: "If this tool result were dropped, could the same information be obtained again cheaply — by re-running the same tool call, or from another step in this session — or is it one-off state that a re-run would not reproduce: an identifier printed once, a value already superseded on disk, or an observation made at one moment?",
    crit: { true: "cheap to obtain again", false: "one-off to obtain again" }
  },
  {
    id: "F2-cheap-alt",
    salt: "verification index: 6",
    rerun: "Imagine the fold has happened and a later step needs this information. Is obtaining it again easy and certain, or is this one-off state that nothing in the session can reproduce — a unique id, a value since changed on disk, a single observation in time?",
    crit: { true: "cheap to obtain again", false: "one-off to obtain again" }
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

function goldOf(entry, messages, cutIndex) {
  const needle = String(entry.target || "").trim();
  const stem = needle.length > 24 ? needle.slice(0, 24) : needle;
  let hits = 0;
  for (let i = cutIndex; i < messages.length; i += 1) {
    const text = JSON.stringify(messages[i] && messages[i].content ? messages[i].content : messages[i]);
    if (stem && text.includes(stem)) hits += 1;
  }
  return hits > 0;
}

async function askOnce(state, needed, rerun, crit, key, timeoutMs = 3500) {
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
          rerunnable: { type: "noul", instructions: rerun, criteria: crit }
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

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node bench/decide-rerun-verify.mjs <session.jsonl.zstd> [更多会话...]");
  process.exit(2);
}

const key = decideKey();
const stats = Object.fromEntries(VARIANTS.map((v) => [v.id, []]));
const goldRows = [];
let keptTokens = Object.fromEntries(VARIANTS.map((v) => [v.id, 0]));

for (const file of files) {
  const raw = execSync("zstd -dc " + JSON.stringify(file), { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const messages = messagesOf(raw);
  const snapshot = inspectMessages(messages);
  const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
  const candidates = pickCandidates(entries, { maxEntries: MAX_ENTRIES, minEntryTokens: MIN_TOKENS });
  const task = taskOf(messages);
  const cutIndex = Math.floor(messages.length * 0.6);
  const totalTokens = entries.reduce((n, e) => n + e.tokens, 0);
  console.log("会话 " + file.split("/").slice(-2)[0].slice(8, 16)
    + " · 工具结果 " + entries.length + " 条 / " + totalTokens + " tok"
    + " · 候选 " + candidates.length + " / 候选合计 " + candidates.reduce((n, e) => n + e.tokens, 0) + " tok");

  for (let i = 0; i < candidates.length; i += 1) {
    const entry = candidates[i];
    const recoverable = goldOf(entry, messages, cutIndex);
    const state = verdictState({ ...entry, laterContext: laterContextOf(entry, candidates) }, { task })
      + NL + "Variant: " + (VARIANTS[0].salt) + " placeholder";
    const cells = [];
    for (const variant of VARIANTS) {
      const vstate = state.replace("Variant: " + VARIANTS[0].salt + " placeholder",
        "Variant: " + variant.salt + " (candidate " + (i + 1) + " of " + candidates.length + ")");
      try {
        const out = await askOnce(vstate, NEEDED_PROD, variant.rerun, variant.crit, key);
        const action = verdictAction({
          pNeeded: out.p, pRerun: out.rp,
          neededMargin: out.m, rerunMargin: out.rm,
          minMargin: DECIDE_FOLD_DEFAULTS.minMargin
        });
        stats[variant.id].push({ ...out, action, recoverable });
        if (action === "keep") keptTokens[variant.id] += entry.tokens;
        cells.push((action === "mechanical" ? " M  " : " *  ") + " n=" + out.p.toFixed(2) + " r=" + out.rp.toFixed(2) + "/" + out.rm.toFixed(2));
      } catch (error) {
        cells.push(" err ");
      }
    }
    console.log("  " + String(entry.tokens).padStart(6) + "  " + cells.join(" |")
      + "   可寻=" + (recoverable ? "Y" : "n") + "  " + entry.target.slice(0, 32));
  }
  console.log("");
}

console.log("=".repeat(88));
console.log("变体           样本 keep drop trunc mech | keep 的精确率  召回率 | keep 捞回的原始体积");
for (const variant of VARIANTS) {
  const rows = stats[variant.id].filter(Boolean);
  if (!rows.length) continue;
  const cnt = (a) => rows.filter((r) => r.action === a).length;
  const keeps = rows.filter((r) => r.action === "keep");
  const goldNeg = rows.filter((r) => r.recoverable === false);
  const goldNegHit = goldNeg.filter((r) => r.action === "keep").length;
  const prec = keeps.length ? Math.round(100 * keeps.filter((r) => r.recoverable === false).length / keeps.length) + "%" : "—";
  const rec = goldNeg.length ? Math.round(100 * goldNegHit / goldNeg.length) + "%" : "—";
  console.log(variant.id.padEnd(15)
    + String(rows.length).padStart(5)
    + String(cnt("keep")).padStart(5)
    + String(cnt("drop")).padStart(5)
    + String(cnt("truncate")).padStart(6)
    + String(cnt("mechanical")).padStart(5)
    + " | " + prec.padStart(12) + "  " + rec.padStart(5)
    + " | " + (keptTokens[variant.id] + " tok"));
}
console.log("");
console.log("keep 的精确率 = 被 keep 且事后确实无处可寻的占比（高=捞得准，不白花 token）");
console.log("keep 的召回率 = 事后无处可寻的条目里被捞回的比例（高=漏得少，不误删）");

