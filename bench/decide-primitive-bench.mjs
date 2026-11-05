/**
 * 三原语边界:Noul(绝对概率) / Choice(相对排序) / Score(有序量表)
 * 在同一组「六条结果里挑出最该丢的那条」上各跑一遍。
 *
 * 为什么值得测:折页的真实形态是「一次处理 N 条结果,挑出可以整条删掉的」。
 * 现在代码走的是 Noul 逐条问(每条一个独立 state,信息最全),
 * 但 Choice 一次就能问完(N 条挤在一个 state 里,单条信息被稀释)。
 * 两者是**成本与信息量的直接交换**,不实测没法选。
 *
 * 公平性口径:各臂保持自己的真实形态,不人为拉平 ——
 *   Noul 臂每条 700 字符结果头(现役形态)
 *   Choice 臂把六条压进一个 state,每条 200 字符(它想给 700 也给不下)
 * 测出来的就是「真实使用形态下的胜负」,不是理想形态。
 *
 * 用法:node bench/decide-primitive-bench.mjs [--probe] [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictState } from '../lib/decide-fold.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENDPOINT = 'http://127.0.0.1:4000/v1/decide/batch';
const PROBE = process.argv.includes('--probe');
const JSON_OUT = process.argv.includes('--json');

function masterKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync('ga-keys get LITELLM_MASTER_KEY', { encoding: 'utf8' }).trim();
}

const Q_NEEDED = 'The contents of this tool result are still needed to finish the current task.';
const Q_CHOICE = 'Which one of these earlier tool results is the least needed to finish the current task?';
const Q_SCORE = 'How valuable are the contents of this tool result for finishing the current task?';
const SCORE_LEGEND = ['no value at all', 'marginal value', 'useful', 'essential and quoted verbatim'];

const POOL = ['lib/excerpt.js', 'lib/fold.js', 'lib/decide-fold.js', 'lib/index.js', 'lib/ingress.js', 'lib/layout.js'];

const TASK = 'the user is adding a feature to this repo and the answer must quote exact lines from the earlier results that are still current.';
const LATER_LIVE = 'No later step in the span touches the same target.';
const LATER_DEAD = 'A later step (edit) rewrote the same target, so this earlier content is superseded.';

/** 四组样本:轮换哪一条是被改写过的(真值 = 该丢的那条)。 */
function cases() {
  const out = [];
  for (let k = 0; k < 4; k += 1) {
    const files = POOL.map((_, i) => POOL[(i + k) % POOL.length]);
    const deadIndex = k % POOL.length;
    out.push({
      id: 'case' + k,
      files,
      deadIndex,
      gold: files[deadIndex]
    });
  }
  return out;
}

async function ask(state, questions, key) {
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ state, questions })
    });
    const text = await res.text();
    if (!res.ok) return { error: 'http ' + res.status + ': ' + text.slice(0, 300) };
    const json = JSON.parse(text);
    const inner = json.result ?? json;
    return { answers: inner.answers ?? inner, latency: Date.now() - started };
  } catch (ex) {
    return { error: String(ex && ex.message ? ex.message : ex) };
  }
}

const key = masterKey();
const texts = {};
for (const f of POOL) texts[f] = readFileSync(join(ROOT, f), 'utf8');

function entryOf(file, dead) {
  return { id: file, name: 'read', target: file, text: texts[file],
    laterContext: dead ? LATER_DEAD : LATER_LIVE };
}

/** Choice / Score 臂共用的总览 state:六条各占一段。 */
function overviewState(files, deadIndex) {
  const parts = ['User request: ' + TASK, 'Earlier tool results in this span, in order:'];
  files.forEach((file, i) => {
    const body = texts[file].replace(/\s+/g, ' ').slice(0, 200);
    parts.push('');
    parts.push('[' + (i + 1) + '] read(' + file + ') -> ok, ' + texts[file].split(String.fromCharCode(10)).length + ' lines.');
    parts.push('    head: ' + body);
    parts.push('    later: ' + (i === deadIndex ? LATER_DEAD : LATER_LIVE));
  });
  return parts.join(String.fromCharCode(10));
}

const list = cases();

