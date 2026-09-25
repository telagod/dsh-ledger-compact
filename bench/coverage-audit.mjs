#!/usr/bin/env node
/**
 * 覆盖率审计：压缩之后，「具体某一行的值」还在不在？按行位置分档。
 *
 * 为什么需要它：fidelity-bench 的每个问题都被刻意限制在文件前 39 行（fixtures.mjs 第 3 行
 * 自述：为了让小变体不因容量受罚）。那个形状能测「小变体会不会被惩罚」，测不出「深处的行
 * 还能不能被读到」。本脚本不调模型、不花钱：它只看每个臂的输出里，原始行还剩下哪些，
 * 再按位置分档统计覆盖率。度量的是「任意问题可答性的上界」，不是「模型答没答对」。
 *
 * 用法：node bench/coverage-audit.mjs [--extra 16] [--json]
 */
import { fixtures } from "./fixtures.mjs";
import { snapExcerpt, tokenDigest } from "../lib/excerpt.js";
import { estTokensUtf8 } from "../lib/tokens.js";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const EXTRA = Number(flag("extra", "16")) || 16;
const JSON_OUT = argv.includes("--json");

const HEAD = 16;
const TAIL = 8;
const SIGNAL = /(error|fail|warn|exception|denied|timeout|refused|panic|fatal|503|500)/i;

/** 行的模板：把数字抹平，用来判断「这行是不是独一无二」。 */
function templateOf(line) {
  return line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function headTailLines(lines) {
  return { head: lines.slice(0, HEAD), tail: lines.slice(lines.length - TAIL) };
}

function noticeOf(skipped) {
  return skipped > 0 ? "\u2026 (" + skipped + " lines elided between the kept ranges) \u2026" : "";
}

function assemble(lines, kept) {
  const keptSet = new Set(kept);
  const body = kept.join(NL);
  const skipped = lines.length - keptSet.size;
  return body + (noticeOf(skipped) ? NL + noticeOf(skipped) : "");
}

/** 按策略挑出额外的行（已去掉头尾已有的那部分）。 */
function pickExtra(lines, count, chooser) {
  const inner = lines.slice(HEAD, Math.max(HEAD, lines.length - TAIL));
  return chooser(inner).slice(0, count);
}

const CHOOSERS = {
  "signal-first": (inner) => inner.filter((line) => SIGNAL.test(line)),
  "rare-first": (inner) => {
    const counts = new Map();
    for (const line of inner) {
      const t = templateOf(line);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    // On homogeneous data every template ties, and ordering by index would silently degrade
    // this arm into "extended head". Ties are spread with a fixed hash instead, so the arm
    // only wins when rarity itself wins. head-extend is the control that proves it.
    const spread = (i) => (i * 2654435761) % 1000;
    return inner
      .map((line, i) => ({ line, i, n: counts.get(templateOf(line)) || 0 }))
      .sort((a, b) => a.n - b.n || spread(a.i) - spread(b.i) || a.i - b.i)
      .map((row) => row.line);
  },
  "even-sample": (inner) => {
    const step = Math.max(1, Math.floor(inner.length / EXTRA));
    const picked = [];
    for (let i = 0; i < inner.length && picked.length < EXTRA; i += step) picked.push(inner[i]);
    return picked;
  }
};

const ARMS = {
  /** Nothing kept: the control that proves the measurement itself is right. */
  all: (lines) => assemble(lines, lines.slice()),
  /** Head 16 with the extra budget spent on more head: the control for rare-first. */
  "head-extend": (lines) => assemble(lines, [...lines.slice(0, HEAD + EXTRA), ...lines.slice(lines.length - TAIL)]),
  "head-tail": (lines) => {
    const both = headTailLines(lines);
    return assemble(lines, [...both.head, ...both.tail]);
  },
  "head-tail+digest": (lines) => {
    const both = headTailLines(lines);
    const digest = tokenDigest(lines.join(NL));
    return assemble(lines, [...both.head, ...both.tail]) + (digest ? NL + digest : "");
  }
};
for (const [name, chooser] of Object.entries(CHOOSERS)) {
  ARMS[name] = (lines) => {
    const both = headTailLines(lines);
    const extra = pickExtra(lines, EXTRA, chooser);
    return assemble(lines, [...both.head, ...extra, ...both.tail]);
  };
}

/** 位置分档。前 39 行单独一档，因为那正是现有 fixture 的答案区。 */
function bandOf(index, total) {
  if (index < HEAD) return "head(0-15)";
  if (index < 40) return "early(16-39)";
  if (index < total / 2) return "mid";
  if (index < total - TAIL) return "late";
  return "tail";
}
const BANDS = ["head(0-15)", "early(16-39)", "mid", "late", "tail"];

const results = [];
for (const fixture of fixtures()) {
  const lines = fixture.lines;
  for (const [arm, render] of Object.entries(ARMS)) {
    const output = render(lines);
    const kept = new Set(output.split(NL));
    const tally = {};
    for (const band of BANDS) tally[band] = { hit: 0, total: 0 };
    for (let i = 0; i < lines.length; i += 1) {
      const band = bandOf(i, lines.length);
      tally[band].total += 1;
      if (kept.has(lines[i])) tally[band].hit += 1;
    }
    const keptCount = lines.filter((line) => kept.has(line)).length;
    results.push({ fixture: fixture.name, arm, lines: lines.length, tokens: estTokensUtf8(output), keptCount, tally });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ extra: EXTRA, results }, null, 2));
  process.exit(0);
}

function pct(hit, total) {
  if (total === 0) return "—";
  return Math.round((hit / total) * 100) + "%";
}

console.log("覆盖率：原始行在压缩输出里还剩下多少（行级精确匹配，不调模型）");
console.log("额外保留行数 = " + EXTRA + "；顺序 = 16 头 / 额外行 / 8 尾");
console.log("");
const header = ["fixture", "arm", "tok", "kept/total", ...BANDS].map((s) => s.padEnd(14)).join("");
console.log(header);
console.log("-".repeat(header.length));
for (const row of results) {
  const cells = [row.fixture, row.arm, String(row.tokens), row.keptCount + "/" + row.lines, ...BANDS.map((b) => pct(row.tally[b].hit, row.tally[b].total))];
  console.log(cells.map((s) => s.padEnd(14)).join(""));
}
console.log("");
console.log("说明：head/early 是现状安全带；mid/late 是现有 fixture 从不提问的区域。");
console.log("digest 是聚合计数，行级匹配对它不公平（它答的是「有多少个」，不是「第几行」）。");