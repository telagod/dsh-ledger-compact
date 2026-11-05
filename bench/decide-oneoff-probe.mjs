#!/usr/bin/env node
/**
 * 可行性验证：如果候选池装的是一次性条目，判定式折页能产生 keep 吗？
 *
 * 前提：candidate-pool-audit 实测一次性条目占全部 token 10.5%，却只拿到候选池 5.4%，
 * 6 个会话里 3 个一条都没进 —— pickCandidates 按 token 降序取前 12，天然只装 read/load 类。
 * 但修候选池之前必须先验一件事：判定器面对一次性条目（命令输出、检查结果、取回的内容）
 * 会不会真的判「不可重跑」。若它仍一律答「可重跑」，那 keep 依旧不可达，候选池怎么改都没用。
 *
 * 用法: node bench/decide-oneoff-probe.mjs <session.jsonl.zstd> [更多会话...]
 */
import { execSync } from "node:child_process";
import { inspectMessages } from "../lib/fold.js";
import { verdictState, verdictAction, DECIDE_FOLD_DEFAULTS, Q_NEEDED, Q_RERUN } from "../lib/decide-fold.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);
const MAX = 12;

const REUSABLE = /^(read|load|view|inspect|list|search|grep|show|cat|open|find|summarize|describe|import)/i;

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

async function askOnce(state, key, timeoutMs = 3500) {
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
          needed: { type: "noul", instructions: Q_NEEDED, criteria: { true: "still needed", false: "no longer needed" } },
          rerunnable: { type: "noul", instructions: Q_RERUN, criteria: { true: "reproduces it", false: "one-off" } }
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
  console.error("用法: node bench/decide-oneoff-probe.mjs <session.jsonl.zstd> [更多会话...]");
  process.exit(2);
}

const key = decideKey();
const tally = { keep: 0, drop: 0, truncate: 0, mechanical: 0 };
let asked = 0;
let reusableSeen = 0;

for (const file of files) {
  const raw = execSync("zstd -dc " + JSON.stringify(file), { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const messages = messagesOf(raw);
  const snapshot = inspectMessages(messages);
  const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
  const task = taskOf(messages);

  // 与 pickCandidates 同一套门槛，只把 reusable 类排除掉。
  const pool = entries
    .filter((e) => e.tokens >= 200)
    .filter((e) => !REUSABLE.test(String(e.target || "").trim().split(/\s+/)[0] || ""))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX);

  console.log("会话 " + file.split("/").slice(-2)[0].slice(8, 16)
    + " · 非 reusable 条目 " + entries.filter((e) => !REUSABLE.test(String(e.target || "").trim().split(/\s+/)[0] || "")).length
    + " · 取最大 " + pool.length);

  for (let i = 0; i < pool.length; i += 1) {
    const entry = pool[i];
    const others = pool.filter((o) => o !== entry).slice(0, 8)
      .map((o) => (o.name || "tool") + " on " + String(o.target || "").slice(0, 60));
    const later = others.length
      ? "Steps in the same span also touched: " + others.join("; ") + "."
      : "No earlier step in the span says anything about this result.";
    const state = verdictState({ ...entry, laterContext: later }, { task })
      + NL + "Variant: probe index: oneoff (candidate " + (i + 1) + " of " + pool.length + ")";
    try {
      const out = await askOnce(state, key);
      const action = verdictAction({
        pNeeded: out.p, pRerun: out.rp,
        neededMargin: out.m, rerunMargin: out.rm,
        minMargin: DECIDE_FOLD_DEFAULTS.minMargin
      });
      tally[action] += 1;
      asked += 1;
      if (REUSABLE.test(String(entry.target || "").trim().split(/\s+/)[0] || "")) reusableSeen += 1;
      console.log("  " + String(entry.tokens).padStart(6) + "  "
        + action.padEnd(11) + " n=" + out.p.toFixed(2) + "/" + out.m.toFixed(2)
        + " r=" + out.rp.toFixed(2) + "/" + out.rm.toFixed(2)
        + "  " + entry.target.slice(0, 40));
    } catch (error) {
      console.log("  " + String(entry.tokens).padStart(6) + "  err " + error.message);
    }
  }
  console.log("");
}

console.log("=".repeat(70));
console.log("一次性条目候选池 · 判定 " + asked + " 条"
  + " · keep " + tally.keep + " · drop " + tally.drop
  + " · truncate " + tally.truncate + " · mechanical " + tally.mechanical);
console.log("keep 是唯一会把内容捞回卡片的动作。keep > 0 说明候选池值得修；keep = 0 说明换候选池也没用。");