if (PROBE) {
  const c = list[0];
  const state = overviewState(c.files, c.deadIndex);
  const criteria = {};
  c.files.forEach((f, i) => { criteria['r' + (i + 1) + '_' + f] = 'read(' + f + ')'; });
  const out = await ask(state, { which: { type: 'choice', instructions: Q_CHOICE, criteria } }, key);
  console.log(JSON.stringify(out, null, 2).slice(0, 2500));
  const out2 = await ask(state, { value: { type: 'score', instructions: Q_SCORE, criteria: SCORE_LEGEND } }, key);
  console.log('SCORE -> ' + JSON.stringify(out2, null, 2).slice(0, 1500));
} else {
  const rows = [];
  for (const c of list) {
    const state = overviewState(c.files, c.deadIndex);
    // 臂 1:Noul 逐条
    const noulParts = [];
    for (let i = 0; i < c.files.length; i += 1) {
      const file = c.files[i];
      const st = verdictState(entryOf(file, i === c.deadIndex), { task: TASK, pageChars: 700 });
      const out = await ask(st, { needed: { type: 'noul', instructions: Q_NEEDED, criteria: { true: 'still needed', false: 'no longer needed' } } }, key);
      const a = out.answers?.needed;
      noulParts.push({ file, p: a && Number.isFinite(Number(a.probability)) ? Number(a.probability) : null,
        margin: a && Number.isFinite(Number(a.margin)) ? Number(a.margin) : null, latency: out.latency, error: out.error });
    }
    const noulPick = noulParts.filter((x) => x.p !== null).sort((a, b) => a.p - b.p)[0];
    // 臂 2:Choice 一次
    const criteria = {};
    c.files.forEach((f, i) => { criteria['r' + (i + 1) + '_' + f] = 'read(' + f + ')'; });
    const chOut = await ask(state, { which: { type: 'choice', instructions: Q_CHOICE, criteria } }, key);
    const chAns = chOut.answers?.which;
    const chPick = chAns && typeof chAns.value === 'string' ? chAns.value : null;
    // 臂 3:Score 逐条(一次 batch,六问)
    const scoreQs = {};
    c.files.forEach((f, i) => {
      scoreQs['s' + (i + 1)] = { type: 'score', instructions: 'How valuable are the contents of result [' + (i + 1) + '] read(' + f + ') for finishing the current task?', criteria: SCORE_LEGEND };
    });
    const scOut = await ask(state, scoreQs, key);
    const scParts = c.files.map((f, i) => {
      const a = scOut.answers?.['s' + (i + 1)];
      return { file: f, value: a && Number.isFinite(Number(a.value)) ? Number(a.value) : null,
        confidence: a && Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : null };
    });
    const scPick = scParts.filter((x) => x.value !== null).sort((a, b) => a.value - b.value)[0];
    rows.push({ id: c.id, gold: c.gold, noulParts, noulPick: noulPick?.file ?? null,
      noulOk: noulPick?.file === c.gold, noulCalls: c.files.length,
      choiceRaw: chPick, choicePick: chPick ? c.files.find((f) => chPick.includes(f)) ?? chPick : null,
      choiceOk: chPick ? chPick.includes(c.gold) : null, choiceCalls: 1,
      choiceConfidence: chAns?.confidence ?? null, choiceMargin: chAns?.margin ?? null,
      scoreParts: scParts, scorePick: scPick?.file ?? null, scoreOk: scPick?.file === c.gold, scoreCalls: 1,
      latencyChoice: chOut.latency, latencyScore: scOut.latency });
  }

  const n = rows.length;
  const report = { rows,
    summary: {
      noulTop1: rows.filter((r) => r.noulOk).length / n,
      choiceTop1: rows.filter((r) => r.choiceOk === true).length / n,
      scoreTop1: rows.filter((r) => r.scoreOk).length / n,
      noulCalls: rows.reduce((a, r) => a + r.noulCalls, 0),
      choiceCalls: rows.reduce((a, r) => a + r.choiceCalls, 0),
      scoreCalls: rows.reduce((a, r) => a + r.scoreCalls, 0)
    } };
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('样本组 ' + n);
    for (const r of rows) {
      console.log('  ' + r.id + ' gold=' + r.gold);
      console.log('    Noul  ' + (r.noulOk ? 'OK ' : 'MISS') + ' 选中=' + r.noulPick + '  p=' + r.noulParts.map((x) => (x.p === null ? 'n/a' : x.p.toFixed(2))).join(','));
      console.log('    Choice ' + (r.choiceOk ? 'OK ' : 'MISS') + ' 选中=' + r.choiceRaw + ' conf=' + r.choiceConfidence + ' margin=' + r.choiceMargin);
      console.log('    Score  ' + (r.scoreOk ? 'OK ' : 'MISS') + ' 选中=' + r.scorePick + ' val=' + r.scoreParts.map((x) => (x.value === null ? 'n/a' : x.value.toFixed(2))).join(','));
    }
    const s = report.summary;
    console.log('');
    console.log('top1 准确率: Noul ' + s.noulTop1.toFixed(2) + ' / Choice ' + s.choiceTop1.toFixed(2) + ' / Score ' + s.scoreTop1.toFixed(2));
    console.log('判定请求数: Noul ' + s.noulCalls + ' / Choice ' + s.choiceCalls + ' / Score ' + s.scoreCalls);
  }
}
