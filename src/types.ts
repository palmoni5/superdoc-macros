/**
 * Shared contracts.
 *
 * `MacroHost` is the single connection point to the editor: all three
 * capabilities (scripts, recorder, snippets) work against it rather than
 * against SuperDoc directly. That is what makes the toolkit testable with an
 * in-memory double, and what lets another host (a different engine version,
 * a different editor) plug in with one implementation of this interface.
 */

/** Result of an operation. Same shape as otzaria-word-editor's `CommandOutcome`. */
export type MacroOutcome = { ok: true } | { ok: false; message: string; reason?: string };

/** Snapshot of the document selection at the moment of the call. */
export interface SelectionSnapshot {
  /** The selected text. `''` when there is no selection or it was not requested. */
  text: string;
  /** Whether a range is selected, as opposed to a caret only. */
  hasRange: boolean;
  /** Id of the block the selection starts in, or `null`. */
  blockId: string | null;
  /** The target that write operations (`insert`) consume. Opaque — handed back to the engine as-is. */
  selectionTarget: unknown | null;
  /** Whether the selection is empty (caret only). */
  empty: boolean;
}

/** A typing event the host reports to the recorder and to auto-text. */
export type TextInputEvent =
  | { kind: 'insert-text'; text: string }
  | { kind: 'insert-paragraph' }
  | { kind: 'delete-backward' }
  | { kind: 'delete-forward' }
  /**
   * The caret moved by pointer or navigation keys. Not an edit — the
   * recorder records no step — but both consumers depend on it: auto-text
   * resets its typed-word buffer (the buffer no longer describes what sits
   * before the caret), and the recorder stops coalescing across it.
   */
  | { kind: 'caret-moved' };

/**
 * What the toolkit needs from the editor. The SuperDoc v2 implementation is
 * `createSuperdocHost`; tests use an in-memory double.
 */
export interface MacroHost {
  commands: {
    /** Whether the engine recognizes the command. */
    has(id: string): boolean;
    /** Runs a command from the engine's catalog and returns a normalized outcome. */
    execute(id: string, payload?: unknown): Promise<MacroOutcome>;
    /** The known command ids, when the host can enumerate them. */
    ids(): readonly string[];
  };
  /** Inserts text at the caret (or at the end of the document when there is no caret). */
  insertText(text: string): Promise<MacroOutcome>;
  /** Deletes characters backwards from the caret. */
  deleteBackward(count: number): Promise<MacroOutcome>;
  /** Deletes characters forwards from the caret. */
  deleteForward(count: number): Promise<MacroOutcome>;
  /** Snapshot of the current selection. Never throws. */
  getSelection(options?: { includeText?: boolean }): Promise<SelectionSnapshot>;
  /**
   * The `count` characters immediately before the caret, or `null` when the
   * host cannot tell. Auto-text verifies the document actually holds the
   * trigger word before deleting it — the buffer alone can lie after a
   * caret move the host failed to report.
   */
  getTextBefore?(count: number): Promise<string | null>;
  /**
   * Atomically replaces the `expected.length` characters before the caret
   * with `replacement` — verifying they equal `expected` first, all inside
   * one engine transaction. Auto-text prefers this over delete+insert: two
   * operations leave the trigger deleted when the second fails.
   */
  replaceTextBefore?(expected: string, replacement: string): Promise<MacroOutcome>;
  /** Replaces every occurrence of `query` with `replacement`. Returns how many were replaced. */
  replaceAll(
    query: string,
    replacement: string,
  ): Promise<{ ok: boolean; replaced: number; message?: string }>;
  /** The full text of the document body. `''` when unavailable. */
  getDocumentText(): Promise<string>;
  /** Observes every command the engine runs (from any source). Returns a dispose function. */
  onCommand(listener: (id: string, payload: unknown) => void): () => void;
  /** Observes typing in the document. Returns a dispose function. */
  onTextInput(listener: (event: TextInputEvent) => void): () => void;
}

/** One step of a recorded macro. Fully JSON-serializable. */
export type MacroStep =
  | { type: 'command'; id: string; payload?: unknown }
  | { type: 'insert-text'; text: string }
  | { type: 'insert-paragraph' }
  | { type: 'delete-backward'; count: number }
  | { type: 'delete-forward'; count: number };

/** A recorded macro, as persisted and imported/exported. */
export interface RecordedMacro {
  version: 1;
  id: string;
  name: string;
  /** ISO-8601. */
  createdAt?: string;
  shortcut?: string;
  steps: MacroStep[];
}

/**
 * A built-in tool the host registers on the kit: a native document-processing
 * action (implemented by the host against its own engine access) that the kit
 * exposes alongside recordings and scripts — listable in a management UI,
 * runnable under the same one-run-at-a-time guard, and bindable to a
 * persisted keyboard shortcut. Tools are runtime registrations, never
 * persisted themselves; only their shortcuts are.
 */
export interface BuiltinTool {
  /** Stable identifier, e.g. `'shulchan.first-word'`. Shortcut persistence is keyed by it. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description for management UIs. */
  description?: string;
  /** Runs the tool. A thrown error is reported as a failed outcome. */
  run(): Promise<MacroOutcome> | MacroOutcome;
}

/** A registered tool as listed to UIs — the registration plus its persisted shortcut. */
export interface BuiltinToolInfo {
  id: string;
  name: string;
  description?: string;
  shortcut?: string;
}

/** A written macro — a JavaScript script that runs against the toolkit's API. */
export interface SavedScript {
  id: string;
  name: string;
  source: string;
  shortcut?: string;
}

/** A text snippet (AutoText building block). */
export interface Snippet {
  id: string;
  name: string;
  /** Snippet content. Supports `{{...}}` variables — see `renderSnippet`. */
  text: string;
  /** Auto-text trigger word: typing the word followed by a space replaces it with the content. */
  trigger?: string;
  /** Keyboard shortcut, e.g. `Ctrl+Alt+1`. */
  shortcut?: string;
}
