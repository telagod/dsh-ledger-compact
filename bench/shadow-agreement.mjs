/**
 * 影子观察层的数据利用:把「判定建议的动作」与「模型实际做的事」join 起来算一致度。
 *
 * 为什么这个 join 是可靠的:shadow.jsonl 每条都记了 session 与 state(该轮用户请求原文),
 * 所以不必重建轮次编号 —— 拿 state 去会话存档里精确匹配那条 user/message 即可。
 * 匹配点之后、下一条真实用户消息之前,就是「模型在无判定干预下实际做的事」(影子层不改行为,
 * 这正是天然的对照组)。
 *
 * 实际行为一律取**结构化**信号:本机 ptc 模式下所有工具都经 run_code 调用,
 * 故从工具调用参数里递归取字符串再匹配 tools.X( —— 与路径追踪同一套做法。
 *
 * 用法:node bench/shadow-agreement.mjs [--json] [--limit N]
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const NL = String.fromCharCode(10);
const JSON_OUT = process.argv.includes('--json');
const HOME = homedir();
const SHADOW = join(HOME, '.decide', 'shadow.jsonl');
const SESSIONS = join(HOME, '.dsh', 'sessions');

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
const isUser = (m) => m && m.role === 'user' && (!m.source || m.source.kind === 'user');

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

/** 会话存档索引:session id -> zstd 路径。 */
function archiveIndex() {
  const map = new Map();
  for (const ws of readdirSync(SESSIONS)) {
    const wsDir = join(SESSIONS, ws);
    let entries;
    try { entries = readdirSync(wsDir); } catch { continue; }
    for (const dir of entries) {
      const dirPath = join(wsDir, dir);
      let files;
      try { files = readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl.zstd')) continue;
        map.set(dir, join(dirPath, f));
      }
    }
  }
  return map;
}

