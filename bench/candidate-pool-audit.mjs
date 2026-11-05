#!/usr/bin/env node
/**
 * 候选池审计：判定式折页挑候选的方式，会不会把「不可重跑」的条目全排除在外。
 *
 * 2026-10-04 实测：四个真实会话 48 条候选、三个自洽问句臂，keep 一律为 0。
 * 判定器对「读文件 / 加载 skill」一律答「可重跑」——而这是正确答案，于是 keep 格不可达。
 * 若候选池按 token 降序只装这类条目，判定式折页就永远没有可捞的东西。
 *
 * 用法: node bench/candidate-pool-audit.mjs <session.jsonl.zstd> [更多会话...]
 */
import { execSync } from "node:child_process";
import { inspectMessages } from "../lib/fold.js";
import { pickCandidates } from "../lib/decide-fold.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

/** target 首词即动词。读/加载类可重跑；运行/检查/取回类产出的是一次性输出。 */
const REUSABLE_VERBS = /^(read|load|view|inspect|list|search|grep|show|cat|open|find|summarize|describe|fetch-skill|import)/i;
const ONEOFF_VERBS = /^(run|check|test|verify|build|install|fetch|gather|collect|curl|gh|query|call|scan|dry)/i;

function classify(entry) {
  const target = String(entry.target || "").trim();
  const verb = (target.split(/\s+/)[0] || "(none)");
  if (REUSABLE_VERBS.test(verb)) return "reusable";
  if (ONEOFF_VERBS.test(verb)) return "one-off";
  return "other";
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

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node bench/candidate-pool-audit.mjs <session.jsonl.zstd> [更多会话...]");
  process.exit(2);
}

const poolAll = { reusable: [], "one-off": [], other: [] };
const poolPick = { reusable: [], "one-off": [], other: [] };
const verbTally = new Map();

for (const file of files) {
  const raw = execSync("zstd -dc " + JSON.stringify(file), { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const messages = messagesOf(raw);
  const snapshot = inspectMessages(messages);
  const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
  const picked = pickCandidates(entries, { maxEntries: 12, minEntryTokens: 200 });
  const pickedIds = new Set(picked.map((e) => e.id));

  for (const entry of entries) {
    const kind = classify(entry);
    poolAll[kind].push(entry.tokens);
    if (pickedIds.has(entry.id)) poolPick[kind].push(entry.tokens);
  }
  for (const entry of entries) {
    const verb = (String(entry.target || "").trim().split(/\s+/)[0] || "(none)").toLowerCase();
    const cur = verbTally.get(verb) || { n: 0, tok: 0 };
    cur.n += 1;
    cur.tok += entry.tokens;
    verbTally.set(verb, cur);
  }
  const oneOffTotal = entries.filter((e) => classify(e) === "one-off").reduce((n, e) => n + e.tokens, 0);
  const oneOffInPool = picked.filter((e) => classify(e) === "one-off").reduce((n, e) => n + e.tokens, 0);
  console.log(file.split("/").slice(-2)[0].slice(8, 16)
    + " · 全部 " + entries.length + " 条 / 候选 " + picked.length
    + " · 一次性条目 " + entries.filter((e) => classify(e) === "one-off").length
    + " 条(" + oneOffTotal + " tok), 进候选池 " + oneOffInPool + " tok");
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log("");
console.log("=".repeat(72));
console.log("类别        全部条数  全部 tok    候选池条数  候选池 tok   token 占比");
for (const kind of ["reusable", "one-off", "other"]) {
  const allTok = sum(poolAll[kind]);
  const pickTok = sum(poolPick[kind]);
  const share = allTok > 0 ? Math.round(100 * pickTok / Math.max(1, sum(poolAll.reusable, poolAll["one-off"], poolAll.other))) + "%" : "—";
  console.log(kind.padEnd(12)
    + String(poolAll[kind].length).padStart(7)
    + String(allTok).padStart(11)
    + String(poolPick[kind].length).padStart(12)
    + String(pickTok).padStart(12)
    + String(share).padStart(11));
}
console.log("");
console.log("首词分布（前 14，按 token）:");
const sorted = [...verbTally.entries()].sort((a, b) => b[1].tok - a[1].tok).slice(0, 14);
for (const [verb, s] of sorted) {
  console.log("  " + verb.padEnd(16) + String(s.n).padStart(5) + " 条 " + String(s.tok).padStart(9) + " tok  " + classify({ target: verb + " x" }));
}
console.log("");
console.log("读法：one-off = 首词属运行/检查/取回类，其产出多为一次性输出，丢了就找不回；");
console.log("      reusable = 首词属读/加载类，重读即可复现，判定器判「可重跑」是正确的。");
console.log("      若 one-off 的 token 占比远低于其在全部结果中的占比，候选选取就是漏的。");

