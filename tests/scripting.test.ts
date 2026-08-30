import { describe, expect, it } from 'vitest';
import { createMacroApi } from '../src/scripting/macro-api.js';
import { createEvalRunner } from '../src/scripting/eval-runner.js';
import { createFakeHost } from './fake-host.js';

describe('macro api', () => {
  it('מריץ פקודות דרך המארח', async () => {
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

  it('סוכר זורק על כשל פקודה, command גולמית אינה זורקת', async () => {
    const host = createFakeHost();
    host.failCommands.add('bold');
    const { api } = createMacroApi(host);

    await expect(api.bold()).rejects.toThrow('bold');
    const outcome = await api.command('bold');
    expect(outcome.ok).toBe(false);
  });

  it('insertText ו-replaceAll פועלים על המסמך', async () => {
    const host = createFakeHost();
    const { api } = createMacroApi(host);

    await api.insertText('שלום שלום');
    const replaced = await api.replaceAll('שלום', 'להתראות');

    expect(replaced).toBe(2);
    expect(host.text).toBe('להתראות להתראות');
  });

  it('call מנתב לפי שם ודוחה מתודה זרה', async () => {
    const host = createFakeHost();
    const bridge = createMacroApi(host);

    await bridge.call('insertText', ['אבג']);
    expect(host.text).toBe('אבג');
    expect(bridge.callCount()).toBe(1);

    await expect(bridge.call('hasOwnProperty', [])).rejects.toThrow('מתודה לא מוכרת');
    await expect(bridge.call('constructor', [])).rejects.toThrow('מתודה לא מוכרת');
  });
});

describe('eval runner', () => {
  const runner = createEvalRunner();

  it('מריץ סקריפט שקורא ל-API ומחזיר ערך', async () => {
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

  it('שגיאת תחביר חוזרת ככשל ולא כזריקה', async () => {
    const host = createFakeHost();
    const result = await runner.run('this is not js {{{', createMacroApi(host));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('שגיאת תחביר');
  });

  it('שגיאת ריצה של הסקריפט חוזרת ככשל', async () => {
    const host = createFakeHost();
    const result = await runner.run('throw new Error("נשבר")', createMacroApi(host));
    expect(result).toEqual({ ok: false, reason: 'error', message: 'נשבר' });
  });

  it('אוכף תקרת קריאות API', async () => {
    const host = createFakeHost();
    const result = await runner.run(
      `for (let i = 0; i < 100; i += 1) await api.insertText('x');`,
      createMacroApi(host),
      { maxApiCalls: 10 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('תקרת הקריאות');
    expect(host.text.length).toBe(10);
  });

  it('עוצר בתום תקרת הזמן', async () => {
    const host = createFakeHost();
    const result = await runner.run(
      `await new Promise((resolve) => setTimeout(resolve, 5000));`,
      createMacroApi(host),
      { timeoutMs: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
  });
});
