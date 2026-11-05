#!/usr/bin/env node
/**
 * 真实会话上的判定式折页扫描。
 *
 * 为什么另起脚本：decide-span-bench.mjs 的 span 是手搓的，它能回答「判定臂相对机械臂
 * 省不省」，但回答不了「真实会话里这次折页到底有多少可判定面」。本脚本直接解压一条
 * 真实 session.jsonl.zstd，按事件流重建消息，喂给插件自己的 inspectMessages，
 * 再用 --decide 跑一次真判定，报出象限分布。
 *
 * 用法：node bench/fold-live-scan.mjs <session.jsonl.zstd> [--decide] [--limit N]
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inspectMessages, foldSummary, foldSummaryDecided } from "../lib/fold.js";
import { pickCandidates, decideEntries, describeVerdicts, verdictState } from "../lib/decide-fold.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const flag = (name) => { const i = argv.indexOf("--" + name); return i === -1 ? undefined : argv[i + 1]; };
const WANT_DECIDE = argv.includes("--decide");
/** 端到端：真的折一次页，走 foldSummaryDecided 全链路。 */
const WANT_FOLD = argv.includes("--fold");
const MAX_ENTRIES = Number(flag("limit") || 12);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

function decideKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync("ga-keys get LITELLM_MASTER_KEY", { encoding: "utf8" }).trim();
}

/** 事件流 -> 消息数组。键名与 dsh 的 message 结构一致：data 本身或 data.message。 */
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

/** 真实的用户请求：最后一条用户来源的消息，跳过插件注入。 */
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

if (!file) {
  console.error("用法: node bench/fold-live-scan.mjs <session.jsonl.zstd> [--decide] [--limit N]");
  process.exit(2);
}

const raw = execSync("zstd -dc " + JSON.stringify(file), { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const messages = messagesOf(raw);
const snapshot = inspectMessages(messages);
const entries = snapshot.entries.map((entry) => ({ ...entry, tokens: estTokensUtf8(entry.text) }));
const totalTokens = entries.reduce((n, e) => n + e.tokens, 0);
const candidates = pickCandidates(entries, { maxEntries: MAX_ENTRIES });

const byKind = {};
for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;

console.log("会话    : " + file.split("/").slice(-2).join("/"));
console.log("消息    : " + messages.length + " 条");
console.log("工具结果: " + entries.length + " 条 · " + totalTokens + " tok · " + JSON.stringify(byKind));
console.log("卡片保留: " + snapshot.excerptLines.length + " 行摘要 · 文件 " + (snapshot.reads.length + snapshot.edits.length)
  + " · 命令 " + snapshot.commands.length + " · 错误 " + snapshot.errors.length);
console.log("候选    : " + candidates.length + " 条（>=200 tok，取最大的 " + MAX_ENTRIES + "）");
for (const entry of candidates.slice(0, MAX_ENTRIES)) {
  console.log("  " + String(entry.tokens).padStart(7) + " tok  " + entry.kind.padEnd(5) + " " + entry.name.padEnd(8) + " " + entry.target.slice(0, 60));
}

const task = taskOf(messages);
console.log("请求    : " + (task ? task.replace(/\s+/g, " ").slice(0, 90) : "(没有用户消息)"));

if (!WANT_DECIDE && !WANT_FOLD) {
  console.log(NL + "（加 --decide 跑真判定，--fold 跑端到端折页）");
  process.exit(0);
}

process.env.LITELLM_MASTER_KEY = decideKey();

if (WANT_DECIDE) {
  const started = Date.now();
  const verdicts = await decideEntries(candidates, { maxEntries: MAX_ENTRIES, task });
  const elapsed = Date.now() - started;
  console.log(NL + "判定    : " + describeVerdicts(verdicts) + "  (实测墙钟 " + elapsed + "ms)");
  for (const entry of candidates) {
    const v = verdicts.get(entry.id) || {};
    console.log("  " + String(entry.tokens).padStart(7) + " tok  " + String(v.action).padEnd(10)
      + " n=" + (v.pNeeded === null || v.pNeeded === undefined ? "—" : Number(v.pNeeded).toFixed(2))
      + " m=" + (v.neededMargin === null || v.neededMargin === undefined ? "—" : Number(v.neededMargin).toFixed(2))
      + " r=" + (v.pRerun === null || v.pRerun === undefined ? "—" : Number(v.pRerun).toFixed(2))
      + " rm=" + (v.rerunMargin === null || v.rerunMargin === undefined ? "—" : Number(v.rerunMargin).toFixed(2))
      + (v.error ? "   ERR: " + v.error : "")
      + "  " + entry.target.slice(0, 40));
  }
  const state = verdictState(candidates[0], { task });
  console.log(NL + "首条判定 state 长度: " + state.length + " 字符");
}

if (WANT_FOLD) {
  const plain = foldSummary({ messages });
  const started = Date.now();
  const decided = await foldSummaryDecided({ messages }, { maxEntries: MAX_ENTRIES });
  const elapsed = Date.now() - started;
  const plainText = plain.summary[0].text;
  const decidedText = decided.summary[0].text;
  console.log(NL + "=== 端到端折页（真实判定）===");
  console.log("机械卡  : " + plainText.length + " 字符 / " + estTokensUtf8(plainText) + " tok");
  console.log("判定卡  : " + decidedText.length + " 字符 / " + estTokensUtf8(decidedText) + " tok");
  console.log("卡片相同: " + (plainText === decidedText) + "  墙钟 " + elapsed + "ms");
  const blocks = Array.isArray(decided.rawOutput) ? decided.rawOutput : [];
  console.log("rawOutput 块数: " + blocks.length);
  for (const block of blocks) {
    console.log("--- rawOutput ---");
    console.log(String(block.text).slice(0, 1500));
  }
  console.log("--- 卡片尾部 300 字符 ---");
  console.log(decidedText.slice(-300));
}