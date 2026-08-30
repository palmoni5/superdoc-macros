/**
 * The API a macro script receives.
 *
 * Two consumers share one implementation: the eval runner hands the `api`
 * object to the script directly, and the iframe runner talks to it through
 * `call(method, args)` — RPC over postMessage. Every method therefore lives
 * in a single dictionary, and the proxy inside the iframe addresses exactly
 * the same names.
 *
 * Failure rules: write operations throw a `MacroError` when they fail, so a
 * script stops instead of continuing against a document in an unexpected
 * state. The raw `command()` returns the outcome and does not throw — for
 * scripts that want to check it themselves.
 */
import { macroMessages } from '../messages.js';
import type { MacroHost, MacroOutcome, SelectionSnapshot } from '../types.js';

/** A macro operation failure. Named so a script can tell it apart from its own TypeError. */
export class MacroError extends Error {
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.name = 'MacroError';
    this.reason = reason;
  }
}

/** Selection snapshot that is safe to hand to the iframe (without the engine's opaque target). */
export interface ScriptSelection {
  text: string;
  hasRange: boolean;
  blockId: string | null;
  empty: boolean;
}

/** What a script receives as `api`. Every method is async. */
export interface MacroApi {
  /** Runs a command from the engine catalog. Returns the outcome, never throws. */
  command(id: string, payload?: unknown): Promise<MacroOutcome>;
  /** Whether the engine recognizes the command. */
  hasCommand(id: string): Promise<boolean>;
  /** The known command ids. */
  commandIds(): Promise<readonly string[]>;

  insertText(text: string): Promise<void>;
  insertParagraph(): Promise<void>;
  deleteBackward(count?: number): Promise<void>;

  getSelection(): Promise<ScriptSelection>;
  getSelectionText(): Promise<string>;
  getDocumentText(): Promise<string>;
  /** Replaces every occurrence. Returns how many were replaced. */
  replaceAll(query: string, replacement: string): Promise<number>;

  /* Sugar for payload-less commands from the SuperDoc catalog. Throw on failure. */
  bold(): Promise<void>;
  italic(): Promise<void>;
  underline(): Promise<void>;
  strikethrough(): Promise<void>;
  clearFormatting(): Promise<void>;
  bulletList(): Promise<void>;
  numberedList(): Promise<void>;
  indentIncrease(): Promise<void>;
  indentDecrease(): Promise<void>;
  directionRtl(): Promise<void>;
  directionLtr(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;

  /** Writes a line to the run log (shown to the user, not to the console). */
  log(...parts: unknown[]): Promise<void>;
}

export interface MacroApiOptions {
  /** Receives every `api.log` line. Default: console.info. */
  onLog?: (line: string) => void;
}

export interface MacroBridge {
  api: MacroApi;
  /** The RPC path: invokes a method by name. Throws on an unknown method. */
  call(method: string, args: readonly unknown[]): Promise<unknown>;
  /** Number of calls made so far. Used by the runners' call limit. */
  callCount(): number;
}

function requireOk(outcome: MacroOutcome, action: string): void {
  if (!outcome.ok) {
    throw new MacroError(`${action}: ${outcome.message}`, outcome.reason);
  }
}

function asText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new MacroError(macroMessages().mustBeString(name));
  return value;
}

function formatLogPart(part: unknown): string {
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

/** Builds the API on top of a host. */
export function createMacroApi(host: MacroHost, options: MacroApiOptions = {}): MacroBridge {
  const onLog = options.onLog ?? ((line: string) => console.info('[superdoc-macros]', line));

  const commandSugar = async (id: string): Promise<void> => {
    requireOk(await host.commands.execute(id), macroMessages().commandFailed(id));
  };

  const api: MacroApi = {
    command: (id, payload) => host.commands.execute(asText(id, 'id'), payload),
    hasCommand: async (id) => host.commands.has(asText(id, 'id')),
    commandIds: async () => host.commands.ids(),

    async insertText(text) {
      requireOk(await host.insertText(asText(text, 'text')), macroMessages().insertTextFailed);
    },
    async insertParagraph() {
      requireOk(await host.insertText('\n'), macroMessages().insertParagraphFailed);
    },
    async deleteBackward(count = 1) {
      const n = Math.max(0, Math.trunc(Number(count)));
      if (n === 0) return;
      requireOk(await host.deleteBackward(n), macroMessages().deleteFailed);
    },

    async getSelection() {
      const snapshot: SelectionSnapshot = await host.getSelection({ includeText: true });
      return {
        text: snapshot.text,
        hasRange: snapshot.hasRange,
        blockId: snapshot.blockId,
        empty: snapshot.empty,
      };
    },
    async getSelectionText() {
      return (await host.getSelection({ includeText: true })).text;
    },
    getDocumentText: () => host.getDocumentText(),
    async replaceAll(query, replacement) {
      const result = await host.replaceAll(asText(query, 'query'), asText(replacement, 'replacement'));
      if (!result.ok) throw new MacroError(result.message ?? macroMessages().replaceFailed);
      return result.replaced;
    },

    bold: () => commandSugar('bold'),
    italic: () => commandSugar('italic'),
    underline: () => commandSugar('underline'),
    strikethrough: () => commandSugar('strikethrough'),
    clearFormatting: () => commandSugar('clear-formatting'),
    bulletList: () => commandSugar('bullet-list'),
    numberedList: () => commandSugar('numbered-list'),
    indentIncrease: () => commandSugar('indent-increase'),
    indentDecrease: () => commandSugar('indent-decrease'),
    directionRtl: () => commandSugar('direction-rtl'),
    directionLtr: () => commandSugar('direction-ltr'),
    undo: () => commandSugar('undo'),
    redo: () => commandSugar('redo'),

    async log(...parts) {
      onLog(parts.map(formatLogPart).join(' '));
    },
  };

  let calls = 0;
  const methods = api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

  return {
    api,
    async call(method, args) {
      const fn = methods[method];
      if (typeof fn !== 'function' || !Object.prototype.hasOwnProperty.call(api, method)) {
        throw new MacroError(macroMessages().unknownMethod(String(method)));
      }
      calls += 1;
      return fn.apply(api, args as unknown[]);
    },
    callCount: () => calls,
  };
}
