/**
 * 证据工程:判定器的答案里,有多少来自「证据事实」,多少来自「证据形式」?
 *
 * 为什么单开一个 bench:decide-calibration 的 state 是手写的,每个 state 只出现一次,
 * 因此无法把「事实变了」与「说法变了」分开。本脚本固定同一份 entry(真实文件内容),
 * 只变证据的形式,于是任何答案差异都只能归因于形式。
 *
 * 三个因子(其余全固定):
 *   A 完备度  A0 无结果头 / A1 头 700 / A2 头 700+后续 / A3 头 2000+后续
 *   B 措辞    B0 中性现役 / B1 中性等价(阴性对照) / B2 暗示该丢 / B3 反问
 *   C 长度    pageChars 200 / 700 / 2000
 *
 * 真值由构造保证,不靠主观:keep 支 = 任务要引用该结果里的确切行,且无后续触碰;
 * drop 支 = 同一 target 已被后续 edit 改写,且任务已转向同一文件的别处。
 *
 * 纪律:每个因子都配阴性对照(B0 vs B1 都是中性,应当无显著差异)。
 * 用法:node bench/decide-evidence-bench.mjs [--json] [--concurrency 4]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictState, verdictAction, DECIDE_FOLD_DEFAULTS } from '../lib/decide-fold.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENDPOINT = 'http://127.0.0.1:4000/v1/decide/batch';
const JSON_OUT = process.argv.includes('--json');
const CONCURRENCY = (() => {
  const i = process.argv.indexOf('--concurrency');
  return i >= 0 ? Number(process.argv[i + 1]) || 4 : 4;
})();

function masterKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync('ga-keys get LITELLM_MASTER_KEY', { encoding: 'utf8' }).trim();
}

/** 现役问句,与 lib/decide-fold.js 保持一致。 */
const Q_NEEDED = 'The contents of this tool result are still needed to finish the current task.';
const Q_RERUN = 'If this tool result were dropped, could the same information be obtained again by re-running the same tool call?';

/** 三个真实文件当 entry:内容不是我编的,长度分布也是真的。 */
const FILES = ['lib/excerpt.js', 'lib/fold.js', 'lib/decide-fold.js'];

/** 支:决定真值与后续语境。 */
const ARMS = {
  keep: {
    gold: { needed: true, rerun: false },
    task: 'the user asks a follow-up question about the code inside this file, and the answer must quote exact lines from this result.',
    later: 'No later step in the span touches the same target.'
  },
  drop: {
    gold: { needed: false, rerun: true },
    task: 'the user now asks to change a different constant in this same file; the lines of this result are no longer what the task reads.',
    later: 'A later step (edit) rewrote the same target, so this earlier content is superseded.'
  }
};

/** 措辞四版,语义等价(都在说「跨度里没有后续触碰」)。 */
const WORDINGS = {
  B0_neutral_shipped: 'No later step in the span touches the same target.',
  B1_neutral_equiv: 'The span does not record whether a later step used this result.',
  B2_hint_drop: 'Nothing in the span refers back to this result.',
  B3_questioning: 'Is there any reason to keep this result?'
};

function entryFor(file, text, laterContext) {
  return {
    id: file,
    name: 'read',
    target: file,
    text,
    laterContext
  };
}

