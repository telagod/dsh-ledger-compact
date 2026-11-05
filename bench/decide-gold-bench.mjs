/**
 * 用「未来」验证「过去」:被判 drop 的结果,在折页点之后真的没被用到吗?
 *
 * 为什么需要它:fold-live-scan 只能给出「判定器想丢多少」(12 条候选 11 条 drop、约 45618 tok),
 * 但那是**潜在**收益 —— 真实会话没有 gold,谁也没法说那 11 条是不是真的可以丢。
 *
 * 做法(不需要人工标注):把一条**已经结束**的会话在中间切开。
 *   折页点之前 = 判定器看到的 span(候选就从这里选)
 *   折页点之后 = 会话真实走完的后续(模型实际写了什么、又调了什么工具)
 * 然后问:被判 drop 的那些结果,它们的内容有没有出现在「后续」里?
 *
 * 判读口径(必须诚实):
 *   - 后续引用了 → **充分证据**说明那次 drop 是误删(内容确实还要用)。
 *   - 后续没引用 → **不等于**可以删:模型可能只是没走到需要它的那一步。
 *   所以本脚本算出的是**误删率的下界**,不是误删率本身。
 *
 * 引用信号两路,都用「稀有」来压噪声:
 *   T 稀有 token:在本次全部候选里只出现 1 次的长标识符 / 长数字
 *   L 整行:长度 >= 30 的行在未来语料里精确出现
 * 另记 target(路径 / 命令 / run_code 描述)是否被后续提到 —— 弱信号,只作参考。
 *
 * 用法:node bench/decide-gold-bench.mjs <session.jsonl.zstd> [--at 0.6] [--json]
 *
 * ## 结论(2026-09-22):这条路**被证伪**,不要再用它算误删率
 *
 * 1. **候选内 DF 的「稀有」是错的**。第一版把「在 12 个候选里只出现一次」当稀有,筛出来的
 *    全是会话主题词(headroom / openviking / codebase-memory / tool-adoption-eval)。
 *    阴性对照当场证伪:稀有串命中率 0.105,随机抽串 0.108 —— **一模一样**。
 *    当时算出的「误删率下界 0.58」是伪结论。
 * 2. **改成全会话 DF <= 2 后信号才立住**(命中率 0.017 vs 随机 0.106),误删率下界降到 0.17。
 *    但逐个看那 8 个命中:`Messages` / `tool_call` / `inputSchema` 是通用词,
 *    其余是路径与文件名(decide/ledger.jsonl、ledger.test.js、client.js)。
 * 3. **路径命中区分不了「引用了内容」与「后续又操作了同一文件」** —— 前者是误删,
 *    后者恰恰是 drop 的理由(rerun 象限)。所以连 0.17 也偏高,可信的内容引用证据接近于零。
 * 4. **整行信号命中 0**:模型从不逐字复制结果里的长行,这条更严的路也走不通。
 *
 * 保留本脚本的理由:随机基线机制可复用,且下次想走「用未来验证过去」时先读这里。
 * 真实 gold 目前只能靠人工抽检,或找一个能区分「引用」与「重跑」的信号。
 */
import { execSync } from 'node:child_process';
import { inspectMessages } from '../lib/fold.js';
import { pickCandidates, decideEntries } from '../lib/decide-fold.js';
import { estTokensUtf8 } from '../lib/tokens.js';

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const file = argv.find((a) => !a.startsWith('--'));
if (!file) { console.error('用法: node bench/decide-gold-bench.mjs <session.jsonl.zstd> [--at 0.6]'); process.exit(2); }
const atIndex = argv.indexOf('--at');
const RATIO = atIndex >= 0 ? Number(argv[atIndex + 1]) || 0.6 : 0.6;

function decideKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync('ga-keys get LITELLM_MASTER_KEY', { encoding: 'utf8' }).trim();
}

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
function messagesOf(raw) {
  const messages = [];
  for (const line of raw.split(NL)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!MESSAGE_TYPES.has(event.type)) continue;
    const message = event.data && event.data.message ? event.data.message : event.data;
    if (message && typeof message === 'object') messages.push(message);
  }
  return messages;
}

function blocksOf(message) { return Array.isArray(message && message.content) ? message.content : []; }
function textOf(message) {
  return blocksOf(message).filter((b) => b && b.type === 'text').map((b) => b.text).join(NL).trim();
}
function toolCallsOf(message) {
  return blocksOf(message).filter((b) => b && b.type === 'tool-call' && typeof b.name === 'string');
}
function toolResultOf(message) {
  return blocksOf(message).find((b) => b && b.type === 'tool-result') || null;
}

