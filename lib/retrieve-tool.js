/**
 * The tool that redeems a persisted copy.
 *
 * The notice names a short handle instead of a path, so the model needs a way to turn
 * that handle back into bytes — this is that way. Its description carries the usage
 * instructions, which is the cheapest place for them: a tool schema is static, so it
 * rides the cached prompt prefix instead of being re-sent inside every notice. The
 * marker in the excerpt names the tool too, so the two meet without the model having
 * to remember anything from earlier in the conversation.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { PERSIST_TTL_MS, RETRIEVE_TOOL_NAME, readPersistText } from "./excerpt.js";

/**
 * Build the redeem tool.
 *
 * @param resolveOptions - returns the live `{ persistDir, ttlMs }` at call time, so a
 * settings change takes effect without re-registering the schema.
 */
export function retrieveToolDefinition(resolveOptions) {
  const options = () => {
    try {
      return resolveOptions?.() ?? {};
    } catch {
      return {};
    }
  };
  return defineTool({
    name: RETRIEVE_TOOL_NAME,
    description: "Retrieve the full text of a tool result that Snapcompact replaced with a "
      + "head/tail excerpt. Pass the handle printed in the excerpt marker, for example "
      + "snap_retrieve(\"7f3a91c2\"). Copies are kept for a limited window; an expired or "
      + "unknown handle returns the reason instead of failing silently.",
    parameters: {
      hash: {
        type: "string",
        required: true,
        description: "The handle shown in the excerpt marker, e.g. 7f3a91c2."
      }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args) {
      const { persistDir, ttlMs } = options();
      const found = readPersistText(args.hash, persistDir, ttlMs ?? PERSIST_TTL_MS);
      return found.ok ? found.text : "snap_retrieve: " + found.reason;
    }
  });
}
