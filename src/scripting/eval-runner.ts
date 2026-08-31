/**
 * Direct script runner — `AsyncFunction` in the page's own context.
 *
 * **Not a sandbox.** A script running here can reach everything the page
 * can. It exists for two situations: tests, and environments where every
 * macro is written by the user themselves and isolation was explicitly
 * waived (e.g. a CSP that blocks iframes). `MacroKit` defaults to the
 * iframe runner.
 *
 * The time cap here is only a race on the promise: an infinite synchronous
 * loop blocks the thread and will not be stopped. The call cap is enforced
 * for real, through the bridge.
 */
import { macroMessages } from '../messages.js';
import type { MacroBridge } from './macro-api.js';
import {
  DEFAULT_MAX_API_CALLS,
  DEFAULT_TIMEOUT_MS,
  type MacroRunner,
  type MacroRunOptions,
  type MacroRunResult,
} from './runner.js';

const AsyncFunction = Object.getPrototypeOf(async function () {
  /* type only */
}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

/** Wraps a bridge with a call cap. Exposed so both runners share the same enforcement. */
export function limitCalls(bridge: MacroBridge, maxCalls: number): MacroBridge {
  return {
    api: bridge.api,
    callCount: bridge.callCount,
    call(method, args) {
      if (bridge.callCount() >= maxCalls) {
        return Promise.reject(new Error(macroMessages().callLimitExceeded(maxCalls)));
      }
      return bridge.call(method, args);
    },
  };
}

/**
 * Wraps a bridge with a kill switch. After `revoke()` every new call is
 * rejected — so a script that keeps running past its timeout (the eval
 * runner cannot stop it) can no longer touch the document.
 *
 * What this cannot do: abort a host call that already reached the engine.
 * The engine's public surfaces expose no cancellation, so an in-flight
 * operation completes; what is guaranteed is that nothing *new* starts.
 */
export function revocable(bridge: MacroBridge): { bridge: MacroBridge; revoke: () => void } {
  let revoked = false;
  return {
    revoke: () => {
      revoked = true;
    },
    bridge: {
      api: bridge.api,
      callCount: bridge.callCount,
      call(method, args) {
        if (revoked) return Promise.reject(new Error(macroMessages().macroStopped));
        return bridge.call(method, args);
      },
    },
  };
}

/** An api proxy that routes everything through `bridge.call`, so the cap applies here too. */
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
      // The revocable wrapper is what contains a timed-out script: eval cannot
      // stop it from running, but it can no longer reach the document.
      const { bridge: guarded, revoke } = revocable(
        limitCalls(bridge, options.maxApiCalls ?? DEFAULT_MAX_API_CALLS),
      );

      let fn: (...fnArgs: unknown[]) => Promise<unknown>;
      try {
        fn = new AsyncFunction('api', `"use strict";\n${source}`);
      } catch (error) {
        return {
          ok: false,
          reason: 'error',
          message: macroMessages().syntaxError(error instanceof Error ? error.message : String(error)),
        };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<MacroRunResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: 'timeout', message: macroMessages().timedOut(timeoutMs / 1000) }),
          timeoutMs,
        );
      });

      const run = (async (): Promise<MacroRunResult> => {
        try {
          const value = await fn(apiThroughBridge(guarded));
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
        revoke();
      }
    },
  };
}
