#!/usr/bin/env node
/**
 * 判定器门控标定：压缩判定问句（两问三档）在真实场景上有没有区分力？
 *
 * 为什么先做这一步：bench/fidelity-bench.mjs 的每个 fixture 都是「关于该文件的问答」，
 * 拿它去问判定器「这段结果还需要吗」必然答「需要」——那个形状测不出判定臂。
 * 端到端对撞之前，先花十几次判定调用确认判定器能不能区分，是便宜的 fail-fast。
 *
 * 四类场景，每类多个变体（类 1 含一个中文场景，贴近本机真实用法）：
 *   1 当前任务直接依赖  → 应【留】
 *   2 已被后续步骤取代  → 应【丢】
 *   3 内容可重跑得到    → 应【丢】或【截断】
 *   4 一次性、不可重跑  → 应【留】
 *
 * 判读：类 1/4 被判「丢」= 高危（删掉不可恢复的信息）→ 否决接线；
 *       类 2/3 被判「留」= 保守到没有收益；全对 = 值得进入端到端对撞。
 *
 * 用法：node bench/decide-calibration.mjs [--json]
 */
import { execSync } from "node:child_process";

const ENDPOINT = process.env.DECIDE_ENDPOINT || "http://127.0.0.1:4000/v1/decide/batch";
const JSON_OUT = process.argv.includes("--json");

function masterKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync("ga-keys get LITELLM_MASTER_KEY", { encoding: "utf8" }).trim();
}

const Q_CALL = "Knowing that this tool call happened, with the arguments it carried, is still important for finishing the current task.";
const Q_RESULT = "The contents of this tool result are still needed to finish the current task, and re-running the same tool call would not give the same information back.";
/** The same question with the conjunction removed: does the content matter, full stop? */
const Q_NEEDED = "The contents of this tool result are still needed to finish the current task.";
/** The reproducibility half, asked on its own instead of as a condition of the first. */
const Q_RERUN = "If this tool result were dropped, could the same information be obtained again by re-running the same tool call?";

