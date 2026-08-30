/**
 * ה-API שסקריפט מאקרו מקבל.
 *
 * שני צרכנים לאותו מימוש: מריץ ה-eval מקבל את האובייקט `api` ישירות, ומריץ
 * ה-iframe מדבר איתו דרך `call(method, args)` — RPC על postMessage. לכן כל
 * מתודה רשומה במילון אחד, וה-proxy בתוך ה-iframe פונה לאותם שמות בדיוק.
 *
 * כללי כשל: פעולות כתיבה זורקות `MacroError` כשהן נכשלות, כדי שסקריפט ייעצר
 * במקום להמשיך על מסמך במצב לא צפוי. `command()` הגולמית מחזירה את התוצאה
 * ואינה זורקת — למי שרוצה לבדוק בעצמו.
 */
import type { MacroHost, MacroOutcome, SelectionSnapshot } from '../types.js';

/** כשל של פעולת מאקרו. השם מאפשר לסקריפט להבחין בינו ובין TypeError שלו. */
export class MacroError extends Error {
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.name = 'MacroError';
    this.reason = reason;
  }
}

/** תצלום בחירה בטוח למסירה ל-iframe (בלי היעד האטום של המנוע). */
export interface ScriptSelection {
  text: string;
  hasRange: boolean;
  blockId: string | null;
  empty: boolean;
}

/** מה שסקריפט מקבל בתור `api`. כל המתודות א-סינכרוניות. */
export interface MacroApi {
  /** מריצה פקודה מקטלוג המנוע. מחזירה תוצאה ואינה זורקת. */
  command(id: string, payload?: unknown): Promise<MacroOutcome>;
  /** האם המנוע מכיר את הפקודה. */
  hasCommand(id: string): Promise<boolean>;
  /** מזהי הפקודות המוכרות. */
  commandIds(): Promise<readonly string[]>;

  insertText(text: string): Promise<void>;
  insertParagraph(): Promise<void>;
  deleteBackward(count?: number): Promise<void>;

  getSelection(): Promise<ScriptSelection>;
  getSelectionText(): Promise<string>;
  getDocumentText(): Promise<string>;
  /** מחליפה את כל המופעים. מחזירה כמה הוחלפו. */
  replaceAll(query: string, replacement: string): Promise<number>;

  /* סוכר לפקודות ללא payload מהקטלוג של SuperDoc. זורקות בכשל. */
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

  /** כותבת שורה ליומן הריצה (מוצג למשתמש, לא ל-console). */
  log(...parts: unknown[]): Promise<void>;
}

export interface MacroApiOptions {
  /** מקבלת כל שורת `api.log`. ברירת המחדל: console.info. */
  onLog?: (line: string) => void;
}

export interface MacroBridge {
  api: MacroApi;
  /** מסלול ה-RPC: מפעילה מתודה לפי שם. זורקת על מתודה שאינה קיימת. */
  call(method: string, args: readonly unknown[]): Promise<unknown>;
  /** מספר הקריאות שבוצעו עד כה. משמש לתקרת קריאות במריצים. */
  callCount(): number;
}

function requireOk(outcome: MacroOutcome, action: string): void {
  if (!outcome.ok) {
    throw new MacroError(`${action}: ${outcome.message}`, outcome.reason);
  }
}

function asText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new MacroError(`${name} חייב להיות מחרוזת`);
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

/** בונה את ה-API מעל מארח. */
export function createMacroApi(host: MacroHost, options: MacroApiOptions = {}): MacroBridge {
  const onLog = options.onLog ?? ((line: string) => console.info('[superdoc-macros]', line));

  const commandSugar = async (id: string): Promise<void> => {
    requireOk(await host.commands.execute(id), `הפקודה ${id} נכשלה`);
  };

  const api: MacroApi = {
    command: (id, payload) => host.commands.execute(asText(id, 'id'), payload),
    hasCommand: async (id) => host.commands.has(asText(id, 'id')),
    commandIds: async () => host.commands.ids(),

    async insertText(text) {
      requireOk(await host.insertText(asText(text, 'text')), 'הכנסת הטקסט נכשלה');
    },
    async insertParagraph() {
      requireOk(await host.insertText('\n'), 'הכנסת הפסקה נכשלה');
    },
    async deleteBackward(count = 1) {
      const n = Math.max(0, Math.trunc(Number(count)));
      if (n === 0) return;
      requireOk(await host.deleteBackward(n), 'המחיקה נכשלה');
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
      if (!result.ok) throw new MacroError(result.message ?? 'ההחלפה נכשלה');
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
        throw new MacroError(`מתודה לא מוכרת: ${String(method)}`);
      }
      calls += 1;
      return fn.apply(api, args as unknown[]);
    },
    callCount: () => calls,
  };
}
