/** Ingress excerpt: head/tail slice with a re-read contract. Never mutates later. */

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampUtf8 } from "./tokens.js";

/**
 * The tool that redeems a persisted copy.
 *
 * Named here rather than in the tool module because the ingress exemption has to
 * recognise a call to it without importing the registry.
 */
export const RETRIEVE_TOOL_NAME = "snap_retrieve";

export const SNAP_HEAD_LINES = 16;
export const SNAP_TAIL_LINES = 8;
export const SNAP_EXCERPT_MAX = 2400;

export const PLACEHOLDER_PREFIXES = [
  "[Output truncated",
  "[Superseded",
  "[Artifact stored",
  "[Shake elided",
  "[Snapcompact",
  "[Ledger]",
  "[Uneventful",
  "[image omitted",
  "[... tool result middle pruned"
];

export function isPlaceholder(text) {
  const value = String(text ?? "").trimStart();
  return PLACEHOLDER_PREFIXES.some((p) => value.startsWith(p));
}

export function skipIngressTool(name) {
  const tool = String(name ?? "");
  // skill/context arrive whole by contract. A redeemed copy is the only record of what an
  // excerpt dropped, so shaping it would write a second copy and hand back a third handle.
  // open_skill/find_skills carry the same contract: both hand back instruction text the model
  // has to follow, and a catalogue entry can clear the threshold on its own.
  return tool === "skill" || tool === "open_skill" || tool === "find_skills"
    || tool === "context" || tool === RETRIEVE_TOOL_NAME;
}

/**
 * Whether a result is instruction text that has to arrive whole.
 *
 * A skill body is a command to follow, not data to sample: an excerpt drops clauses
 * and the miss is silent, because the model cannot tell what it never saw. The tag is
 * a stable marker, so this guard holds even when the tool-name lookup does not.
 */
const INSTRUCTION_PREFIXES = ["<skill_content", "<skill_instructions"];

