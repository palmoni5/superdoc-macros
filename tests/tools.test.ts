/**
 * Built-in tools: registration, listing, the run guard, persisted shortcuts
 * and their interaction with every other saved binding.
 */
import { describe, expect, it } from 'vitest';
import { MacroKit } from '../src/manager.js';
import { createMemoryStorage } from '../src/storage.js';
import { MacroError } from '../src/scripting/macro-api.js';
import type { MacroOutcome } from '../src/types.js';
import { createFakeHost } from './fake-host.js';

function createKit(host = createFakeHost()) {
  const storage = createMemoryStorage();
  const kit = new MacroKit({ host, storage, runner: 'eval', onLog: () => undefined });
  return { host, storage, kit };
}

const ok = (): MacroOutcome => ({ ok: true });

describe('MacroKit — built-in tools', () => {
  it('registers, lists and runs a tool', async () => {
    const { kit } = createKit();
    let ran = 0;

    kit.registerTool({
      id: 'shulchan.demo',
      name: 'כלי לדוגמה',
      description: 'תיאור',
      run: () => {
        ran += 1;
        return ok();
      },
    });

    expect(kit.listTools()).toEqual([
      { id: 'shulchan.demo', name: 'כלי לדוגמה', description: 'תיאור' },
    ]);

    const result = await kit.runTool('shulchan.demo');
    expect(result).toEqual({ ok: true });
    expect(ran).toBe(1);
  });

  it('refuses a duplicate id and an empty name', () => {
    const { kit } = createKit();
    kit.registerTool({ id: 't', name: 'כלי', run: ok });
    expect(() => kit.registerTool({ id: 't', name: 'אחר', run: ok })).toThrow(MacroError);
    expect(() => kit.registerTool({ id: 't2', name: '', run: ok })).toThrow(MacroError);
  });

  it('reports an unknown tool and a thrown run as failed outcomes', async () => {
    const { kit } = createKit();
    kit.registerTool({
      id: 'boom',
      name: 'נפילה',
      run: () => {
        throw new Error('נשבר');
      },
    });

    const missing = await kit.runTool('אין-כזה');
    expect(missing.ok).toBe(false);

    const thrown = await kit.runTool('boom');
    expect(thrown).toEqual({ ok: false, message: 'נשבר', reason: 'threw' });
  });

  it('refuses to run while recording — same guard as scripts', async () => {
    const { kit } = createKit();
    kit.registerTool({ id: 't', name: 'כלי', run: ok });

    kit.startRecording();
    const result = await kit.runTool('t');
    expect(result.ok).toBe(false);
    kit.cancelRecording();
  });

  it('persists a tool shortcut across reloads and binds only registered tools', () => {
    const storage = createMemoryStorage();
    const first = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    first.registerTool({ id: 't', name: 'כלי', run: ok });
    first.setToolShortcut('t', 'Ctrl+Alt+7');
    expect(first.listTools()[0]?.shortcut).toBe('Ctrl+Alt+7');

    // A new kit without the registration still loads, keeps the stored
    // shortcut for the day the tool returns, and reports it once registered.
    const second = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    expect(second.listTools()).toEqual([]);
    second.registerTool({ id: 't', name: 'כלי', run: ok });
    expect(second.listTools()[0]?.shortcut).toBe('Ctrl+Alt+7');
  });

  it('clears a tool shortcut', () => {
    const { kit } = createKit();
    kit.registerTool({ id: 't', name: 'כלי', run: ok });
    kit.setToolShortcut('t', 'Ctrl+Alt+7');
    kit.setToolShortcut('t', undefined);
    expect(kit.listTools()[0]?.shortcut).toBeUndefined();
  });

  it('rejects a tool shortcut that collides with any other saved binding — and vice versa', () => {
    const { kit } = createKit();
    kit.registerTool({ id: 't', name: 'כלי הצבעה', run: ok });
    kit.saveSnippet({ name: 'בסד', text: 'בס"ד', shortcut: 'Ctrl+Alt+1' });

    expect(() => kit.setToolShortcut('t', 'Ctrl+Alt+1')).toThrow(MacroError);

    kit.setToolShortcut('t', 'Ctrl+Alt+2');
    expect(() => kit.saveScript({ name: 'ס', source: '1', shortcut: 'Ctrl+Alt+2' })).toThrow(
      /כלי הצבעה|Ctrl/,
    );
    expect(kit.validateShortcut('Ctrl+Alt+2').ok).toBe(false);
  });

  it('setToolShortcut refuses an unregistered tool and an invalid shortcut', () => {
    const { kit } = createKit();
    expect(() => kit.setToolShortcut('אין', 'Ctrl+Alt+1')).toThrow(MacroError);
    kit.registerTool({ id: 't', name: 'כלי', run: ok });
    expect(() => kit.setToolShortcut('t', 'X')).toThrow(MacroError);
  });

  it('strips a stored tool shortcut that today\'s rules reject', () => {
    const storage = createMemoryStorage();
    storage.save({
      version: 1,
      scripts: [],
      recordings: [],
      snippets: [{ id: 's', name: 'בסד', text: 'בס"ד', shortcut: 'Ctrl+Alt+3' }],
      // The first entry duplicates the snippet's binding; the second has no modifier.
      toolShortcuts: { dup: 'Ctrl+Alt+3', bare: 'K' },
    });

    const kit = new MacroKit({ host: createFakeHost(), storage, runner: 'eval' });
    kit.registerTool({ id: 'dup', name: 'כפול', run: ok });
    kit.registerTool({ id: 'bare', name: 'חשוף', run: ok });
    expect(kit.listTools().every((tool) => tool.shortcut === undefined)).toBe(true);
  });

  it('export/import round-trips tool shortcuts', () => {
    const { kit } = createKit();
    kit.registerTool({ id: 't', name: 'כלי', run: ok });
    kit.setToolShortcut('t', 'Ctrl+Alt+9');
    const exported = kit.exportState();

    const { kit: other } = createKit();
    other.registerTool({ id: 't', name: 'כלי', run: ok });
    expect(other.importState(exported)).toEqual({ ok: true });
    expect(other.listTools()[0]?.shortcut).toBe('Ctrl+Alt+9');
  });

  it('import rejects a file whose tool shortcut collides with an existing binding', () => {
    const { kit } = createKit();
    kit.registerTool({ id: 't', name: 'כלי', run: ok });
    kit.setToolShortcut('t', 'Ctrl+Alt+9');
    const exported = kit.exportState();

    const { kit: other } = createKit();
    other.saveSnippet({ name: 'בסד', text: 'בס"ד', shortcut: 'Ctrl+Alt+9' });
    // merge: the imported tool shortcut duplicates the snippet's.
    expect(other.importState(exported, { merge: true }).ok).toBe(false);
  });
});
