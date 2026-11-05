/**
 * 措辞对照实验:同一事实、不同说法,判定器的概率跟着谁走?
 *
 * 为什么再做一次:decide-evidence-bench 的 B 组把「措辞」与「事实」一起换掉了
 * (drop 支原本写着「已被 edit 改写」,换措辞时那句话也被换掉了),
 * 于是 drop 支上四种措辞其实都在说「无后续触碰」—— 判定器只能靠先验,概率全落在 0.5 附近。
 * 本脚本把两个轴彻底分开:
 *   事实轴 F 决定真值(F_none = 任务依赖该内容 / F_superseded = 已被改写,任务转向别处)
 *   措辞轴 W 只改说法,且在每一格都套满
 * 于是「同一事实下 pN 的极差」就是措辞的驱动幅度,与真值无关。
 *
 * 反向对照是必须的:W4 在 F_superseded 上是一句**假陈述**。它若把概率拉上去,
 * 说明判定器跟随措辞而非事实;若拉不动,说明事实在那句话之外仍被读到。
 *
 * 只问一个问题(needed),避免复合问句混入(复合问句是已记在案的坑)。
 * 用法:node bench/decide-wording-bench.mjs [--json]
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

/** 六个真实文件,够让每格有 6 个样本。 */
const FILES = ['lib/excerpt.js', 'lib/fold.js', 'lib/decide-fold.js', 'lib/index.js', 'lib/ingress.js', 'lib/layout.js'];

/** 事实轴:决定任务与真值。 */
const FACTS = {
  F_none: {
    needed: true,
    task: 'the user asks a follow-up question about the code inside this file, and the answer must quote exact lines from this result.'
  },
  F_superseded: {
    needed: false,
    task: 'the user now asks to change a different constant in this same file; the task no longer reads the lines of this result.'
  }
};

/** 措辞轴:同一事实下的四种说法。W4 在 F_superseded 上是假陈述,用作反向对照。 */
const WORDINGS = {
  W1_fact_as_is: {
    F_none: 'No later step in the span touches the same target.',
    F_superseded: 'A later step (edit) rewrote the same target, so this earlier content is superseded.'
  },
  W2_soft_hint: {
    F_none: 'Nothing later in the span refers back to this result.',
    F_superseded: 'A later step touched the same file again.'
  },
  W3_hard_hint_drop: {
    F_none: 'Nothing later refers back to this result, so it looks safe to drop.',
    F_superseded: 'This result has been replaced, and keeping it would only waste context.'
  },
  W4_counter_hint_keep: {
    F_none: 'This result holds the very lines the task is about to quote.',
    F_superseded: 'This result still holds the lines the task is about to quote.'
  }
};

async function ask(state, key) {
  const body = {
    state,
    questions: {
      needed: { type: 'noul', instructions: Q_NEEDED, criteria: { true: 'still needed', false: 'no longer needed' } }
    }
  };
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) return { error: 'http ' + res.status + ': ' + text.slice(0, 200) };
    const json = JSON.parse(text);
    const inner = json.result ?? json;
    const answers = inner.answers ?? inner;
    const a = answers?.needed;
    return {
      probability: a && Number.isFinite(Number(a.probability)) ? Number(a.probability) : null,
      margin: a && Number.isFinite(Number(a.margin)) ? Number(a.margin) : null,
      latency: Date.now() - started
    };
  } catch (ex) {
    return { error: String(ex && ex.message ? ex.message : ex) };
  }
}

async function mapLimit(items, limit, worker) {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }));
}

const key = masterKey();
const texts = {};
for (const f of FILES) texts[f] = readFileSync(join(ROOT, f), 'utf8');

const rows = [];
for (const file of FILES) {
  for (const factName of Object.keys(FACTS)) {
    for (const wName of Object.keys(WORDINGS)) {
      rows.push({
        id: wName + '|' + factName + '|' + file,
        file, fact: factName, wording: wName,
        later: WORDINGS[wName][factName],
        task: FACTS[factName].task,
        gold: FACTS[factName].needed
      });
    }
  }
}

