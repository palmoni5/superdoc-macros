/**
 * מימוש `MacroHost` מעל SuperDoc v2 במצב מנוע-בלבד (`ui: false`) — הקונפיגורציה
 * של otzaria-word-editor.
 *
 * המשטחים שבשימוש, לפי סדר עדיפות:
 *   1. `superdoc.ui.commands` — קטלוג הפקודות של ה-controller (הרצה + תצפית).
 *   2. `superdoc.activeEditor.doc` — ה-Document API הציבורי (בחירה, הכנסה, בלוקים).
 *   3. `superdoc.ui.search` — חיפוש/החלפה.
 *   4. `superdoc.activeEditor.view` — מופע ProseMirror הפנימי, **רק** לפערים
 *      שאין להם משטח ציבורי: מחיקה לאחור וטקסט מלא של המסמך. קיים בדפדפן
 *      ו-null ב-headless.
 *
 * הטיפוסים כאן מבניים (structural) ואינם מייבאים מ-superdoc: הערכה לא תלויה
 * בחבילה, וגרסת מנוע שמשנה שדה תיכשל סגור (הפונקציה תחזיר כשל) ולא תקרוס.
 *
 * תצפית הפקודות למקליט נעשית בעטיפת `executeAsync` על אובייקט ה-commands.
 * זה מכסה כל מסלול שקורא לו — כולל ה-CommandAdapter של otzaria — בלי לשנות
 * את הקוד הקורא. `dispose()` מחזיר את המתודה המקורית.
 */
import type { MacroHost, MacroOutcome, SelectionSnapshot, TextInputEvent } from '../types.js';

/* ---------- הצורות הנצרכות מהמנוע ---------- */

interface CommandStateLike {
  reason?: string;
}

interface CommandsLike {
  has(id: string): boolean;
  ids?: readonly string[] | (() => readonly string[]);
  get(id: string): { getState(): CommandStateLike };
  executeAsync(id: string, payload?: unknown): Promise<unknown>;
}

interface SearchSliceLike {
  available?: boolean;
  total?: number;
  query?: string;
}

interface SearchHandleLike {
  getSnapshot(): SearchSliceLike;
  search(query: string): SearchSliceLike;
  clear?(): void;
  open?(): unknown;
  close?(): unknown;
  replaceAll(replacement: string): Promise<{ ok?: boolean; reason?: string } | undefined> | { ok?: boolean; reason?: string } | undefined;
}

interface DocReceiptLike {
  success?: boolean;
  failure?: { code?: string; message?: string };
}

interface SelectionInfoLike {
  empty?: boolean;
  text?: string;
  target?: { segments?: readonly { blockId?: string; range?: { start?: number; end?: number } }[] } | null;
  selectionTarget?: unknown;
}

interface DocLike {
  insert?(input: { value: string; type: 'text'; target?: unknown }): Promise<DocReceiptLike | undefined> | DocReceiptLike | undefined;
  selection?: {
    current?(input?: { includeText?: boolean }): Promise<SelectionInfoLike | undefined> | SelectionInfoLike | undefined;
  };
  blocks?: {
    list?(input?: { offset?: number; limit?: number }): Promise<unknown> | unknown;
  } | null;
}

interface ProseMirrorViewLike {
  state: {
    doc: { content: { size: number }; textBetween(from: number, to: number, blockSeparator?: string): string };
    selection: { from: number; empty: boolean };
    tr: {
      delete(from: number, to: number): unknown;
      insertText(text: string, from?: number, to?: number): unknown;
      scrollIntoView(): unknown;
    };
  };
  dispatch(tr: unknown): void;
}

export interface SuperdocLike {
  ui?: { commands?: CommandsLike; search?: SearchHandleLike } | null;
  activeEditor?: { doc?: DocLike | null; view?: ProseMirrorViewLike | null } | null;
}

export interface SuperdocHostOptions {
  superdoc: SuperdocLike;
  /** האלמנט שהמסמך מרונדר בתוכו — עליו נקלטים אירועי ההקלדה. */
  container?: HTMLElement | null;
}

export interface SuperdocMacroHost extends MacroHost {
  /** מסירה את עטיפת התצפית ואת מאזיני ה-DOM. לקרוא לפני החלפת מסמך. */
  dispose(): void;
}

/* ---------- עזרים ---------- */

const NOT_READY: MacroOutcome = { ok: false, message: 'אין מסמך פתוח', reason: 'not-ready' };

function failed(message: string, reason?: string): MacroOutcome {
  return { ok: false, message, reason };
}

