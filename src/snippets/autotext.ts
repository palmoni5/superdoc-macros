/**
 * Auto-text: typing a snippet's trigger word followed by a space replaces
 * the word with the snippet's content.
 *
 * How it works: a small buffer keeps the characters typed in the current run
 * (from the host's `TextInputEvent`s). When an expansion character (space by
 * default) is typed and the word before it is some snippet's trigger, the
 * word and the expansion character are deleted backwards and the rendered
 * content is inserted in their place, with the expansion character restored
 * at the end.
 *
 * The buffer resets on a new paragraph, on forward deletion and on a command
 * running mid-typing — anything that breaks the correspondence between what
 * was typed and what actually sits before the caret. A missed expansion is
 * better than an expansion that deletes the wrong text.
 */
import type { MacroHost, Snippet, TextInputEvent } from '../types.js';
import { renderSnippet, usesSelection } from './snippets.js';

/** What an expansion actually did — what a recorder needs to stay truthful. */
export interface AutoTextExpansion {
  /** The trigger word the user typed. */
  trigger: string;
  /** The character that fired the expansion (and was restored at the end). */
  expandChar: string;
  /** The rendered snippet text that replaced the trigger. */
  rendered: string;
}

export interface AutoTextOptions {
  /** The expansion characters. Default: space only. */
  expandOn?: readonly string[];
  /** Buffer size. A trigger word longer than this will not be recognized. */
  bufferSize?: number;
  /** Called after a successful expansion. */
  onExpand?: (snippet: Snippet, expansion: AutoTextExpansion) => void;
  /** Called when an expansion failed (e.g. a read-only document). */
  onError?: (message: string) => void;
}

const DEFAULT_BUFFER = 64;

export class AutoText {
  private readonly host: MacroHost;
  private readonly getSnippets: () => readonly Snippet[];
  private readonly expandOn: ReadonlySet<string>;
  private readonly bufferSize: number;
  private readonly onExpand?: (snippet: Snippet, expansion: AutoTextExpansion) => void;
  private readonly onError?: (message: string) => void;

  private buffer = '';
  private busy = false;
  private disposeCommand: (() => void) | null = null;
  private disposeInput: (() => void) | null = null;

  constructor(host: MacroHost, getSnippets: () => readonly Snippet[], options: AutoTextOptions = {}) {
    this.host = host;
    this.getSnippets = getSnippets;
    this.expandOn = new Set(options.expandOn ?? [' ']);
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER;
    this.onExpand = options.onExpand;
    this.onError = options.onError;
  }

  get attached(): boolean {
    return this.disposeInput !== null;
  }

  attach(): () => void {
    if (this.disposeInput) return () => this.detach();
    this.buffer = '';
    this.disposeInput = this.host.onTextInput((event) => void this.handleInput(event));
    // A command mid-typing (formatting, paste) breaks the buffer's link to the document.
    this.disposeCommand = this.host.onCommand(() => {
      if (!this.busy) this.buffer = '';
    });
    return () => this.detach();
  }

  detach(): void {
    this.disposeInput?.();
    this.disposeCommand?.();
    this.disposeInput = null;
    this.disposeCommand = null;
    this.buffer = '';
  }

  private async handleInput(event: TextInputEvent): Promise<void> {
    // Input generated while the expansion itself is writing — not the user's typing.
    if (this.busy) return;

    switch (event.kind) {
      case 'insert-paragraph':
      case 'delete-forward':
        this.buffer = '';
        return;
      // A click or navigation key moved the caret: the buffer no longer
      // describes what sits before it, and expanding on it would delete
      // text at the new position. Missing an expansion is the cheap error.
      case 'caret-moved':
        this.buffer = '';
        return;
      case 'delete-backward':
        this.buffer = this.buffer.slice(0, -1);
        return;
      case 'insert-text':
        break;
    }

    for (const char of event.text) {
      if (this.expandOn.has(char)) {
        const trigger = trailingWord(this.buffer);
        const snippet = trigger ? this.findByTrigger(trigger) : undefined;
        this.buffer = '';
        if (snippet && trigger) await this.expand(snippet, trigger, char);
        continue;
      }
      this.buffer = (this.buffer + char).slice(-this.bufferSize);
    }
  }

  private findByTrigger(word: string): Snippet | undefined {
    return this.getSnippets().find((snippet) => snippet.trigger === word);
  }

  private async expand(snippet: Snippet, trigger: string, expandChar: string): Promise<void> {
    this.busy = true;
    try {
      // The input event (beforeinput) fires before the character is written
      // to the document. Deferring to the task queue guarantees the expansion
      // character is already in before it is deleted along with the trigger.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Second line of defense, independent of the event stream: the
      // document itself must hold the trigger right before the caret. A
      // caret move the host failed to report (or a race with another
      // writer) is caught here instead of deleting foreign text.
      const expected = trigger + expandChar;
      const actual = await this.host.getTextBefore?.(expected.length);
      if (typeof actual === 'string' && actual !== expected) return;

      const selectionText = usesSelection(snippet.text)
        ? (await this.host.getSelection({ includeText: true })).text
        : undefined;
      const rendered = renderSnippet(snippet.text, { selectionText });

      // The expansion character is already in the document by now, so it is
      // included in the deletion and restored at the end.
      const deleted = await this.host.deleteBackward(trigger.length + 1);
      if (!deleted.ok) {
        this.onError?.(deleted.message);
        return;
      }
      const inserted = await this.host.insertText(rendered + expandChar);
      if (!inserted.ok) {
        this.onError?.(inserted.message);
        return;
      }
      this.onExpand?.(snippet, { trigger, expandChar, rendered });
    } finally {
      this.busy = false;
    }
  }
}

/** The word at the end of the buffer — a run of non-whitespace. */
function trailingWord(buffer: string): string | null {
  const match = /(\S+)$/u.exec(buffer);
  return match?.[1] ?? null;
}