async function ask(state, key) {
  const body = {
    state,
    questions: {
      needed: { type: 'noul', instructions: Q_NEEDED, criteria: { true: 'still needed', false: 'no longer needed' } },
      rerunnable: { type: 'noul', instructions: Q_RERUN, criteria: { true: 'reproduces it', false: 'one-off' } }
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
    const pick = (k) => {
      const a = answers?.[k];
      if (!a || typeof a !== 'object') return { probability: null, margin: null };
      return {
        probability: Number.isFinite(Number(a.probability)) ? Number(a.probability) : null,
        margin: Number.isFinite(Number(a.margin)) ? Number(a.margin) : null
      };
    };
    return { needed: pick('needed'), rerun: pick('rerunnable'), latency: Date.now() - started, cached: inner.cached === true };
  } catch (ex) {
    return { error: String(ex && ex.message ? ex.message : ex) };
  }
}

/** 造出全部变体。A/B/C 三个因子分三组,组内只变一个因子。 */
function variants(texts) {
  const rows = [];
  for (const file of FILES) {
    const text = texts[file];
    for (const armName of Object.keys(ARMS)) {
      const arm = ARMS[armName];
      // A 完备度
      rows.push({ id: 'A0|' + armName + '|' + file, factor: 'A', level: 'A0_no_head', file, arm: armName,
        entry: entryFor(file, '', undefined), task: arm.task, gold: arm.gold });
      rows.push({ id: 'A1|' + armName + '|' + file, factor: 'A', level: 'A1_head700', file, arm: armName,
        entry: entryFor(file, text, undefined), task: arm.task, gold: arm.gold, pageChars: 700 });
      rows.push({ id: 'A2|' + armName + '|' + file, factor: 'A', level: 'A2_head700_later', file, arm: armName,
        entry: entryFor(file, text, arm.later), task: arm.task, gold: arm.gold, pageChars: 700 });
      rows.push({ id: 'A3|' + armName + '|' + file, factor: 'A', level: 'A3_head2000_later', file, arm: armName,
        entry: entryFor(file, text, arm.later), task: arm.task, gold: arm.gold, pageChars: 2000 });
    }
    // B 措辞:只在 keep 支上测(无后续触碰那一支才谈得上措辞) + drop 支的反向对照
    for (const armName of Object.keys(ARMS)) {
      for (const [wName, wText] of Object.entries(WORDINGS)) {
        rows.push({ id: 'B|' + armName + '|' + wName + '|' + file, factor: 'B', level: wName, file, arm: armName,
          entry: entryFor(file, text, wText), task: ARMS[armName].task, gold: ARMS[armName].gold, pageChars: 700 });
      }
    }
    // C 长度
    for (const armName of Object.keys(ARMS)) {
      for (const pc of [200, 700, 2000]) {
        rows.push({ id: 'C|' + armName + '|pc' + pc + '|' + file, factor: 'C', level: 'pc' + pc, file, arm: armName,
          entry: entryFor(file, text, ARMS[armName].later), task: ARMS[armName].task, gold: ARMS[armName].gold, pageChars: pc });
      }
    }
  }
  return rows;
}

async function mapLimit(items, limit, worker) {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }));
}

const key = masterKey();
const texts = {};
for (const f of FILES) texts[f] = readFileSync(join(ROOT, f), 'utf8');
const rows = variants(texts);

await mapLimit(rows, CONCURRENCY, async (row) => {
  const state = verdictState(row.entry, { task: row.task, pageChars: row.pageChars ?? DECIDE_FOLD_DEFAULTS.pageChars });
  row.state = state;
  const out = await ask(state, key);
  if (out.error) { row.error = out.error; return; }
  row.pNeeded = out.needed.probability;
  row.pRerun = out.rerun.probability;
  row.neededMargin = out.needed.margin;
  row.rerunMargin = out.rerun.margin;
  row.latency = out.latency;
  row.action = verdictAction({
    pNeeded: row.pNeeded, pRerun: row.pRerun,
    neededMargin: row.neededMargin, rerunMargin: row.rerunMargin,
    minMargin: 0
  });
  row.neededOk = row.pNeeded === null ? null : (row.pNeeded >= 0.5) === row.gold.needed;
  row.rerunOk = row.pRerun === null ? null : (row.pRerun >= 0.5) === row.gold.rerun;
  const wantAction = row.gold.needed ? (row.gold.rerun ? 'truncate' : 'keep') : (row.gold.rerun ? 'drop' : 'keep');
  row.actionOk = row.action === wantAction;
  // 危险 = 把「仍需要」的东西判成 drop(唯一不可逆方向)
  row.dangerous = row.gold.needed && row.action === 'drop';
});

const errors = rows.filter((r) => r.error);
const scored = rows.filter((r) => !r.error && r.pNeeded !== null);

function mean(xs) { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function fmt(x) { return x === null ? '  n/a' : x.toFixed(3); }

function groupStats(list, keyFn) {
  const groups = new Map();
  for (const r of list) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([k, v]) => ({
    key: k,
    n: v.length,
    pNeeded: mean(v.map((r) => r.pNeeded)),
    pRerun: mean(v.map((r) => r.pRerun)),
    neededAcc: v.filter((r) => r.neededOk).length / v.length,
    actionAcc: v.filter((r) => r.actionOk).length / v.length,
    dangerous: v.filter((r) => r.dangerous).length,
    margin: mean(v.map((r) => r.neededMargin))
  }));
}

