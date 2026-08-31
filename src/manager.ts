/**
 * `MacroKit` — the facade a host installs once to get all three capabilities
 * wired together: scripts (sandboxed), the recorder, and snippets with
 * auto-text — plus persistence, import/export and keyboard shortcuts.
 *
 * One safety rule is enforced here: no running while recording, and no two
 * runs at once. A replay or script running during a recording would be
 * recorded itself and duplicate itself on the next replay.
 */
import { createMacroApi, type MacroApiOptions } from './scripting/macro-api.js';
import { createEvalRunner } from './scripting/eval-runner.js';
import { createIframeRunner } from './scripting/iframe-runner.js';
import type { MacroRunner, MacroRunOptions, MacroRunResult } from './scripting/runner.js';
import { MacroRecorder, replayMacro, type ReplayOptions, type ReplayResult } from './recorder/recorder.js';
import { AutoText, type AutoTextOptions } from './snippets/autotext.js';
import { expandSnippet, type ExpandOptions } from './snippets/snippets.js';
import { IMPORT_LIMITS, isPersistableState } from './storage.js';
import {
  bindShortcuts,
  hasBindingModifier,
  parseShortcut,
  shortcutSignatures,
  type ShortcutBinding,
  type ShortcutTarget,
} from './shortcuts.js';
import { MacroError } from './scripting/macro-api.js';
import { createLocalStorage, emptyState, parsePersistedState, type MacroStorage, type PersistedMacroState } from './storage.js';
import { macroMessages } from './messages.js';
import type { MacroHost, MacroStep, RecordedMacro, SavedScript, Snippet } from './types.js';

export interface MacroKitOptions {
  host: MacroHost;
  /** Default: localStorage. */
  storage?: MacroStorage;
  /**
   * `'iframe'` (the default) runs scripts in a sandbox; `'eval'` runs them
   * directly — see the warning in eval-runner. A custom runner can also be
   * passed.
   */
  runner?: MacroRunner | 'iframe' | 'eval';
  /** Run options for scripts (time, call cap). */
  runOptions?: MacroRunOptions;
  /** Auto-text options. */
  autoText?: Omit<AutoTextOptions, 'onExpand' | 'onError'> & AutoTextOptions;
  /** Run log for `api.log`. */
  onLog?: MacroApiOptions['onLog'];
  /**
   * Shortcuts the host already owns (e.g. its ribbon registry). A saved
   * binding that collides with any of these is rejected — otherwise the
   * macro binding, attached in the capture phase, would silently shadow an
   * editor shortcut. Unparseable entries are ignored.
   */
  reservedShortcuts?: readonly string[];
  /**
   * Whether scripted macros may *execute*. Default: true. When false the
   * gate is real, not cosmetic: `runScript`/`runSource` refuse, and saved
   * script shortcuts are not bound — so a pre-existing or imported script
   * cannot run through any path. Saving and listing still work (a UI may
   * let the user manage scripts it will not run).
   */
  scriptsEnabled?: boolean;
  /**
   * Called when a recording hits the step cap and stops on its own. The
   * steps are kept — `stopRecording(name)` still saves them — but a UI that
   * shows a live "recording" indicator must update it.
   */
  onRecordingAutoStop?: () => void;
}

export type ShortcutValidation = { ok: true } | { ok: false; message: string };

let idCounter = 0;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    idCounter += 1;
    return `macro-${Date.now().toString(36)}-${idCounter}`;
  }
}

export class MacroKit {
  private readonly host: MacroHost;
  private readonly storage: MacroStorage;
  private readonly runner: MacroRunner;
  private readonly runOptions: MacroRunOptions;
  private readonly onLog?: MacroApiOptions['onLog'];

  private state: PersistedMacroState;
  private readonly recorder: MacroRecorder;
  private readonly autoText: AutoText;
  private readonly reservedSignatures: ReadonlySet<string>;
  private readonly scriptsEnabled: boolean;
  private running = false;

