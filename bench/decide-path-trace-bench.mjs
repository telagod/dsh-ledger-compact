/**
 * 路径追踪:被判 drop 的结果读过的文件,折页点之后有没有被**写操作**碰过?
 *
 * 为什么换这个信号:token 匹配已被证伪(稀有串命中率与随机抽串无异)。
 * 但「后续 edit 了某个文件」是**结构化**事实 —— 它写在工具调用参数里,不靠语义猜测。
 * 判读方向(关键):
 *   后续 **edit/write** 同一文件 → 需要知道文件内容 → 该结果被 drop 是**高风险**
 *   后续只 **read** 同一文件     → 内容可以重新读到 → drop 是**合理**的(rerun 象限)
 *
 * 本机 ptc 模式下一切工具都经 run_code 调用,所以路径要从 code 文本里提取。
 * 局限(必须诚实):code 里大量使用变量拼接(R + "/README.md"),字面量提取会漏;
 * 故本脚本只提取「以扩展名结尾的字符串片段」并按文件名比对,是下界而非全量。
 *
 * 用法:node bench/decide-path-trace-bench.mjs <session.jsonl.zstd> [--at 0.6] [--json]
 */
import { execSync } from 'node:child_process';
import { inspectMessages } from '../lib/fold.js';
import { pickCandidates, decideEntries } from '../lib/decide-fold.js';
import { estTokensUtf8 } from '../lib/tokens.js';

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const file = argv.find((a) => !a.startsWith('--'));
if (!file) { console.error('用法: node bench/decide-path-trace-bench.mjs <session.jsonl.zstd> [--at 0.6]'); process.exit(2); }
const atIndex = argv.indexOf('--at');
const RATIO = atIndex >= 0 ? Number(argv[atIndex + 1]) || 0.6 : 0.6;

function decideKey() {
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  return execSync('ga-keys get LITELLM_MASTER_KEY', { encoding: 'utf8' }).trim();
}

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
function messagesOf(raw) {
  const out = [];
  for (const line of raw.split(NL)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!MESSAGE_TYPES.has(e.type)) continue;
    const m = e.data && e.data.message ? e.data.message : e.data;
    if (m && typeof m === 'object') out.push(m);
  }
  return out;
}
const blocks = (m) => Array.isArray(m && m.content) ? m.content : [];
const textOf = (m) => blocks(m).filter((b) => b && b.type === 'text').map((b) => b.text).join(NL).trim();
const callsOf = (m) => blocks(m).filter((b) => b && b.type === 'tool-call' && typeof b.name === 'string');
const resultOf = (m) => blocks(m).find((b) => b && b.type === 'tool-result') || null;
const argText = (a) => typeof a === 'string' ? a : JSON.stringify(a || {});

/** 递归收集参数里的所有字符串。
 * 不能先 JSON.stringify 再正则:那样引号会变成 \",实测提取出的是
 * `.tree[] | select(.type==\\\"blob` 这类转义残渣。 */
function collectStrings(value, out) {
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, out); }
}
function stringsOf(args) {
  let value = args;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = args; } }
  const out = [];
  collectStrings(value, out);
  return out;
}
/** 从参数字符串里提取以扩展名结尾的路径片段(README.md / lib/fold.js / CHANGELOG.md)。 */
function pathFragments(args) {
  const out = new Set();
  for (const text of stringsOf(args)) {
    const re = /"([^"\n]{3,140})"|'([^'\n]{3,140})'/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m[1] || m[2];
      if (!/\.[a-z]{2,5}$/.test(s)) continue;
      if (!/[A-Za-z]/.test(s)) continue;
      out.add(s);
    }
  }
  return out;
}
const baseName = (p) => p.split('/').pop();
/** 参数里是否出现写操作。 */
function hasWrite(args) {
  return stringsOf(args).some((t) => /tools\.(edit|write)\s*\(/.test(t));
}

const raw = execSync('zstd -dc ' + JSON.stringify(file), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const messages = messagesOf(raw);
const idx = [];
messages.forEach((m, i) => { if (resultOf(m)) idx.push(i); });
if (idx.length < 4) { console.error('工具结果太少'); process.exit(2); }
const cut = idx[Math.min(idx.length - 1, Math.max(0, Math.floor(idx.length * RATIO)))];
const before = messages.slice(0, cut + 1);
const after = messages.slice(cut + 1);

const snap = inspectMessages(before);
const candidates = pickCandidates(snap.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) })), {});

/** entry.id -> 该次工具调用的参数文本(拿它读过的文件)。 */
const argsById = new Map();
const pending = new Map();
for (const m of before) {
  for (const c of callsOf(m)) pending.set(String(c.id ?? ''), c.arguments);
  const res = resultOf(m);
  if (!res) continue;
  const id = String(res.toolCallId ?? res.id ?? '');
  if (pending.has(id)) argsById.set(id, pending.get(id));
}

/** 折页点之后的读/写轨迹,外加「写之前没有重读」的文件。
 * 判据:后续要写某文件却没先重读它 ⇒ 它用的是折页点前上下文里的内容 ⇒
 * 那条内容若被判 drop,模型就写不出来了 —— 这是误删的强证据。
 * 反之若写之前重读过,内容从新的 read 来,旧结果 drop 无害(rerun 象限)。 */
const writtenAfter = new Set();
const readAfter = new Set();
const riskyWrites = new Set();
const readSeen = new Set();
for (const m of after) {
  for (const c of callsOf(m)) {
    const a = c.arguments;
    const frags = [...pathFragments(a)].map(baseName);
    if (hasWrite(a)) {
      for (const f of frags) {
        writtenAfter.add(f);
        if (!readSeen.has(f)) riskyWrites.add(f);
        readSeen.add(f);
      }
    } else {
      for (const f of frags) { readAfter.add(f); readSeen.add(f); }
    }
  }
}

