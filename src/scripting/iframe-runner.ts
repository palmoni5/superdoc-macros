/**
 * מריץ סקריפטים בארגז חול — iframe עם `sandbox="allow-scripts"` בלבד.
 *
 * ה-iframe מקבל origin אטום: אין לו גישה ל-DOM של הדף, ל-localStorage, ל-cookies
 * או לרשת עם אישורי המשתמש. הדרך היחידה שלו לגעת במסמך היא RPC על postMessage
 * אל המתודות של `MacroApi` — כל קריאה עוברת דרך `bridge.call`, שאוכף רשימת
 * מתודות סגורה ותקרת קריאות.
 *
 * תקרת הזמן כאן אמיתית: בתום הזמן ה-iframe מוסר מה-DOM, וזה הורג גם לולאה
 * סינכרונית אינסופית — היא רצה ב-event loop של ה-iframe, לא של הדף.
 *
 * ערכי החזרה והארגומנטים חוצים גבול structured-clone; ה-API כבר בנוי כך שכל
 * מה שהוא מחזיר JSON-safe (ראו `ScriptSelection`).
 */
import type { MacroBridge } from './macro-api.js';
import { limitCalls } from './eval-runner.js';
import {
  DEFAULT_MAX_API_CALLS,
  DEFAULT_TIMEOUT_MS,
  type MacroRunner,
  type MacroRunOptions,
  type MacroRunResult,
} from './runner.js';

/** סימון ההודעות של הפרוטוקול, כדי לא להתנגש בהודעות אחרות בדף. */
export const PROTOCOL_MARK = '__otzariaMacro' as const;

export type SandboxMessage =
  | { [PROTOCOL_MARK]: true; kind: 'ready' }
  | { [PROTOCOL_MARK]: true; kind: 'call'; id: number; method: string; args: unknown[] }
  | { [PROTOCOL_MARK]: true; kind: 'done'; value: unknown }
  | { [PROTOCOL_MARK]: true; kind: 'error'; message: string };

export type HostMessage =
  | { [PROTOCOL_MARK]: true; kind: 'run'; source: string }
  | { [PROTOCOL_MARK]: true; kind: 'result'; id: number; ok: boolean; value?: unknown; message?: string };

/** האם הודעה שייכת לפרוטוקול. חשופה לבדיקות. */
export function isProtocolMessage(data: unknown): data is SandboxMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[PROTOCOL_MARK] === true &&
    typeof (data as Record<string, unknown>).kind === 'string'
  );
}

/**
 * הקוד שרץ בתוך ה-iframe. מחרוזת ולא פונקציה מוסרלת — כדי שה-build לא ישנה
 * אותו (minify של שמות היה שובר את הפרוטוקול).
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
      if (method === 'then') return undefined; // ש-await api לא יתפרש כ-thenable
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

/** ערך בטוח למסירה חזרה ל-iframe (structured clone עלול להיכשל על אובייקטי מנוע). */
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
      const limited = limitCalls(bridge, options.maxApiCalls ?? DEFAULT_MAX_API_CALLS);

      return new Promise<MacroRunResult>((resolve) => {
        const iframe = doc.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.display = 'none';
        iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>${SANDBOX_BOOTSTRAP}</script>`;

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: MacroRunResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          removeEventListener('message', onMessage);
          iframe.remove();
          resolve(result);
        };

        const onMessage = (event: MessageEvent): void => {
          // רק הודעות מה-iframe הזה: דף יכול להריץ כמה מאקרו במקביל.
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
            limited
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
          () => finish({ ok: false, reason: 'timeout', message: `המאקרו לא הסתיים תוך ${timeoutMs / 1000} שניות ונעצר` }),
          timeoutMs,
        );
        doc.body.appendChild(iframe);
      });
    },
  };
}
