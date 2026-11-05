/** Mechanical summarizer: wrap the documented `summarize` hook on an existing engine.
 *  `/fast-compact` marks the agent via `withMechanicalFold`. If replace-default is on,
 *  every summarize path (`/compact`, auto, overflow) uses the local fold.
 *  Does not subclass or replace `ctx.compaction` (that would duplicate auto listeners).
 */

import { foldSummary, foldSummaryDecided } from "./fold.js";

const MECHANICAL_AGENTS = new WeakSet();
const WRAPPED_ENGINES = new WeakSet();
const HOOK_STATS = { wrapped: 0, unsupportedEngines: [], mechanicalFolds: 0, replacedFolds: 0 };

let replaceDefault = () => false;

/** Snapshot of hook wiring, for diagnostics and `/fast-compact status`. */
export function hookStats() {
  return {
    wrapped: HOOK_STATS.wrapped,
    unsupported: HOOK_STATS.unsupportedEngines.length,
    unsupportedEngines: [...HOOK_STATS.unsupportedEngines],
    mechanicalFolds: HOOK_STATS.mechanicalFolds,
    replacedFolds: HOOK_STATS.replacedFolds
  };
}

export function setReplaceDefault(fn) {
  replaceDefault = typeof fn === "function" ? fn : () => Boolean(fn);
}

function replaceDefaultEnabled() {
  try {
    return Boolean(replaceDefault());
  } catch {
    return false;
  }
}

/** Opt-in verdict pass. Off unless the settings document turns it on. */
let decideFold = () => false;

export function setDecideFold(fn) {
  decideFold = typeof fn === "function" ? fn : () => Boolean(fn);
}

function decideFoldEnabled() {
  try {
    return Boolean(decideFold());
  } catch {
    return false;
  }
}

export function hookMechanicalSummarizer(engine) {
  if (!engine) return;
  if (typeof engine.summarize !== "function") {
    const label = engine.constructor?.name || "anonymous engine";
    if (!HOOK_STATS.unsupportedEngines.includes(label)) HOOK_STATS.unsupportedEngines.push(label);
    return;
  }
  if (WRAPPED_ENGINES.has(engine)) return;
  const original = engine.summarize;
  engine.summarize = async function summarize(input, agent, signal) {
    const mechanical = Boolean(agent && MECHANICAL_AGENTS.has(agent));
    if (mechanical || replaceDefaultEnabled()) {
      if (mechanical) HOOK_STATS.mechanicalFolds += 1;
      else HOOK_STATS.replacedFolds += 1;
      // The verdict pass is additive and opt-in: with the switch off, or with the
      // decider unreachable, this returns the same card the mechanical path produced.
      if (!decideFoldEnabled()) return foldSummary(input);
      const decided = await foldSummaryDecided(input);
      return decided;
    }
    return original.call(this, input, agent, signal);
  };
  WRAPPED_ENGINES.add(engine);
  HOOK_STATS.wrapped += 1;
}

export async function withMechanicalFold(engine, agent, fn) {
  hookMechanicalSummarizer(engine);
  if (agent) MECHANICAL_AGENTS.add(agent);
  try {
    return await fn();
  } finally {
    if (agent) MECHANICAL_AGENTS.delete(agent);
  }
}

export function isMechanicalAgent(agent) {
  return Boolean(agent && MECHANICAL_AGENTS.has(agent));
}