  constructor(options: MacroKitOptions) {
    this.host = options.host;
    this.storage = options.storage ?? createLocalStorage();
    this.runOptions = options.runOptions ?? {};
    this.onLog = options.onLog;

    const runner = options.runner ?? 'iframe';
    this.runner =
      runner === 'iframe' ? createIframeRunner() : runner === 'eval' ? createEvalRunner() : runner;

    this.scriptsEnabled = options.scriptsEnabled ?? true;
    this.state = this.storage.load() ?? emptyState();
    this.recorder = new MacroRecorder(this.host, { onAutoStop: options.onRecordingAutoStop });
    this.autoText = new AutoText(this.host, () => this.state.snippets, {
      ...options.autoText,
      // The recorder rewrite keeps recordings truthful: the user typed a
      // trigger word, the document holds the expanded text, and a replay of
      // the raw keystrokes would diverge. See applyAutoTextExpansion.
      onExpand: (snippet, expansion) => {
        this.recorder.applyAutoTextExpansion(
          expansion.trigger.length + expansion.expandChar.length,
          expansion.rendered + expansion.expandChar,
        );
        options.autoText?.onExpand?.(snippet, expansion);
      },
    });

    const reserved = new Set<string>();
    for (const shortcut of options.reservedShortcuts ?? []) {
      const parsed = parseShortcut(shortcut);
      if (parsed) for (const signature of shortcutSignatures(parsed)) reserved.add(signature);
    }
    this.reservedSignatures = reserved;
  }

  /* ---------- Shortcut validation ---------- */

  /**
   * Whether a shortcut is acceptable for a saved binding: parseable, carries
   * a real modifier, not reserved by the host, and not already used by
   * another saved item (`excludeId` skips the item being edited). Empty or
   * undefined means "no shortcut" and is fine. The save paths enforce this;
   * UIs call it directly to show the message before saving.
   */
  validateShortcut(shortcut: string | undefined, excludeId?: string): ShortcutValidation {
    const trimmed = shortcut?.trim();
    if (!trimmed) return { ok: true };

    const parsed = parseShortcut(trimmed);
    if (!parsed) return { ok: false, message: macroMessages().shortcutInvalid };
    if (!hasBindingModifier(parsed)) return { ok: false, message: macroMessages().shortcutNeedsModifier };

    const signatures = shortcutSignatures(parsed);
    if (signatures.some((signature) => this.reservedSignatures.has(signature))) {
      return { ok: false, message: macroMessages().shortcutReserved };
    }

    const owner = this.findShortcutOwner(signatures, excludeId);
    if (owner) return { ok: false, message: macroMessages().shortcutTaken(owner) };
    return { ok: true };
  }

  private findShortcutOwner(signatures: readonly string[], excludeId?: string): string | null {
    const items: ReadonlyArray<{ id: string; name: string; shortcut?: string }> = [
      ...this.state.scripts,
      ...this.state.recordings,
      ...this.state.snippets,
    ];
    for (const item of items) {
      if (!item.shortcut || item.id === excludeId) continue;
      const parsed = parseShortcut(item.shortcut);
      if (!parsed) continue;
      const existing = shortcutSignatures(parsed);
      if (existing.some((signature) => signatures.includes(signature))) return item.name;
    }
    return null;
  }

  /** Throws a MacroError when the shortcut is unacceptable. The save paths call this. */
  private requireValidShortcut(shortcut: string | undefined, excludeId?: string): void {
    const validation = this.validateShortcut(shortcut, excludeId);
    if (!validation.ok) throw new MacroError(validation.message, 'invalid-shortcut');
  }

  /* ---------- Scripts ---------- */

  listScripts(): readonly SavedScript[] {
    return this.state.scripts;
  }

  saveScript(input: { id?: string; name: string; source: string; shortcut?: string }): SavedScript {
    this.requireValidShortcut(input.shortcut, input.id);
    this.requireItemLimits({ name: input.name, source: input.source });
    this.requireRoom(this.state.scripts, input.id);
    const script: SavedScript = {
      id: input.id ?? newId(),
      name: input.name,
      source: input.source,
      ...(input.shortcut ? { shortcut: input.shortcut } : {}),
    };
    this.upsert(this.state.scripts, script);
    this.persist();
    return script;
  }

  removeScript(id: string): void {
    this.state.scripts = this.state.scripts.filter((script) => script.id !== id);
    this.persist();
  }

  async runScript(id: string): Promise<MacroRunResult> {
    const script = this.state.scripts.find((entry) => entry.id === id);
    if (!script) return { ok: false, reason: 'error', message: macroMessages().scriptNotFound };
    return this.runSource(script.source);
  }

