/**
 * 现役 later-context 四句话的效力谱系。
 *
 * 为什么单独测:lib/decide-fold.js 的 laterContextOf 会输出四种句子,它们携带的证据量并不一样:
 *   L1 没有 target 信息(跨度没说这条是否被取代)—— 信息缺失
 *   L2 有 target 但无后续触碰 —— 弱事实
 *   L3 同 target 被后续 edit 改写 —— 强事实(判定该丢)
 *   L4 同 target 被后续 read 再读 —— 强事实(判定可重跑)
 * 前两个实验证明「有没有 later context」决定成败;这一步问的是「哪一句值一次判定调用」。
 * 若 L1 的 margin 系统性塌陷,那么这类 entry 注定被 minMargin 打回 mechanical,
 * 就不该为它花一次上游往返。
 *
 * 做法:同一份 entry(真实文件内容),四种句子各套一遍,在 keep / drop 两个真值上分别测。
 * 用法:node bench/decide-later-bench.mjs [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictState } from '../lib/decide-fold.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENDPOINT = 'http://127.0.0.1:4000/v1/decide/batch';
const JSON_OUT = process.argv.includes('--json');

function masterKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync('ga-keys get LITELLM_MASTER_KEY', { encoding: 'utf8' }).trim();
}

const Q_NEEDED = 'The contents of this tool result are still needed to finish the current task.';
const FILES = ['lib/excerpt.js', 'lib/fold.js', 'lib/decide-fold.js'];

/** 四句原文,与 lib/decide-fold.js 的 laterContextOf 逐字一致。 */
const LATER = {
  L1_no_target_info: 'No later step in the span names a target for this result, so the span does not say whether it has been superseded.',
  L2_target_untouched: 'No later step in the span touches the same target.',
  L3_superseded: 'A later step (edit) rewrote the same target, so this earlier content is superseded.',
  L4_read_again: 'A later step (read) touched the same target again, so this content can be obtained again.'
};

/** 真值支。L1 形态下 target 为空,所以两种真值的任务都不指向具体文件。 */
const ARMS = {
  keep: {
    needed: true,
    task: 'the user asks a follow-up question about the code inside this file, and the answer must quote exact lines from this result.'
  },
  drop: {
    needed: false,
    task: 'the user now asks to change a different constant in this same file; the task no longer reads the lines of this result.'
  }
};

/** L1 必须让 entry 真的没有 target,否则那句证据不成立。 */
function targetFor(laterKey) {
  return laterKey === 'L1_no_target_info' ? '' : null; // null = 用文件名
}

async function ask(state, key) {
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ state, questions: {
        needed: { type: 'noul', instructions: Q_NEEDED, criteria: { true: 'still needed', false: 'no longer needed' } }
      } })
    });
    const text = await res.text();
    if (!res.ok) return { error: 'http ' + res.status + ': ' + text.slice(0, 200) };
    const json = JSON.parse(text);
    const inner = json.result ?? json;
    const answers = inner.answers ?? inner;
    const a = answers?.needed;
    return { p: a && Number.isFinite(Number(a.probability)) ? Number(a.probability) : null,
      margin: a && Number.isFinite(Number(a.margin)) ? Number(a.margin) : null, latency: Date.now() - started };
  } catch (ex) {
    return { error: String(ex && ex.message ? ex.message : ex) };
  }
}

async function mapLimit(items, limit, worker) {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) { const i = cursor; cursor += 1; if (i >= items.length) return; await worker(items[i], i); }
  }));
}

const key = masterKey();
const texts = {};
for (const f of FILES) texts[f] = readFileSync(join(ROOT, f), 'utf8');

const rows = [];
for (const file of FILES) {
  for (const armName of Object.keys(ARMS)) {
    for (const laterKey of Object.keys(LATER)) {
      rows.push({ id: laterKey + '|' + armName + '|' + file, file, arm: armName, later: laterKey,
        gold: ARMS[armName].needed });
    }
  }
}

await mapLimit(rows, 4, async (row) => {
  const forced = targetFor(row.later);
  const entry = { id: row.file, name: 'read', target: forced === null ? row.file : forced,
    text: texts[row.file], laterContext: LATER[row.later] };
  row.state = verdictState(entry, { task: ARMS[row.arm].task, pageChars: 700 });
  const out = await ask(row.state, key);
  if (out.error) { row.error = out.error; return; }
  row.p = out.p;
  row.margin = out.margin;
  row.latency = out.latency;
  row.ok = row.p === null ? null : (row.p >= 0.5) === row.gold;
});

const scored = rows.filter((r) => !r.error && r.p !== null);
function mean(xs) { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function fmt(x) { return x === null || x === undefined ? '  n/a' : x.toFixed(3); }

const cells = [];
for (const laterKey of Object.keys(LATER)) {
  for (const armName of Object.keys(ARMS)) {
    const v = scored.filter((r) => r.later === laterKey && r.arm === armName);
    cells.push({ later: laterKey, arm: armName, n: v.length, p: mean(v.map((r) => r.p)),
      margin: mean(v.map((r) => r.margin)), acc: v.length ? v.filter((r) => r.ok).length / v.length : null });
  }
}

const report = { rows, errors: rows.filter((r) => r.error).length, scored: scored.length, cells };
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('样本 ' + rows.length + ' / 出错 ' + report.errors + ' / 计分 ' + scored.length);
  console.log('');
  console.log('  ' + 'later'.padEnd(22) + 'keep支(应p高)'.padEnd(24) + 'drop支(应p低)'.padEnd(24));
  for (const laterKey of Object.keys(LATER)) {
    const k = cells.find((c) => c.later === laterKey && c.arm === 'keep');
    const d = cells.find((c) => c.later === laterKey && c.arm === 'drop');
    console.log('  ' + laterKey.padEnd(22) + ('p=' + fmt(k.p) + ' m=' + fmt(k.margin) + ' acc=' + fmt(k.acc)).padEnd(24)
      + ('p=' + fmt(d.p) + ' m=' + fmt(d.margin) + ' acc=' + fmt(d.acc)).padEnd(24));
  }
  console.log('');
  console.log('== 逐条 ==');
  for (const r of scored) console.log('  ' + r.id.padEnd(46) + ' p=' + fmt(r.p) + ' m=' + fmt(r.margin) + ' gold=' + (r.gold ? 1 : 0) + ' ok=' + r.ok);
}