/** 模型侧的「未来」:它写了什么、又带着什么参数调了什么工具。工具结果本身不算引用。 */
function futureCorpus(messages) {
  const parts = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = textOf(m);
    if (text) parts.push(text);
    for (const call of toolCallsOf(m)) {
      parts.push(typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}));
    }
  }
  return parts.join(NL);
}

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_./-]{6,}[A-Za-z0-9]|[0-9]{5,}/g;
/** 只把「结构化」的串当证据:含 . / - _ 、含大写、或足够长。
 * 纯小写常用词(complete / anything / directly / validate)不算 —— 实测它们会把
 * 「模型只是又提到了这个话题」误判成「模型引用了这条结果」。 */
function isStructured(token) {
  if (/[^A-Za-z0-9]/.test(token)) return true;
  if (token.length >= 14) return true;
  if (/[A-Z]/.test(token)) return true;
  return false;
}
function tokensOf(text) {
  return new Set((String(text).match(TOKEN_RE) || []).filter(isStructured));
}
function linesOf(text) {
  return String(text).split(NL).map((l) => l.trim()).filter((l) => l.length >= 30);
}

/** 整个折页点前语料里每个 token 出现几次。
 * 第一版把「稀有」定义成「在 12 个候选里只出现一次」,阴性对照立刻证伪:那样筛出来的串
 * (headroom / openviking / codebase-memory)本就是会话主题词,命中率与随机抽串一模一样(0.105 vs 0.108)。
 * 改成全语料计数后,只有真正只在一处出现过的标识符才算稀有。 */
function tokenCounts(text) {
  const map = new Map();
  for (const t of String(text).match(TOKEN_RE) || []) {
    if (!isStructured(t)) continue;
    map.set(t, (map.get(t) || 0) + 1);
  }
  return map;
}

function corpusTextOf(messages) {
  return messages.map((m) => {
    const parts = [textOf(m)];
    for (const call of toolCallsOf(m)) {
      parts.push(typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}));
    }
    const res = toolResultOf(m);
    if (res) parts.push(typeof res.content === 'string' ? res.content : JSON.stringify(res.content || ''));
    return parts.join(NL);
  }).join(NL);
}

/** 稀有 token:在整个折页点前语料里出现 <= 2 次(算上它自己)。 */
function rareTokens(candidates, counts) {
  const out = new Map();
  for (const c of candidates) {
    out.set(c.id, [...tokensOf(c.text)].filter((t) => (counts.get(t) || 0) <= 2));
  }
  return out;
}

/** 折页点之前的最后一条真实用户请求。 */
function taskOf(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const kind = m.source && m.source.kind;
    if (kind && kind !== 'user') continue;
    const t = textOf(m);
    if (t) return t;
  }
  return '';
}

