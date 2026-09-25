/** Ingress shaping: large tool results are frozen before their first send. Never rewrite already-sent history.
 *
 * Cache contract: a result produced by step N is shaped at the pre-step of step N+1,
 * which is the request that first carries it. Restricting the pass to `step - 1`
 * makes that a structural property instead of a consequence of idempotence: an
 * older node already sits in a provider-cached prefix, and rewriting it would
 * force a full re-prefill of everything after it.
 */

import { IMAGE_ECONOMY, MIN_SNAP_TOKENS, SNAP_SAVINGS, estTokensUtf8 } from "./tokens.js";
import { planGrid } from "./layout.js";
import { collectText, excerptNotice, isPlaceholder, skipIngressTool, snapExcerpt, tokenDigest } from "./excerpt.js";
import { encodePngGray } from "./png.js";
import * as snapfont from "./snapfont.js";
import { getService, sessionEvent } from "./ctx.js";

export function shapeIngress(text, opts = {}) {
  const keep = { changed: false, snapped: false, excerpted: false, text, tokensSaved: 0 };
  if (!text || isPlaceholder(text) || skipIngressTool(opts.toolName)) return keep;
  const tok = estTokensUtf8(text);
  if (tok < (opts.minSnapTokens ?? MIN_SNAP_TOKENS)) return keep;
  const excerpt = snapExcerpt(text, opts);
  const digest = tokenDigest(text);
  const excerptText = excerptNotice(tok, excerpt, "", digest);
  const excerptSaved = Math.max(0, tok - estTokensUtf8(excerptText));
  const excerptOnly = {
    changed: excerptSaved > 0,
    snapped: false,
    excerpted: true,
    text: excerptText,
    tokensSaved: excerptSaved
  };
  if (opts.vision !== true) return excerptOnly.changed ? excerptOnly : keep;

  const shape = snapfont.resolveShape(opts.model, { imagePixelBudget: opts.imagePixelBudget });
  const excerptTok = Math.min(estTokensUtf8(excerpt) + 48, 800);
  const rows = snapfont.maxRows(tok, excerptTok, shape);
  const plan = planGrid(text.split("\n"), shape);
  const framed = plan ? snapfont.rasterGrid(plan, shape, rows) : undefined;
  if (!framed) return excerptOnly.changed ? excerptOnly : keep;
  const imgTok = snapfont.estImageTokens(framed.w, framed.h, shape.family, shape.pixelBudget);
  // A tile band costs the same packed or blank, so the image has to carry more
  // than it costs: refuse to pay image prices for text that was cheaper as text.
  const drawnTok = estTokensUtf8(framed.renderedText);
  if (drawnTok <= 0 || imgTok > drawnTok * IMAGE_ECONOMY) {
    return excerptOnly.changed ? excerptOnly : keep;
  }
  const layoutNote = framed.columns > 1 ? " · " + framed.columns + " cols" : "";
  const rulerNote = framed.gutterCols > 0 ? " · line ruler" : "";
  // The request pipeline resizes a frame that exceeds the model's pixel budget, and
  // the provider bills what it receives: say both sizes instead of only the drawn one.
  const preview = snapfont.previewSize(framed.w, framed.h, shape.family, shape.pixelBudget);
  const previewNote = preview.resized ? " (preview " + preview.width + "x" + preview.height + ")" : "";
  const extra = framed.w + "x" + framed.h + " PNG" + previewNote + " ~" + imgTok + " tokens" + layoutNote + rulerNote;
  const notice = excerptNotice(tok, excerpt, extra, digest);
  const after = estTokensUtf8(notice) + imgTok;
  const savings = opts.savingsRatio ?? SNAP_SAVINGS;
  if (after > tok * savings) return excerptOnly.changed ? excerptOnly : keep;
  return {
    changed: true,
    snapped: true,
    excerpted: true,
    text: notice,
    image: { pixels: framed.pixels, w: framed.w, h: framed.h },
    tokensSaved: Math.max(0, tok - after)
  };
}

export function encodeIngressPng(shaped) {
  if (!shaped || !shaped.image) return undefined;
  return encodePngGray(shaped.image.pixels, shaped.image.w, shaped.image.h);
}

function resultBlockOf(message) {
  const content = Array.isArray(message && message.content) ? message.content : [];
  const wrapper = content.find((block) => block && block.type === "tool-result");
  if (wrapper) return wrapper;
  // Session format v4 lifts a tool result into a first-class `role: "tool"` message
  // (`liftToolResult` in dsh-session-format-v3-to-v4): the content is plain blocks and
  // no `tool-result` wrapper survives. The v3-only lookup above then answered undefined
  // for every row, so the whole ingress pass went silent — no fold, no error, no log.
  // Keep both shapes readable: a v3 session is still replayed through this path.
  if (message && message.role === "tool" && content.length > 0) {
    return {
      type: "tool-result",
      toolCallId: message.toolCallId,
      content,
      ...(message.isError === undefined ? {} : { isError: message.isError })
    };
  }
  return undefined;
}

