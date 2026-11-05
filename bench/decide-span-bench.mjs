#!/usr/bin/env node
/**
 * 判定式压缩的净增量对撞：多结果 span 上，判定臂 vs 现役机械摘录臂。
 *
 * 为什么另起脚本：fidelity-bench 测的是「单个文件被压缩后还能答对多少」，而判定式压缩的
 * 收益来自「删掉已经没用的结果」——那要求 span 里同时存在仍需要的与已被取代的结果。
 * 这是另一种形状，硬塞进现有 fixture 表会把两种结论混在一起。
 *
 * 两臂（判定臂是现役臂的增强，不是替代：它保留摘录与 digest，只多一个「整条删除」动作）：
 *   excerpt-digest  每条结果 -> 头 16 行 + 省略注记 + 尾 8 行 + 整文件计数
 *   decide-quadrant 先判定每条 -> 不需要且可重跑的整条删除，其余同上
 *
 * 度量：准确率（问题只问仍需要的内容）+ provider 报的 prompt_tokens。
 * 用法：node bench/decide-span-bench.mjs [--repeats 3] [--json]
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { matches } from "./match.mjs";

const NL = String.fromCharCode(10);
const MODEL = process.env.SPAN_MODEL || "deepseek-flash";
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const CREDENTIALS = join(process.env.DSH_HOME ?? "/Users/lanws/.dsh", ".credentials.yaml");
const DECIDE = process.env.DECIDE_ENDPOINT || "http://127.0.0.1:4000/v1/decide/batch";
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf("--" + name);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const REPEATS = Math.max(1, Number(flag("repeats", "2")) || 2);
const JSON_OUT = argv.includes("--json");

function credential(ref) {
  if (process.env[ref]) return process.env[ref];
  // 本机纪律：key 只在钥匙串维护一份，文件里通常没有。
  try {
    const fromKeychain = execSync("ga-keys get " + ref, { encoding: "utf8" }).trim();
    if (fromKeychain) return fromKeychain;
  } catch { /* fall through to the file */ }
  const text = readFileSync(CREDENTIALS, "utf8");
  const m = text.match(new RegExp("^\\s*" + ref + ":\\s*(\\S+)\\s*$", "m"));
  if (!m) throw new Error("credential " + ref + " not found");
  return m[1].replace(/["']/g, "");
}

function decideKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync("ga-keys get LITELLM_MASTER_KEY", { encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------- 现役摘录（与插件同形）
const HEAD = 16, TAIL = 8;
function snapExcerpt(text) {
  const lines = String(text).split(NL);
  if (lines.length <= HEAD + TAIL) return String(text);
  const skipped = lines.length - HEAD - TAIL;
  return lines.slice(0, HEAD).join(NL)
    + NL + "… (" + skipped + " lines elided; re-read with offset/limit) …" + NL
    + lines.slice(-TAIL).join(NL);
}
function tokenDigest(text) {
  const counts = new Map();
  for (const raw of String(text).split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");
    if (!token || token.length > 16) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const rows = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return rows.length ? "whole-file totals: " + rows.map(([t, n]) => t + "×" + n).join(" · ") : "";
}
function excerptOf(entry) {
  const digest = tokenDigest(entry.text);
  return "[tool " + entry.tool + "] " + snapExcerpt(entry.text) + (digest ? NL + digest : "");
}

// ---------------------------------------------------------------- span
const R1 = [
  "# config module", "DEFAULTS = {}", "RETRY_LIMIT = 7",
  ...Array.from({ length: 300 }, (_, i) => "setting_" + i + " = " + ((i * 7) % 100)),
  "TAIL_MARKER = 4242"
].join(NL);
const R3 = Array.from({ length: 400 }, (_, i) =>
  "10.0." + (i % 256) + "." + ((i * 7) % 256) + " GET /api/v1/items/" + i + " " + (i % 37 === 0 ? 503 : 200)
).join(NL);
const STALE = (tag) => ["# build output " + tag, ...Array.from({ length: 250 }, (_, i) => tag + " step " + i + " ok dur=" + ((i * 13) % 400) + "ms")].join(NL);
const R4 = "npm run build -> ok, BUILD_ID 7f3a91c2 (single-use, not reproducible)";

const STALE_ENTRIES = [
  { id: "stale-a", tool: "bash", text: STALE("alpha"), status: "superseded", note: "an earlier exploratory build; its output was already read and later steps moved past it" },
  { id: "stale-b", tool: "bash", text: STALE("beta"), status: "superseded", note: "an earlier exploratory listing; the target file was located afterwards" },
  { id: "stale-c", tool: "bash", text: STALE("gamma"), status: "superseded", note: "an earlier lint dump; the issues it named were fixed in a later edit" }
];
const LIVE_ENTRIES = [
  { id: "live-config", tool: "read", text: R1, status: "live", note: "the current task edits this very file" },
  { id: "live-log", tool: "bash", text: R3, status: "live", note: "the current task counts a status code in this log" },
  { id: "live-build", tool: "bash", text: R4, status: "live", note: "the build id is single-use and cannot be reproduced" }
];
/** --stale N 控制 span 里「已被取代」的结果条数：真实会话里这个比例远低于一半。 */
const SPAN = [...STALE_ENTRIES.slice(0, Math.max(0, Number(flag("stale", "3")) || 0)), ...LIVE_ENTRIES];

const TASK = "Tighten the retry policy in the config module and report how many requests failed in the access log.";

const QUESTIONS = [
  { q: "What is the value of RETRY_LIMIT in the config module? Answer with the number only.", a: "7", about: "live-config" },
  { q: "How many requests in the access log returned status 503? Answer with a number.", a: String(Array.from({ length: 400 }, (_, i) => i % 37 === 0).filter(Boolean).length), about: "live-log" },
  { q: "What is the BUILD_ID printed by the build output? Answer with the id only.", a: "7f3a91c2", about: "live-build" },
  { q: "What is the value of TAIL_MARKER in the config module? Answer with the number only.", a: "4242", about: "live-config" }
];

// ---------------------------------------------------------------- 判定（四象限矩阵）
const Q_NEEDED = "The contents of this tool result are still needed to finish the current task.";
const Q_RERUN = "If this tool result were dropped, could the same information be obtained again by re-running the same tool call?";

async function decideSpan(key) {
  const out = new Map();
  for (const entry of SPAN) {
    const head = entry.text.slice(0, 900);
    const state = [
      "User request: " + TASK,
      "Earlier tool call: " + entry.tool + " -> ok, " + entry.text.split(NL).length + " lines.",
      "Result head: " + head.replace(/\s+/g, " ").slice(0, 700),
      "Later context: " + entry.note + "."
    ].join(NL);
    const res = await fetch(DECIDE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ state, questions: {
        needed: { type: "noul", instructions: Q_NEEDED, criteria: { true: "still needed", false: "no longer needed" } },
        rerunnable: { type: "noul", instructions: Q_RERUN, criteria: { true: "reproduces it", false: "one-off" } }
      } })
    });
    const json = await res.json();
    const inner = json.result ?? json;
    const answers = inner.answers ?? inner;
    const pNeeded = answers?.needed?.probability ?? null;
    const pRerun = answers?.rerunnable?.probability ?? null;
    const action = pNeeded === null || pRerun === null ? "keep"
      : pNeeded >= 0.5 ? (pRerun >= 0.5 ? "truncate" : "keep")
      : (pRerun >= 0.5 ? "drop" : "keep");
    out.set(entry.id, { action, pNeeded, pRerun });
  }
  return out;
}

// ---------------------------------------------------------------- 组装上下文
function buildContext(arm, decisions) {
  const parts = [];
  for (const entry of SPAN) {
    if (arm === "decide-quadrant") {
      const d = decisions.get(entry.id);
      if (d.action === "drop") { parts.push("[tool " + entry.tool + "] " + entry.id + ": dropped as superseded and reproducible."); continue; }
      if (d.action === "keep") { parts.push("[tool " + entry.tool + "] " + entry.text); continue; }
    }
    parts.push(excerptOf(entry));
  }
  return parts.join(NL + NL);
}

async function askOnce(key, context, question) {
  const prompt = "Context from the session:" + NL + context + NL + NL + "Question: " + question + NL + "Answer with the value only.";
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 200, stream: false })
  });
  const text = await res.text();
  if (res.status !== 200) return { error: res.status + " " + text.slice(0, 140) };
  const json = JSON.parse(text);
  return {
    answer: json.choices?.[0]?.message?.content ?? "",
    promptTokens: json.usage?.prompt_tokens ?? null
  };
}

