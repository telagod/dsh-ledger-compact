/**
 * Verdict fold: typed-decide decides what a fold card must carry verbatim.
 *
 * Why this sits at the fold and not at the ingress. The ingress pass may only rewrite
 * the result of the immediately preceding step; an older node already sits in a
 * provider-cached prefix, and rewriting it would force a full re-prefill of everything
 * after it (the contract at the top of ingress.js). A fold replaces the whole span in a
 * single write, so that cache is invalidated either way and the choice is free.
 *
 * Off by default, and every failure path answers "mechanical": a compaction that cannot
 * reach the decider must still compact.
 */

import { clampUtf8, estTokensUtf8 } from "./tokens.js";

export const DECIDE_FOLD_DEFAULTS = {
  endpoint: "http://127.0.0.1:4000/v1/decide/batch",
  /** Only the largest results are worth a call; a 40-line result is already cheap. */
  maxEntries: 12,
  minEntryTokens: 200,
  /** Whole-pass budget. Past it the remaining entries stay mechanical. */
  budgetMs: 4000,
  perCallTimeoutMs: 3500,
  /** Below this the answer is a coin flip, so the entry keeps the mechanical treatment. */
  minMargin: 0.15,
  /** Measured: twelve at once loses about half the answers to upstream throttling. */
  concurrency: 4,
  /** One retry, for the transient failures that throttling produces. */
  retries: 1,
  retryDelayMs: 300,
  pageChars: 700,
  /** Lines of body a "keep" verdict restores to the card. */
  keepLines: 14
};

/**
 * Both halves of the quadrant are asked in one call. The second question is deliberately
 * "if dropped, could this be obtained again" — not "is it reproducible in principle":
 * a one-off id printed once is never reproducible, and that is exactly the case a fold
 * must not drop.
 */
export const Q_NEEDED = "The contents of this tool result are still needed to finish the current task.";
export const Q_RERUN = "If this tool result were dropped, could the same information be obtained again by re-running the same tool call?";

/**
 * A missing answer must never read as zero.
 *
 * `Number(null)` is 0, and the wire shape reports an absent probability as null. Coercing
 * it would turn "the decider did not answer" into "certainly not needed" — the one
 * direction that deletes context. Absent and unusable values are null here, and every
 * caller treats null as no verdict.
 */
function probabilityOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Quadrant -> action. Drops are the only irreversible move, so they need the strictest
 * precondition: not needed AND reproducible. Anything uncertain keeps the mechanical
 * treatment, which is the behaviour this plugin already had.
 */
export function verdictAction(input) {
  const needed = probabilityOf(input?.pNeeded);
  const rerun = probabilityOf(input?.pRerun);
  const needMargin = probabilityOf(input?.neededMargin);
  const rerunMargin = probabilityOf(input?.rerunMargin);
  const minMargin = probabilityOf(input?.minMargin) ?? DECIDE_FOLD_DEFAULTS.minMargin;
  if (needed === null || rerun === null) return "mechanical";
  if (needMargin === null || rerunMargin === null) return "mechanical";
  if (needMargin < minMargin || rerunMargin < minMargin) return "mechanical";
  const isNeeded = needed >= 0.5;
  const isRerun = rerun >= 0.5;
  if (isNeeded && !isRerun) return "keep";
  if (!isNeeded && isRerun) return "drop";
  if (isNeeded && isRerun) return "truncate";
  return "keep";
}

/**
 * One line of evidence the decider cannot derive on its own: what happened after this entry.
 *
 * Stated neutrally on purpose. An earlier version said "nothing in the span refers back to this
 * result", which reads as an argument for dropping it; the decider then answered the hint
 * instead of the fact. Absence of a later touch is absence of evidence, and is worded as such.
 */
