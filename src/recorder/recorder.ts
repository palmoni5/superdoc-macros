/**
 * A Word-style macro recorder: records **commands** and typing, not caret
 * positions.
 *
 * That choice is deliberate. Recording raw ProseMirror steps (with absolute
 * positions) breaks the moment the document differs from what it was at
 * recording time; recording commands ("bold", "bullet-list", typing a
 * greeting) behaves like Word's recorder — the actions apply wherever the
 * caret is at replay time. It is also what makes a recording saveable and
 * shareable: the steps are plain JSON.
 *
 * What is not recorded: caret movement and mouse selection. As in Word, a
 * recorded macro acts from wherever the caret stands when it runs.
 */
import type { MacroHost, MacroOutcome, MacroStep, TextInputEvent } from '../types.js';

export interface RecorderOptions {
  /** Command filter. The default records everything except undo/redo. */
  shouldRecordCommand?: (id: string) => boolean;
  /** Step cap per recording, against a recording left running by mistake. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 5_000;

/** Undo/redo during recording fix the recording itself — replaying them would replay the mistake too. */
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

  /** Stops and returns the steps. Empty when nothing was recorded. */
  stop(): MacroStep[] {
    if (!this.active) return [];
    this.teardown();
    const recorded = this.steps;
    this.steps = [];
    return recorded;
  }

  /** Stops and discards whatever was recorded. */
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
        // Consecutive keystrokes coalesce into one step — more readable, faster to replay.
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
  /** How many steps completed successfully. */
  completed: number;
  failures: ReplayFailure[];
}

export interface ReplayOptions {
  /** Stop at the first failure. Default: true — a macro that failed midway must not keep running blind. */
  stopOnError?: boolean;
  /** Called before each step; enables a progress indicator. */
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
      return host.deleteForward(step.count);
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
