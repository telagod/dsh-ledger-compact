import type { Context } from "@deepseek-ai/cordis";

/**
 * 插件配置(与 lib/config.js 的 settingsSchema / DEFAULTS 对应;
 * 未在此列出的键仍可通过 patch 层传入, 故保留索引签名兜底)。
 */
export interface Config {
  enabled?: boolean;
  snapImages?: boolean;
  imagePixelBudget?: number;
  minSnapTokens?: number;
  savingsRatio?: number;
  confirmFold?: boolean;
  replaceDefault?: boolean;
  decideFold?: boolean;
  persistIngress?: boolean;
  persistDir?: string;
  persistTtlHours?: number;
  [key: string]: unknown;
}

export declare const name: string;

/** 依赖的宿主服务。 */
export declare const inject: readonly string[];

export declare const Config: import("@deepseek-ai/schemastery").default<Config>;

/** 解析 /compact 一类命令的原始输入。 */
export declare function parseCommand(rawInput: string): unknown;

export declare function apply(ctx: Context, config?: Config): void;

/** 折叠钩子统计(供健康检查展示)。 */
export declare function hookStats(): unknown;

/** 注册「是否替换默认压缩」的动态开关(返回撤销函数由调用方决定)。 */
export declare function setReplaceDefault(fn: () => boolean): void;

/** 注册「判定式折叠」的动态开关。 */
export declare function setDecideFold(fn: () => boolean): void;

/** 给某个压缩引擎挂上机械摘要钩子。 */
export declare function hookMechanicalSummarizer(engine: unknown): void;

/** 在机械折叠生效的作用域内执行 fn。 */
export declare function withMechanicalFold<T>(engine: unknown, agent: unknown, fn: () => T | Promise<T>): Promise<T>;

/** 枚举当前会话可用的压缩引擎。 */
export declare function collectCompactionEngines(ctx: Context, agent: unknown): Iterable<unknown>;

/** 选出一个压缩引擎(无可用引擎时返回 undefined)。 */
export declare function resolveCompactionEngine(ctx: Context, agent: unknown): unknown;

declare const plugin: { Config: typeof Config; apply: typeof apply; inject: typeof inject; name: typeof name };
export default plugin;
