/** Fold card for /fast-compact. Mechanical, no LLM. Old fold placeholders are dropped, not nested. */

import { clampUtf8, estTokensUtf8 } from "./tokens.js";
import { collectText, isPlaceholder } from "./excerpt.js";

const FOLD_FILE_MAX = 24;
const FOLD_INTENT_MAX = 3;
const FOLD_INTENT_CHARS = 200;
const FOLD_HEAD_LINES = 16;
const FOLD_TAIL_LINES = 8;
const FOLD_MSG_CLAMP = 400;
const FOLD_CMD_MAX = 16;
const FOLD_ERR_MAX = 8;

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function pushUnique(list, value, max) {
  const item = trim(value);
  if (!item) return;
  if (list.includes(item)) return;
  if (max !== undefined && list.length >= max) return;
  list.push(item);
}

const READ_TOOLS = new Set(["read", "read_image", "grep", "glob"]);
const EDIT_TOOLS = new Set(["write", "edit"]);

function argPath(args) {
  return trim(args.file_path || args.path || args.workdir || args.pattern || "");
}

function jsonPath(text) {
  const match = String(text).match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
  return match ? match[1] : "";
}

function isOldFold(text) {
  const value = String(text ?? "");
  return isPlaceholder(value)
    || value.startsWith("(Conversation compacted")
    || value.includes("<compacted-summary>");
}

function toolCallsOf(message) {
  const content = Array.isArray(message && message.content) ? message.content : [];
  return content.filter((block) => block && block.type === "tool-call" && typeof block.name === "string");
}

function toolResultOf(message) {
  if (message && message.source && message.source.kind === "tool") {
    const content = Array.isArray(message.content) ? message.content : [];
    const block = content.find((item) => item && item.type === "tool-result");
    if (block) return block;
  }
  const content = Array.isArray(message && message.content) ? message.content : [];
  return content.find((block) => block && block.type === "tool-result");
}

