import { describe, expect, it } from 'vitest';
import { MacroKit } from '../src/manager.js';
import { createMemoryStorage } from '../src/storage.js';
import { createFakeHost } from './fake-host.js';

function createKit(host = createFakeHost()) {
  const storage = createMemoryStorage();
  const kit = new MacroKit({ host, storage, runner: 'eval', onLog: () => undefined });
  return { host, storage, kit };
}

describe('MacroKit — scripts', () => {
  it('saves, runs and removes a script', async () => {
    const { kit, host } = createKit();

    const saved = kit.saveScript({ name: 'greeting', source: `await api.insertText('בס"ד');` });
    expect(kit.listScripts()).toHaveLength(1);

    const result = await kit.runScript(saved.id);
    expect(result.ok).toBe(true);
    expect(host.text).toBe('בס"ד');

    kit.removeScript(saved.id);
    expect(kit.listScripts()).toHaveLength(0);
  });

  it('state persists and reloads from storage', () => {
    const storage = createMemoryStorage();
    const first = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    first.saveScript({ name: 'a', source: 'return 1' });
    first.saveSnippet({ name: 'בסד', text: 'בס"ד', trigger: 'בסד' });

    const second = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    expect(second.listScripts()).toHaveLength(1);
    expect(second.listSnippets()).toHaveLength(1);
  });
});

describe('MacroKit — recording and replay', () => {
  it('records through the host, saves and replays', async () => {
    const { kit, host } = createKit();

    kit.startRecording();
    await host.uiCommand('bold');
    await host.typeText('שלום');
    const recording = kit.stopRecording('intro');

    expect(recording).not.toBeNull();
    expect(kit.listRecordings()).toHaveLength(1);

    host.text = '';
    host.cursor = 0;
    host.executed = [];
    const result = await kit.replayRecording(recording!.id);

    expect(result.ok).toBe(true);
    expect(host.text).toBe('שלום');
    expect(host.executed).toEqual([{ id: 'bold', payload: undefined }]);
  });

  it('updateRecording renames and clears shortcuts', async () => {
    const { kit, host } = createKit();
    kit.startRecording();
    await host.typeText('א');
    const recording = kit.stopRecording('temporary', 'Ctrl+Alt+9')!;

    const renamed = kit.updateRecording({ id: recording.id, name: 'permanent', shortcut: '' });

    expect(renamed?.name).toBe('permanent');
    expect(renamed?.shortcut).toBeUndefined();
    expect(kit.updateRecording({ id: 'no-such-id', name: 'x' })).toBeNull();
  });

  it('an empty recording is not saved', () => {
    const { kit } = createKit();
    kit.startRecording();
    expect(kit.stopRecording('empty')).toBeNull();
    expect(kit.listRecordings()).toHaveLength(0);
  });

  it('no macro runs while recording', async () => {
    const { kit } = createKit();
    const saved = kit.saveScript({ name: 'a', source: `await api.insertText('x');` });

    kit.startRecording();
    const result = await kit.runScript(saved.id);
    kit.cancelRecording();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('while recording');
  });
});

describe('MacroKit — shortcut validation', () => {
  it('requires a real modifier and a parseable form', () => {
    const { kit } = createKit();

    expect(kit.validateShortcut(undefined).ok).toBe(true);
    expect(kit.validateShortcut('  ').ok).toBe(true);
    expect(kit.validateShortcut('Ctrl+Alt+M').ok).toBe(true);

    // A bare letter would fire on ordinary typing; Shift alone is a capital letter.
    expect(kit.validateShortcut('a').ok).toBe(false);
    expect(kit.validateShortcut('Shift+a').ok).toBe(false);
    expect(kit.validateShortcut('Ctrl+').ok).toBe(false);
  });

  it('rejects shortcuts reserved by the host', () => {
    const kit = new MacroKit({
      host: createFakeHost(),
      storage: createMemoryStorage(),
      runner: 'eval',
      reservedShortcuts: ['Ctrl+S', 'not-parseable', 'Mod+K'],
    });

    expect(kit.validateShortcut('Ctrl+S').ok).toBe(false);
    // Mod expands to both Ctrl and Meta — either form collides.
    expect(kit.validateShortcut('Ctrl+K').ok).toBe(false);
    expect(kit.validateShortcut('Meta+K').ok).toBe(false);
    expect(kit.validateShortcut('Ctrl+Alt+K').ok).toBe(true);
  });

  it('rejects a shortcut already used by another item, allows the item itself', () => {
    const { kit } = createKit();
    const snippet = kit.saveSnippet({ name: 'בסד', text: 'בס"ד', shortcut: 'Ctrl+Alt+7' });

    const taken = kit.validateShortcut('Ctrl+Alt+7');
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.message).toContain('בסד');

    // Editing the owner keeps its own shortcut valid.
    expect(kit.validateShortcut('Ctrl+Alt+7', snippet.id).ok).toBe(true);
  });

  it('the save paths enforce validation by throwing', () => {
    const { kit } = createKit();
    kit.saveSnippet({ name: 'א', text: 'ב', shortcut: 'Ctrl+Alt+7' });

    expect(() => kit.saveScript({ name: 'x', source: '1', shortcut: 'a' })).toThrow();
    expect(() => kit.saveSnippet({ name: 'y', text: 'z', shortcut: 'Ctrl+Alt+7' })).toThrow();
  });
});

describe('MacroKit — snippets and import/export', () => {
  it('expands a saved snippet with variables', async () => {
    const { kit, host } = createKit();
    const snippet = kit.saveSnippet({ name: 'signature', text: 'בברכה, {{שם}}' });

    const result = await kit.expandSnippet(snippet.id, { variables: { שם: 'ראובן' } });

    expect(result.ok).toBe(true);
    expect(host.text).toBe('בברכה, ראובן');
  });

  it('export then import restores the state', () => {
    const { kit } = createKit();
    kit.saveScript({ name: 'a', source: 'return 1', shortcut: 'Ctrl+1' });
    kit.saveSnippet({ name: 'בסד', text: 'בס"ד', trigger: 'בסד' });
    const exported = kit.exportState();

    const { kit: fresh } = createKit();
    const outcome = fresh.importState(exported);

    expect(outcome.ok).toBe(true);
    expect(fresh.listScripts()).toHaveLength(1);
    expect(fresh.listSnippets()).toHaveLength(1);
  });

  it('importing broken JSON fails closed', () => {
    const { kit } = createKit();
    expect(kit.importState('not json').ok).toBe(false);
    expect(kit.importState('{"version":99}').ok).toBe(false);
  });
});

describe('MacroKit — keyboard shortcuts', () => {
  it('a saved script shortcut runs it', async () => {
    const { kit, host } = createKit();
    kit.saveScript({ name: 'a', source: `await api.insertText('קיצור');`, shortcut: 'Ctrl+Alt+1' });

    let keydown: ((event: unknown) => void) | null = null;
    kit.attachShortcuts({
      addEventListener: (_type, listener) => {
        keydown = listener as (event: unknown) => void;
      },
      removeEventListener: () => undefined,
    });

    keydown!({
      key: '1',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('קיצור');
  });
});
