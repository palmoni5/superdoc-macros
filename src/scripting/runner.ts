/** חוזה משותף לשני המריצים (eval ו-iframe). */
import type { MacroBridge } from './macro-api.js';

export type MacroRunResult =
  | { ok: true; value?: unknown }
  | { ok: false; message: string; reason?: 'timeout' | 'error' | 'call-limit' };

export interface MacroRunOptions {
  /** תקרת זמן לריצה כולה. ברירת מחדל: 30 שניות. */
  timeoutMs?: number;
  /** תקרת קריאות API, נגד לולאה בורחת. ברירת מחדל: 10,000. */
  maxApiCalls?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_API_CALLS = 10_000;

export interface MacroRunner {
  run(source: string, bridge: MacroBridge, options?: MacroRunOptions): Promise<MacroRunResult>;
}