function exitCodeOf(text) {
  const match = String(text).match(/\[exit code:\s*(-?\d+)\]/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function inspectMessages(messages) {
  const intents = [];
  const reads = [];
  const edits = [];
  const commands = [];
  const errors = [];
  const excerptLines = [];
  const carriedFiles = [];
  const carriedIntents = [];
  const carriedErrors = [];
  const toolCounts = new Map();
  const pending = new Map();

  function bumpTool(name) {
    const key = trim(name) || "tool";
    toolCounts.set(key, (toolCounts.get(key) || 0) + 1);
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const result = toolResultOf(message);
    if (result) {
      const id = String(result.toolCallId ?? result.id ?? "");
      const pendingCall = pending.get(id) || { name: "tool", args: {} };
      pending.delete(id);
      const resultText = collectText(result.content);
      if (isOldFold(resultText)) continue;
      const path = argPath(pendingCall.args) || jsonPath(resultText);
      const command = trim(pendingCall.args.command);
      const exit = exitCodeOf(resultText);
      const failed = result.isError === true || (exit !== undefined && exit !== 0);
      bumpTool(pendingCall.name);
      if (READ_TOOLS.has(pendingCall.name)) pushUnique(reads, path, FOLD_FILE_MAX);
      if (EDIT_TOOLS.has(pendingCall.name)) pushUnique(edits, path, FOLD_FILE_MAX);
      if (command) pushUnique(commands, exit === undefined ? command : command + " -> " + exit, FOLD_CMD_MAX);
      if (failed) {
        errors.push(pendingCall.name + ": " + clampUtf8(command || path || pendingCall.name, 160));
        if (errors.length > FOLD_ERR_MAX) errors.shift();
      }
      excerptLines.push("[tool] " + clampUtf8([pendingCall.name, path || command].filter(Boolean).join(" "), FOLD_MSG_CLAMP));
      continue;
    }
    for (const block of toolCallsOf(message)) {
      pending.set(String(block.id ?? ""), { name: block.name, args: parseJsonObject(block.arguments) });
    }
    const text = collectText(message.content).trim();
    if (!text) continue;
    if (isOldFold(text)) {
      // An earlier checkpoint is the only surviving record of that span: keep its
      // files, intents and errors instead of dropping the generation entirely.
      const carried = carriedFromFold(text);
      for (const item of carried.files) pushUnique(carriedFiles, item.kind + " " + item.path, FOLD_FILE_MAX);
      for (const item of carried.intents) pushUnique(carriedIntents, item, FOLD_INTENT_MAX + CARRIED_INTENT_MAX);
      for (const item of carried.errors) pushUnique(carriedErrors, item, FOLD_ERR_MAX);
      continue;
    }
    if (message.role === "user") {
      intents.push(text);
      excerptLines.push("[user] " + clampUtf8(text.replace(/\s+/g, " "), FOLD_MSG_CLAMP));
    } else if (message.role === "assistant") {
      excerptLines.push("[assistant] " + clampUtf8(text.replace(/\s+/g, " "), FOLD_MSG_CLAMP));
    }
  }

  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => ({ name, n }));
  return { intents, reads, edits, commands, errors, excerptLines, tools, carriedFiles, carriedIntents, carriedErrors };
}

/** Structured items recovered from one earlier fold card. */
export function carriedFromFold(text) {
  const raw = String(text ?? "");
  const at = raw.indexOf(FOLD_CARD_MARKER);
  const body = at === -1 ? raw : raw.slice(0, at);
  const sections = parseFoldSections(body).sections;
  const strip = (line) => String(line || "").replace(/^\u21a9\s*/u, "").trim();
  const files = [];
  for (const line of bulletsOf(sections, "FILES")) {
    const match = line.match(/^\[(edit|read|carried)\]\s*(.+)$/);
    if (!match) continue;
    files.push({ kind: match[1] === "edit" ? "edit" : "read", path: match[2].trim() });
  }
  const intents = bulletsOf(sections, "INTENTS").map(strip).filter(Boolean);
  const errors = bulletsOf(sections, "ERRORS").map(strip).filter(Boolean);
  return { files, intents, errors };
}

function headTail(lines, head, tail) {
  if (lines.length <= head + tail) return lines.slice();
  return [...lines.slice(0, head), "...", ...lines.slice(lines.length - tail)];
}

function bullet(items) {
  return items.map((item) => "- " + item).join("\n");
}

export function renderFold(snapshot, options = {}) {
  const discardedTok = options.discardedTokens ?? 0;
  const carried = {
    files: Array.isArray(snapshot.carriedFiles) ? snapshot.carriedFiles : [],
    intents: Array.isArray(snapshot.carriedIntents) ? snapshot.carriedIntents : [],
    errors: Array.isArray(snapshot.carriedErrors) ? snapshot.carriedErrors : []
  };
  const files = [];
  for (const path of snapshot.edits) pushUnique(files, "[edit] " + path, FOLD_FILE_MAX);
  for (const path of snapshot.reads) pushUnique(files, "[read] " + path, FOLD_FILE_MAX);
  // Earlier generations fill only the capacity the new span left over.
  for (const item of carried.files) {
    const at = item.indexOf(" ");
    const kind = at === -1 ? "read" : item.slice(0, at);
    const path = at === -1 ? item : item.slice(at + 1);
    pushUnique(files, "[" + (kind === "edit" ? "edit" : "carried") + "] " + path, FOLD_FILE_MAX);
  }
  const intents = snapshot.intents.slice(-FOLD_INTENT_MAX).map((text) => clampUtf8(String(text).replace(/\s+/g, " "), FOLD_INTENT_CHARS));
  const intentSeen = new Set(intents);
  for (const text of carried.intents.slice(-CARRIED_INTENT_MAX)) {
    const value = clampUtf8(String(text).replace(/\s+/g, " "), FOLD_INTENT_CHARS);
    if (!value || intentSeen.has(value)) continue;
    intentSeen.add(value);
    intents.push("↩ " + value);
  }
  const errors = carried.errors.slice(-CARRIED_INTENT_MAX).map((item) => "↩ " + item);
  errors.push(...snapshot.errors);
  const excerpt = headTail(snapshot.excerptLines, FOLD_HEAD_LINES, FOLD_TAIL_LINES);
  const sections = [];
  const carriedNote = [
    carried.files.length ? carried.files.length + " files" : "",
    carried.intents.length ? carried.intents.length + " intents" : "",
    carried.errors.length ? carried.errors.length + " errors" : ""
  ].filter(Boolean).join(", ");
  sections.push("[Snapcompact] Fold ~" + discardedTok + " tok. Exact file bytes are not stored — re-read with offset/limit if a detail matters."
    + (carriedNote ? " Carried forward from earlier folds: " + carriedNote + "." : ""));
  if (files.length) sections.push("FILES\n" + bullet(files));
  if (intents.length) sections.push("INTENTS\n" + bullet(intents));
  if (snapshot.tools && snapshot.tools.length) {
    sections.push("TOOLS\n" + bullet(snapshot.tools.slice(0, 16).map((item) => item.name + " " + item.n)));
  }
  if (snapshot.commands.length) sections.push("COMMANDS\n" + bullet(snapshot.commands.slice(-FOLD_CMD_MAX).map((item) => clampUtf8(item, 220))));
  if (errors.length) sections.push("ERRORS\n" + bullet(errors.slice(-FOLD_ERR_MAX)));
  if (excerpt.length) sections.push("EXCERPT\n" + excerpt.join("\n"));
  return sections.join("\n");
}

export function buildFold(messages, options = {}) {
  const discardedTokens = Array.isArray(messages)
    ? messages.reduce((n, m) => n + estTokensUtf8(collectText(m && m.content)), 0)
    : 0;
  return renderFold(inspectMessages(messages), { ...options, discardedTokens: options.discardedTokens ?? discardedTokens });
}

/**
 * Record of one fold, for the compaction cell's raw-output tab.
 *
 * The summary blocks are what the model sees; this is what a person reads when
 * asking "which span did this replace, and what did it cost?". It rides the same
 * optional `rawOutput` seam the official LLM summarizer uses for its call
 * envelope, so it needs no new channel, no new UI and no extra model call — the
 * first block is an aligned table, the second the same numbers as JSON.
 *
 * @param messages - the span being replaced.
 * @param text - the fold card that replaced it.
 * @param options - `discardedTokens` / `provider` / `model` overrides.
 * @returns the raw-output content blocks.
 */
export function foldReport(messages, text, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const card = String(text ?? "");
  const snapshot = inspectMessages(list);
  const discardedTokens = Number.isFinite(options.discardedTokens)
    ? options.discardedTokens
    : list.reduce((n, m) => n + estTokensUtf8(collectText(m && m.content)), 0);
  const payload = {
    provider: options.provider || "dsh-ledger-compact",
    model: options.model || "local-ledger",
    spanMessages: list.length,
    discardedTokens,
    cardLines: card ? card.split("\n").length : 0,
    cardChars: card.length,
    files: snapshot.reads.length + snapshot.edits.length,
    reads: snapshot.reads.length,
    edits: snapshot.edits.length,
    intents: snapshot.intents.length,
    tools: snapshot.tools,
    commands: snapshot.commands.length,
    errors: snapshot.errors.length,
    carriedFiles: snapshot.carriedFiles.length,
    carriedIntents: snapshot.carriedIntents.length,
    excerptLines: snapshot.excerptLines.length
  };
  const rows = [
    ["span messages", payload.spanMessages],
    ["discarded tokens (est)", payload.discardedTokens],
    ["card", payload.cardLines + " lines · " + payload.cardChars + " chars"],
    ["files", payload.files + " (" + payload.reads + " read · " + payload.edits + " edit)"],
    ["intents", payload.intents],
    ["tools", payload.tools.map((item) => item.name + " " + item.n).join(", ") || "—"],
    ["commands", payload.commands],
    ["errors", payload.errors],
    ["carried forward", payload.carriedFiles + " files · " + payload.carriedIntents + " intents"]
  ];
  const width = rows.reduce((n, row) => Math.max(n, row[0].length), 0);
  const table = ["dsh-ledger-compact fold"]
    .concat(rows.map((row) => row[0].padEnd(width) + "  " + row[1]))
    .join("\n");
  return [
    { type: "text", text: table },
    { type: "text", text: JSON.stringify(payload) }
  ];
}

export function foldSummary(input, options = {}) {
  const messages = Array.isArray(input && input.messages) ? input.messages : [];
  const text = String(options.text ?? buildFold(messages, options)).trim();
  if (!text) throw new Error("ledger compaction produced no text");
  const result = {
    summary: [{ type: "text", text }],
    provider: options.provider || "dsh-ledger-compact",
    model: options.model || "local-ledger"
  };
  // Template summarizers are allowed to carry rawOutput (the official
  // SummaryResult marks it optional for unmarked summarizers); the LLM-call
  // discriminator stays absent on purpose.
  if (options.report !== false) result.rawOutput = foldReport(messages, text, options);
  return result;
}

export function formatTokenCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function collectSummaryText(summary) {
  if (typeof summary === "string") return summary.trim();
  if (!Array.isArray(summary)) return "";
  const parts = [];
  for (const block of summary) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

export const FOLD_CARD_MARKER = "<!--dsh-ledger-fold:1-->";
const FOLD_SECTION_KEYS = ["FILES", "INTENTS", "TOOLS", "COMMANDS", "ERRORS", "EXCERPT"];
const CARRIED_INTENT_MAX = 2;

export function parseFoldSections(text) {
  const lines = String(text || "").split("\n");
  const note = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const key = line.trim();
    if (FOLD_SECTION_KEYS.includes(key)) {
      current = { key, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim()) note.push(line);
  }
  return { note: note.join("\n"), sections };
}

function bulletsOf(sections, key) {
  const section = sections.find((item) => item.key === key);
  if (!section) return [];
  return section.lines.map((line) => String(line || "").replace(/^\s*-\s*/, "").trim()).filter(Boolean);
}

function linesOf(sections, key) {
  const section = sections.find((item) => item.key === key);
  if (!section) return [];
  return section.lines.map((line) => String(line || "").trim()).filter((line) => line && line !== "...");
}

function toolsOf(sections) {
  const tools = [];
  for (const line of bulletsOf(sections, "TOOLS")) {
    const match = line.match(/^(\S+)\s+(\d+)\s*$/);
    if (!match) continue;
    tools.push({ name: match[1], n: Number(match[2]) });
  }
  return tools;
}

export function foldCardFromSummary(text, meta = {}) {
  const sections = parseFoldSections(text).sections;
  const edits = [];
  const reads = [];
  for (const line of bulletsOf(sections, "FILES")) {
    const match = line.match(/^\[(edit|read|carried)\]\s*(.+)$/);
    if (!match) continue;
    if (match[1] === "edit") edits.push(match[2]);
    else reads.push(match[2]);
  }
  return {
    v: 1,
    items: Math.max(0, Math.round(Number(meta.items) || 0)),
    tokens: Math.max(0, Math.round(Number(meta.tokens) || 0)),
    edits,
    reads,
    intents: bulletsOf(sections, "INTENTS"),
    tools: toolsOf(sections),
    commands: bulletsOf(sections, "COMMANDS"),
    errors: bulletsOf(sections, "ERRORS"),
    excerpt: linesOf(sections, "EXCERPT").slice(0, 12).map((line) => clampUtf8(line, 120))
  };
}

export function formatFoldNotice(result) {
  const items = Array.isArray(result && result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
  const tokens = Number(result && result.shadowedTokenCount) || 0;
  const headline = "已折页 " + items + " 条历史（约 " + formatTokenCount(tokens) + " tokens）";
  const card = foldCardFromSummary(collectSummaryText(result && result.summary), { items, tokens });
  return headline + "\n\n" + FOLD_CARD_MARKER + JSON.stringify(card);
}

export function parseFoldNotice(text) {
  const raw = String(text || "");
  const at = raw.indexOf(FOLD_CARD_MARKER);
  const before = (at === -1 ? raw : raw.slice(0, at)).replace(/\s+$/, "");
  const headline = before.split("\n")[0] ? before.split("\n")[0].trim() : "";
  const rest = at === -1 ? before.split("\n").slice(1).join("\n").trim() : "";
  if (at !== -1) {
    try {
      const card = JSON.parse(raw.slice(at + FOLD_CARD_MARKER.length).trim());
      if (card && card.v === 1) return { headline, card, rest: "" };
    } catch {
      // fall through
    }
  }
  return { headline, card: null, rest };
}
