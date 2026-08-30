/**
 * `MacroKit` — הפאסדה שמארח מתקין פעם אחת ומקבל את שלוש היכולות מחווטות:
 * סקריפטים (עם ארגז חול), מקליט, וקטעי טקסט עם השלמה אוטומטית — פלוס שמירה,
 * ייבוא/ייצוא וקיצורי מקלדת.
 *
 * כלל בטיחות אחד נאכף כאן: אין ריצה בזמן הקלטה ואין שתי ריצות במקביל.
 * ניגון או סקריפט שרצים תוך כדי הקלטה היו מוקלטים בעצמם ומכפילים את עצמם
 * בניגון הבא.
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
import type { MacroHost, MacroStep, RecordedMacro, SavedScript, Snippet } from './types.js';

export interface MacroKitOptions {
  host: MacroHost;
  /** ברירת מחדל: localStorage. */
  storage?: MacroStorage;
  /**
   * `'iframe'` (ברירת המחדל) מריץ סקריפטים בארגז חול; `'eval'` מריץ ישירות —
   * ראו את האזהרה ב-eval-runner. אפשר גם למסור מריץ מותאם.
   */
  runner?: MacroRunner | 'iframe' | 'eval';
  /** אפשרויות ריצה לסקריפטים (זמן, תקרת קריאות). */
  runOptions?: MacroRunOptions;
  /** אפשרויות ההשלמה האוטומטית. */
  autoText?: Omit<AutoTextOptions, 'onExpand' | 'onError'> & AutoTextOptions;
  /** יומן ריצה של `api.log`. */
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

  /* ---------- סקריפטים ---------- */

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
    if (!script) return { ok: false, reason: 'error', message: 'המאקרו לא נמצא' };
    return this.runSource(script.source);
  }

  /** מריצה סקריפט שלא נשמר — למשל מתוך עורך המאקרו לפני שמירה. */
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

  /* ---------- מקליט ---------- */

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

  /** עוצרת ושומרת. `null` כשלא הוקלט אף צעד — אין מה לשמור. */
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

  /** עדכון שם או קיצור של הקלטה קיימת. `null` כשההקלטה לא נמצאה. */
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
    if (!recording) return { ok: false, completed: 0, failures: [{ stepIndex: -1, step: { type: 'insert-text', text: '' }, message: 'ההקלטה לא נמצאה' }] };

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

  /* ---------- קטעי טקסט ---------- */

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
    if (!snippet) return { ok: false, message: 'הקטע לא נמצא' };
    const outcome = await expandSnippet(this.host, snippet, options);
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  }

  /** מפעילה השלמה אוטומטית (trigger + רווח). מחזירה פונקציית כיבוי. */
  enableAutoText(): () => void {
    return this.autoText.attach();
  }

  disableAutoText(): void {
    this.autoText.detach();
  }

  /* ---------- קיצורי מקלדת ---------- */

  /**
   * קושרת את הקיצורים של כל מה ששמור (סקריפטים, הקלטות, קטעים) ליעד — בדרך
   * כלל ה-container של העורך או `window`. הרשימה חיה: שמירה חדשה נקלטת בלי
   * לקשור מחדש. מחזירה פונקציית ניתוק.
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

  /* ---------- ייבוא/ייצוא ---------- */

  exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * ייבוא מ-JSON שיוצא ב-`exportState`. במיזוג (`merge: true`) פריט מיובא עם
   * `id` קיים מחליף את הקיים; בלי מיזוג המצב כולו מוחלף.
   */
  importState(json: string, options: { merge?: boolean } = {}): { ok: boolean; message?: string } {
    const imported = parsePersistedState(json);
    if (!imported) return { ok: false, message: 'הקובץ אינו ייצוא מאקרו תקין' };

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

  /* ---------- פנימי ---------- */

  private guardRun(): { ok: false; reason: 'error'; message: string } | null {
    if (this.recorder.recording) {
      return { ok: false, reason: 'error', message: 'אי אפשר להריץ מאקרו בזמן הקלטה' };
    }
    if (this.running) {
      return { ok: false, reason: 'error', message: 'מאקרו אחר עדיין רץ' };
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