function laterContextOf(entry, index, entries) {
  const target = entry.target;
  if (!target) return "No later step in the span names a target for this result, so the span does not say whether it has been superseded.";
  const after = entries.slice(index + 1).filter((item) => item.target === target);
  if (after.length === 0) return "No later step in the span touches the same target.";
  const kinds = [...new Set(after.map((item) => item.kind))].join(", ");
  const rewrite = after.some((item) => item.kind === "edit" || item.kind === "write");
  return rewrite
    ? "A later step (" + kinds + ") rewrote the same target, so this earlier content is superseded."
    : "A later step (" + kinds + ") touched the same target again, so this content can be obtained again.";
}

/** The state handed to the decider: task, the call, a page of the result, and the evidence. */
export function verdictState(entry, options = {}) {
  const pageChars = Number(options.pageChars) || DECIDE_FOLD_DEFAULTS.pageChars;
  const text = String(entry?.text ?? "");
  const lines = text.split(String.fromCharCode(10));
  const head = text.replace(/\s+/g, " ").slice(0, pageChars);
  return [
    "User request: " + (options.task ? clampUtf8(options.task, 400) : "(not available)"),
    "Tool call: " + (entry?.name || "tool") + " -> ok, " + lines.length + " lines" + (entry?.target ? " on " + entry.target : "") + ".",
    "Result head: " + head,
    "Later context: " + (entry?.laterContext || "No earlier step in the span says anything about this result.")
  ].join(String.fromCharCode(10));
}

/** `{ok, result, latency_ms}` three-layer envelope; a flat body is also accepted. */
export function parseBatch(json) {
  const inner = json && typeof json === "object" && json.result && typeof json.result === "object" ? json.result : json;
  const answers = inner && typeof inner === "object" && inner.answers && typeof inner.answers === "object" ? inner.answers : inner;
  const pick = (key) => {
    const answer = answers && typeof answers === "object" ? answers[key] : undefined;
    if (!answer || typeof answer !== "object") return null;
    const probability = Number(answer.probability);
    const margin = Number(answer.margin);
    return {
      probability: Number.isFinite(probability) ? probability : null,
      margin: Number.isFinite(margin) ? margin : null
    };
  };
  return { needed: pick("needed"), rerun: pick("rerunnable") };
}

/** Largest first: the pass buys the most context back with the fewest calls. */
export function pickCandidates(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const minTokens = Number.isFinite(Number(options.minEntryTokens)) ? Number(options.minEntryTokens) : DECIDE_FOLD_DEFAULTS.minEntryTokens;
  const max = Number.isFinite(Number(options.maxEntries)) ? Number(options.maxEntries) : DECIDE_FOLD_DEFAULTS.maxEntries;
  return list
    .map((entry) => ({ entry, tokens: estTokensUtf8(String(entry?.text ?? "")) }))
    .filter((row) => row.tokens >= minTokens)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, Math.max(0, max))
    .map((row) => row.entry);
}

/** The master key is the only credential: the plugin never holds a second one. */
export function resolveDecideKey(env = process.env) {
  return String(env?.LITELLM_MASTER_KEY || env?.DSH_DECIDE_KEY || "").trim();
}

