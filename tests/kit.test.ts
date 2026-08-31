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

describe('MacroKit — the scripts gate', () => {
  function createGatedKit() {
    const host = createFakeHost();
    const kit = new MacroKit({ host, storage: createMemoryStorage(), runner: 'eval', scriptsEnabled: false });
    return { host, kit };
  }

  it('runScript and runSource refuse when scripts are disabled', async () => {
    const { kit } = createGatedKit();
    const saved = kit.saveScript({ name: 'x', source: `await api.insertText('x');` });

    for (const result of [await kit.runScript(saved.id), await kit.runSource('return 1')]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('disabled');
    }
  });

  it('a script shortcut is not bound while disabled — other shortcuts still are', async () => {
    const { kit, host } = createGatedKit();
    kit.saveScript({ name: 'x', source: `await api.insertText('script');`, shortcut: 'Ctrl+Alt+1' });
    kit.saveSnippet({ name: 'בסד', text: 'בס"ד', shortcut: 'Ctrl+Alt+2' });

    let keydown: ((event: unknown) => void) | null = null;
    kit.attachShortcuts({
      addEventListener: (_type, listener) => {
        keydown = listener as (event: unknown) => void;
      },
      removeEventListener: () => undefined,
    });
    const press = (key: string) =>
      keydown!({
        key,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        metaKey: false,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });

    press('1');
    press('2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only the snippet ran: the script's key was not even swallowed.
    expect(host.text).toBe('בס"ד');
  });
});

describe('MacroKit — save-path limits (the persistence invariant)', () => {
  it('rejects oversized fields and empty names before touching the state', () => {
    const { kit } = createKit();

    expect(() => kit.saveSnippet({ name: '', text: 'x' })).toThrow();
    expect(() => kit.saveSnippet({ name: 'x', text: 'y'.repeat(100_001) })).toThrow();
    expect(() => kit.saveScript({ name: 'x', source: 'y'.repeat(200_001) })).toThrow();
    expect(kit.listSnippets()).toHaveLength(0);
    expect(kit.listScripts()).toHaveLength(0);
  });

  it('rejects additions past the item cap, allows in-place updates', () => {
    const { kit } = createKit();
    let last = '';
    for (let index = 0; index < 500; index += 1) {
      last = kit.saveSnippet({ name: `s${index}`, text: 'x' }).id;
    }

    expect(() => kit.saveSnippet({ name: 'overflow', text: 'x' })).toThrow();
    // Updating an existing item is not an addition.
    expect(() => kit.saveSnippet({ id: last, name: 'renamed', text: 'x' })).not.toThrow();
  });

  it('splits an oversized recorded paste into loadable steps', async () => {
    const { kit, host } = createKit();
    const big = 'א'.repeat(150_000);

    kit.startRecording();
    await host.typePaste(big);
    const recording = kit.stopRecording('paste');

    expect(recording).not.toBeNull();
    expect(recording!.steps.length).toBe(2);
    expect(recording!.steps.every((step) => step.type === 'insert-text' && step.text.length <= 100_000)).toBe(true);
    // The exact text survives the split.
    expect(recording!.steps.map((step) => (step.type === 'insert-text' ? step.text : '')).join('')).toBe(big);
  });
});

describe('MacroKit — atomic import validation', () => {
  it('rejects an import whose shortcut breaks the binding rules, untouched state', () => {
    const { kit } = createKit();
    kit.saveSnippet({ name: 'קיים', text: 'x' });

    const bad = JSON.stringify({
      version: 1,
      scripts: [],
      recordings: [],
      snippets: [{ id: 'n1', name: 'חדש', text: 'y', shortcut: 'a' }],
    });

    const outcome = kit.importState(bad, { merge: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('חדש');
    expect(kit.listSnippets()).toHaveLength(1);
  });

  it('rejects unmappable keys the manual path rejects — Ctrl+Tab, Alt+Enter', () => {
    const { kit } = createKit();
    for (const shortcut of ['Ctrl+Tab', 'Alt+Enter']) {
      const file = JSON.stringify({
        version: 1,
        scripts: [],
        recordings: [],
        snippets: [{ id: 'n1', name: 'עוקף', text: 'y', shortcut }],
      });
      const outcome = kit.importState(file, { merge: true });
      expect(outcome.ok, shortcut).toBe(false);
    }
    expect(kit.listSnippets()).toHaveLength(0);
  });

  it('rejects a reserved or internally-duplicated shortcut in the merged result', () => {
    const kit = new MacroKit({
      host: createFakeHost(),
      storage: createMemoryStorage(),
      runner: 'eval',
      reservedShortcuts: ['Ctrl+S'],
    });
    kit.saveSnippet({ name: 'קיים', text: 'x', shortcut: 'Ctrl+Alt+3' });

    const reserved = JSON.stringify({
      version: 1,
      scripts: [],
      recordings: [],
      snippets: [{ id: 'n1', name: 'שמור-מערכת', text: 'y', shortcut: 'Ctrl+S' }],
    });
    expect(kit.importState(reserved, { merge: true }).ok).toBe(false);

    // The duplicate is against an *existing* item — visible only on the merged result.
    const duplicate = JSON.stringify({
      version: 1,
      scripts: [],
      recordings: [],
      snippets: [{ id: 'n2', name: 'כפול', text: 'y', shortcut: 'Ctrl+Alt+3' }],
    });
    expect(kit.importState(duplicate, { merge: true }).ok).toBe(false);
    expect(kit.listSnippets()).toHaveLength(1);
  });

  it('rejects a merge that would exceed the item cap', () => {
    const { kit } = createKit();
    for (let index = 0; index < 500; index += 1) kit.saveSnippet({ name: `s${index}`, text: 'x' });

    const one = JSON.stringify({
      version: 1,
      scripts: [],
      recordings: [],
      snippets: [{ id: 'extra', name: 'עוד', text: 'y' }],
    });
    const outcome = kit.importState(one, { merge: true });
    expect(outcome.ok).toBe(false);
    expect(kit.listSnippets()).toHaveLength(500);
  });
});

describe('MacroKit — transactional persistence', () => {
  it('a storage failure leaves the in-memory state untouched', () => {
    const host = createFakeHost();
    let accept = true;
    const kit = new MacroKit({
      host,
      runner: 'eval',
      storage: { load: () => null, save: () => accept },
    });

    kit.saveSnippet({ name: 'ראשון', text: 'x' });
    accept = false; // quota exceeded from here on

    expect(() => kit.saveSnippet({ name: 'שני', text: 'y' })).toThrow();
    // Memory and disk still agree: the rejected change is nowhere.
    expect(kit.listSnippets().map((snippet) => snippet.name)).toEqual(['ראשון']);
  });

  it('a bindable-key restriction applies: Enter cannot be a saved binding', () => {
    const { kit } = createKit();
    expect(kit.validateShortcut('Ctrl+Enter').ok).toBe(false);
    expect(kit.validateShortcut('Ctrl+Alt+F5').ok).toBe(true);
  });

  it('an uncapturable payload makes the recording incomplete — saved only with explicit consent', async () => {
    const { kit, host } = createKit();

    kit.startRecording();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await host.uiCommand('bold', cyclic);
    await host.uiCommand('font-size', { value: 'x'.repeat(20_000) }); // an image insert looks like this
    await host.uiCommand('italic', { value: 12 });

    // No silent omission: the save refuses and names the missing commands.
    let thrown: unknown;
    try {
      kit.stopRecording('פקודות');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('bold');
    expect((thrown as Error).message).toContain('font-size');

    // The recording survived the refusal — explicit consent saves it.
    const recording = kit.stopRecording('פקודות', undefined, { allowIncomplete: true });
    expect(recording!.steps).toEqual([{ type: 'command', id: 'italic', payload: { value: 12 } }]);
  });
});

describe('MacroKit — a failed save keeps the recording', () => {
  it('quota failure at stopRecording: the recording survives and a retry saves it', async () => {
    const host = createFakeHost();
    let accept = true;
    const kit = new MacroKit({ host, runner: 'eval', storage: { load: () => null, save: () => accept } });

    kit.startRecording();
    await host.typeText('שלום');
    accept = false; // quota exceeded at the exact wrong moment

    expect(() => kit.stopRecording('חשוב')).toThrow();
    // Not lost: the stopped recording waits for another attempt.
    expect(kit.hasPendingRecording).toBe(true);
    expect(kit.listRecordings()).toHaveLength(0);

    accept = true; // the user freed space
    const saved = kit.stopRecording('חשוב');
    expect(saved!.steps).toEqual([{ type: 'insert-text', text: 'שלום' }]);
    expect(kit.hasPendingRecording).toBe(false);
  });
});

describe('MacroKit — loaded-state shortcut sanitization', () => {
  it('strips stale shortcuts that today’s rules reject, keeps the items', () => {
    const stored = {
      version: 1 as const,
      scripts: [],
      recordings: [],
      snippets: [
        { id: 's1', name: 'לא-ממופה', text: 'x', shortcut: 'Ctrl+Tab' },
        { id: 's2', name: 'שמור-מערכת', text: 'x', shortcut: 'Ctrl+S' },
        { id: 's3', name: 'ראשון', text: 'x', shortcut: 'Ctrl+Alt+4' },
        { id: 's4', name: 'כפול', text: 'x', shortcut: 'Ctrl+Alt+4' },
      ],
    };
    const kit = new MacroKit({
      host: createFakeHost(),
      runner: 'eval',
      reservedShortcuts: ['Ctrl+S'],
      storage: { load: () => JSON.parse(JSON.stringify(stored)), save: () => true },
    });

    const shortcuts = kit.listSnippets().map((snippet) => snippet.shortcut);
    expect(shortcuts).toEqual([undefined, undefined, 'Ctrl+Alt+4', undefined]);
    expect(kit.listSnippets()).toHaveLength(4); // the items themselves survive
  });
});

describe('MacroKit — snippet insertion during recording', () => {
  it('a snippet expanded from a button/shortcut is recorded and replays', async () => {
    const { kit, host } = createKit();
    const snippet = kit.saveSnippet({ name: 'ברכה', text: 'בעזרת השם' });

    kit.startRecording();
    await host.typeText('פתיח: ');
    await kit.expandSnippet(snippet.id);
    const recording = kit.stopRecording('עם קטע');

    expect(host.text).toBe('פתיח: בעזרת השם');
    expect(recording!.steps).toEqual([{ type: 'insert-text', text: 'פתיח: בעזרת השם' }]);

    host.text = '';
    host.cursor = 0;
    const result = await kit.replayRecording(recording!.id);
    expect(result.ok).toBe(true);
    expect(host.text).toBe('פתיח: בעזרת השם');
  });
});

describe('MacroKit — auto-text during recording', () => {
  it('records the expanded text, not the raw trigger', async () => {
    const { kit, host } = createKit();
    kit.saveSnippet({ name: 'בס"ד', text: 'בס"ד', trigger: 'בסד' });
    kit.enableAutoText();

    kit.startRecording();
    await host.typeText('בסד ');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recording = kit.stopRecording('עם הרחבה');

    expect(host.text).toBe('בס"ד ');
    expect(recording!.steps).toEqual([{ type: 'insert-text', text: 'בס"ד ' }]);

    // Replay reproduces the document exactly, with auto-text out of the loop.
    host.text = '';
    host.cursor = 0;
    const result = await kit.replayRecording(recording!.id);
    expect(result.ok).toBe(true);
    expect(host.text).toBe('בס"ד ');
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