function toolNameFor(session, event) {
  const callId = event?.data?.message?.source?.callId;
  const nodes = session?.surface?.nodes;
  if (!callId || !nodes) return "";
  for (const seq of nodes) {
    const item = sessionEvent(session, seq);
    if (item?.type === "tool/call" && item.data?.callId === callId) return String(item.data.name ?? "");
  }
  return "";
}

/** Content-only replacement; DSH requires every other field to stay deeply equal. */
function replaceToolResultContent(message, blocks) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const index = content.findIndex((block) => block && block.type === "tool-result");
  if (index !== -1) {
    const next = content.slice();
    next[index] = { ...content[index], content: blocks };
    return { ...message, content: next };
  }
  // Format v4 lifts a tool result into a first-class `role: "tool"` message: there is no
  // wrapper to swap, the message content *is* the result. Everything else stays as-is.
  if (message && message.role === "tool") return { ...message, content: blocks };
  return undefined;
}

/** DSH renamed the positional replace keys from start/end to startSeq/endSeq. */
let legacyReplaceKeys = false;

function replaceOp(seq) {
  return legacyReplaceKeys
    ? { op: "replace", start: seq, end: seq }
    : { op: "replace", startSeq: seq, endSeq: seq };
}

function isInvalidReplaceOp(error) {
  const message = error && error.message ? error.message : String(error ?? "");
  return /invalid replace surfaceOp/i.test(message);
}

/**
 * Append one content-only rewrite of a current tool/result node.
 *
 * The first rejected append settles the key naming for the process: DSH validates
 * surface metadata before committing, so a rejected append leaves no trace and the
 * retry is safe.
 */
export function appendToolResultRewrite(session, event, seq, message) {
  const data = { ...event.data, message };
  try {
    return session.append("tool/result", data, { surfaceOp: replaceOp(seq), sourceEventSeqs: [seq] });
  } catch (error) {
    if (!legacyReplaceKeys && isInvalidReplaceOp(error)) {
      legacyReplaceKeys = true;
      return session.append("tool/result", data, { surfaceOp: replaceOp(seq), sourceEventSeqs: [seq] });
    }
    throw error;
  }
}

/** Test seam: forget the discovered key naming. */
export function resetReplaceOpShape() {
  legacyReplaceKeys = false;
}

/** Whether the legacy start/end op shape has been selected. */
export function usesLegacyReplaceKeys() {
  return legacyReplaceKeys;
}

/**
 * Shape tool results from the immediately preceding step of this turn — the only
 * ones that have not been included in an LLM request yet. Every already-sent
 * (older step, older turn) node is left alone.
 */
export async function shapeCurrentTurnIngress(session, ctx, opts) {
  const report = { shaped: 0, snapped: 0, excerpted: 0, tokensSaved: 0, failed: 0, error: "" };
  const turn = opts.turn;
  const step = opts.step;
  if (!session || !Number.isInteger(turn) || !Number.isInteger(step) || step < 2) return report;
  const tokenMeter = getService(ctx, "tokenMeter");
  if (typeof tokenMeter?.estimateMessage !== "function") return report;
  const nodes = [...(session.surface?.nodes ?? [])];
  for (const seq of nodes) {
    const event = sessionEvent(session, seq);
    if (event?.type !== "tool/result") continue;
    if (event.data?.turn !== turn) continue;
    if (event.data?.step !== step - 1) continue;
    const message = event.data.message;
    const result = resultBlockOf(message);
    if (!result) continue;
    const text = collectText(result.content);
    const toolName = toolNameFor(session, event);
    const shaped = shapeIngress(text, {
      vision: opts.vision === true,
      model: opts.model,
      toolName,
      minSnapTokens: opts.minSnapTokens,
      savingsRatio: opts.savingsRatio
    });
    if (!shaped.changed) continue;
    const excerptText = excerptNotice(estTokensUtf8(text), snapExcerpt(text), "", tokenDigest(text));
    const blocks = [{ type: "text", text: shaped.text }];
    const attachments = getService(ctx, "attachments");
    if (shaped.snapped && attachments?.saveImage) {
      try {
        const png = encodeIngressPng(shaped);
        if (png) {
          const ref = await attachments.saveImage({
            data: new Uint8Array(png),
            mediaType: "image/png",
            name: "snapcompact.png"
          });
          blocks.push({ type: "image", attachment: ref });
        } else {
          shaped.snapped = false;
          blocks[0] = { type: "text", text: excerptText };
        }
      } catch {
        shaped.snapped = false;
        blocks[0] = { type: "text", text: excerptText };
      }
    } else if (shaped.snapped) {
      shaped.snapped = false;
      blocks[0] = { type: "text", text: excerptText };
    }
    const nextMessage = replaceToolResultContent(message, blocks);
    if (!nextMessage) continue;
    try {
      session.append("compaction/prune", {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: tokenMeter.estimateMessage(message)
      });
      appendToolResultRewrite(session, event, seq, nextMessage);
    } catch (error) {
      report.failed += 1;
      report.error = error instanceof Error ? error.message : String(error);
      break;
    }
    report.shaped += 1;
    report.tokensSaved += shaped.tokensSaved;
    if (shaped.snapped) report.snapped += 1;
    else report.excerpted += 1;
  }
  return report;
}