await mapLimit(rows, 4, async (row) => {
  const entry = { id: row.file, name: 'read', target: row.file, text: texts[row.file], laterContext: row.later };
  row.state = verdictState(entry, { task: row.task, pageChars: 700 });
  const out = await ask(row.state, key);
  if (out.error) { row.error = out.error; return; }
  row.p = out.probability;
  row.margin = out.margin;
  row.latency = out.latency;
  row.verdictKeep = row.p === null ? null : row.p >= 0.5;
  row.ok = row.verdictKeep === null ? null : row.verdictKeep === row.gold;
});

const scored = rows.filter((r) => !r.error && r.p !== null);
function mean(xs) { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function fmt(x) { return x === null || x === undefined ? '  n/a' : x.toFixed(3); }

/** 逐格统计:同一事实下,四种措辞的 pN 均值与极差。 */
const cells = [];
for (const factName of Object.keys(FACTS)) {
  for (const wName of Object.keys(WORDINGS)) {
    const v = scored.filter((r) => r.fact === factName && r.wording === wName);
    cells.push({ fact: factName, wording: wName, n: v.length, p: mean(v.map((r) => r.p)),
      margin: mean(v.map((r) => r.margin)), acc: v.length ? v.filter((r) => r.ok).length / v.length : null });
  }
}

/** 措辞驱动幅度:同一事实下各措辞均值的极差,以及相对「事实如实陈述」的偏移。 */
const drift = [];
for (const factName of Object.keys(FACTS)) {
  const group = cells.filter((c) => c.fact === factName);
  const ps = group.map((c) => c.p).filter((x) => x !== null);
  const base = group.find((c) => c.wording === 'W1_fact_as_is');
  drift.push({
    fact: factName,
    spread: ps.length ? Math.max(...ps) - Math.min(...ps) : null,
    baseP: base ? base.p : null,
    deltas: group.map((c) => ({ wording: c.wording, delta: base && c.p !== null ? c.p - base.p : null }))
  });
}

const report = { rows, errors: rows.filter((r) => r.error).length, scored: scored.length, cells, drift,
  overall: { acc: scored.length ? scored.filter((r) => r.ok).length / scored.length : null,
    marginMean: mean(scored.map((r) => r.margin)) } };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('样本 ' + rows.length + ' / 出错 ' + report.errors + ' / 计分 ' + scored.length);
  console.log('');
  console.log('== 格子:行=事实(真值),列=措辞 ==');
  const wNames = Object.keys(WORDINGS);
  console.log('  ' + 'fact'.padEnd(16) + wNames.map((w) => w.slice(0, 20).padEnd(22)).join(''));
  for (const factName of Object.keys(FACTS)) {
    const line = Object.keys(WORDINGS).map((w) => {
      const c = cells.find((x) => x.fact === factName && x.wording === w);
      return (fmt(c.p) + ' m' + fmt(c.margin)).padEnd(22);
    }).join('');
    console.log('  ' + (factName + '(needed=' + (FACTS[factName].needed ? 1 : 0) + ')').padEnd(16) + line);
  }
  console.log('');
  console.log('== 措辞驱动幅度(同一事实下 pN 极差)==');
  for (const d of drift) console.log('  ' + d.fact.padEnd(16) + ' 极差 ' + fmt(d.spread) + '   基准(W1) ' + fmt(d.baseP) + '   ' +
    d.deltas.map((x) => x.wording.slice(0, 18) + ' ' + (x.delta === null ? 'n/a' : (x.delta >= 0 ? '+' : '') + x.delta.toFixed(3))).join('  '));
  console.log('');
  console.log('== 逐条 ==');
  for (const r of scored) console.log('  ' + r.id.padEnd(46) + ' p=' + fmt(r.p) + ' m=' + fmt(r.margin) + ' gold=' + (r.gold ? 1 : 0) + ' ok=' + r.ok);
}
