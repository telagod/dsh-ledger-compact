/**
 * task 取样敏感性:同一个 span,换「当前任务」那一行,判定结果会不会翻?
 *
 * 为什么必须测:fold 用 taskOf() 取**最后一条**用户消息当任务。真实会话的最后一条
 * 常常是「我在界面关了」「继续」这类没有信息量的话 —— 而判定器被问的正是
 * 「内容是否还需要完成当前任务」。若任务文本没信息,判定就只剩先验。
 * 实测动机:真实会话扫描给出 12 条候选里 11 条 drop,而那条会话的最后一条用户消息
 * 恰是「我在界面关了」。这个 drop 率是真收益还是 task 噪音,只能靠换 task 实测。
 *
 * 做法:直接调用现役 decideEntries(连 laterContext 与 state 构造都是真的),只换 task。
 * 用法:node bench/decide-task-bench.mjs <session.jsonl.zstd> [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMessages } from '../lib/fold.js';
import { pickCandidates, decideEntries } from '../lib/decide-fold.js';
import { estTokensUtf8 } from '../lib/tokens.js';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const JSON_OUT = process.argv.includes('--json');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) { console.error('用法: node bench/decide-task-bench.mjs <session.jsonl.zstd>'); process.exit(2); }

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

function textOf(message) {
  return (message.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join(NL).trim();
}

/** 真实用户消息(跳过插件注入),按时间顺序。 */
function userTexts(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const kind = m.source && m.source.kind;
    if (kind && kind !== 'user') continue;
    const t = textOf(m);
    if (t) out.push(t);
  }
  return out;
}

/** 无信息量的短消息,模拟「继续」「关了」这类。 */
const NOISE = /^(继续|好的|好|ok|okay|嗯|关了|我在界面关了|go on|continue|thanks|谢谢)[。.!！]?$/i;

const raw = execSync('zstd -dc ' + JSON.stringify(file), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const messages = messagesOf(raw);
const snapshot = inspectMessages(messages);
const entries = snapshot.entries.map((e) => ({ ...e, tokens: estTokensUtf8(e.text) }));
const candidates = pickCandidates(entries, {});
const users = userTexts(messages);

const lastUser = users.length ? users[users.length - 1] : '';
const substantive = [...users].reverse().find((t) => t.length >= 20 && !NOISE.test(t.trim())) || '';
const firstUser = users.length ? users[0] : '';

const TASKS = [
  { id: 'T_last(现役)', text: lastUser },
  { id: 'T_substantive', text: substantive },
  { id: 'T_first', text: firstUser },
  { id: 'T_none', text: '' }
];

const key = decideKey();
const out = [];
for (const t of TASKS) {
  const verdicts = await decideEntries(candidates, { task: t.text, key, minMargin: 0 });
  const rows = candidates.map((c) => {
    const v = verdicts.get(c.id) || {};
    return { id: c.id, tokens: c.tokens, target: c.target, action: v.action, pNeeded: v.pNeeded ?? null,
      pRerun: v.pRerun ?? null, neededMargin: v.neededMargin ?? null, error: v.error ?? null };
  });
  const ok = rows.filter((r) => r.pNeeded !== null);
  out.push({ task: t.id, taskText: t.text.replace(/\s+/g, ' ').slice(0, 80), rows,
    meanP: ok.length ? ok.reduce((a, r) => a + r.pNeeded, 0) / ok.length : null,
    meanMargin: ok.length ? ok.reduce((a, r) => a + r.neededMargin, 0) / ok.length : null,
    drops: rows.filter((r) => r.action === 'drop').length,
    keeps: rows.filter((r) => r.action === 'keep').length,
    truncates: rows.filter((r) => r.action === 'truncate').length,
    mechanical: rows.filter((r) => r.action === 'mechanical').length,
    droppedTokens: rows.filter((r) => r.action === 'drop').reduce((a, r) => a + r.tokens, 0) });
}

const report = { file: file.split('/').slice(-2).join('/'), users: users.length, lastUser: lastUser.slice(0, 120),
  substantive: substantive.slice(0, 120), candidates: candidates.length, byTask: out };
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('会话 ' + report.file + ' · 候选 ' + candidates.length + ' 条 · 用户消息 ' + users.length + ' 条');
  console.log('现役 task(最后一条): ' + report.lastUser);
  console.log('有实义的 task      : ' + report.substantive);
  console.log('');
  console.log('  ' + 'task'.padEnd(18) + 'meanP'.padEnd(8) + 'meanMargin'.padEnd(12) + 'drop/keep/trunc/mech'.padEnd(24) + '丢弃tok');
  for (const t of out) {
    console.log('  ' + t.task.padEnd(18) + (t.meanP === null ? 'n/a' : t.meanP.toFixed(3)).padEnd(8)
      + (t.meanMargin === null ? 'n/a' : t.meanMargin.toFixed(3)).padEnd(12)
      + (t.drops + '/' + t.keeps + '/' + t.truncates + '/' + t.mechanical).padEnd(24) + t.droppedTokens);
  }
  console.log('');
  console.log('  逐条 pNeeded(行=候选,列=task)');
  console.log('    ' + 'tok'.padEnd(7) + out.map((t) => t.task.slice(0, 14).padEnd(16)).join(''));
  candidates.forEach((c, i) => {
    console.log('    ' + String(c.tokens).padEnd(7) + out.map((t) => {
      const r = t.rows[i];
      return ((r.pNeeded === null ? 'n/a' : r.pNeeded.toFixed(2)) + '/' + r.action.slice(0, 4)).padEnd(16);
    }).join(''));
  });
}