const byLevel = groupStats(scored, (r) => r.factor + ' ' + r.level);
const byWordingKeep = groupStats(scored.filter((r) => r.factor === 'B' && r.arm === 'keep'), (r) => r.level);
const byWordingDrop = groupStats(scored.filter((r) => r.factor === 'B' && r.arm === 'drop'), (r) => r.level);
const byCompleteness = groupStats(scored.filter((r) => r.factor === 'A'), (r) => r.level);
const byLength = groupStats(scored.filter((r) => r.factor === 'C'), (r) => r.level);

// margin 标定:把所有「needed 判断」按 margin 分档,看准确率怎么涨
const calib = [];
for (const r of scored) {
  if (r.neededMargin === null || r.neededOk === null) continue;
  calib.push({ margin: r.neededMargin, ok: r.neededOk, dangerous: r.dangerous });
}
const bands = [[0, 0.05], [0.05, 0.15], [0.15, 0.25], [0.25, 0.4], [0.4, 1.01]];
const marginBands = bands.map(([lo, hi]) => {
  const v = calib.filter((c) => c.margin >= lo && c.margin < hi);
  return { band: lo.toFixed(2) + '-' + (hi > 1 ? '1.0' : hi.toFixed(2)), n: v.length,
    acc: v.length ? v.filter((c) => c.ok).length / v.length : null,
    dangerous: v.filter((c) => c.dangerous).length };
});

const report = {
  rows, errors: errors.length, scored: scored.length,
  overall: {
    neededAcc: scored.length ? scored.filter((r) => r.neededOk).length / scored.length : null,
    actionAcc: scored.length ? scored.filter((r) => r.actionOk).length / scored.length : null,
    dangerous: scored.filter((r) => r.dangerous).length,
    marginMean: mean(scored.map((r) => r.neededMargin))
  },
  byCompleteness, byLength, byWordingKeep, byWordingDrop, byLevel, marginBands
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('变体 ' + rows.length + ' / 出错 ' + errors.length + ' / 计分 ' + scored.length);
  const O = report.overall;
  console.log('总体 needed 准确率 ' + fmt(O.neededAcc) + '  action 准确率 ' + fmt(O.actionAcc) + '  危险 ' + O.dangerous + '  margin 均值 ' + fmt(O.marginMean));
  console.log('');
  console.log('== A 完备度 ==');
  for (const g of byCompleteness) console.log('  ' + g.key.padEnd(20) + ' n=' + String(g.n).padEnd(3) + ' pNeeded=' + fmt(g.pNeeded) + ' 准确=' + fmt(g.neededAcc) + ' 危险=' + g.dangerous + ' margin=' + fmt(g.margin));
  console.log('== C 长度 ==');
  for (const g of byLength) console.log('  ' + g.key.padEnd(20) + ' n=' + String(g.n).padEnd(3) + ' pNeeded=' + fmt(g.pNeeded) + ' 准确=' + fmt(g.neededAcc) + ' 危险=' + g.dangerous + ' margin=' + fmt(g.margin));
  console.log('== B 措辞(keep 支:应判 needed=1)==');
  for (const g of byWordingKeep) console.log('  ' + g.key.padEnd(22) + ' n=' + String(g.n).padEnd(3) + ' pNeeded=' + fmt(g.pNeeded) + ' 准确=' + fmt(g.neededAcc) + ' margin=' + fmt(g.margin));
  console.log('== B 措辞(drop 支:应判 needed=0)==');
  for (const g of byWordingDrop) console.log('  ' + g.key.padEnd(22) + ' n=' + String(g.n).padEnd(3) + ' pNeeded=' + fmt(g.pNeeded) + ' 准确=' + fmt(g.neededAcc) + ' margin=' + fmt(g.margin));
  console.log('== margin 标定(needed 问句)==');
  for (const g of marginBands) console.log('  margin ' + g.band.padEnd(12) + ' n=' + String(g.n).padEnd(3) + ' 准确=' + fmt(g.acc) + ' 危险=' + g.dangerous);
}