const raw = execSync('zstd -dc ' + JSON.stringify(file), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const messages = messagesOf(raw);

const resultIndexes = [];
messages.forEach((m, i) => { if (toolResultOf(m)) resultIndexes.push(i); });
if (resultIndexes.length < 4) { console.error('工具结果太少,无法切分'); process.exit(2); }
const cutAt = resultIndexes[Math.min(resultIndexes.length - 1, Math.max(0, Math.floor(resultIndexes.length * RATIO)))];
const before = messages.slice(0, cutAt + 1);
const after = messages.slice(cutAt + 1);

const snapshot = inspectMessages(before);
const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
const candidates = pickCandidates(entries, {});
const corpus = futureCorpus(after);
const beforeCounts = tokenCounts(corpusTextOf(before));
const rare = rareTokens(candidates, beforeCounts);

const key = decideKey();
const verdicts = await decideEntries(candidates, { task: taskOf(before), key, minMargin: 0 });

const rows = candidates.map((c) => {
  const v = verdicts.get(c.id) || {};
  const toks = rare.get(c.id) || [];
  const hitTokens = toks.filter((t) => corpus.includes(t));
  const lines = linesOf(c.text);
  const hitLines = lines.filter((l) => corpus.includes(l));
  const target = String(c.target || '');
  const targetHit = target.length >= 6 ? corpus.includes(target) : false;
  return {
    id: c.id, tokens: c.tokens, kind: c.kind, name: c.name, target: target.slice(0, 60),
    action: v.action || 'mechanical', pNeeded: v.pNeeded ?? null, neededMargin: v.neededMargin ?? null,
    rareCount: toks.length, tokenHits: hitTokens.length, lineHits: hitLines.length,
    targetHit, cited: hitTokens.length >= 2 || hitLines.length >= 1,
    hits: hitTokens
  };
});

/** 阴性对照:从候选的全部 token 池里随机抽同样多的串,看它们命中未来语料的概率。
 * 若随机串的命中率与「稀有 token」相当,那么 0.58 这个数字只是「会话主题词又出现了一次」,
 * 不能读成「模型引用了这条结果的内容」。 */
function baselineHitRate(seed) {
  const pool = [...new Set(candidates.flatMap((c) => [...tokensOf(c.text)]))];
  // 池子是候选的全部 token(不限稀有度),这样基线回答的是「随便一个串有多容易命中」。
  let state = seed;
  const rnd = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const rates = [];
  for (let trial = 0; trial < 20; trial += 1) {
    let hits = 0;
    let total = 0;
    for (const c of candidates) {
      const n = (rare.get(c.id) || []).length;
      for (let i = 0; i < n; i += 1) {
        const token = pool[Math.floor(rnd() * pool.length)];
        total += 1;
        if (corpus.includes(token)) hits += 1;
      }
    }
    rates.push(total ? hits / total : 0);
  }
  return { poolSize: pool.length, mean: rates.reduce((a, b) => a + b, 0) / rates.length };
}

const rareTotal = rows.reduce((a, r) => a + r.rareCount, 0);
const rareHits = rows.reduce((a, r) => a + r.tokenHits, 0);
const baseline = baselineHitRate(20260922);

const dropped = rows.filter((r) => r.action === 'drop');
const droppedCited = dropped.filter((r) => r.cited);
const kept = rows.filter((r) => r.action !== 'drop');
const keptCited = kept.filter((r) => r.cited);

const report = {
  file: file.split('/').slice(-2).join('/'),
  messages: messages.length, results: resultIndexes.length, cutAtResult: resultIndexes.indexOf(cutAt),
  beforeResults: entries.length, candidates: candidates.length, futureMessages: after.length,
  rows,
  summary: {
    dropped: dropped.length, droppedCited: droppedCited.length,
    droppedCitedTokens: droppedCited.reduce((a, r) => a + r.tokens, 0),
    droppedTokens: dropped.reduce((a, r) => a + r.tokens, 0),
    kept: kept.length, keptCited: keptCited.length,
    falseDropLowerBound: dropped.length ? droppedCited.length / dropped.length : null,
    rareTotal, rareHits,
    rareHitRate: rareTotal ? rareHits / rareTotal : null,
    baselineHitRate: baseline.mean, baselinePool: baseline.poolSize
  }
};

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('会话 ' + report.file);
  console.log('消息 ' + messages.length + ' 条 · 工具结果 ' + resultIndexes.length + ' 条 · 折页点在第 ' + report.cutAtResult + ' 条结果之后');
  console.log('折页点前 ' + entries.length + ' 条结果(候选 ' + candidates.length + ') · 折页点后 ' + after.length + ' 条消息');
  console.log('');
  console.log('  ' + 'tok'.padEnd(7) + 'action'.padEnd(11) + 'pNeed'.padEnd(7) + '稀有tok'.padEnd(9) + '命中tok'.padEnd(9) + '命中行'.padEnd(8) + 'target'.padEnd(8) + '引用?  说明');
  for (const r of rows) {
    console.log('  ' + String(r.tokens).padEnd(7) + r.action.padEnd(11)
      + (r.pNeeded === null ? 'n/a' : r.pNeeded.toFixed(2)).padEnd(7)
      + String(r.rareCount).padEnd(9) + String(r.tokenHits).padEnd(9) + String(r.lineHits).padEnd(8)
      + String(r.targetHit).padEnd(8) + (r.cited ? 'YES   ' : '-     ') + r.target);
  }
  const s = report.summary;
  console.log('');
  console.log('判 drop 的 ' + s.dropped + ' 条里有 ' + s.droppedCited + ' 条在折页点之后被引用'
    + (s.falseDropLowerBound === null ? '' : ' → 误删率下界 ' + s.falseDropLowerBound.toFixed(2)));
  console.log('  其中被误删的体量 ' + s.droppedCitedTokens + ' tok / 判丢总量 ' + s.droppedTokens + ' tok');
  console.log('判 keep/truncate 的 ' + s.kept + ' 条里有 ' + s.keptCited + ' 条确实被引用(保守但必要)');
  console.log('');
  console.log('阴性对照:稀有 token 命中率 ' + (s.rareHitRate === null ? 'n/a' : s.rareHitRate.toFixed(3))
    + ' (' + s.rareHits + '/' + s.rareTotal + ') · 随机抽同样多的串 ' + s.baselineHitRate.toFixed(3)
    + '(池 ' + s.baselinePool + ')');
}
