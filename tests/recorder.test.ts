import { describe, expect, it } from 'vitest';
import { MacroRecorder, replayMacro } from '../src/recorder/recorder.js';
import { createFakeHost } from './fake-host.js';

describe('MacroRecorder', () => {
  it('records commands and typing, coalescing consecutive keystrokes', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.uiCommand('bold');
    await host.typeText('בסד');
    await host.uiCommand('bold');
    await host.typeText('\nשלום');
    await host.typeBackspace();
    await host.typeBackspace();
    const { steps } = recorder.stop();

    expect(steps).toEqual([
      { type: 'command', id: 'bold' },
      { type: 'insert-text', text: 'בסד' },
      { type: 'command', id: 'bold' },
      { type: 'insert-paragraph' },
      { type: 'insert-text', text: 'שלום' },
      { type: 'delete-backward', count: 2 },
    ]);
  });

  it('a caret move records no step but breaks coalescing', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.typeText('אב');
    host.typeCaretMove(0);
    await host.typeText('גד');
    const { steps } = recorder.stop();

    // Text typed at a new position is not a continuation of the old text.
    expect(steps).toEqual([
      { type: 'insert-text', text: 'אב' },
      { type: 'insert-text', text: 'גד' },
    ]);
  });

  it('does not record undo/redo by default', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.uiCommand('undo');
    await host.uiCommand('italic');
    const { steps } = recorder.stop();

    expect(steps).toEqual([{ type: 'command', id: 'italic' }]);
  });

  it('the step cap auto-stops, notifies, and keeps the steps for stop()', async () => {
    const host = createFakeHost();
    let autoStopped = 0;
    const recorder = new MacroRecorder(host, { maxSteps: 3, onAutoStop: () => (autoStopped += 1) });

    recorder.start();
    await host.uiCommand('bold');
    await host.uiCommand('italic');
    await host.uiCommand('bold');
    await host.uiCommand('italic'); // past the cap — listening already ceased

    expect(autoStopped).toBe(1);
    expect(recorder.recording).toBe(false);

    // The steps survive the auto-stop — losing a recording at its cap would
    // punish exactly the longest recordings.
    const { steps } = recorder.stop();
    expect(steps).toHaveLength(3);
  });

  it('applyAutoTextExpansion rewrites the typed trigger into the expanded text', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.typeText('לפני בסד ');
    recorder.applyAutoTextExpansion('בסד '.length, 'בס"ד ');

    expect(recorder.stop().steps).toEqual([{ type: 'insert-text', text: 'לפני בס"ד ' }]);
  });

  it('applyAutoTextExpansion skips when the tail is not plain typed text', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.typeText('בס');
    await host.uiCommand('bold'); // a command lands mid-word — the tail no longer matches
    await host.typeText('ד ');
    recorder.applyAutoTextExpansion('בסד '.length, 'בס"ד ');

    // The raw truth stays: a guessed rewrite of non-matching steps is worse.
    expect(recorder.stop().steps).toEqual([
      { type: 'insert-text', text: 'בס' },
      { type: 'command', id: 'bold' },
      { type: 'insert-text', text: 'ד ' },
    ]);
  });

  it('cancel discards the recording and stops listening', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.typeText('א');
    recorder.cancel();
    await host.typeText('ב');

    expect(recorder.recording).toBe(false);
    expect(recorder.stop().steps).toEqual([]);
  });
});

describe('replayMacro', () => {
  it('replays a recording onto a fresh document', async () => {
    const recordedOn = createFakeHost();
    const recorder = new MacroRecorder(recordedOn);
    recorder.start();
    await recordedOn.uiCommand('bold');
    await recordedOn.typeText('בס"ד\n');
    const { steps } = recorder.stop();

    const target = createFakeHost();
    const result = await replayMacro(target, steps);

    expect(result.ok).toBe(true);
    expect(result.completed).toBe(3);
    expect(target.text).toBe('בס"ד\n');
    expect(target.executed).toEqual([{ id: 'bold', payload: undefined }]);
  });

  it('replays forward deletion', async () => {
    const recordedOn = createFakeHost();
    const recorder = new MacroRecorder(recordedOn);
    recorder.start();
    await recordedOn.typeDeleteForward();
    await recordedOn.typeDeleteForward();
    const { steps } = recorder.stop();
    expect(steps).toEqual([{ type: 'delete-forward', count: 2 }]);

    const target = createFakeHost();
    await target.insertText('אבגד');
    target.cursor = 1;
    const result = await replayMacro(target, steps);

    expect(result.ok).toBe(true);
    expect(target.text).toBe('אד');
  });

  it('stops at the first failure by default, continues with stopOnError: false', async () => {
    const host = createFakeHost();
    host.failCommands.add('italic');
    const steps = [
      { type: 'command', id: 'italic' },
      { type: 'insert-text', text: 'אחרי' },
    ] as const;

    const stopped = await replayMacro(host, [...steps]);
    expect(stopped.ok).toBe(false);
    expect(stopped.completed).toBe(0);
    expect(host.text).toBe('');

    const continued = await replayMacro(host, [...steps], { stopOnError: false });
    expect(continued.ok).toBe(false);
    expect(continued.completed).toBe(1);
    expect(host.text).toBe('אחרי');
  });
});