/** Bounded parallelism. Twelve at once measured worse than four, not faster. */
async function mapLimit(items, limit, worker) {
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * Decide every candidate, inside one wall-clock budget.
 *
 * Never throws: an unreachable or slow decider costs the pass its verdicts, not its fold.
 * @returns Map(entryId -> { action, pNeeded, pRerun, neededMargin, rerunMargin, error? })
 */
export async function decideEntries(entries, options = {}) {
  const opts = { ...DECIDE_FOLD_DEFAULTS, ...(options || {}) };
  const out = new Map();
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return out;
  const key = options.key ?? resolveDecideKey(options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!key) {
    for (const entry of list) out.set(entry.id, { action: "mechanical", error: "no decider credential" });
    return out;
  }
  if (typeof fetchImpl !== "function") {
    for (const entry of list) out.set(entry.id, { action: "mechanical", error: "no fetch" });
    return out;
  }
  const started = Date.now();
  const one = async (entry, index) => {
    const state = verdictState({ ...entry, laterContext: laterContextOf(entry, index, list) }, opts);
    const body = JSON.stringify({
      state,
      questions: {
        needed: { type: "noul", instructions: Q_NEEDED, criteria: { true: "still needed", false: "no longer needed" } },
        rerunnable: { type: "noul", instructions: Q_RERUN, criteria: { true: "reproduces it", false: "one-off" } }
      }
    });
    let lastError = null;
    for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs * attempt));
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), Math.max(200, Math.min(opts.perCallTimeoutMs, opts.budgetMs)))
        : null;
        try {
          const res = await fetchImpl(opts.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body,
            signal: controller ? controller.signal : undefined
          });
          if (!res || res.ok !== true) throw new Error("decider HTTP " + (res ? res.status : "no response"));
          const parsed = parseBatch(await res.json());
          const action = verdictAction({
            pNeeded: parsed.needed?.probability,
            pRerun: parsed.rerun?.probability,
            neededMargin: parsed.needed?.margin,
            rerunMargin: parsed.rerun?.margin,
            minMargin: opts.minMargin
          });
          out.set(entry.id, {
            action,
            pNeeded: parsed.needed?.probability ?? null,
            pRerun: parsed.rerun?.probability ?? null,
            neededMargin: parsed.needed?.margin ?? null,
            rerunMargin: parsed.rerun?.margin ?? null
          });
          return;
        } catch (error) {
          lastError = error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      out.set(entry.id, { action: "mechanical", error: lastError instanceof Error ? lastError.message : String(lastError) });
  };
  // The losing branch of the race must not keep the process alive for the full budget.
  let budgetTimer = null;
  const budget = new Promise((resolve) => { budgetTimer = setTimeout(resolve, Math.max(200, opts.budgetMs)); });
  try {
    await Promise.race([
      mapLimit(list, opts.concurrency, one),
      budget
    ]);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
  const elapsed = Date.now() - started;
  for (const entry of list) {
    if (!out.has(entry.id)) out.set(entry.id, { action: "mechanical", error: "budget exceeded" });
  }
  out.elapsedMs = elapsed;
  return out;
}

/** The line a verdict contributes to the card, or "" when the mechanical line stands. */
export function verdictBodyLines(entry, verdict, options = {}) {
  if (!verdict || verdict.action !== "keep") return [];
  const lines = String(entry?.text ?? "").split(String.fromCharCode(10));
  const limit = Number.isFinite(Number(options.keepLines)) ? Number(options.keepLines) : DECIDE_FOLD_DEFAULTS.keepLines;
  const chosen = lines.length <= limit ? lines : [...lines.slice(0, limit), "      ... (" + (lines.length - limit) + " more lines still in the tool log)"];
  return chosen.map((line) => "      " + clampUtf8(line, 220));
}

/** Counts for the fold report and the trajectory raw-output tab. */
export function summarizeVerdicts(verdicts) {
  const rows = verdicts instanceof Map ? [...verdicts.entries()] : Object.entries(verdicts || {});
  const counts = { keep: 0, drop: 0, truncate: 0, mechanical: 0 };
  let failed = 0;
  let keptTokens = 0;
  for (const [, verdict] of rows) {
    if (!verdict || typeof verdict !== "object") continue;
    if (counts[verdict.action] === undefined) counts.mechanical += 1;
    else counts[verdict.action] += 1;
    if (verdict.error) failed += 1;
    if (verdict.action === "keep") keptTokens += Number(verdict.keptTokens) || 0;
  }
  return {
    asked: rows.length,
    keep: counts.keep,
    drop: counts.drop,
    truncate: counts.truncate,
    mechanical: counts.mechanical,
    failed,
    keptTokens,
    elapsedMs: verdicts instanceof Map ? (verdicts.elapsedMs ?? null) : null
  };
}

/** One readable line for the fold report table. */
export function describeVerdicts(verdicts) {
  const s = summarizeVerdicts(verdicts);
  if (s.asked === 0) return "none asked";
  return s.asked + " asked · keep " + s.keep + " · truncate " + s.truncate + " · drop " + s.drop
    + " · mechanical " + s.mechanical + (s.failed ? " · failed " + s.failed : "")
    + " · " + (s.elapsedMs === null ? "?" : s.elapsedMs) + "ms";
}