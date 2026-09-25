import { buildObjectEnvelope } from "./schema-envelope.js";
import z from "@deepseek-ai/schemastery";

export const NS = "dsh-ledger-compact";
export const SERVICE = "ledgerCompact";
export const PACKAGE = "dsh-ledger-compact";
/** Kept in sync with package.json by a test — and with the top CHANGELOG entry. */
export const VERSION = "0.14.2";

export const DEFAULTS = {
  enabled: true,
  snapImages: false,
  /**
   * Request-image pixel budget of the routed deployment (llm-deepseek's
   * `imagePixelBudget`, 640000 by default). The canvas is drawn to fit it: a frame the
   * request pipeline has to resize loses its detail to the resample, which measured
   * 1–2/10 answers against 8/10 drawn natively.
   */
  imagePixelBudget: 640000,
  minSnapTokens: 3000,
  savingsRatio: 0.85,
  confirmFold: true,
  replaceDefault: false,
  /**
   * Save the full text of every shaped result whose bytes no re-read can recover.
   *
   * Under a ptc deployment every call arrives as run_code, so the readability whitelist
   * never matches and an elided middle is unrecoverable. Persisting the bytes first makes
   * the notice path true. Off by default: it writes files, so a deployment opts in instead
   * of inheriting the behaviour. An empty persistDir means the plugin drop directory.
   */
  persistIngress: false,
  persistDir: "",
  /**
   * How long a persisted copy stays readable, in hours.
   *
   * Headroom's CCR expires in 30 minutes because its copy only has to survive one
   * request; a copy here has to survive the model deciding to read it, which is steps
   * later and possibly a different session. 24h is session-scale without being forever.
   * 0 disables expiry, leaving only the 300-file cap.
   */
  persistTtlHours: 24
};

function bool(value, fallback) {
  if (value === true || value === false) return value;
  return fallback;
}

function intInRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function ratio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0.05) return 0.05;
  if (n > 1) return 1;
  return n;
}

/**
 * The plugin's Cordis Config: DSH 0.1.7 derives the settings namespace (entry id)
 * from this schema and serves only the fields marked `volatile`. A volatile field
 * stays a live reference in the running config, so the Host commits an edit in
 * place instead of remounting the plugin.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  snapImages: z.boolean().default(DEFAULTS.snapImages).volatile(),
  imagePixelBudget: z.number().step(1000).min(200000).max(4000000).default(DEFAULTS.imagePixelBudget).volatile(),
  minSnapTokens: z.number().step(1).min(200).max(200000).default(DEFAULTS.minSnapTokens).volatile(),
  savingsRatio: z.number().min(0.05).max(1).default(DEFAULTS.savingsRatio).volatile(),
  confirmFold: z.boolean().default(DEFAULTS.confirmFold).volatile(),
  replaceDefault: z.boolean().default(DEFAULTS.replaceDefault).volatile(),
  persistIngress: z.boolean().default(DEFAULTS.persistIngress).volatile(),
  persistDir: z.string().default(DEFAULTS.persistDir).volatile(),
  persistTtlHours: z.number().step(1).min(0).max(8760).default(DEFAULTS.persistTtlHours).volatile()
});

export function settingsSchema(value) {
  const source = value && typeof value === "object" ? value : {};
  /** Legacy sidecar: it only decides while the schema key itself was never written. */
  const enabled = source.enabled === undefined
    ? (source.ingress === false ? false : DEFAULTS.enabled)
    : bool(source.enabled, DEFAULTS.enabled);
  return {
    enabled,
    snapImages: bool(source.snapImages, DEFAULTS.snapImages),
    imagePixelBudget: intInRange(source.imagePixelBudget, 200000, 4000000, DEFAULTS.imagePixelBudget),
    minSnapTokens: intInRange(source.minSnapTokens, 200, 200000, DEFAULTS.minSnapTokens),
    savingsRatio: ratio(source.savingsRatio, DEFAULTS.savingsRatio),
    confirmFold: bool(source.confirmFold, DEFAULTS.confirmFold),
    replaceDefault: bool(source.replaceDefault, DEFAULTS.replaceDefault),
    persistIngress: bool(source.persistIngress, DEFAULTS.persistIngress),
    persistDir: typeof source.persistDir === "string" ? source.persistDir : DEFAULTS.persistDir,
    persistTtlHours: intInRange(source.persistTtlHours, 0, 8760, DEFAULTS.persistTtlHours)
  };
}

/** Field table shared by the schema and its canonical wire envelope. */
export const FIELDS = {
  enabled: { type: "boolean", meta: { default: DEFAULTS.enabled } },
  snapImages: { type: "boolean", meta: { default: DEFAULTS.snapImages } },
  imagePixelBudget: { type: "number", meta: { step: 1000, min: 200000, max: 4000000, default: DEFAULTS.imagePixelBudget } },
  minSnapTokens: { type: "number", meta: { step: 1, min: 200, max: 200000, default: DEFAULTS.minSnapTokens } },
  savingsRatio: { type: "number", meta: { min: 0.05, max: 1, default: DEFAULTS.savingsRatio } },
  confirmFold: { type: "boolean", meta: { default: DEFAULTS.confirmFold } },
  replaceDefault: { type: "boolean", meta: { default: DEFAULTS.replaceDefault } },
  persistIngress: { type: "boolean", meta: { default: DEFAULTS.persistIngress } },
  persistDir: { type: "string", meta: { default: DEFAULTS.persistDir } },
  persistTtlHours: { type: "number", meta: { step: 1, min: 0, max: 8760, default: DEFAULTS.persistTtlHours } }
};

/** Canonical `{ uid, refs }` envelope so the browser settingsScope can rehydrate and write. */
settingsSchema.toJSON = () => buildObjectEnvelope(FIELDS);