export function isInstructionText(text) {
  const head = String(text ?? "").trimStart();
  return INSTRUCTION_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Tools whose results the `offset/limit` re-read can actually recover.
 *
 * The shipped notice assumes a tool result is file content. A file read can be repeated
 * byte-exactly; the stdout of a command cannot — it is not addressable, so an elided
 * middle is simply gone. Under this deployment every call arrives as `run_code`, so the
 * old wording promised a re-read that did not exist for most shaped results and sent the
 * model looking for bytes it could not reach. Unknown tools count as unreadable: an
 * unkept promise costs more than a missed convenience.
 */
const REREADABLE_TOOLS = new Set(["read"]);

export function isRereadableTool(name) {
  return REREADABLE_TOOLS.has(String(name ?? "").toLowerCase());
}

/** Where shaped results land when no tool can address their bytes again. */
export const PERSIST_DIR_DEFAULT = join(homedir(), ".dsh", "cache", "ledger-ingress");
/**
 * How long a persisted copy stays reachable.
 *
 * Headroom's CCR, which solves the same problem, defaults to 1800s — but its window is
 * one request, while a copy here has to survive the model noticing the excerpt, deciding
 * to read it, and spending another step on the call. Session-scale is hours, not minutes.
 * The count cap stays as the burst guard; the TTL is what actually bounds the directory.
 */
export const PERSIST_TTL_MS = 24 * 60 * 60 * 1000;
const PERSIST_MAX_FILES = 300;
const PERSIST_CLEAN_EVERY = 25;
let persistWrites = 0;

/** The retention the notice advertises, as a human-readable span. */
export function persistRetentionLabel(ttlMs = PERSIST_TTL_MS) {
  const minutes = ttlMs / 60000;
  if (minutes < 60) return Math.max(1, Math.round(minutes)) + "m";
  const hours = ttlMs / 3600000;
  if (hours < 48) return Math.round(hours) + "h";
  return Math.round(hours / 24) + "d";
}

/**
 * Name a copy by a short opaque handle.
 *
 * The name used to encode the call id and a timestamp, which made the path a
 * 48-character tail the notice had to carry on every request. The handle only has to
 * address the bytes, and the notice only has to name the handle, so 6 random bytes are
 * both cheaper and — unlike a clock — collision-free under a burst of writes.
 */
function persistName() {
  return randomBytes(6).toString("hex") + ".txt";
}

/**
 * Drop expired copies, then hold the directory under its count cap.
 *
 * Time comes first: the cap alone never expires anything, so a directory below 300
 * entries grew forever. Expiry is a hard delete — a path the model was handed must not
 * outlive its own notice by much, or a read-back silently returns bytes from a session
 * the model has no way to tell apart from the current one.
 */
function prunePersistDir(dir, ttlMs = PERSIST_TTL_MS) {
  persistWrites += 1;
  if (persistWrites % PERSIST_CLEAN_EVERY !== 0) return;
  try {
    const now = Date.now();
    const stamped = readdirSync(dir)
      .filter((n) => n.endsWith(".txt"))
      .map((n) => {
        try {
          return { n, t: statSync(join(dir, n)).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
    const survivors = [];
    for (const entry of stamped) {
      // Age by write time, not by read: reading a copy is exactly what should not keep it,
      // and a copy is never appended to after it is written, so mtime is its birth.
      if (now - entry.t > ttlMs) {
        try { unlinkSync(join(dir, entry.n)); } catch { /* already gone */ }
      } else {
        survivors.push(entry);
      }
    }
    if (survivors.length <= PERSIST_MAX_FILES) return;
    for (const entry of survivors.slice(0, survivors.length - PERSIST_MAX_FILES)) {
      try { unlinkSync(join(dir, entry.n)); } catch { /* already gone */ }
    }
  } catch { /* housekeeping must never fail the shape pass */ }
}

/**
 * Save the full text of a result that no offset/limit re-read can recover.
 *
 * Under this deployment every call arrives as run_code, so the readability whitelist
 * can never match and an elided middle is gone for good — the only recovery is repeating
 * the whole call. Writing the bytes first turns the notice back into a true promise: the
 * model gets a path it can actually read.
 */
export function persistIngressText(text, dir, callId, ttlMs = PERSIST_TTL_MS) {
  const target = String(dir ?? "").trim() || PERSIST_DIR_DEFAULT;
  try {
    mkdirSync(target, { recursive: true });
    const file = join(target, persistName());
    writeFileSync(file, String(text ?? ""), "utf8");
    prunePersistDir(target, ttlMs);
    return file;
  } catch {
    return undefined;
  }
}

/** A handle is 6 random bytes in lower-case hex; anything else cannot name a copy. */
const PERSIST_HASH_RE = /^[a-f0-9]{12}$/;

/**
 * Read a copy back by its handle, or say why it cannot be read.
 *
 * A miss has to explain itself: the model holding a marker has no other way to tell an
 * expired copy from a mistyped handle, and "not found" alone reads like its own mistake.
 */
export function readPersistText(hash, dir, ttlMs = PERSIST_TTL_MS) {
  const target = String(dir ?? "").trim() || PERSIST_DIR_DEFAULT;
  const key = String(hash ?? "").trim().toLowerCase();
  if (!PERSIST_HASH_RE.test(key)) return { ok: false, reason: "not a valid handle: " + JSON.stringify(String(hash ?? "")) };
  const file = join(target, key + ".txt");
  try {
    const s = statSync(file);
    const age = Date.now() - s.mtimeMs;
    if (ttlMs > 0 && age > ttlMs) {
      return {
        ok: false,
        reason: "expired (kept " + persistRetentionLabel(ttlMs) + "; age " + Math.round(age / 3600000) + "h)"
      };
    }
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false, reason: "no copy for this handle (copies are kept " + persistRetentionLabel(ttlMs) + ")" };
  }
}

/**
 * Whether a call is redeeming a result this plugin wrote down.
 *
 * A copy exists so an elided middle stays reachable, but the redemption is itself an
 * ordinary large result: shaping it would write a second copy of the same bytes and hand
 * the model a third handle, so the fallback would feed on itself and the original would
 * never arrive. A call to the redeem tool is therefore left alone — the bytes it carries
 * are the only record of what an earlier excerpt dropped.
 *
 * Matched by the tool name inside the program, not by the directory: the name is a stable
 * literal, while a path is configuration and can move. The path form was removed once the
 * pre-handle copies it existed for were cleaned out of the directory.
 */
export function isPersistReadback(input) {
  const text = stringFieldsOf(input);
  return text ? text.includes(RETRIEVE_TOOL_NAME) : false;
}

/** The tool names a program uses to pull a skill body in. */
const SKILL_LOAD_NAMES = ["skill", "open_skill", "find_skills"];

/**
 * Whether a program is loading a skill body through the ptc channel.
 *
 * Under this deployment every call arrives as run_code, so the tool-name exemption above never
 * sees a skill: the wrapper's name is the one that reaches it. The load travels as a string
 * field of the wrapper's arguments, so the same locator that keeps a redemption whole keeps a
 * skill whole — matched on the call the program makes, not on the text it happens to print.
 *
 * Deliberately loose about the call shape: a program may space the dot, reach for the name
 * through brackets, or wrap the call across lines, and a missed match costs a silently halved
 * instruction. A bare mention of one of these names inside a program is rare enough that the
 * false positive — one result that keeps its bytes — is the cheaper error.
 */
export function isSkillLoad(input) {
  const text = stringFieldsOf(input);
  if (!text) return false;
  return SKILL_LOAD_NAMES.some((name) => text.includes("tools." + name)
    || text.includes('tools["' + name + '"]')
    || text.includes("tools['" + name + "']"));
}

/** Every string field of a call's arguments, flattened — the locator can sit in any. */
function stringFieldsOf(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const parts = [];
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value) parts.push(value);
  }
  return parts.join("\n");
}

export function snapExcerpt(text, options = {}) {
  const head = options.headLines ?? SNAP_HEAD_LINES;
  const tail = options.tailLines ?? SNAP_TAIL_LINES;
  const maxBytes = options.maxBytes ?? SNAP_EXCERPT_MAX;
  const value = String(text ?? "");
  const lines = value.split("\n");
  if (lines.length <= head + tail) return clampUtf8(value, maxBytes);
  const noticeOf = (skipped) => "… (" + skipped + " lines elided; see image if attached. "
    + (options.savedHash
      ? "full text: " + RETRIEVE_TOOL_NAME + "(\"" + options.savedHash + "\")"
      : options.rereadable === false
        ? "These bytes cannot be re-read from here — repeat the call if you need the full text"
        : "To inspect or edit exact bytes, re-read with offset/limit")
    + ") …";
  // The notice is the only thing that says the text was cut, so it is paid for before the
  // window is sized and can never be what falls off the end. Sizing the window first is how
  // a 165-character-per-line result lost both the notice and its tail: the head alone filled
  // the byte ceiling, the clamp trimmed from the back, and what reached the model was a cut
  // opening that read like a whole one.
  const bytesOf = (line) => Buffer.byteLength(String(line), "utf8") + 1;
  const budget = maxBytes - Buffer.byteLength(noticeOf(lines.length), "utf8") - 2;
  const headLines = [];
  const tailLines = [];
  let used = 0;
  while (headLines.length < head || tailLines.length < tail) {
    if (headLines.length + tailLines.length >= lines.length) break;
    const useHead = headLines.length < head
      && (tailLines.length >= tail || headLines.length <= tailLines.length);
    const line = useHead ? lines[headLines.length] : lines[lines.length - 1 - tailLines.length];
    const cost = bytesOf(line);
    if (used + cost > budget) break;
    if (useHead) headLines.push(line); else tailLines.push(line);
    used += cost;
  }
  const skipped = lines.length - headLines.length - tailLines.length;
  const notice = skipped > 0 ? noticeOf(skipped) : "";
  const body = [headLines.join("\n"), notice, tailLines.join("\n")]
    .filter((part) => part.length > 0)
    .join("\n");
  return clampUtf8(body, maxBytes);
}

/** A token longer than this is structure (a path, a timestamp), not a value. */
const DIGEST_MAX_TOKEN = 16;
/** A token has to repeat this often before a count question can be about it. */
const DIGEST_MIN_COUNT = 3;
const DIGEST_TOP = 8;

/**
 * Mechanical whole-file totals — the values a "how many X are in this file" question is
 * about, counted for free in text. Neither a picture nor a head/tail excerpt can count a
 * 2000-line file, and the model cannot count it either; measured paired over 168
 * questions, this line takes that class from 35% to 78% structure accuracy and leaves
 * exact-value reading untouched (bench/FINDINGS.md, `excerpt-digest`).
 */
export function tokenDigest(text, options = {}) {
  const top = options.top ?? DIGEST_TOP;
  const counts = new Map();
  for (const raw of String(text ?? "").split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "");
    if (!token || token.length > DIGEST_MAX_TOKEN) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const rows = [...counts]
    .filter(([, n]) => n >= DIGEST_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top);
  return rows.length === 0 ? "" : "whole-file totals: " + rows.map(([t, n]) => t + "×" + n).join(" · ");
}

export function excerptNotice(originalTokens, excerpt, extra = "", digest = "", source = "") {
  // The source label is the whole point of the line: bench/FINDINGS.md found the
  // offset/limit re-read works but nothing cheap makes the model take one, because a
  // bare excerpt names neither the call nor the file it came from. Naming both lets the
  // model re-run the same read instead of guessing at what it is missing.
  const label = source ? " · " + source : "";
  const head = extra
    ? "[Snapcompact: " + originalTokens + " tokens → " + extra + label + "]"
    : "[Snapcompact: " + originalTokens + " tokens → excerpt" + label + "]";
  return head + "\n" + excerpt + (digest ? "\n" + digest : "");
}

/** Arguments that identify *which* call produced a result, most specific first. */
const SOURCE_ARG_KEYS = ["file_path", "notebook_path", "path", "command", "pattern", "query", "url", "description"];
/** Kept short on purpose: the label is priced like text on every later request. */
const SOURCE_ARG_MAX = 60;

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function sourceArgOf(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of SOURCE_ARG_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const flat = oneLine(value);
    return flat.length > SOURCE_ARG_MAX ? flat.slice(0, SOURCE_ARG_MAX - 1) + "…" : flat;
  }
  return "";
}

/**
 * Name the call an excerpt came from, so the excerpt stays addressable.
 *
 * A tool name alone says whether the result can be reproduced; the identifying
 * argument says where to re-read it. Both are needed to turn "this was truncated"
 * into an actionable re-read, and neither is available from the excerpt body.
 *
 * `description` is last on purpose: it is the weakest locator, but it is the only
 * one a wrapper tool has. Under this deployment every call arrives as `run_code`,
 * whose identifying argument is the task summary the model wrote, so without it the
 * label would name nothing beyond the wrapper itself.
 *
 * @param name - the `tool/call` name, empty when the log lookup found none.
 * @param input - the call arguments, when the event carried them.
 * @returns a one-line label such as `read src/a.ts`, or "" when nothing is known.
 */
export function toolSourceLabel(name, input) {
  const tool = oneLine(name ?? "");
  const detail = sourceArgOf(input);
  if (!tool) return detail;
  return detail ? tool + " " + detail : tool;
}

export function collectText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool-result" && Array.isArray(block.content)) parts.push(collectText(block.content));
  }
  return parts.filter(Boolean).join("\n");
}
