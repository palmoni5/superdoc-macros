/**
 * מקליט מאקרו בסגנון Word: מקליט **פקודות** והקלדה, לא מיקומי סמן.
 *
 * הבחירה הזאת מכוונת. הקלטת צעדי ProseMirror גולמיים (עם מיקומים אבסולוטיים)
 * נשברת ברגע שהמסמך שונה ממה שהיה בזמן ההקלטה; הקלטת פקודות ("bold",
 * "bullet-list", הקלדת "בס\"ד") מתנהגת כמו המקליט של Word — הפעולות חלות
 * במקום שבו הסמן נמצא בזמן הניגון. זה גם מה שהופך הקלטה לניתנת לשמירה
 * ולשיתוף: הצעדים JSON בלבד.
 *
 * מה לא נקלט: תנועת סמן ובחירה בעכבר. כמו ב-Word, מאקרו מוקלט פועל מהמקום
 * שבו הסמן עומד כשמריצים אותו.
 */
import type { MacroHost, MacroOutcome, MacroStep, TextInputEvent } from '../types.js';

export interface RecorderOptions {
  /** סינון פקודות. ברירת המחדל מקליטה הכול חוץ מ-undo/redo. */
  shouldRecordCommand?: (id: string) => boolean;
  /** תקרת צעדים להקלטה אחת, נגד הקלטה שנשכחה פתוחה. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 5_000;

/** undo/redo בזמן הקלטה מתקנים את ההקלטה עצמה — ניגון שלהם היה משחזר גם את הטעות. */
function defaultShouldRecord(id: string): boolean {
  return id !== 'undo' && id !== 'redo';
}

export class MacroRecorder {
  private readonly host: MacroHost;
  private readonly shouldRecordCommand: (id: string) => boolean;
  private readonly maxSteps: number;

  private steps: MacroStep[] = [];
  private disposers: Array<() => void> = [];
  private active = false;

  constructor(host: MacroHost, options: RecorderOptions = {}) {
    this.host = host;
    this.shouldRecordCommand = options.shouldRecordCommand ?? defaultShouldRecord;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  get recording(): boolean {
    return this.active;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.steps = [];
    this.disposers = [
      this.host.onCommand((id, payload) => this.recordCommand(id, payload)),
      this.host.onTextInput((event) => this.recordTextInput(event)),
    ];
  }

  /** עוצרת ומחזירה את הצעדים. ריקה כשלא הוקלט דבר. */
  stop(): MacroStep[] {
    if (!this.active) return [];
    this.teardown();
    const recorded = this.steps;
    this.steps = [];
    return recorded;
  }

  /** עוצרת וזורקת את מה שהוקלט. */
  cancel(): void {
    if (!this.active) return;
    this.teardown();
    this.steps = [];
  }

  private teardown(): void {
    this.active = false;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private push(step: MacroStep): void {
    if (this.steps.length >= this.maxSteps) {
      this.teardown();
      return;
    }
    this.steps.push(step);
  }

  private recordCommand(id: string, payload: unknown): void {
    if (!this.shouldRecordCommand(id)) return;
    this.push(payload === undefined ? { type: 'command', id } : { type: 'command', id, payload });
  }

  private recordTextInput(event: TextInputEvent): void {
    const last = this.steps[this.steps.length - 1];

    switch (event.kind) {
      case 'insert-text': {
        // הקשות רצופות מתלכדות לצעד אחד — גם קריא יותר וגם ניגון מהיר יותר.
        if (last?.type === 'insert-text') {
          last.text += event.text;
          return;
        }
        this.push({ type: 'insert-text', text: event.text });
        return;
      }
      case 'insert-paragraph':
        this.push({ type: 'insert-paragraph' });
        return;
      case 'delete-backward': {
        if (last?.type === 'delete-backward') {
          last.count += 1;
          return;
        }
        this.push({ type: 'delete-backward', count: 1 });
        return;
      }
      case 'delete-forward': {
        if (last?.type === 'delete-forward') {
          last.count += 1;
          return;
        }
        this.push({ type: 'delete-forward', count: 1 });
        return;
      }
    }
  }
}

export interface ReplayFailure {
  stepIndex: number;
  step: MacroStep;
  message: string;
}

export interface ReplayResult {
  ok: boolean;
  /** כמה צעדים הושלמו בהצלחה. */
  completed: number;
  failures: ReplayFailure[];
}

export interface ReplayOptions {
  /** עצירה בכשל הראשון. ברירת מחדל: true — מאקרו שנכשל באמצע לא ממשיך לרוץ עיוור. */
  stopOnError?: boolean;
  /** נקראת לפני כל צעד; מאפשרת מד התקדמות. */
  onStep?: (index: number, step: MacroStep) => void;
}

async function runStep(host: MacroHost, step: MacroStep): Promise<MacroOutcome> {
  switch (step.type) {
    case 'command':
      return host.commands.execute(step.id, step.payload);
    case 'insert-text':
      return host.insertText(step.text);
    case 'insert-paragraph':
      return host.insertText('\n');
    case 'delete-backward':
      return host.deleteBackward(step.count);
    case 'delete-forward':
      // המנוע אינו חושף מחיקה קדימה נפרדת; מדווח ככשל מפורש ולא מדלג בשקט.
      return { ok: false, message: 'מחיקה קדימה אינה נתמכת בניגון', reason: 'unsupported-step' };
  }
}

export async function replayMacro(
  host: MacroHost,
  steps: readonly MacroStep[],
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const stopOnError = options.stopOnError ?? true;
  const failures: ReplayFailure[] = [];
  let completed = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) continue;
    options.onStep?.(index, step);

    let outcome: MacroOutcome;
    try {
      outcome = await runStep(host, step);
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    if (outcome.ok) {
      completed += 1;
      continue;
    }

    failures.push({ stepIndex: index, step, message: outcome.message });
    if (stopOnError) break;
  }

  return { ok: failures.length === 0, completed, failures };
}
