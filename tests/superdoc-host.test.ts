/**
 * Tests for the SuperDoc adapter, against a structural engine double — the
 * same surfaces otzaria-word-editor consumes (ui.commands / activeEditor.doc
 * / ui.search / activeEditor.view).
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
  it('runs a command and normalizes a rejected routing', async () => {
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

  it('insertText hands the selection target to the engine', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const outcome = await host.insertText('אבג');

    expect(outcome.ok).toBe(true);
    expect(engine.log).toContain('insert:אבג:targeted');
  });

  it('deleteBackward goes through ProseMirror', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const outcome = await host.deleteBackward(3);

    expect(outcome.ok).toBe(true);
    expect(engine.log).toEqual(expect.arrayContaining(['pm:delete:2-5', 'pm:dispatch']));
  });

  it('replaceAll counts matches and replaces through search', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });
    await host.insertText('שלום עולם שלום');

    const result = await host.replaceAll('שלום', 'להתראות');

    expect(result).toMatchObject({ ok: true, replaced: 2 });
    expect(engine.log).toContain('search:replaceAll');
  });

  it('command observation sees executions from any source, and dispose restores the original', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const seen: string[] = [];
    host.onCommand((id) => seen.push(id));

    // A "UI-driven" execution — directly on the engine, not through the host.
    await engine.ui!.commands!.executeAsync('bold');
    // Notification is deliberately post-success, i.e. async — wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['bold']);

    host.dispose();
    await engine.ui!.commands!.executeAsync('bold');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['bold']);
  });

  it('a command the engine refused is not observed — it must not enter a recording', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const seen: string[] = [];
    host.onCommand((id) => seen.push(id));

    await engine.ui!.commands!.executeAsync('blocked'); // returns false — not routed
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([]);
    host.dispose();
  });

  it('deleteForward goes through ProseMirror and is clamped to the document end', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine });

    const outcome = await host.deleteForward(99);

    expect(outcome.ok).toBe(true);
    // Caret at 5, document size 10 — the deletion clamps to 5-10.
    expect(engine.log).toEqual(expect.arrayContaining(['pm:delete:5-10', 'pm:dispatch']));
  });

  it('a failed selection read blocks insertion — no fallback to end-of-document', async () => {
    const engine = createFakeSuperdoc();
    engine.activeEditor!.doc!.selection = {
      current: async () => {
        throw new Error('engine hiccup');
      },
    };
    const host = createSuperdocHost({ superdoc: engine });

    const outcome = await host.insertText('אבג');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('selection-read-failed');
    expect(engine.log.filter((entry) => entry.startsWith('insert:'))).toEqual([]);
  });

  it('replaceTextBefore verifies and replaces in one transaction', async () => {
    const log: string[] = [];
    let text = 'שלום בסד ';
    const engine: SuperdocLike = {
      activeEditor: {
        view: {
          state: {
            doc: {
              content: { size: text.length },
              textBetween: (from: number, to: number) => text.slice(from, to),
            },
            selection: { from: text.length, empty: true },
            tr: {
              delete: () => undefined,
              insertText: (value: string, from?: number, to?: number) => {
                text = text.slice(0, from) + value + text.slice(to);
                log.push(`replace:${from}-${to}`);
              },
              scrollIntoView: () => undefined,
            },
          },
          dispatch: () => log.push('dispatch'),
        },
      },
    };
    const host = createSuperdocHost({ superdoc: engine });

    const mismatch = await host.replaceTextBefore!('אחר ', 'x');
    expect(mismatch.ok).toBe(false);
    expect(log).toEqual([]);

    const replaced = await host.replaceTextBefore!('בסד ', 'בס"ד ');
    expect(replaced.ok).toBe(true);
    expect(text).toBe('שלום בס"ד ');
    expect(log).toEqual(['replace:5-9', 'dispatch']);
  });

  it('viewFallback: false fails the view-backed operations closed', async () => {
    const engine = createFakeSuperdoc();
    const host = createSuperdocHost({ superdoc: engine, viewFallback: false });

    expect((await host.deleteBackward(1)).ok).toBe(false);
    expect((await host.deleteForward(1)).ok).toBe(false);
    expect(await host.getDocumentText()).toBe('');
    // The Document API path still works — only the escape hatch is closed.
    expect((await host.insertText('א')).ok).toBe(true);
  });

  it('fails closed when there is no document', async () => {
    const host = createSuperdocHost({ superdoc: {} });

    expect((await host.commands.execute('bold')).ok).toBe(false);
    expect((await host.insertText('x')).ok).toBe(false);
    expect((await host.deleteBackward(1)).ok).toBe(false);
    expect(await host.getDocumentText()).toBe('');
    expect((await host.getSelection()).empty).toBe(true);
    expect((await host.replaceAll('א', 'ב')).ok).toBe(false);
  });
});
