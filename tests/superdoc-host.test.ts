/**
 * בדיקות למתאם SuperDoc עם כפיל מבני של המנוע — אותם משטחים ש-otzaria-word-editor
 * צורך (ui.commands / activeEditor.doc / ui.search / activeEditor.view).
 */
import { describe, expect, it } from 'vitest';
import { createSuperdocHost, type SuperdocLike } from '../src/host/superdoc-host.js';

interface FakeEngine extends SuperdocLike {
  log: string[];
}

function createFakeSuperdoc(): FakeEngine {
  const log: string[] = [];
  let text = '';

  const engine: FakeEngine = {
    log,
    ui: {
      commands: {
        has: (id) => id === 'bold' || id === 'blocked',
        get: () => ({ getState: () => ({ reason: 'selection-required' }) }),
        async executeAsync(id: string) {
          log.push(`exec:${id}`);
          if (id === 'blocked') return false;
          return { success: true };
        },
      },
      search: {
        getSnapshot: () => ({ available: true, total: 0, query: '' }),
        search: (query: string) => ({
          available: true,
          total: text.split(query).length - 1,
          query,
        }),
        clear: () => log.push('search:clear'),
        async replaceAll(replacement: string) {
          text = text.split('שלום').join(replacement);
          log.push('search:replaceAll');
          return { ok: true };
        },
      },
    },
    activeEditor: {
      doc: {
        async insert(input) {
          text += input.value;
          log.push(`insert:${input.value}${input.target ? ':targeted' : ''}`);
          return { success: true };
        },
        selection: {
          current: async () => ({
            empty: false,
            text: 'מסומן',
            target: { segments: [{ blockId: 'b1', range: { start: 0, end: 5 } }] },
            selectionTarget: { kind: 'selection', start: {}, end: {} },
          }),
        },
      },
      view: {
        state: {
          doc: {
            content: { size: 10 },
            textBetween: () => text,
          },
          selection: { from: 5, empty: true },
          tr: {
            delete: (from: number, to: number) => log.push(`pm:delete:${from}-${to}`),
            insertText: (value: string) => log.push(`pm:insert:${value}`),
            scrollIntoView: () => undefined,
          },
        },
        dispatch: () => log.push('pm:dispatch'),
      },
    },
  };
  return engine;
}

describe('createSuperdocHost', () => {
  it('מריץ פקודה ומנרמל ניתוב שנדחה', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    expect((await host.commands.execute('bold')).ok).toBe(true);

    const blocked = await host.commands.execute('blocked');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('selection-required');

    const unknown = await host.commands.execute('no-such');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('unknown-command');
  });

  it('insertText מוסר את יעד הבחירה למנוע', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const outcome = await host.insertText('אבג');

    expect(outcome.ok).toBe(true);
    expect(engine.log).toContain('insert:אבג:targeted');
  });

  it('deleteBackward עובר דרך ProseMirror', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const outcome = await host.deleteBackward(3);

    expect(outcome.ok).toBe(true);
    expect(engine.log).toEqual(expect.arrayContaining(['pm:delete:2-5', 'pm:dispatch']));
  });

  it('replaceAll סופר התאמות ומחליף דרך החיפוש', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });
    await host.insertText('שלום עולם שלום');

    const result = await host.replaceAll('שלום', 'להתראות');

    expect(result).toMatchObject({ ok: true, replaced: 2 });
    expect(engine.log).toContain('search:replaceAll');
  });

  it('תצפית הפקודות רואה הרצות מכל מקור ו-dispose מחזיר את המקור', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const seen: string[] = [];
    host.onCommand((id) => seen.push(id));

    // הרצה "מהממשק" — ישירות על המנוע, לא דרך המארח.
    await engine.ui!.commands!.executeAsync('bold');
    expect(seen).toEqual(['bold']);

    host.dispose();
    await engine.ui!.commands!.executeAsync('bold');
    expect(seen).toEqual(['bold']);
  });

  it('נכשל סגור כשאין מסמך', async () => {
    const host = createSuperdocHost({ superdoc: {} });

    expect((await host.commands.execute('bold')).ok).toBe(false);
    expect((await host.insertText('x')).ok).toBe(false);
    expect((await host.deleteBackward(1)).ok).toBe(false);
    expect(await host.getDocumentText()).toBe('');
    expect((await host.getSelection()).empty).toBe(true);
    expect((await host.replaceAll('א', 'ב')).ok).toBe(false);
  });
});