function receiptOutcome(receipt: DocReceiptLike | undefined, failedAction: string): MacroOutcome {
  if (receipt && receipt.success === false) {
    const code = receipt.failure?.code;
    if (code === 'NO_OP') return { ok: true };
    const detail = receipt.failure?.message;
    return failed(detail ? `${failedAction}: ${detail}` : `${failedAction}${code ? ` (${code})` : ''}`, code);
  }
  return { ok: true };
}

function emptySelection(): SelectionSnapshot {
  return { text: '', hasRange: false, blockId: null, selectionTarget: null, empty: true };
}

/* ---------- המימוש ---------- */

export function createSuperdocHost(options: SuperdocHostOptions): SuperdocMacroHost {
  const { superdoc, container } = options;

  // נקראים ברגע השימוש ולא נשמרים: activeEditor מוחלף בכל פתיחת מסמך.
  const commands = (): CommandsLike | null => superdoc.ui?.commands ?? null;
  const doc = (): DocLike | null => superdoc.activeEditor?.doc ?? null;
  const view = (): ProseMirrorViewLike | null => superdoc.activeEditor?.view ?? null;
  const search = (): SearchHandleLike | null => superdoc.ui?.search ?? null;

  const commandListeners = new Set<(id: string, payload: unknown) => void>();
  const inputListeners = new Set<(event: TextInputEvent) => void>();

  /* תצפית פקודות: עטיפת executeAsync, פעם אחת, עם שחזור ב-dispose. */
  const wrapped = commands();
  const originalExecuteAsync = wrapped?.executeAsync;
  if (wrapped && originalExecuteAsync) {
    wrapped.executeAsync = function (id: string, payload?: unknown): Promise<unknown> {
      for (const listener of commandListeners) {
        try {
          listener(id, payload);
        } catch (error) {
          console.warn('[superdoc-macros] מאזין פקודות זרק', error);
        }
      }
      return originalExecuteAsync.call(wrapped, id, payload);
    };
  }

  /* הקלדה: beforeinput על ה-container, בשלב הלכידה. */
  const onBeforeInput = (event: Event): void => {
    const input = event as InputEvent;
    let mapped: TextInputEvent | null = null;
    switch (input.inputType) {
      case 'insertText':
      case 'insertCompositionText':
        if (typeof input.data === 'string' && input.data.length > 0) {
          mapped = { kind: 'insert-text', text: input.data };
        }
        break;
      case 'insertParagraph':
        mapped = { kind: 'insert-paragraph' };
        break;
      case 'deleteContentBackward':
        mapped = { kind: 'delete-backward' };
        break;
      case 'deleteContentForward':
        mapped = { kind: 'delete-forward' };
        break;
      default:
        break;
    }
    if (!mapped) return;
    for (const listener of inputListeners) {
      try {
        listener(mapped);
      } catch (error) {
        console.warn('[superdoc-macros] מאזין הקלדה זרק', error);
      }
    }
  };
  container?.addEventListener('beforeinput', onBeforeInput, true);

  async function readSelection(includeText: boolean): Promise<SelectionSnapshot> {
    const current = doc()?.selection?.current;
    if (typeof current !== 'function') return emptySelection();

    let info: SelectionInfoLike | undefined;
    try {
      info = await current(includeText ? { includeText: true } : undefined);
    } catch {
      return emptySelection();
    }
    if (!info || typeof info !== 'object') return emptySelection();

    const segments = Array.isArray(info.target?.segments) ? info.target.segments : [];
    const first = segments.find((segment) => typeof segment?.blockId === 'string');
    const hasRange = segments.some(
      (segment) =>
        typeof segment?.blockId === 'string' &&
        typeof segment.range?.start === 'number' &&
        typeof segment.range?.end === 'number' &&
        segment.range.start !== segment.range.end,
    );
    const text = typeof info.text === 'string' ? info.text : '';

    return {
      text,
      hasRange,
      blockId: first?.blockId ?? null,
      selectionTarget:
        info.selectionTarget !== null && typeof info.selectionTarget === 'object' ? info.selectionTarget : null,
      empty: typeof info.empty === 'boolean' ? info.empty : !(hasRange || text.length > 0),
    };
  }

  return {
    commands: {
      has(id) {
        return commands()?.has(id) ?? false;
      },
      ids() {
        const raw = commands()?.ids;
        if (typeof raw === 'function') return raw();
        return Array.isArray(raw) ? raw : [];
      },
      async execute(id, payload): Promise<MacroOutcome> {
        const bus = commands();
        if (!bus) return NOT_READY;
        if (!bus.has(id)) return failed(`הפקודה ${id} אינה מוכרת למנוע`, 'unknown-command');

        let result: unknown;
        try {
          result = await bus.executeAsync(id, payload);
        } catch (error) {
          return failed(error instanceof Error ? error.message : 'הפעולה נכשלה', 'threw');
        }

        // false = ה-controller לא ניתב את הפקודה; מצב הפקד מסביר למה.
        if (result === false) {
          const reason = bus.get(id).getState().reason;
          return failed(reason ? `הפעולה נכשלה (${reason})` : 'הפעולה נכשלה', reason);
        }
        if (typeof result === 'object' && result !== null) {
          return receiptOutcome(result as DocReceiptLike, `הפקודה ${id} נכשלה`);
        }
        return { ok: true };
      },
    },

    async insertText(text): Promise<MacroOutcome> {
      const insert = doc()?.insert;
      if (typeof insert === 'function') {
        // בלי target ההכנסה נופלת לסוף המסמך — לכן היעד נלקח מהבחירה החיה.
        const snapshot = await readSelection(false);
        try {
          const receipt = await insert({
            value: text,
            type: 'text',
            ...(snapshot.selectionTarget ? { target: snapshot.selectionTarget } : {}),
          });
          return receiptOutcome(receipt, 'הכנסת הטקסט נכשלה');
        } catch (error) {
          return failed(error instanceof Error ? error.message : 'הכנסת הטקסט נכשלה', 'threw');
        }
      }

      // נפילה לאחור: ProseMirror ישיר, כשה-Document API אינו זמין.
      const pm = view();
      if (pm) {
        try {
          const tr = pm.state.tr;
          tr.insertText(text);
          (tr as { scrollIntoView(): unknown }).scrollIntoView();
          pm.dispatch(tr);
          return { ok: true };
        } catch (error) {
          return failed(error instanceof Error ? error.message : 'הכנסת הטקסט נכשלה', 'threw');
        }
      }
      return NOT_READY;
    },

    async deleteBackward(count): Promise<MacroOutcome> {
      // אין משטח ציבורי למחיקה — זה השימוש המרכזי ב-escape hatch של ProseMirror.
      const pm = view();
      if (!pm) return failed('מחיקה אינה זמינה במסמך הזה', 'view-unavailable');
      try {
        const { from } = pm.state.selection;
        const start = Math.max(0, from - Math.max(0, Math.trunc(count)));
        if (start === from) return { ok: true };
        const tr = pm.state.tr;
        tr.delete(start, from);
        pm.dispatch(tr);
        return { ok: true };
      } catch (error) {
        return failed(error instanceof Error ? error.message : 'המחיקה נכשלה', 'threw');
      }
    },

    getSelection(options) {
      return readSelection(options?.includeText ?? false);
    },

    async replaceAll(query, replacement) {
      const handle = search();
      if (!handle) return { ok: false, replaced: 0, message: 'החיפוש אינו זמין' };

      try {
        handle.open?.();
        const slice = handle.search(query);
        if (slice?.available === false) {
          return { ok: false, replaced: 0, message: 'החיפוש אינו זמין במסמך הזה' };
        }
        const total = typeof slice?.total === 'number' ? slice.total : 0;
        if (total === 0) return { ok: true, replaced: 0 };

        const result = await handle.replaceAll(replacement);
        if (result && result.ok === false) {
          return { ok: false, replaced: 0, message: `ההחלפה נכשלה${result.reason ? ` (${result.reason})` : ''}` };
        }
        return { ok: true, replaced: total };
      } catch (error) {
        return { ok: false, replaced: 0, message: error instanceof Error ? error.message : 'ההחלפה נכשלה' };
      } finally {
        try {
          handle.clear?.();
          handle.close?.();
        } catch {
          /* ניקוי בלבד */
        }
      }
    },

    async getDocumentText(): Promise<string> {
      const pm = view();
      if (!pm) return '';
      try {
        return pm.state.doc.textBetween(0, pm.state.doc.content.size, '\n');
      } catch {
        return '';
      }
    },

    onCommand(listener) {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },

    onTextInput(listener) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },

    dispose() {
      if (wrapped && originalExecuteAsync) wrapped.executeAsync = originalExecuteAsync;
      container?.removeEventListener('beforeinput', onBeforeInput, true);
      commandListeners.clear();
      inputListeners.clear();
    },
  };
}