/** 实际行为的结构化信号。 */
const SIGNALS = {
  askedUser: /tools\.ask_user_question\s*\(/,
  createdGoal: /tools\.create_goal\s*\(/,
  delegated: /tools\.(subagent|subagent_fork|summon_expert|summon_experts|summon_expert_team)\s*\(/,
  usedSkill: /tools\.(skill|open_skill|find_skills)\s*\(/,
  usedTodo: /tools\.todo_write\s*\(/,
  // 「Research」不能只认 web_search:本机取仓库外材料的途径还有 MCP 中间层、anysearch、
  // gh、curl、opencli。第一版只认 web_search/web_fetch,得出的 0% 一致率是检测太窄,不是分歧。
  researched: /tools\.(web_search|web_fetch)\s*\(/,
  fetchedOutside: /tools\.(ws_mcp_call|ws_mcp_search|anysearch_search|anysearch_batch_search|ws_mcp_list|ws_mcp_detail)\s*\(/,
  shellNet: /(curl|wget)\s+[^"']{0,60}https?:|gh\s+(api|search|pr|issue|repo|release)\s|opencli\s/
};

const shadow = readFileSync(SHADOW, 'utf8').trim().split(NL).filter(Boolean).map((l) => JSON.parse(l));
const archives = archiveIndex();
const cache = new Map();
function messagesFor(session) {
  if (cache.has(session)) return cache.get(session);
  const path = archives.get(session) || archives.get('session-' + session) || archives.get(String(session).replace(/^session-/, ''));
  let out = null;
  if (path && existsSync(path)) {
    try { out = messagesOf(execSync('zstd -dc ' + JSON.stringify(path), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })); } catch { out = null; }
  }
  cache.set(session, out);
  return out;
}

const rows = [];
let joined = 0;
let missing = 0;
let unmatched = 0;
for (const s of shadow) {
  const messages = messagesFor(s.session);
  if (!messages) { missing += 1; rows.push({ session: s.session, turn: s.turn, joined: false, why: 'no-archive' }); continue; }
  const want = String(s.state || '').slice(0, 200);
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!isUser(messages[i])) continue;
    const t = textOf(messages[i]);
    if (t && (t.startsWith(want) || want.startsWith(t.slice(0, 200)))) { at = i; break; }
  }
  if (at < 0) { unmatched += 1; rows.push({ session: s.session, turn: s.turn, joined: false, why: 'no-match' }); continue; }
  joined += 1;
  const texts = [];
  for (let i = at + 1; i < messages.length; i += 1) {
    if (isUser(messages[i])) break;
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (const c of callsOf(m)) for (const t of stringsOf(c.arguments)) texts.push(t);
  }
  const blob = texts.join(NL);
  const actual = {};
  for (const [k, re] of Object.entries(SIGNALS)) actual[k] = re.test(blob);
  actual.researchedAny = actual.researched || actual.fetchedOutside || actual.shellNet;
  const byId = {};
  for (const r of s.rows || []) byId[r.id] = r;
  rows.push({ session: s.session, turn: s.turn, joined: true, actual,
    ask_now: byId.ask_now?.action ?? null,
    need_goal: byId.need_goal?.action ?? null,
    delegate: byId.delegate?.action ?? null,
    effort: byId.effort?.value ?? null,
    effortLevel: String(byId.effort?.level || '').split(':')[0] || null,
    state: String(s.state || '').slice(0, 70),
    calls: texts.length });
}

const ok = rows.filter((r) => r.joined);
function rate(list, pred) { return list.length ? list.filter(pred).length / list.length : null; }
function pct(x) { return x === null ? 'n/a' : (x * 100).toFixed(0) + '%'; }

/** 混淆矩阵:判定建议动作 vs 模型实际做没做。 */
function confusion(list, suggest, actualKey) {
  const yes = list.filter((r) => suggest(r));
  const no = list.filter((r) => !suggest(r));
  return {
    suggested: yes.length, suggestedAndDid: yes.filter((r) => r.actual[actualKey]).length,
    suggestedNotDid: yes.filter((r) => !r.actual[actualKey]).length,
    notSuggestedButDid: no.filter((r) => r.actual[actualKey]).length,
    neither: no.filter((r) => !r.actual[actualKey]).length
  };
}

const report = {
  total: shadow.length, joined, missing, unmatched,
  sessions: new Set(shadow.map((s) => s.session)).size,
  askNow: confusion(ok, (r) => r.ask_now === 'ASK_USER', 'askedUser'),
  needGoal: confusion(ok, (r) => r.need_goal === 'CREATE_GOAL', 'createdGoal'),
  delegate: confusion(ok, (r) => r.delegate === 'delegate', 'delegated'),
  research: confusion(ok, (r) => String(r.effortLevel || '').includes('Research'), 'researchedAny'),
  researchNarrow: confusion(ok, (r) => String(r.effortLevel || '').includes('Research'), 'researched'),
  actualRates: {
    askedUser: rate(ok, (r) => r.actual.askedUser),
    createdGoal: rate(ok, (r) => r.actual.createdGoal),
    delegated: rate(ok, (r) => r.actual.delegated),
    researched: rate(ok, (r) => r.actual.researched),
    fetchedOutside: rate(ok, (r) => r.actual.fetchedOutside),
    shellNet: rate(ok, (r) => r.actual.shellNet),
    researchedAny: rate(ok, (r) => r.actual.researchedAny),
    usedSkill: rate(ok, (r) => r.actual.usedSkill),
    usedTodo: rate(ok, (r) => r.actual.usedTodo)
  },
  rows
};

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('shadow 记录 ' + report.total + ' 条 · 会话 ' + report.sessions + ' 个');
  console.log('join 成功 ' + joined + ' · 存档缺失 ' + missing + ' · 用户消息没匹配上 ' + unmatched);
  console.log('');
  console.log('== 模型实际行为发生率(仅 join 成功的)==');
  for (const [k, v] of Object.entries(report.actualRates)) console.log('  ' + k.padEnd(14) + pct(v));
  console.log('');
  console.log('== 混淆矩阵:判定建议 vs 模型实际 ==');
  const show = (name, c) => console.log('  ' + name.padEnd(12) + '建议 ' + String(c.suggested).padEnd(4)
    + '· 建议且做了 ' + String(c.suggestedAndDid).padEnd(4) + '· 建议没做 ' + String(c.suggestedNotDid).padEnd(4)
    + '· 没建议却做了 ' + String(c.notSuggestedButDid).padEnd(4) + '· 都没 ' + c.neither);
  show('ask_now', report.askNow);
  show('need_goal', report.needGoal);
  show('delegate', report.delegate);
  show('effort(窄)', report.researchNarrow);
  show('effort(宽)', report.research);
}
