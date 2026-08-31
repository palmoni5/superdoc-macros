/**
 * The `MacroHost` implementation on top of SuperDoc v2 in engine-only mode
 * (`ui: false`) — the configuration otzaria-word-editor runs.
 *
 * The surfaces used, in order of preference:
 *   1. `superdoc.ui.commands` — the controller's command catalog (execution + observation).
 *   2. `superdoc.activeEditor.doc` — the public Document API (selection, insertion, blocks).
 *   3. `superdoc.ui.search` — find/replace.
 *   4. `superdoc.activeEditor.view` — the internal ProseMirror instance,
 *      **only** for gaps that have no public surface: backward deletion and
 *      the document's full text. Present in the browser, null headless.
 *
 * The types here are structural and do not import from superdoc: the toolkit
 * does not depend on the package, and an engine version that changes a field
 * fails closed (the function returns a failure) rather than crashing.
 *
 * Command observation for the recorder wraps `executeAsync` on the commands
 * object. That covers every path that calls it — including otzaria's
 * CommandAdapter — without changing the calling code. `dispose()` restores
 * the original method.
 */
import { macroMessages } from '../messages.js';
import type { MacroHost, MacroOutcome, SelectionSnapshot, TextInputEvent } from '../types.js';

/* ---------- The shapes consumed from the engine ---------- */

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
  /** The element the document renders in — typing events are captured on it. */
  container?: HTMLElement | null;
  /**
   * Whether the adapter may fall back to the engine's internal ProseMirror
   * view for the operations that have no public surface: backward/forward
   * deletion, full-document text, and insertion when the Document API is
   * missing. Default: true. Hosts that want to stay strictly on public
   * surfaces set false — those operations then fail closed.
   */
  viewFallback?: boolean;
}

export interface SuperdocMacroHost extends MacroHost {
  /** Removes the observation wrapper and the DOM listeners. Call before swapping documents. */
  dispose(): void;
}

/* ---------- Helpers ---------- */

function notReady(): MacroOutcome {
  return { ok: false, message: macroMessages().noDocument, reason: 'not-ready' };
}

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

/* ---------- The implementation ---------- */

