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
import { bindShortcuts, type ShortcutBinding, type ShortcutTarget } from './shortcuts.js';
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
}

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
  private running = false;

  constructor(options: MacroKitOptions) {
    this.host = options.host;
    this.storage = options.storage ?? createLocalStorage();
    this.runOptions = options.runOptions ?? {};
    this.onLog = options.onLog;

    const runner = options.runner ?? 'iframe';
    this.runner =
      runner === 'iframe' ? createIframeRunner() : runner === 'eval' ? createEvalRunner() : runner;

    this.state = this.storage.load() ?? emptyState();
    this.recorder = new MacroRecorder(this.host);
    this.autoText = new AutoText(this.host, () => this.state.snippets, options.autoText);
  }

  /* ---------- Scripts ---------- */

  listScripts(): readonly SavedScript[] {
    return this.state.scripts;
  }

  saveScript(input: { id?: string; name: string; source: string; shortcut?: string }): SavedScript {
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
    const steps: MacroStep[] = this.recorder.stop();
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
    for (const script of this.state.scripts) {
      if (script.shortcut) bindings.push({ shortcut: script.shortcut, run: () => this.runScript(script.id) });
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
   */
  importState(json: string, options: { merge?: boolean } = {}): { ok: boolean; message?: string } {
    const imported = parsePersistedState(json);
    if (!imported) return { ok: false, message: macroMessages().invalidImport };

    if (options.merge) {
      for (const script of imported.scripts) this.upsert(this.state.scripts, script);
      for (const recording of imported.recordings) this.upsert(this.state.recordings, recording);
      for (const snippet of imported.snippets) this.upsert(this.state.snippets, snippet);
    } else {
      this.state = imported;
    }
    this.persist();
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

  private upsert<T extends { id: string }>(list: T[], item: T): void {
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index >= 0) list[index] = item;
    else list.push(item);
  }

  private persist(): void {
    this.storage.save(this.state);
  }
}
