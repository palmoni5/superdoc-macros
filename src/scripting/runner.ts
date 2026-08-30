/** Contract shared by the two runners (eval and iframe). */
import type { MacroBridge } from './macro-api.js';

export type MacroRunResult =
  | { ok: true; value?: unknown }
  | { ok: false; message: string; reason?: 'timeout' | 'error' | 'call-limit' };

export interface MacroRunOptions {
  /** Time cap for the whole run. Default: 30 seconds. */
  timeoutMs?: number;
  /** API call cap, against runaway loops. Default: 10,000. */
  maxApiCalls?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_API_CALLS = 10_000;

export interface MacroRunner {
  run(source: string, bridge: MacroBridge, options?: MacroRunOptions): Promise<MacroRunResult>;
}
