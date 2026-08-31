import { describe, expect, it } from 'vitest';
import { MacroKit } from '../src/manager.js';
import { MacroRecorder } from '../src/recorder/recorder.js';
import { MacroError } from '../src/scripting/macro-api.js';
import { createMemoryStorage, type PersistedMacroState } from '../src/storage.js';
import { createFakeHost } from './fake-host.js';

function captureMacroError(run: () => unknown, reason: string): MacroError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MacroError);
  expect((caught as MacroError).reason).toBe(reason);
  return caught as MacroError;
}

function fullRecordingState(): PersistedMacroState {
  return {
    version: 1,
    scripts: [],
    snippets: [],
    recordings: Array.from({ length: 500 }, (_value, index) => ({
      version: 1 as const,
      id: `r-${index}`,
      name: `recording ${index}`,
      steps: [{ type: 'insert-text' as const, text: 'x' }],
    })),
  };
}

function mutableStorage(initial: PersistedMacroState) {
  let stored = JSON.parse(JSON.stringify(initial)) as PersistedMacroState;
  return {
    load: () => JSON.parse(JSON.stringify(stored)) as PersistedMacroState,
    save: (state: PersistedMacroState) => {
      stored = JSON.parse(JSON.stringify(state)) as PersistedMacroState;
      return true;
    },
  };
}

describe('MacroKit — safe recording finalization', () => {
  it('rejects warning-only captures even with allowIncomplete and retains them until cancellation', async () => {
    const host = createFakeHost();
    const kit = new MacroKit({ host, storage: createMemoryStorage(), runner: 'eval' });

    expect(kit.startRecording()).toBe(true);
    await host.uiCommand('font-size', { value: 'x'.repeat(20_000) });

    const first = captureMacroError(
      () => kit.stopRecording('image only'),
      'recording-uncapturable',
    );
    expect(first.message).toContain('font-size');
    expect(kit.isRecording).toBe(false);
    expect(kit.hasPendingRecording).toBe(true);
    expect(kit.listRecordings()).toHaveLength(0);

    captureMacroError(
      () => kit.stopRecording('image only', undefined, { allowIncomplete: true }),
      'recording-uncapturable',
    );
    expect(kit.hasPendingRecording).toBe(true);
    expect(kit.listRecordings()).toHaveLength(0);

    // A fresh start would otherwise call MacroRecorder.start(), whose low-level
    // contract intentionally discards a pending snapshot. MacroKit must guard
    // that destructive transition without introducing a new throwing API.
    expect(kit.startRecording()).toBe(false);
    expect(kit.hasPendingRecording).toBe(true);

    kit.cancelRecording();
    expect(kit.hasPendingRecording).toBe(false);
  });

  it('stops before a full-list failure and lets the caller free space and retry', async () => {
    const host = createFakeHost();
    const kit = new MacroKit({ host, storage: mutableStorage(fullRecordingState()), runner: 'eval' });

    expect(kit.startRecording()).toBe(true);
    await host.typeText('חשוב');

    captureMacroError(() => kit.stopRecording('rescued'), 'too-many-items');
    expect(kit.isRecording).toBe(false);
    expect(kit.hasPendingRecording).toBe(true);
    expect(kit.listRecordings()).toHaveLength(500);

    kit.removeRecording('r-0');
    const saved = kit.stopRecording('rescued');

    expect(saved?.steps).toEqual([{ type: 'insert-text', text: 'חשוב' }]);
    expect(kit.hasPendingRecording).toBe(false);
    expect(kit.listRecordings()).toHaveLength(500);
  });

  it('retains an auto-stopped capture when the recording list is full', async () => {
    const host = createFakeHost();
    const autoStop = { error: null as MacroError | null };
    let kit!: MacroKit;
    kit = new MacroKit({
      host,
      storage: mutableStorage(fullRecordingState()),
      runner: 'eval',
      onRecordingAutoStop: () => {
        try {
          kit.stopRecording('auto rescued');
        } catch (error) {
          autoStop.error = error as MacroError;
        }
      },
    });

    expect(kit.startRecording()).toBe(true);
    for (let index = 0; index < 5_000; index += 1) {
      await host.uiCommand('bold');
    }

    expect(kit.isRecording).toBe(false);
    expect(kit.hasPendingRecording).toBe(true);
    expect(autoStop.error?.reason).toBe('too-many-items');

    kit.removeRecording('r-0');
    const saved = kit.stopRecording('auto rescued');
    expect(saved?.steps).toHaveLength(5_000);
    expect(kit.hasPendingRecording).toBe(false);
  });

  it('retains the capture when metadata validation fails, then accepts a corrected retry', async () => {
    const host = createFakeHost();
    const kit = new MacroKit({ host, storage: createMemoryStorage(), runner: 'eval' });

    expect(kit.startRecording()).toBe(true);
    await host.typeText('שלום');

    captureMacroError(() => kit.stopRecording(''), 'invalid-item');
    expect(kit.isRecording).toBe(false);
    expect(kit.hasPendingRecording).toBe(true);

    const saved = kit.stopRecording('שם תקין');
    expect(saved?.steps).toEqual([{ type: 'insert-text', text: 'שלום' }]);
    expect(kit.hasPendingRecording).toBe(false);
  });
});

describe('MacroRecorder — warning cap', () => {
  it('counts uncapturable warnings toward the auto-stop cap', async () => {
    const host = createFakeHost();
    let autoStops = 0;
    const recorder = new MacroRecorder(host, {
      maxSteps: 3,
      onAutoStop: () => {
        autoStops += 1;
      },
    });

    recorder.start();
    for (let index = 0; index < 3; index += 1) {
      await host.uiCommand('font-size', { value: 'x'.repeat(20_000) });
    }

    expect(recorder.recording).toBe(false);
    expect(autoStops).toBe(1);
    const pending = recorder.stop();
    expect(pending.steps).toEqual([]);
    expect(pending.warnings).toHaveLength(3);
  });
});
