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
import { renderSnippetForHost, type ExpandOptions } from './snippets/snippets.js';
import { IMPORT_LIMITS, isPersistableState, serializePersistable } from './storage.js';
import {
  bindShortcuts,
  hasBindingModifier,
  isBindableKey,
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

    const reserved = new Set<string>();
    for (const shortcut of options.reservedShortcuts ?? []) {
      const parsed = parseShortcut(shortcut);
      if (parsed) for (const signature of shortcutSignatures(parsed)) reserved.add(signature);
    }
    this.reservedSignatures = reserved;

    this.state = this.storage.load() ?? emptyState();
    // Loaded state passed the *structural* validation only. The semantic
    // shortcut rules (bindable key, reserved list, duplicates) may have
    // tightened since it was saved — a stale binding must not stay armed.
    // Offending shortcuts are stripped, their items kept.
    this.sanitizeLoadedShortcuts();
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

    const issue = this.bindingIssue(trimmed);
    if (issue) return { ok: false, message: issue.message };

    const owner = this.findShortcutOwner(shortcutSignatures(parseShortcut(trimmed)!), excludeId);
    if (owner) return { ok: false, message: macroMessages().shortcutTaken(owner) };
    return { ok: true };
  }

  /**
   * The context-free binding rules, in one place: parseable, real modifier,
   * physically-mappable key, not host-reserved. Manual save, import and
   * legacy-state load all judge a shortcut by exactly this — a file or an
   * old store must not smuggle in what typing cannot.
   */
  private bindingIssue(shortcut: string): { message: string } | null {
    const parsed = parseShortcut(shortcut);
    if (!parsed) return { message: macroMessages().shortcutInvalid };
    if (!hasBindingModifier(parsed)) return { message: macroMessages().shortcutNeedsModifier };
    // Only keys with a physical-code mapping (letters, digits, F-keys):
    // matching is by event.code, so it survives a Hebrew keyboard layout.
    if (!isBindableKey(parsed)) return { message: macroMessages().shortcutInvalid };
    if (shortcutSignatures(parsed).some((signature) => this.reservedSignatures.has(signature))) {
      return { message: macroMessages().shortcutReserved };
    }
    return null;
  }

  /**
   * Strips loaded shortcuts that today's rules reject — see the constructor.
   * Items survive; only their bindings are dropped.
   */
  private sanitizeLoadedShortcuts(): void {
    const seen = new Set<string>();
    const items: Array<{ shortcut?: string }> = [
      ...this.state.scripts,
      ...this.state.recordings,
      ...this.state.snippets,
    ];
    for (const item of items) {
      if (!item.shortcut) continue;
      if (this.bindingIssue(item.shortcut)) {
        delete item.shortcut;
        continue;
      }
      const signatures = shortcutSignatures(parseShortcut(item.shortcut)!);
      if (signatures.some((signature) => seen.has(signature))) {
        delete item.shortcut;
        continue;
      }
      for (const signature of signatures) seen.add(signature);
    }
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
    this.requireItemLimits({ name: input.name, source: input.source, shortcut: input.shortcut });
    this.requireRoom(this.state.scripts, input.id);
    const script: SavedScript = {
      id: input.id ?? newId(),
      name: input.name,
      source: input.source,
      ...(input.shortcut ? { shortcut: input.shortcut } : {}),
    };
    return this.commit((draft) => {
      this.upsert(draft.scripts, script);
      return script;
    });
  }

  removeScript(id: string): void {
    this.commit((draft) => {
      draft.scripts = draft.scripts.filter((script) => script.id !== id);
    });
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

  /**
   * Stops and saves. `null` when no step was recorded — there is nothing to
   * save.
   *
   * Throws — with the stopped recording **retained for retry** (call again;
   * `cancelRecording` is the explicit way to drop it) — when:
   * - `recording-incomplete`: some actions could not be captured (e.g. an
   *   inserted image, whose payload is the whole file). Saving that as-is
   *   would present a macro that replays less than what the user did, so it
   *   needs an explicit `allowIncomplete: true` from a confirming UI.
   * - `recording-too-large`: even split, the steps exceed the loader's cap —
   *   a silently partial macro is not produced.
   * - a persistence failure (quota, oversized state).
   */
  stopRecording(
    name: string,
    shortcut?: string,
    options: { allowIncomplete?: boolean } = {},
  ): RecordedMacro | null {
    this.requireValidShortcut(shortcut);
    this.requireItemLimits({ name, shortcut });
    this.requireRoom(this.state.recordings);

    const pending = this.recorder.stop();
    const { steps, truncated } = splitOversizedSteps(pending.steps);
    if (truncated) throw new MacroError(macroMessages().recordingTooLarge, 'recording-too-large');
    if (steps.length === 0) {
      this.recorder.discard();
      return null;
    }
    if (pending.warnings.length > 0 && !options.allowIncomplete) {
      const commandIds = [...new Set(pending.warnings.map((warning) => warning.commandId))].join(', ');
      throw new MacroError(macroMessages().recordingIncomplete(commandIds), 'recording-incomplete');
    }

    const recording: RecordedMacro = {
      version: 1,
      id: newId(),
      name,
      createdAt: new Date().toISOString(),
      ...(shortcut ? { shortcut } : {}),
      steps,
    };
    const saved = this.commit((draft) => {
      draft.recordings.push(recording);
      return recording;
    });
    // Only after the commit landed: a failed save keeps the recording
    // retrievable for another attempt (delete an old macro, stop again).
    this.recorder.discard();
    return saved;
  }

  cancelRecording(): void {
    this.recorder.cancel();
  }

  /** Whether a stopped recording awaits a retried save (see stopRecording). */
  get hasPendingRecording(): boolean {
    return this.recorder.hasPending;
  }

  listRecordings(): readonly RecordedMacro[] {
    return this.state.recordings;
  }

  removeRecording(id: string): void {
    this.commit((draft) => {
      draft.recordings = draft.recordings.filter((recording) => recording.id !== id);
    });
  }

  /** Renames a recording or edits its shortcut. `null` when the recording was not found. */
  updateRecording(input: { id: string; name?: string; shortcut?: string }): RecordedMacro | null {
    if (!this.state.recordings.some((entry) => entry.id === input.id)) return null;
    if (input.shortcut !== undefined) this.requireValidShortcut(input.shortcut, input.id);
    if (input.name !== undefined) this.requireItemLimits({ name: input.name, shortcut: input.shortcut });
    return this.commit((draft) => {
      const recording = draft.recordings.find((entry) => entry.id === input.id)!;
      if (input.name !== undefined) recording.name = input.name;
      if (input.shortcut !== undefined) {
        if (input.shortcut) recording.shortcut = input.shortcut;
        else delete recording.shortcut;
      }
      return recording;
    });
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
    this.requireItemLimits({
      name: input.name,
      text: input.text,
      trigger: input.trigger,
      shortcut: input.shortcut,
    });
    this.requireRoom(this.state.snippets, input.id);
    const snippet: Snippet = {
      id: input.id ?? newId(),
      name: input.name,
      text: input.text,
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.shortcut ? { shortcut: input.shortcut } : {}),
    };
    return this.commit((draft) => {
      this.upsert(draft.snippets, snippet);
      return snippet;
    });
  }

  removeSnippet(id: string): void {
    this.commit((draft) => {
      draft.snippets = draft.snippets.filter((snippet) => snippet.id !== id);
    });
  }

  async expandSnippet(id: string, options?: ExpandOptions): Promise<{ ok: boolean; message?: string }> {
    const snippet = this.state.snippets.find((entry) => entry.id === id);
    if (!snippet) return { ok: false, message: macroMessages().snippetNotFound };

    const rendered = await renderSnippetForHost(this.host, snippet, options);
    const outcome = await this.host.insertText(rendered);
    if (!outcome.ok) return { ok: false, message: outcome.message };

    // A snippet expanded from a button or shortcut writes through the
    // document API and fires no typing events — recorded explicitly, or a
    // replay would silently miss text the user watched appear. The auto-text
    // path needs nothing here: its expansion rewrites the typed tail.
    this.recorder.recordInsert(rendered);
    return { ok: true };
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

    try {
      this.adopt(candidate);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : macroMessages().saveFailed };
    }
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

      // The exact same context-free rules the manual save path applies —
      // including the bindable-key restriction (an imported Ctrl+Tab must
      // not slip in through the event.key fallback).
      const issue = this.bindingIssue(item.shortcut);
      if (issue) {
        return { ok: false, message: macroMessages().importRejectedShortcut(item.name, issue.message) };
      }

      for (const signature of shortcutSignatures(parseShortcut(item.shortcut)!)) {
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
  private requireItemLimits(fields: {
    name: string;
    text?: string;
    source?: string;
    trigger?: string;
    shortcut?: string;
  }): void {
    const limits = IMPORT_LIMITS;
    if (fields.name.length === 0) throw new MacroError(macroMessages().nameRequired, 'invalid-item');
    if (fields.name.length > limits.maxNameLength) {
      throw new MacroError(macroMessages().fieldTooLong('name', limits.maxNameLength), 'invalid-item');
    }
    if (fields.shortcut !== undefined && fields.shortcut.length > limits.maxShortcutLength) {
      throw new MacroError(macroMessages().fieldTooLong('shortcut', limits.maxShortcutLength), 'invalid-item');
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

  /**
   * Applies a mutation transactionally: the change runs on a clone, and the
   * clone becomes the state only through `adopt` — validation and storage
   * included. A failure at any stage leaves the previous state fully
   * intact. Before this, the in-memory state mutated first and a quota
   * failure left memory and disk silently disagreeing until the next
   * successful save rewrote history.
   */
  private commit<T>(mutate: (draft: PersistedMacroState) => T): T {
    const draft = JSON.parse(JSON.stringify(this.state)) as PersistedMacroState;
    const result = mutate(draft);
    this.adopt(draft);
    return result;
  }

  /**
   * The persistence invariant, in one place: a candidate becomes the state
   * only if it serializes under the loader's exact rules (shape, field
   * caps, whole-file size) *and* the storage actually accepted it.
   */
  private adopt(candidate: PersistedMacroState): void {
    if (serializePersistable(candidate) === null) {
      throw new MacroError(macroMessages().saveFailed, 'invalid-state');
    }
    if (!this.storage.save(candidate)) {
      throw new MacroError(macroMessages().saveFailed, 'storage-failed');
    }
    this.state = candidate;
  }
}

/**
 * A recorded insert-text step can exceed the loader's per-step cap (one huge
 * paste coalesces into one step). Splitting preserves the exact text while
 * keeping the recording loadable. `truncated` reports the pathological case
 * where even the split exceeds the loader's step limit — the caller refuses
 * to save then, with a message: a silently partial macro is worse than no
 * macro.
 */
function splitOversizedSteps(steps: MacroStep[]): { steps: MacroStep[]; truncated: boolean } {
  const max = IMPORT_LIMITS.maxTextLength;
  const split = steps.flatMap((step) => {
    if (step.type !== 'insert-text' || step.text.length <= max) return [step];
    const chunks: MacroStep[] = [];
    for (let offset = 0; offset < step.text.length; offset += max) {
      chunks.push({ type: 'insert-text', text: step.text.slice(offset, offset + max) });
    }
    return chunks;
  });

  return { steps: split, truncated: split.length > IMPORT_LIMITS.maxStepsPerRecording };
}
