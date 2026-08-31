/**
 * Sandboxed script runner — an iframe with `sandbox="allow-scripts"` only.
 *
 * The iframe gets an opaque origin: no access to the page's DOM, to
 * localStorage, to cookies, or to the network with the user's credentials.
 * Its only way to touch the document is RPC over postMessage to the
 * `MacroApi` methods — every call goes through `bridge.call`, which enforces
 * a closed method list and a call cap.
 *
 * The time cap here is real: when it expires the iframe is removed from the
 * DOM, which also kills an infinite synchronous loop — it runs on the
 * iframe's event loop, not the page's.
 *
 * Return values and arguments cross a structured-clone boundary; the API is
 * already shaped so everything it returns is JSON-safe (see
 * `ScriptSelection`).
 */
import { macroMessages } from '../messages.js';
import type { MacroBridge } from './macro-api.js';
import { limitCalls, revocable } from './eval-runner.js';
import {
  DEFAULT_MAX_API_CALLS,
  DEFAULT_TIMEOUT_MS,
  type MacroRunner,
  type MacroRunOptions,
  type MacroRunResult,
} from './runner.js';

/** Protocol marker, so the messages cannot collide with others on the page. */
export const PROTOCOL_MARK = '__otzariaMacro' as const;

export type SandboxMessage =
  | { [PROTOCOL_MARK]: true; kind: 'ready' }
  | { [PROTOCOL_MARK]: true; kind: 'call'; id: number; method: string; args: unknown[] }
  | { [PROTOCOL_MARK]: true; kind: 'done'; value: unknown }
  | { [PROTOCOL_MARK]: true; kind: 'error'; message: string };

export type HostMessage =
  | { [PROTOCOL_MARK]: true; kind: 'run'; source: string }
  | { [PROTOCOL_MARK]: true; kind: 'result'; id: number; ok: boolean; value?: unknown; message?: string };

/** Whether a message belongs to the protocol. Exposed for tests. */
export function isProtocolMessage(data: unknown): data is SandboxMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[PROTOCOL_MARK] === true &&
    typeof (data as Record<string, unknown>).kind === 'string'
  );
}

/**
 * The code that runs inside the iframe. A string rather than a serialized
 * function, so the build cannot touch it (minifying names would break the
 * protocol).
 */
export const SANDBOX_BOOTSTRAP = `
'use strict';
(function () {
  var MARK = '${PROTOCOL_MARK}';
  var pending = new Map();
  var seq = 0;

  function post(message) {
    message[MARK] = true;
    parent.postMessage(message, '*');
  }

  var api = new Proxy({}, {
    get: function (_target, method) {
      if (typeof method !== 'string') return undefined;
      if (method === 'then') return undefined; // so "await api" is not treated as a thenable
      return function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
          seq += 1;
          pending.set(seq, { resolve: resolve, reject: reject });
          post({ kind: 'call', id: seq, method: method, args: args });
        });
      };
    }
  });

  addEventListener('message', function (event) {
    var m = event.data;
    if (!m || m[MARK] !== true) return;

    if (m.kind === 'run') {
      var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      Promise.resolve()
        .then(function () {
          var fn = new AsyncFunction('api', '"use strict";' + m.source);
          return fn(api);
        })
        .then(function (value) {
          var safe;
          try { safe = value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
          catch (_e) { safe = String(value); }
          post({ kind: 'done', value: safe });
        })
        .catch(function (error) {
          post({ kind: 'error', message: error && error.message ? String(error.message) : String(error) });
        });
      return;
    }

    if (m.kind === 'result') {
      var entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      if (m.ok) entry.resolve(m.value);
      else entry.reject(new Error(m.message || 'macro call failed'));
    }
  });

  post({ kind: 'ready' });
})();
`;

/** A value safe to hand back to the iframe (structured clone can fail on engine objects). */
function toCloneSafe(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function createIframeRunner(doc: Document = document): MacroRunner {
  return {
    run(source, bridge, options: MacroRunOptions = {}): Promise<MacroRunResult> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // The revocable wrapper closes a small race: a call message that was
      // already queued when the run finished must not dispatch to the host
      // after the iframe is gone.
      const { bridge: guarded, revoke } = revocable(
        limitCalls(bridge, options.maxApiCalls ?? DEFAULT_MAX_API_CALLS),
      );

      return new Promise<MacroRunResult>((resolve) => {
        const iframe = doc.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.display = 'none';
        // The CSP closes the sandbox's remaining hole: an opaque-origin iframe
        // cannot reach the app, but it can still fetch the public internet.
        // `default-src 'none'` blocks fetch/XHR/WebSocket/resources inside it;
        // only the inline bootstrap (and the AsyncFunction it compiles) runs.
        iframe.srcdoc =
          `<!doctype html><meta charset="utf-8">` +
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">` +
          `<script>${SANDBOX_BOOTSTRAP}</script>`;

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: MacroRunResult): void => {
          if (settled) return;
          settled = true;
          revoke();
          clearTimeout(timer);
          removeEventListener('message', onMessage);
          iframe.remove();
          resolve(result);
        };

        const onMessage = (event: MessageEvent): void => {
          // Only messages from this iframe: a page may run several macros at once.
          if (event.source !== iframe.contentWindow) return;
          const data: unknown = event.data;
          if (!isProtocolMessage(data)) return;

          if (data.kind === 'ready') {
            iframe.contentWindow?.postMessage(
              { [PROTOCOL_MARK]: true, kind: 'run', source } satisfies HostMessage,
              '*',
            );
            return;
          }

          if (data.kind === 'call') {
            const { id, method, args } = data;
            guarded
              .call(method, args)
              .then((value) => {
                iframe.contentWindow?.postMessage(
                  { [PROTOCOL_MARK]: true, kind: 'result', id, ok: true, value: toCloneSafe(value) } satisfies HostMessage,
                  '*',
                );
              })
              .catch((error: unknown) => {
                iframe.contentWindow?.postMessage(
                  {
                    [PROTOCOL_MARK]: true,
                    kind: 'result',
                    id,
                    ok: false,
                    message: error instanceof Error ? error.message : String(error),
                  } satisfies HostMessage,
                  '*',
                );
              });
            return;
          }

          if (data.kind === 'done') finish({ ok: true, value: data.value });
          else if (data.kind === 'error') finish({ ok: false, reason: 'error', message: data.message });
        };

        addEventListener('message', onMessage);
        timer = setTimeout(
          () => finish({ ok: false, reason: 'timeout', message: macroMessages().timedOut(timeoutMs / 1000) }),
          timeoutMs,
        );
        doc.body.appendChild(iframe);
      });
    },
  };
}