/** 四类场景，每类多个 state 变体；换措辞是为了把「偶发」与「系统性偏差」分开。 */
const SCENARIOS = [
  {
    id: "1-still-needed",
    expect: "keep",
    why: "当前任务直接依赖这份内容",
    states: [
      ["User request: fix the failing parser test, and never edit anything under src/generated.",
       "Earlier tool call: read(file_path=src/parser.ts) -> ok, 180 lines.",
       "The result defines parseConfig(raw), which trims the input and returns null on an empty string.",
       "Current task: the user now asks which line of parseConfig handles the empty input.",
       "This is the only place that content exists; nothing has replaced it."].join(String.fromCharCode(10)),
      ["User request: the user is reading a 180-line source file to answer their next question about it.",
       "Tool call: read(file_path=src/parser.ts) -> ok, 180 lines.",
       "Current task: answer a question about the function defined inside this very result.",
       "The question cannot be answered without the lines of this result."].join(String.fromCharCode(10)),
      ["User request: diagnose why the parser test fails.",
       "Tool call: bash(command=npm test -- parser) -> ok, failure output naming src/parser.ts line 42.",
       "Current task: the user asks for the exact assertion message from that failure output.",
       "Nothing has re-run the test since; the message exists only in this result."].join(String.fromCharCode(10)),
      ["用户请求：修复 parser 的失败测试，先看清失败原因。",
       "此前的工具调用：read(file_path=src/parser.ts) -> ok，180 行源码。",
       "当前任务：用户紧接着问「parseConfig 里对空输入的处理在哪一行」。",
       "这份结果是唯一包含该函数的地方，之后没有任何步骤取代它。"].join(String.fromCharCode(10))
    ]
  },
  {
    id: "2-superseded",
    expect: "drop",
    why: "内容已被后续步骤取代",
    states: [
      ["User request: raise the request timeout from 30s to 60s in the defaults file.",
       "Earlier tool call: read(file_path=config/defaults.yaml) -> ok, 40 lines, timeout: 30.",
       "That read was followed by edit(config/defaults.yaml, timeout 30 -> 60), which succeeded.",
       "Current task: raise retries from 2 to 5 in the same file."].join(String.fromCharCode(10)),
      ["User request: rewrite the greeting in src/hello.ts.",
       "Earlier tool call: read(file_path=src/hello.ts) -> ok, 12 lines, the old greeting.",
       "The file was then rewritten in full by a later edit that the user approved.",
       "Current task: add a unit test for the new greeting."].join(String.fromCharCode(10)),
      ["User request: find where the retry policy is defined.",
       "Earlier tool call: bash(command=ls -R src) -> ok, a 300-line directory listing.",
       "Later steps narrowed it down and the file was already identified and opened.",
       "Current task: change the retry count in that identified file."].join(String.fromCharCode(10))
    ]
  },
  {
    id: "3-reproducible",
    expect: "drop",
    why: "同一命令随时可重跑",
    states: [
      ["User request: count how many requests in access.log returned status 503.",
       "Earlier tool call: bash(command=head -200 access.log) -> ok, 200 lines.",
       "The file is still on disk and the same command can be run again at any time."].join(String.fromCharCode(10)),
      ["User request: check whether the working tree is clean.",
       "Earlier tool call: bash(command=git status --short) -> ok, 6 lines.",
       "That command is stateless and can be repeated whenever needed."].join(String.fromCharCode(10)),
      ["User request: list the fixture files.",
       "Earlier tool call: bash(command=ls bench/*.mjs) -> ok, 6 file names.",
       "Nothing has changed on disk since; the same listing can be produced again."].join(String.fromCharCode(10))
    ]
  },
  {
    id: "4-one-off",
    expect: "keep",
    why: "一次性内容，重跑拿不到同样的值",
    states: [
      ["User request: fetch a short-lived session token and then call the downstream API with it.",
       "Earlier tool call: bash(command=curl -s https://api.internal/session) -> ok, one token string.",
       "The token is single-use and a second call would mint a different one."].join(String.fromCharCode(10)),
      ["User request: correlate this build against the CI logs.",
       "Earlier tool call: bash(command=npm run build) -> ok, printing build id 7f3a91c2 at the end.",
       "That build id cannot be reproduced; a new build gets a new id."].join(String.fromCharCode(10)),
      ["User request: answer follow-up questions about the dataset the user pasted.",
       "Earlier tool call: the user pasted a 60-row dataset directly into the conversation.",
       "It came from the user, is not stored anywhere, and cannot be fetched again."].join(String.fromCharCode(10))
    ]
  }
];

async function ask(state, key) {
  const body = {
    state,
    questions: {
      keep_call: { type: "noul", instructions: Q_CALL, criteria: { true: "still important", false: "no longer matters" } },
      keep_result: { type: "noul", instructions: Q_RESULT, criteria: { true: "still needed verbatim", false: "safe to drop or truncate" } },
      needed: { type: "noul", instructions: Q_NEEDED, criteria: { true: "still needed", false: "no longer needed" } },
      rerunnable: { type: "noul", instructions: Q_RERUN, criteria: { true: "re-running reproduces it", false: "one-off, cannot be reproduced" } }
    }
  };
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { error: "non-json: " + text.slice(0, 160) }; }
  if (!res.ok) return { error: "http " + res.status + ": " + text.slice(0, 160) };
  const inner = json.result ?? json;
  return { answers: inner.answers ?? inner, latency: Date.now() - started };
}

const key = masterKey();
const rows = [];
const perClass = new Map();

