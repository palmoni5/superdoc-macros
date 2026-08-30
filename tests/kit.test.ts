import { describe, expect, it } from 'vitest';
import { MacroKit } from '../src/manager.js';
import { createMemoryStorage } from '../src/storage.js';
import { createFakeHost } from './fake-host.js';

function createKit(host = createFakeHost()) {
  const storage = createMemoryStorage();
  const kit = new MacroKit({ host, storage, runner: 'eval', onLog: () => undefined });
  return { host, storage, kit };
}

describe('MacroKit — סקריפטים', () => {
  it('שומר, מריץ ומוחק סקריפט', async () => {
    const { kit, host } = createKit();

    const saved = kit.saveScript({ name: 'ברכה', source: `await api.insertText('בס"ד');` });
    expect(kit.listScripts()).toHaveLength(1);

    const result = await kit.runScript(saved.id);
    expect(result.ok).toBe(true);
    expect(host.text).toBe('בס"ד');

    kit.removeScript(saved.id);
    expect(kit.listScripts()).toHaveLength(0);
  });

  it('המצב נשמר ונטען מחדש מהאחסון', () => {
    const storage = createMemoryStorage();
    const first = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    first.saveScript({ name: 'א', source: 'return 1' });
    first.saveSnippet({ name: 'בסד', text: 'בס"ד', trigger: 'בסד' });

    const second = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    expect(second.listScripts()).toHaveLength(1);
    expect(second.listSnippets()).toHaveLength(1);
  });
});

describe('MacroKit — הקלטה וניגון', () => {
  it('מקליט דרך המארח, שומר ומנגן', async () => {
    const { kit, host } = createKit();

    kit.startRecording();
    await host.uiCommand('bold');
    await host.typeText('שלום');
    const recording = kit.stopRecording('פתיח');

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

  it('הקלטה ריקה אינה נשמרת', () => {
    const { kit } = createKit();
    kit.startRecording();
    expect(kit.stopRecording('ריק')).toBeNull();
    expect(kit.listRecordings()).toHaveLength(0);
  });

  it('אין ריצת מאקרו בזמן הקלטה', async () => {
    const { kit } = createKit();
    const saved = kit.saveScript({ name: 'א', source: `await api.insertText('x');` });

    kit.startRecording();
    const result = await kit.runScript(saved.id);
    kit.cancelRecording();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('בזמן הקלטה');
  });
});

describe('MacroKit — קטעים וייבוא/ייצוא', () => {
  it('מרחיב קטע שמור עם משתנים', async () => {
    const { kit, host } = createKit();
    const snippet = kit.saveSnippet({ name: 'חתימה', text: 'בברכה, {{שם}}' });

    const result = await kit.expandSnippet(snippet.id, { variables: { שם: 'ראובן' } });

    expect(result.ok).toBe(true);
    expect(host.text).toBe('בברכה, ראובן');
  });

  it('ייצוא ואז ייבוא משחזרים את המצב', () => {
    const { kit } = createKit();
    kit.saveScript({ name: 'א', source: 'return 1', shortcut: 'Ctrl+1' });
    kit.saveSnippet({ name: 'בסד', text: 'בס"ד', trigger: 'בסד' });
    const exported = kit.exportState();

    const { kit: fresh } = createKit();
    const outcome = fresh.importState(exported);

    expect(outcome.ok).toBe(true);
    expect(fresh.listScripts()).toHaveLength(1);
    expect(fresh.listSnippets()).toHaveLength(1);
  });

  it('ייבוא של JSON פגום נכשל סגור', () => {
    const { kit } = createKit();
    expect(kit.importState('לא json').ok).toBe(false);
    expect(kit.importState('{"version":99}').ok).toBe(false);
  });
});

describe('MacroKit — קיצורי מקלדת', () => {
  it('קיצור של סקריפט שמור מריץ אותו', async () => {
    const { kit, host } = createKit();
    kit.saveScript({ name: 'א', source: `await api.insertText('קיצור');`, shortcut: 'Ctrl+Alt+1' });

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
