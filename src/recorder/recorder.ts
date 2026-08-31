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
import { IMPORT_LIMITS } from '../storage.js';
import type { MacroHost, MacroOutcome, MacroStep, TextInputEvent } from '../types.js';

export interface RecorderOptions {
  /** Command filter. The default records everything except undo/redo. */
  shouldRecordCommand?: (id: string) => boolean;
  /** Step cap per recording, against a recording left running by mistake. */
  maxSteps?: number;
  /**
   * Called when the step cap stops the recording. The steps are kept —
   * `stop()` still returns them — but listening has ceased, and a UI that
   * shows "recording" must be told, or its indicator would keep promising a
   * recording that is no longer happening.
   */
  onAutoStop?: () => void;
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
  private readonly onAutoStop?: () => void;

  private steps: MacroStep[] = [];
  private disposers: Array<() => void> = [];
  private active = false;
  /**
   * Set by a caret move: the next typed character starts a fresh step
   * instead of coalescing — text typed at a new position is not a
   * continuation of the text typed at the old one.
   */
  private tailInterrupted = false;

  constructor(host: MacroHost, options: RecorderOptions = {}) {
    this.host = host;
    this.shouldRecordCommand = options.shouldRecordCommand ?? defaultShouldRecord;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.onAutoStop = options.onAutoStop;
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

  /**
   * Stops and returns the steps. Empty when nothing was recorded. Also the
   * way to collect a recording that auto-stopped at the cap — the steps are
   * kept until someone asks for them.
   */
  stop(): MacroStep[] {
    this.teardown();
    const recorded = this.steps;
    this.steps = [];
    return recorded;
  }

  /** Stops and discards whatever was recorded. */
  cancel(): void {
    this.teardown();
    this.steps = [];
  }

  /**
   * Rewrites the recorded tail after an auto-text expansion: the user typed
   * a trigger word plus the expansion character, but what the document now
   * holds is the expanded text — a replay of the raw keystrokes would
   * diverge (and would depend on auto-text being active at replay time).
   * The trailing `consumed` characters are removed from the recorded
   * insert-text steps and the expanded text is recorded in their place.
   *
   * If the tail does not hold `consumed` plain characters (a command landed
   * mid-word, or the recording started mid-trigger), the rewrite is skipped
   * and the raw keystrokes stay — a truthful raw recording beats a guessed
   * edit of steps that do not match.
   */
  applyAutoTextExpansion(consumed: number, replacement: string): void {
    if (!this.active || consumed <= 0) return;

    // Verify the tail is entirely typed text before touching anything.
    let remaining = consumed;
    let index = this.steps.length - 1;
    while (remaining > 0 && index >= 0) {
      const step = this.steps[index];
      if (step?.type !== 'insert-text') return;
      remaining -= step.text.length;
      index -= 1;
    }
    if (remaining > 0) return;

    let toRemove = consumed;
    while (toRemove > 0) {
      const last = this.steps[this.steps.length - 1];
      if (last?.type !== 'insert-text') return; // unreachable after the check above
      if (last.text.length > toRemove) {
        last.text = last.text.slice(0, -toRemove);
        break;
      }
      toRemove -= last.text.length;
      this.steps.pop();
    }

    this.recordTextInput({ kind: 'insert-text', text: replacement });
  }

  private teardown(): void {
    this.active = false;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private push(step: MacroStep): void {
    this.steps.push(step);
    if (this.steps.length >= this.maxSteps) {
      // The cap stops the *listening*, not the data: the steps stay for
      // stop() to collect, and the owner is told the recording ended.
      this.teardown();
      this.onAutoStop?.();
    }
  }

  /**
   * Records a programmatic insertion the host will not report as typing —
   * e.g. a snippet expanded from a button or shortcut, which writes through
   * the document API and never fires beforeinput. Without this, a replay
   * would silently miss text the user watched appear.
   */
  recordInsert(text: string): void {
    if (!this.active || text.length === 0) return;
    this.recordTextInput({ kind: 'insert-text', text });
  }

  private recordCommand(id: string, payload: unknown): void {
    if (!this.shouldRecordCommand(id)) return;
    if (payload === undefined) {
      this.push({ type: 'command', id });
      return;
    }
    // The payload is opaque engine data, but not unlimited: it must survive
    // a JSON round-trip within the persistence cap, or the recording would
    // be rejected by the loader. A command whose payload cannot be kept
    // faithfully is skipped whole — replaying it with a mangled payload
    // would do something other than what was recorded.
    let json: string | undefined;
    try {
      json = JSON.stringify(payload);
    } catch {
      return;
    }
    if (typeof json !== 'string' || json.length > IMPORT_LIMITS.maxPayloadLength) return;
    this.push({ type: 'command', id, payload: JSON.parse(json) });
  }

  private recordTextInput(event: TextInputEvent): void {
    const interrupted = this.tailInterrupted;
    this.tailInterrupted = false;
    const last = this.steps[this.steps.length - 1];

    switch (event.kind) {
      case 'insert-text': {
        // Consecutive keystrokes coalesce into one step — more readable,
        // faster to replay — but never across a caret move.
        if (!interrupted && last?.type === 'insert-text') {
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
        if (!interrupted && last?.type === 'delete-backward') {
          last.count += 1;
          return;
        }
        this.push({ type: 'delete-backward', count: 1 });
        return;
      }
      case 'delete-forward': {
        if (!interrupted && last?.type === 'delete-forward') {
          last.count += 1;
          return;
        }
        this.push({ type: 'delete-forward', count: 1 });
        return;
      }
      case 'caret-moved':
        // Not a step — replay acts from the live caret — but the recorded
        // tail is no longer "where the user is typing".
        this.tailInterrupted = true;
        return;
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