export function createSuperdocHost(options: SuperdocHostOptions): SuperdocMacroHost {
  const { superdoc, container } = options;
  const viewFallback = options.viewFallback ?? true;

  // Read at call time, never cached: activeEditor is replaced on every document open.
  const commands = (): CommandsLike | null => superdoc.ui?.commands ?? null;
  const doc = (): DocLike | null => superdoc.activeEditor?.doc ?? null;
  const search = (): SearchHandleLike | null => superdoc.ui?.search ?? null;
  /**
   * The single gate to the internal ProseMirror view. Every use of a
   * non-public surface goes through here, so disabling the fallback (or a
   * future engine that hides the view) degrades to closed failures in one
   * place.
   */
  const view = (): ProseMirrorViewLike | null =>
    viewFallback ? (superdoc.activeEditor?.view ?? null) : null;

  const commandListeners = new Set<(id: string, payload: unknown) => void>();
  const inputListeners = new Set<(event: TextInputEvent) => void>();

  const emitInput = (mapped: TextInputEvent): void => {
    for (const listener of inputListeners) {
      try {
        listener(mapped);
      } catch (error) {
        console.warn('[superdoc-macros] input listener threw', error);
      }
    }
  };

  /* Command observation: wrap executeAsync, once, restored on dispose.
     Listeners are notified only after the engine reports success — a command
     that was refused (not routed, or a failed receipt) must not enter a
     recording, or replay would re-fail it or, worse, apply it in a context
     where it now succeeds unintended. */
  const wrapped = commands();
  const originalExecuteAsync = wrapped?.executeAsync;
  if (wrapped && originalExecuteAsync) {
    wrapped.executeAsync = function (id: string, payload?: unknown): Promise<unknown> {
      const result = originalExecuteAsync.call(wrapped, id, payload);
      void Promise.resolve(result)
        .then((value) => {
          if (value === false) return;
          if (typeof value === 'object' && value !== null && (value as DocReceiptLike).success === false) return;
          for (const listener of commandListeners) {
            try {
              listener(id, payload);
            } catch (error) {
              console.warn('[superdoc-macros] command listener threw', error);
            }
          }
        })
        .catch(() => undefined); // a thrown command is a failure — nothing to record.
      return result;
    };
  }

  /* Typing: beforeinput on the container, capture phase.

     IME composition is folded to a single event: while composing, the
     engine fires insertCompositionText repeatedly with the growing
     candidate text, and mapping each one would record the word once per
     keystroke. The events are suppressed during composition and the final
     text is emitted once, from compositionend. */
  let composing = false;

  const onCompositionStart = (): void => {
    composing = true;
  };

  const onCompositionEnd = (event: Event): void => {
    composing = false;
    const data = (event as CompositionEvent).data;
    if (typeof data === 'string' && data.length > 0) emitInput({ kind: 'insert-text', text: data });
  };

  /* Caret movement: a click or a navigation key breaks the link between the
     recently-typed characters and what actually sits before the caret.
     Auto-text resets its buffer on this, and the recorder stops coalescing
     across it. Reported as an input event so any MacroHost can supply it. */
  const NAVIGATION_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]);

  const onPointerDown = (): void => emitInput({ kind: 'caret-moved' });

  const onKeydown = (event: Event): void => {
    if (NAVIGATION_KEYS.has((event as KeyboardEvent).key)) emitInput({ kind: 'caret-moved' });
  };

  const onBeforeInput = (event: Event): void => {
    const input = event as InputEvent;
    let mapped: TextInputEvent | null = null;
    switch (input.inputType) {
      case 'insertText':
      case 'insertCompositionText':
        if (composing) break; // the final text arrives from compositionend.
        if (typeof input.data === 'string' && input.data.length > 0) {
          mapped = { kind: 'insert-text', text: input.data };
        }
        break;
      // Paste, drop and spellcheck replacement carry their text either in
      // `data` or in a dataTransfer — without this branch a recording
      // silently missed everything the user pasted.
      case 'insertFromPaste':
      case 'insertFromDrop':
      case 'insertReplacementText': {
        const text =
          typeof input.data === 'string' && input.data.length > 0
            ? input.data
            : input.dataTransfer?.getData('text/plain') ?? '';
        if (text.length > 0) mapped = { kind: 'insert-text', text };
        break;
      }
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
    if (mapped) emitInput(mapped);
  };

  container?.addEventListener('beforeinput', onBeforeInput, true);
  container?.addEventListener('compositionstart', onCompositionStart, true);
  container?.addEventListener('compositionend', onCompositionEnd, true);
  container?.addEventListener('pointerdown', onPointerDown, true);
  container?.addEventListener('keydown', onKeydown, true);

  /**
   * `failed: true` means the engine call itself threw — as opposed to a
   * clean "no selection" answer. Callers that write relative to the caret
   * must fail closed on it: falling back to "no target" would send the text
   * to the end of the document, far from where the user is looking.
   */
  async function readSelectionDetailed(
    includeText: boolean,
  ): Promise<{ snapshot: SelectionSnapshot; failed: boolean }> {
    const current = doc()?.selection?.current;
    if (typeof current !== 'function') return { snapshot: emptySelection(), failed: false };

    let info: SelectionInfoLike | undefined;
    try {
      info = await current(includeText ? { includeText: true } : undefined);
    } catch {
      return { snapshot: emptySelection(), failed: true };
    }
    return { snapshot: parseSelectionInfo(info), failed: false };
  }

  function parseSelectionInfo(info: SelectionInfoLike | undefined): SelectionSnapshot {
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
        if (!bus) return notReady();
        if (!bus.has(id)) return failed(macroMessages().unknownCommand(id), 'unknown-command');

        let result: unknown;
        try {
          result = await bus.executeAsync(id, payload);
        } catch (error) {
          return failed(error instanceof Error ? error.message : macroMessages().actionFailed, 'threw');
        }

        // false = the controller did not route the command; the command state explains why.
        if (result === false) {
          const reason = bus.get(id).getState().reason;
          return failed(reason ? `${macroMessages().actionFailed} (${reason})` : macroMessages().actionFailed, reason);
        }
        if (typeof result === 'object' && result !== null) {
          return receiptOutcome(result as DocReceiptLike, macroMessages().commandFailed(id));
        }
        return { ok: true };
      },
    },

    async insertText(text): Promise<MacroOutcome> {
      const insert = doc()?.insert;
      if (typeof insert === 'function') {
        // Without a target the insertion falls to the end of the document — so the target comes from the live selection.
        const { snapshot, failed: selectionFailed } = await readSelectionDetailed(false);
        // A failed read is not "no selection": inserting without a target
        // would land the text at the end of the document. Fail closed.
        if (selectionFailed) return failed(macroMessages().selectionUnavailable, 'selection-read-failed');
        try {
          const receipt = await insert({
            value: text,
            type: 'text',
            ...(snapshot.selectionTarget ? { target: snapshot.selectionTarget } : {}),
          });
          return receiptOutcome(receipt, macroMessages().insertTextFailed);
        } catch (error) {
          return failed(error instanceof Error ? error.message : macroMessages().insertTextFailed, 'threw');
        }
      }

      // Fallback: direct ProseMirror, when the Document API is unavailable.
      const pm = view();
      if (pm) {
        try {
          const tr = pm.state.tr;
          tr.insertText(text);
          (tr as { scrollIntoView(): unknown }).scrollIntoView();
          pm.dispatch(tr);
          return { ok: true };
        } catch (error) {
          return failed(error instanceof Error ? error.message : macroMessages().insertTextFailed, 'threw');
        }
      }
      return notReady();
    },

    async deleteBackward(count): Promise<MacroOutcome> {
      // No public deletion surface — this is the main use of the ProseMirror escape hatch.
      const pm = view();
      if (!pm) return failed(macroMessages().deletionUnavailable, 'view-unavailable');
      try {
        const { from } = pm.state.selection;
        const start = Math.max(0, from - Math.max(0, Math.trunc(count)));
        if (start === from) return { ok: true };
        const tr = pm.state.tr;
        tr.delete(start, from);
        pm.dispatch(tr);
        return { ok: true };
      } catch (error) {
        return failed(error instanceof Error ? error.message : macroMessages().deleteFailed, 'threw');
      }
    },

    async deleteForward(count): Promise<MacroOutcome> {
      const pm = view();
      if (!pm) return failed(macroMessages().deletionUnavailable, 'view-unavailable');
      try {
        const { from } = pm.state.selection;
        const size = pm.state.doc.content.size;
        const end = Math.min(size, from + Math.max(0, Math.trunc(count)));
        if (end === from) return { ok: true };
        const tr = pm.state.tr;
        tr.delete(from, end);
        pm.dispatch(tr);
        return { ok: true };
      } catch (error) {
        return failed(error instanceof Error ? error.message : macroMessages().deleteFailed, 'threw');
      }
    },

    async getSelection(options) {
      return (await readSelectionDetailed(options?.includeText ?? false)).snapshot;
    },

    async getTextBefore(count): Promise<string | null> {
      // Auto-text's verification before it deletes: the answer must reflect
      // the live document, so `null` (unknown) is the only honest reply when
      // the view is unavailable — never a guess.
      const pm = view();
      if (!pm) return null;
      try {
        const { from } = pm.state.selection;
        const start = Math.max(0, from - Math.max(0, Math.trunc(count)));
        return pm.state.doc.textBetween(start, from);
      } catch {
        return null;
      }
    },

    async replaceAll(query, replacement) {
      const handle = search();
      if (!handle) return { ok: false, replaced: 0, message: macroMessages().searchUnavailable };

      try {
        handle.open?.();
        const slice = handle.search(query);
        if (slice?.available === false) {
          return { ok: false, replaced: 0, message: macroMessages().searchUnavailableInDocument };
        }
        const total = typeof slice?.total === 'number' ? slice.total : 0;
        if (total === 0) return { ok: true, replaced: 0 };

        const result = await handle.replaceAll(replacement);
        if (result && result.ok === false) {
          return {
            ok: false,
            replaced: 0,
            message: `${macroMessages().replaceFailed}${result.reason ? ` (${result.reason})` : ''}`,
          };
        }
        return { ok: true, replaced: total };
      } catch (error) {
        return { ok: false, replaced: 0, message: error instanceof Error ? error.message : macroMessages().replaceFailed };
      } finally {
        try {
          handle.clear?.();
          handle.close?.();
        } catch {
          /* cleanup only */
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
      container?.removeEventListener('compositionstart', onCompositionStart, true);
      container?.removeEventListener('compositionend', onCompositionEnd, true);
      container?.removeEventListener('pointerdown', onPointerDown, true);
      container?.removeEventListener('keydown', onKeydown, true);
      commandListeners.clear();
      inputListeners.clear();
    },
  };
}
