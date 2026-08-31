/**
 * An in-memory `MacroHost` double: the document as a single string with a
 * caret, a command catalog that records executions, and manual typing-event
 * emission (`typeText`) — as if the user typed.
 *
 * Sample data across the suite is deliberately Hebrew: RTL documents are a
 * primary target for this toolkit, and ASCII-only tests would never catch a
 * regression there.
 */
import type { MacroHost, MacroOutcome, SelectionSnapshot, TextInputEvent } from '../src/types.js';

export interface FakeHost extends MacroHost {
  text: string;
  cursor: number;
  selection: { from: number; to: number } | null;
  /** Every command execution that went through the host. */
  executed: Array<{ id: string; payload: unknown }>;
  /** Commands whose execution should fail. */
  failCommands: Set<string>;
  /** Simulates user typing: writes to the document and emits input events. */
  typeText(text: string): Promise<void>;
  /** Simulates the user pressing Backspace. */
  typeBackspace(): Promise<void>;
  /** Simulates the user pressing Delete. */
  typeDeleteForward(): Promise<void>;
  /** Simulates a UI-driven command (e.g. a ribbon button) — same path. */
  uiCommand(id: string, payload?: unknown): Promise<MacroOutcome>;
}

export function createFakeHost(knownCommands: readonly string[] = DEFAULT_COMMANDS): FakeHost {
  const commandListeners = new Set<(id: string, payload: unknown) => void>();
  const inputListeners = new Set<(event: TextInputEvent) => void>();

  const emitInput = (event: TextInputEvent): void => {
    for (const listener of inputListeners) listener(event);
  };

  const host: FakeHost = {
    text: '',
    cursor: 0,
    selection: null,
    executed: [],
    failCommands: new Set(),

    commands: {
      has: (id) => knownCommands.includes(id),
      ids: () => knownCommands,
      async execute(id, payload): Promise<MacroOutcome> {
        if (!knownCommands.includes(id)) {
          return { ok: false, message: `unknown command ${id}`, reason: 'unknown-command' };
        }
        for (const listener of commandListeners) listener(id, payload);
        if (host.failCommands.has(id)) {
          return { ok: false, message: `command ${id} failed`, reason: 'test-failure' };
        }
        host.executed.push({ id, payload });
        return { ok: true };
      },
    },

    async insertText(text): Promise<MacroOutcome> {
      const from = host.selection?.from ?? host.cursor;
      const to = host.selection?.to ?? host.cursor;
      host.text = host.text.slice(0, from) + text + host.text.slice(to);
      host.cursor = from + text.length;
      host.selection = null;
      return { ok: true };
    },

    async deleteBackward(count): Promise<MacroOutcome> {
      const from = Math.max(0, host.cursor - count);
      host.text = host.text.slice(0, from) + host.text.slice(host.cursor);
      host.cursor = from;
      return { ok: true };
    },

    async deleteForward(count): Promise<MacroOutcome> {
      const to = Math.min(host.text.length, host.cursor + count);
      host.text = host.text.slice(0, host.cursor) + host.text.slice(to);
      return { ok: true };
    },

    async getSelection(options): Promise<SelectionSnapshot> {
      const selected =
        options?.includeText && host.selection
          ? host.text.slice(host.selection.from, host.selection.to)
          : '';
      return {
        text: selected,
        hasRange: host.selection !== null,
        blockId: host.selection || host.text ? 'block-1' : null,
        selectionTarget: host.selection ? { kind: 'selection', ...host.selection } : null,
        empty: host.selection === null,
      };
    },

    async replaceAll(query, replacement) {
      if (!query) return { ok: false, replaced: 0, message: 'no query' };
      const count = host.text.split(query).length - 1;
      host.text = host.text.split(query).join(replacement);
      return { ok: true, replaced: count };
    },

    async getDocumentText() {
      return host.text;
    },

    onCommand(listener) {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },

    onTextInput(listener) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },

    async typeText(text) {
      for (const char of text) {
        if (char === '\n') {
          emitInput({ kind: 'insert-paragraph' });
          await host.insertText('\n');
        } else {
          // Like beforeinput: the event is emitted, then the character lands.
          emitInput({ kind: 'insert-text', text: char });
          await host.insertText(char);
        }
      }
    },

    async typeBackspace() {
      emitInput({ kind: 'delete-backward' });
      await host.deleteBackward(1);
    },

    async typeDeleteForward() {
      emitInput({ kind: 'delete-forward' });
      await host.deleteForward(1);
    },

    uiCommand(id, payload) {
      return host.commands.execute(id, payload);
    },
  };

  return host;
}

export const DEFAULT_COMMANDS = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'clear-formatting',
  'bullet-list',
  'numbered-list',
  'indent-increase',
  'indent-decrease',
  'direction-rtl',
  'direction-ltr',
  'undo',
  'redo',
  'text-align',
  'font-size',
] as const;