// ---------------------------------------------------------------- main
const modelKey = credential("DEEPSEEK_API_KEY");
const decisions = await decideSpan(decideKey());

const arms = ["excerpt-digest", "decide-quadrant"];
const results = [];
for (const arm of arms) {
  const context = buildContext(arm, decisions);
  for (const item of QUESTIONS) {
    for (let r = 0; r < REPEATS; r += 1) {
      const out = await askOnce(modelKey, context, item.q);
      results.push({ arm, q: item.q.slice(0, 40), ok: out.error ? false : matches(out.answer, item.a),
        answer: String(out.answer ?? "").slice(0, 24), expect: item.a, tokens: out.promptTokens, error: out.error ?? null });
    }
  }
}

const summary = arms.map((arm) => {
  const rows = results.filter((x) => x.arm === arm);
  const ok = rows.filter((x) => x.ok).length;
  const tok = rows.map((x) => x.tokens).filter((n) => typeof n === "number");
  const avg = tok.length ? Math.round(tok.reduce((a, b) => a + b, 0) / tok.length) : null;
  return { arm, correct: ok, total: rows.length, avgPromptTokens: avg,
    decisions: arm === "decide-quadrant" ? Object.fromEntries([...decisions].map(([k, v]) => [k, v.action])) : null };
});

if (JSON_OUT) { console.log(JSON.stringify({ summary, decisions: [...decisions], results }, null, 2)); }
else {
  console.log("臂 | 正确 | 平均 prompt_tokens");
  console.log("-".repeat(64));
  for (const s of summary) {
    console.log(s.arm.padEnd(17) + " | " + (s.correct + "/" + s.total).padEnd(5) + " | " + s.avgPromptTokens);
  }
  console.log("-".repeat(64));
  console.log("判定动作：" + JSON.stringify(Object.fromEntries([...decisions].map(([k, v]) => [k, v.action]))));
  console.log("判定细节：" + [...decisions].map(([k, v]) => k + " n=" + v.pNeeded + " r=" + v.pRerun).join(" | "));
  const a = summary[0], b = summary[1];
  if (a.avgPromptTokens && b.avgPromptTokens) {
    const saved = Math.round((1 - b.avgPromptTokens / a.avgPromptTokens) * 1000) / 10;
    console.log("判定臂相对现役臂：token " + (saved >= 0 ? "-" : "+") + Math.abs(saved) + "% · 正确 " + (b.correct - a.correct >= 0 ? "+" : "") + (b.correct - a.correct));
  }
}