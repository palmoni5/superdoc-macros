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
    const steps = recorder.stop();

    expect(steps).toEqual([
      { type: 'command', id: 'bold' },
      { type: 'insert-text', text: 'בסד' },
      { type: 'command', id: 'bold' },
      { type: 'insert-paragraph' },
      { type: 'insert-text', text: 'שלום' },
      { type: 'delete-backward', count: 2 },
    ]);
  });

  it('does not record undo/redo by default', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.uiCommand('undo');
    await host.uiCommand('italic');
    const steps = recorder.stop();

    expect(steps).toEqual([{ type: 'command', id: 'italic' }]);
  });

  it('cancel discards the recording and stops listening', async () => {
    const host = createFakeHost();
    const recorder = new MacroRecorder(host);

    recorder.start();
    await host.typeText('א');
    recorder.cancel();
    await host.typeText('ב');

    expect(recorder.recording).toBe(false);
    expect(recorder.stop()).toEqual([]);
  });
});

describe('replayMacro', () => {
  it('replays a recording onto a fresh document', async () => {
    const recordedOn = createFakeHost();
    const recorder = new MacroRecorder(recordedOn);
    recorder.start();
    await recordedOn.uiCommand('bold');
    await recordedOn.typeText('בס"ד\n');
    const steps = recorder.stop();

    const target = createFakeHost();
    const result = await replayMacro(target, steps);

    expect(result.ok).toBe(true);
    expect(result.completed).toBe(3);
    expect(target.text).toBe('בס"ד\n');
    expect(target.executed).toEqual([{ id: 'bold', payload: undefined }]);
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
