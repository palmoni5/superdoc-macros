import { describe, expect, it } from 'vitest';
import { createMacroApi } from '../src/scripting/macro-api.js';
import { createEvalRunner } from '../src/scripting/eval-runner.js';
import { createFakeHost } from './fake-host.js';

describe('macro api', () => {
  it('runs commands through the host', async () => {
    const host = createFakeHost();
    const { api } = createMacroApi(host);

    await api.bold();
    const outcome = await api.command('text-align', { value: 'center' });

    expect(outcome.ok).toBe(true);
    expect(host.executed).toEqual([
      { id: 'bold', payload: undefined },
      { id: 'text-align', payload: { value: 'center' } },
    ]);
  });

  it('sugar throws on command failure, raw command() does not', async () => {
    const host = createFakeHost();
    host.failCommands.add('bold');
    const { api } = createMacroApi(host);

    await expect(api.bold()).rejects.toThrow('bold');
    const outcome = await api.command('bold');
    expect(outcome.ok).toBe(false);
  });

  it('insertText and replaceAll act on the document', async () => {
    const host = createFakeHost();
    const { api } = createMacroApi(host);

    await api.insertText('שלום שלום');
    const replaced = await api.replaceAll('שלום', 'להתראות');

    expect(replaced).toBe(2);
    expect(host.text).toBe('להתראות להתראות');
  });

  it('call() routes by name and rejects foreign methods', async () => {
    const host = createFakeHost();
    const bridge = createMacroApi(host);

    await bridge.call('insertText', ['אבג']);
    expect(host.text).toBe('אבג');
    expect(bridge.callCount()).toBe(1);

    await expect(bridge.call('hasOwnProperty', [])).rejects.toThrow('Unknown method');
    await expect(bridge.call('constructor', [])).rejects.toThrow('Unknown method');
  });
});

describe('eval runner', () => {
  const runner = createEvalRunner();

  it('runs a script that calls the API and returns a value', async () => {
    const host = createFakeHost();
    const bridge = createMacroApi(host);

    const result = await runner.run(
      `
      await api.insertText('בדיקה ');
      await api.insertText('שנייה');
      return await api.getDocumentText();
      `,
      bridge,
    );

    expect(result).toEqual({ ok: true, value: 'בדיקה שנייה' });
    expect(host.text).toBe('בדיקה שנייה');
  });

  it('a syntax error comes back as a failure, not a throw', async () => {
    const host = createFakeHost();
    const result = await runner.run('this is not js {{{', createMacroApi(host));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Macro syntax error');
  });

  it('a runtime error in the script comes back as a failure', async () => {
    const host = createFakeHost();
    const result = await runner.run('throw new Error("broken")', createMacroApi(host));
    expect(result).toEqual({ ok: false, reason: 'error', message: 'broken' });
  });

  it('enforces the API call cap', async () => {
    const host = createFakeHost();
    const result = await runner.run(
      `for (let i = 0; i < 100; i += 1) await api.insertText('x');`,
      createMacroApi(host),
      { maxApiCalls: 10 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('call limit');
    expect(host.text.length).toBe(10);
  });

  it('stops when the time cap expires', async () => {
    const host = createFakeHost();
    const result = await runner.run(
      `await new Promise((resolve) => setTimeout(resolve, 5000));`,
      createMacroApi(host),
      { timeoutMs: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
  });

  it('a script that keeps running past its timeout can no longer touch the document', async () => {
    const host = createFakeHost();
    // eval cannot stop the script itself — after the timeout it is still
    // alive. The revoked bridge is what keeps it away from the document.
    const result = await runner.run(
      `
      await new Promise((resolve) => setTimeout(resolve, 60));
      await api.insertText('late');
      `,
      createMacroApi(host),
      { timeoutMs: 20 },
    );
    expect(result.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.text).toBe('');
  });
});
