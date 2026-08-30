/**
 * מריץ סקריפטים ישיר — `AsyncFunction` באותו הקשר של הדף.
 *
 * **אינו ארגז חול.** סקריפט שרץ כאן מקבל גישה לכל מה שהדף מכיר. מיועד לשני
 * מצבים: בדיקות, וסביבה שבה כל המאקרו נכתבים בידי המשתמש עצמו והוחלט
 * במפורש לוותר על בידוד (למשל בגלל CSP שחוסם iframe). ברירת המחדל של
 * `MacroKit` היא מריץ ה-iframe.
 *
 * תקרת הזמן כאן היא race על ההבטחה בלבד: לולאה סינכרונית אינסופית תחסום את
 * ה-thread ולא תיעצר. תקרת הקריאות כן נאכפת, דרך ה-bridge.
 */
import type { MacroBridge } from './macro-api.js';
import {
  DEFAULT_MAX_API_CALLS,
  DEFAULT_TIMEOUT_MS,
  type MacroRunner,
  type MacroRunOptions,
  type MacroRunResult,
} from './runner.js';

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* טיפוס בלבד */
}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

/** עוטפת bridge בתקרת קריאות. חשופה כדי ששני המריצים ישתמשו באותה אכיפה. */
export function limitCalls(bridge: MacroBridge, maxCalls: number): MacroBridge {
  return {
    api: bridge.api,
    callCount: bridge.callCount,
    call(method, args) {
      if (bridge.callCount() >= maxCalls) {
        return Promise.reject(
          new Error(`המאקרו חצה את תקרת הקריאות (${maxCalls}) ונעצר`),
        );
      }
      return bridge.call(method, args);
    },
  };
}

/** proxy של api שמנתב הכול דרך `bridge.call`, כדי שהתקרה תיאכף גם כאן. */
function apiThroughBridge(bridge: MacroBridge): unknown {
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]) => bridge.call(method, args);
      },
    },
  );
}

export function createEvalRunner(): MacroRunner {
  return {
    async run(source, bridge, options: MacroRunOptions = {}): Promise<MacroRunResult> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const limited = limitCalls(bridge, options.maxApiCalls ?? DEFAULT_MAX_API_CALLS);

      let fn: (...fnArgs: unknown[]) => Promise<unknown>;
      try {
        fn = new AsyncFunction('api', `"use strict";\n${source}`);
      } catch (error) {
        return {
          ok: false,
          reason: 'error',
          message: `שגיאת תחביר במאקרו: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<MacroRunResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: 'timeout', message: `המאקרו לא הסתיים תוך ${timeoutMs / 1000} שניות ונעצר` }),
          timeoutMs,
        );
      });

      const run = (async (): Promise<MacroRunResult> => {
        try {
          const value = await fn(apiThroughBridge(limited));
          return { ok: true, value };
        } catch (error) {
          return {
            ok: false,
            reason: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })();

      try {
        return await Promise.race([run, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