  /** Runs an unsaved script — e.g. from the macro editor before saving. */
  async runSource(source: string): Promise<MacroRunResult> {
    // The real gate: with scripts disabled nothing executes through any
    // path — not a saved script, not an imported one, not its shortcut.
    if (!this.scriptsEnabled) {
      return { ok: false, reason: 'error', message: macroMessages().scriptsDisabled };
    }
    const guard = this.guardRun();
    if (guard) return guard;

    this.running = true;
    try {
      const bridge = createMacroApi(this.host, { onLog: this.onLog });
      return await this.runner.run(source, bridge, this.runOptions);
    } finally {
      this.running = false;
    }
  }

  /* ---------- Recorder ---------- */

  get isRecording(): boolean {
    return this.recorder.recording;
  }

  get recordedStepCount(): number {
    return this.recorder.stepCount;
  }

  startRecording(): void {
    if (this.running) return;
    this.recorder.start();
  }

  /** Stops and saves. `null` when no step was recorded — there is nothing to save. */
  stopRecording(name: string, shortcut?: string): RecordedMacro | null {
    this.requireValidShortcut(shortcut);
    this.requireItemLimits({ name });
    this.requireRoom(this.state.recordings);
    const steps: MacroStep[] = splitOversizedSteps(this.recorder.stop());
    if (steps.length === 0) return null;

    const recording: RecordedMacro = {
      version: 1,
      id: newId(),
      name,
      createdAt: new Date().toISOString(),
      ...(shortcut ? { shortcut } : {}),
      steps,
    };
    this.state.recordings.push(recording);
    this.persist();
    return recording;
  }

  cancelRecording(): void {
    this.recorder.cancel();
  }

  listRecordings(): readonly RecordedMacro[] {
    return this.state.recordings;
  }

  removeRecording(id: string): void {
    this.state.recordings = this.state.recordings.filter((recording) => recording.id !== id);
    this.persist();
  }

  /** Renames a recording or edits its shortcut. `null` when the recording was not found. */
  updateRecording(input: { id: string; name?: string; shortcut?: string }): RecordedMacro | null {
    const recording = this.state.recordings.find((entry) => entry.id === input.id);
    if (!recording) return null;
    if (input.shortcut !== undefined) this.requireValidShortcut(input.shortcut, input.id);
    if (input.name !== undefined) this.requireItemLimits({ name: input.name });
    if (input.name !== undefined) recording.name = input.name;
    if (input.shortcut !== undefined) {
      if (input.shortcut) recording.shortcut = input.shortcut;
      else delete recording.shortcut;
    }
    this.persist();
    return recording;
  }

  async replayRecording(id: string, options?: ReplayOptions): Promise<ReplayResult> {
    const recording = this.state.recordings.find((entry) => entry.id === id);
    if (!recording) {
      return {
        ok: false,
        completed: 0,
        failures: [{ stepIndex: -1, step: { type: 'insert-text', text: '' }, message: macroMessages().recordingNotFound }],
      };
    }

    const guard = this.guardRun();
    if (guard) {
      return { ok: false, completed: 0, failures: [{ stepIndex: -1, step: { type: 'insert-text', text: '' }, message: guard.message }] };
    }

    this.running = true;
    try {
      return await replayMacro(this.host, recording.steps, options);
    } finally {
      this.running = false;
    }
  }

  /* ---------- Snippets ---------- */

  listSnippets(): readonly Snippet[] {
    return this.state.snippets;
  }