for (const scenario of SCENARIOS) {
  for (let i = 0; i < scenario.states.length; i += 1) {
    const id = scenario.id + "-" + "abcd"[i];
    const out = await ask(scenario.states[i], key);
    if (out.error) { console.log("ERROR " + id + ": " + out.error); process.exitCode = 1; continue; }
    const keepCall = out.answers?.keep_call ?? {};
    const keepResult = out.answers?.keep_result ?? {};
    const needed = out.answers?.needed ?? {};
    const rerun = out.answers?.rerunnable ?? {};
    const p = typeof keepResult.probability === "number" ? keepResult.probability : null;
    const verdict = p === null ? "?" : (p >= 0.5 ? "keep" : "drop");
    const ok = verdict === scenario.expect;
    const dangerous = !ok && verdict === "drop" && scenario.expect === "keep";
    const bucket = perClass.get(scenario.id) ?? { ok: 0, total: 0, dangerous: 0 };
    bucket.total += 1;
    if (ok) bucket.ok += 1;
    if (dangerous) bucket.dangerous += 1;
    perClass.set(scenario.id, bucket);
    const pNeeded = typeof needed.probability === "number" ? needed.probability : null;
    const pRerun = typeof rerun.probability === "number" ? rerun.probability : null;
    // 四象限决策：内容还需要就绝不删；只有「不需要且能重跑」才允许丢弃；
    // 「不需要但不可重跑」必须留——这类一旦删掉就是永久信息丢失。
    const matrix = pNeeded === null || pRerun === null ? "?"
      : pNeeded >= 0.5 ? (pRerun >= 0.5 ? "truncate" : "keep")
      : (pRerun >= 0.5 ? "drop" : "keep");
    const matrixSafe = !(scenario.expect === "keep" && matrix === "drop");
    const verdictNeeded = pNeeded === null ? "?" : (pNeeded >= 0.5 ? "keep" : "drop");
    const okNeeded = verdictNeeded === scenario.expect;
    rows.push({ id, expect: scenario.expect, verdict, ok, dangerous, p_result: p,
      p_needed: pNeeded, verdict_needed: verdictNeeded, ok_needed: okNeeded,
      p_rerun: pRerun, matrix, matrixSafe,

      m_result: keepResult.margin ?? null,
      p_call: typeof keepCall.probability === "number" ? keepCall.probability : null,
      latency_ms: out.latency });
  }
}

const dangerous = rows.filter((x) => x.dangerous).length;
const wrong = rows.filter((x) => !x.ok).length;
const wrongNeeded = rows.filter((x) => !x.ok_needed).length;
const dangerNeeded = rows.filter((x) => !x.ok_needed && x.verdict_needed === "drop" && x.expect === "keep").length;
const unsafe = rows.filter((x) => !x.matrixSafe).length;
const actions = {};
for (const x of rows) actions[x.matrix] = (actions[x.matrix] ?? 0) + 1;

if (JSON_OUT) {
  // 三个口径必须一起给:只报合取式口径,会把「四象限其实全安全」读成「高危误删 4 条」。
  // 真实代码路径(lib/decide-fold.js 的 verdictAction)走的是四象限,合取式只是历史对照。
  console.log(JSON.stringify({
    rows,
    compound: { ok: rows.length - wrong, wrong, dangerous },
    split: { ok: rows.length - wrongNeeded, wrong: wrongNeeded, dangerous: dangerNeeded },
    quadrant: { ok: rows.length - unsafe, unsafe, actions },
    total: rows.length
  }, null, 2));
} else {
  console.log("场景 | 期望 | 判定 | p_result | margin | p_call | 延迟");
  console.log("-".repeat(80));
  for (const r of rows) {
    const tag = r.ok ? "OK  " : (r.dangerous ? "危险" : "保守");
    console.log(tag + " | " + r.id.padEnd(18) + " | " + r.expect.padEnd(4) + " | " + r.verdict.padEnd(4) + " | "
      + String(r.p_result).padEnd(8) + " | " + String(r.m_result).padEnd(6) + " | "
      + String(r.p_call).padEnd(6) + " | " + r.latency_ms + "ms");
  }
  console.log("-".repeat(80));
  for (const [id, b] of perClass) {
    console.log(id.padEnd(18) + " 正确 " + b.ok + "/" + b.total + (b.dangerous ? "  高危误删 " + b.dangerous : ""));
  }
  console.log("-".repeat(80));
  console.log("合计（合取式问句）" + (rows.length - wrong) + "/" + rows.length + " 正确 · 高危误删 " + dangerous);
  console.log("合计（拆开问句）" + (rows.length - wrongNeeded) + "/" + rows.length + " 正确 · 高危误删 " + dangerNeeded);
  console.log("合计（四象限矩阵）" + (rows.length - unsafe) + "/" + rows.length + " 安全 · 误删 " + unsafe +
    " · 动作分布 " + JSON.stringify(actions));
  if (unsafe > 0) console.log("裁决（四象限矩阵）：否决——仍有内容被判可丢。");
  else if ((actions.drop ?? 0) === 0) console.log("裁决（四象限矩阵）：保守——没有任何一条可安全丢弃，收益为零。");
  else console.log("裁决（四象限矩阵）：通过——零误删，且有 " + (actions.drop ?? 0) + "/" + rows.length + " 条可安全丢弃。");
}