const key = decideKey();
const verdicts = await decideEntries(candidates, { task: (function taskOf(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const k = m.source && m.source.kind;
    if (k && k !== 'user') continue;
    const t = textOf(m); if (t) return t;
  }
  return '';
})(before), key, minMargin: 0 });

const rows = candidates.map((c) => {
  const v = verdicts.get(c.id) || {};
  const own = [...pathFragments(argsById.get(c.id) || '')].map(baseName);
  const written = own.filter((f) => writtenAfter.has(f));
  const read = own.filter((f) => readAfter.has(f));
  return { id: c.id, tokens: c.tokens, target: c.target.slice(0, 50),
    action: v.action || 'mechanical', pNeeded: v.pNeeded ?? null,
    files: [...new Set(own)].slice(0, 8), written, read,
    risky: own.filter((f) => riskyWrites.has(f)),
    risk: own.some((f) => riskyWrites.has(f)) };
});

/** 折页点前每条结果覆盖了哪些文件 —— 决定「内容是否会被彻底删光」。
 * 判据:后续要写某文件又没重读,而该文件在折页点前**只被这一条结果覆盖**,且这条被判 drop
 * ⇒ 那份内容在 fold 之后无处可寻,模型写不出来 —— 这才是真正的误删。
 * 若同一文件还有别的结果覆盖(哪怕只是摘录),内容就没丢干净。 */
const coverageBefore = new Map();
for (const e of snap.entries) {
  for (const f of [...pathFragments(argsById.get(e.id))].map(baseName)) {
    if (!coverageBefore.has(f)) coverageBefore.set(f, []);
    coverageBefore.get(f).push(e.id);
  }
}
const droppedIds = new Set([...verdicts.entries()].filter(([, v]) => v.action === 'drop').map(([id]) => id));
const lostFiles = [...riskyWrites].map((f) => {
  const owners = coverageBefore.get(f) || [];
  const droppedOwners = owners.filter((id) => droppedIds.has(id));
  return { file: f, owners: owners.length, droppedOwners: droppedOwners.length,
    lost: owners.length > 0 && droppedOwners.length === owners.length };
});

// 回填 risk:写前未重读还不够 —— 该文件在折页点前必须**有内容**,且覆盖它的结果**全被判 drop**,
// 才算「fold 之后这份内容无处可寻」。折页点之后新建的文件(覆盖 0 条)不该算。
const lostSet = new Set(lostFiles.filter((l) => l.lost).map((l) => l.file));
for (const r of rows) r.risk = r.risky.some((f) => lostSet.has(f));

const dropped = rows.filter((r) => r.action === 'drop');
const report = {
  file: file.split('/').slice(-2).join('/'),
  cutAt: idx.indexOf(cut), results: idx.length,
  afterWrittenFiles: [...writtenAfter].slice(0, 40), afterReadFiles: [...readAfter].slice(0, 40),
  rows,
  summary: {
    candidates: rows.length,
    withFiles: rows.filter((r) => r.files.length > 0).length,
    dropped: dropped.length,
    droppedWithWriteHit: dropped.filter((r) => r.written.length > 0).length,
    droppedWithRisky: dropped.filter((r) => r.risk).length,
    droppedTokens: dropped.reduce((a, r) => a + r.tokens, 0),
    droppedRiskTokens: dropped.filter((r) => r.risk).reduce((a, r) => a + r.tokens, 0),
    lostFiles
  }
};

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('会话 ' + report.file + ' · 折页点在第 ' + report.cutAt + '/' + report.results + ' 条结果之后');
  console.log('折页点后写过的文件: ' + report.afterWrittenFiles.join(', '));
  console.log('');
  console.log('  ' + 'tok'.padEnd(7) + 'action'.padEnd(11) + 'pNeed'.padEnd(7) + '读过文件'.padEnd(34) + '后续写过?  后续读过?');
  for (const r of rows) {
    console.log('  ' + String(r.tokens).padEnd(7) + r.action.padEnd(11)
      + (r.pNeeded === null ? 'n/a' : r.pNeeded.toFixed(2)).padEnd(7)
      + r.files.join(',').slice(0, 32).padEnd(34)
      + (r.written.join(',') || '-').slice(0, 12).padEnd(12) + (r.risky.join(',') || '-').slice(0, 18));
  }
  const s = report.summary;
  console.log('');
  console.log('候选 ' + s.candidates + ' 条(其中 ' + s.withFiles + ' 条能提取到文件)');
  console.log('判 drop ' + s.dropped + ' 条 · 其中读过「后续被写过」的文件的 ' + s.droppedWithWriteHit + ' 条');
  console.log('  ** 其中「写之前没有重读」的(误删强证据): ' + s.droppedWithRisky + ' 条 · ' + s.droppedRiskTokens + ' tok / 判丢总量 ' + s.droppedTokens + ' tok');
  console.log('');
  console.log('写前未重读的文件,在折页点前由几条结果覆盖:');
  for (const l of s.lostFiles.filter((x) => x.owners > 0)) {
    console.log('  ' + l.file.padEnd(26) + '覆盖 ' + l.owners + ' 条 · 其中判 drop ' + l.droppedOwners + ' 条'
      + (l.lost ? '  ← 内容被删光' : '  (仍有别的结果覆盖)'));
  }
}