  saveSnippet(input: { id?: string; name: string; text: string; trigger?: string; shortcut?: string }): Snippet {
    this.requireValidShortcut(input.shortcut, input.id);
    this.requireItemLimits({ name: input.name, text: input.text, trigger: input.trigger });
    this.requireRoom(this.state.snippets, input.id);
    const snippet: Snippet = {
      id: input.id ?? newId(),
      name: input.name,
      text: input.text,
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.shortcut ? { shortcut: input.shortcut } : {}),
    };
    this.upsert(this.state.snippets, snippet);
    this.persist();
    return snippet;
  }

  removeSnippet(id: string): void {
    this.state.snippets = this.state.snippets.filter((snippet) => snippet.id !== id);
    this.persist();
  }

  async expandSnippet(id: string, options?: ExpandOptions): Promise<{ ok: boolean; message?: string }> {
    const snippet = this.state.snippets.find((entry) => entry.id === id);
    if (!snippet) return { ok: false, message: macroMessages().snippetNotFound };
    const outcome = await expandSnippet(this.host, snippet, options);
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  }

  /** Enables auto-text (trigger + space). Returns a disable function. */
  enableAutoText(): () => void {
    return this.autoText.attach();
  }

  disableAutoText(): void {
    this.autoText.detach();
  }

  /* ---------- Keyboard shortcuts ---------- */

  /**
   * Binds the shortcuts of everything saved (scripts, recordings, snippets)
   * to a target — usually the editor container or `window`. The list is
   * live: a new save is picked up without rebinding. Returns a dispose
   * function.
   */
  attachShortcuts(target: ShortcutTarget): () => void {
    return bindShortcuts(target, () => this.currentBindings());
  }

  private currentBindings(): ShortcutBinding[] {
    const bindings: ShortcutBinding[] = [];
    // Part of the scripts gate: with scripts disabled their shortcuts are
    // not bound at all — runScript would refuse anyway, but an unbound key
    // is better than a key that swallows the event just to show an error.
    if (this.scriptsEnabled) {
      for (const script of this.state.scripts) {
        if (script.shortcut) bindings.push({ shortcut: script.shortcut, run: () => this.runScript(script.id) });
      }
    }
    for (const recording of this.state.recordings) {
      if (recording.shortcut) bindings.push({ shortcut: recording.shortcut, run: () => this.replayRecording(recording.id) });
    }
    for (const snippet of this.state.snippets) {
      if (snippet.shortcut) bindings.push({ shortcut: snippet.shortcut, run: () => this.expandSnippet(snippet.id) });
    }
    return bindings;
  }

  /* ---------- Import/export ---------- */

  exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * Imports JSON produced by `exportState`. With `merge: true` an imported
   * item with an existing `id` replaces it; without merge the whole state is
   * replaced.
   *
   * The check is **atomic, on the final result**: a candidate state is built
   * first, its size limits and every shortcut in it are validated (the same
   * rules the save paths enforce — a file cannot smuggle in what typing
   * cannot), and only a candidate that passed in full is committed. On any
   * failure the current state is untouched.
   */
  importState(json: string, options: { merge?: boolean } = {}): { ok: boolean; message?: string } {
    const imported = parsePersistedState(json);
    if (!imported) return { ok: false, message: macroMessages().invalidImport };

    let candidate: PersistedMacroState;
    if (options.merge) {
      candidate = {
        version: 1,
        scripts: [...this.state.scripts.map((item) => ({ ...item }))],
        recordings: [...this.state.recordings.map((item) => ({ ...item }))],
        snippets: [...this.state.snippets.map((item) => ({ ...item }))],
      };
      for (const script of imported.scripts) this.upsert(candidate.scripts, script);
      for (const recording of imported.recordings) this.upsert(candidate.recordings, recording);
      for (const snippet of imported.snippets) this.upsert(candidate.snippets, snippet);
    } else {
      candidate = imported;
    }

    // The merged result can exceed what each file alone respected.
    if (!isPersistableState(candidate)) return { ok: false, message: macroMessages().importTooLarge };

    const shortcutsOk = this.validateStateShortcuts(candidate);
    if (!shortcutsOk.ok) return shortcutsOk;

    this.state = candidate;
    this.persist();
    return { ok: true };
  }

  /**
   * Every shortcut in a candidate state, under the exact rules of
   * `validateShortcut`: parseable, real modifier, not host-reserved, and
   * unique within the candidate. `importState` is the only caller — the
   * save paths enforce the same rules one item at a time.
   */
  private validateStateShortcuts(candidate: PersistedMacroState): { ok: true } | { ok: false; message: string } {
    const seen = new Map<string, string>();
    const items: ReadonlyArray<{ name: string; shortcut?: string }> = [
      ...candidate.scripts,
      ...candidate.recordings,
      ...candidate.snippets,
    ];

    for (const item of items) {
      if (!item.shortcut) continue;

      const parsed = parseShortcut(item.shortcut);
      if (!parsed) {
        return { ok: false, message: macroMessages().importRejectedShortcut(item.name, macroMessages().shortcutInvalid) };
      }
      if (!hasBindingModifier(parsed)) {
        return { ok: false, message: macroMessages().importRejectedShortcut(item.name, macroMessages().shortcutNeedsModifier) };
      }

      for (const signature of shortcutSignatures(parsed)) {
        if (this.reservedSignatures.has(signature)) {
          return { ok: false, message: macroMessages().importRejectedShortcut(item.name, macroMessages().shortcutReserved) };
        }
        const owner = seen.get(signature);
        if (owner !== undefined) {
          return { ok: false, message: macroMessages().importRejectedShortcut(item.name, macroMessages().shortcutTaken(owner)) };
        }
        seen.set(signature, item.name);
      }
    }
    return { ok: true };
  }

  /* ---------- Internal ---------- */

  private guardRun(): { ok: false; reason: 'error'; message: string } | null {
    if (this.recorder.recording) {
      return { ok: false, reason: 'error', message: macroMessages().cannotRunWhileRecording };
    }
    if (this.running) {
      return { ok: false, reason: 'error', message: macroMessages().anotherMacroRunning };
    }
    return null;
  }

  /**
   * The save-path half of the persistence invariant: field lengths that the
   * loader would reject are refused at the door. Without this, one oversized
   * save would make the whole store unloadable — and the next startup would
   * silently fall back to an empty state, losing everything.
   */
  private requireItemLimits(fields: { name: string; text?: string; source?: string; trigger?: string }): void {
    const limits = IMPORT_LIMITS;
    if (fields.name.length === 0) throw new MacroError(macroMessages().nameRequired, 'invalid-item');
    if (fields.name.length > limits.maxNameLength) {
      throw new MacroError(macroMessages().fieldTooLong('name', limits.maxNameLength), 'invalid-item');
    }
    if (fields.text !== undefined && fields.text.length > limits.maxTextLength) {
      throw new MacroError(macroMessages().fieldTooLong('text', limits.maxTextLength), 'invalid-item');
    }
    if (fields.source !== undefined && fields.source.length > limits.maxSourceLength) {
      throw new MacroError(macroMessages().fieldTooLong('source', limits.maxSourceLength), 'invalid-item');
    }
    if (fields.trigger !== undefined && fields.trigger.length > limits.maxTriggerLength) {
      throw new MacroError(macroMessages().fieldTooLong('trigger', limits.maxTriggerLength), 'invalid-item');
    }
  }

  /** The item-count half of the invariant. `existingId` exempts an in-place update. */
  private requireRoom(list: ReadonlyArray<{ id: string }>, existingId?: string): void {
    if (existingId && list.some((entry) => entry.id === existingId)) return;
    if (list.length >= IMPORT_LIMITS.maxItems) {
      throw new MacroError(macroMessages().tooManyItems, 'too-many-items');
    }
  }

  private upsert<T extends { id: string }>(list: T[], item: T): void {
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index >= 0) list[index] = item;
    else list.push(item);
  }

  private persist(): void {
    // Final safety net for the invariant: state the loader would reject is
    // never written. Reaching this branch is a bug in a save path above —
    // the warning is what surfaces it — but the user's stored macros
    // surviving that bug is the point.
    if (!isPersistableState(this.state)) {
      console.warn('[superdoc-macros] refusing to persist state that would fail to load');
      return;
    }
    this.storage.save(this.state);
  }
}

/**
 * A recorded insert-text step can exceed the loader's per-step cap (one huge
 * paste coalesces into one step). Splitting preserves the exact text while
 * keeping the recording loadable.
 */
function splitOversizedSteps(steps: MacroStep[]): MacroStep[] {
  const max = IMPORT_LIMITS.maxTextLength;
  const split = steps.flatMap((step) => {
    if (step.type !== 'insert-text' || step.text.length <= max) return [step];
    const chunks: MacroStep[] = [];
    for (let offset = 0; offset < step.text.length; offset += max) {
      chunks.push({ type: 'insert-text', text: step.text.slice(offset, offset + max) });
    }
    return chunks;
  });

  // Splitting can push a cap-length recording past the loader's step limit.
  // Truncating the tail is the honest option left: the alternative is a
  // recording the loader rejects, which loses the whole store's worth more.
  if (split.length > IMPORT_LIMITS.maxStepsPerRecording) {
    console.warn('[superdoc-macros] recording truncated to the step limit');
    return split.slice(0, IMPORT_LIMITS.maxStepsPerRecording);
  }
  return split;
}
