/**
 * Localization: the default strings are English, and a host can swap them.
 * The locale is module-global, so the Hebrew test restores English after
 * itself — leaking a locale would fail unrelated assertions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ENGLISH_MESSAGES, HEBREW_MESSAGES, setMacroMessages } from '../src/messages.js';
import { createMacroApi } from '../src/scripting/macro-api.js';
import { MacroKit } from '../src/manager.js';
import { createMemoryStorage } from '../src/storage.js';
import { createFakeHost } from './fake-host.js';

afterEach(() => {
  setMacroMessages(ENGLISH_MESSAGES);
});

describe('setMacroMessages', () => {
  it('defaults to English', async () => {
    const bridge = createMacroApi(createFakeHost());
    await expect(bridge.call('noSuchMethod', [])).rejects.toThrow('Unknown method: noSuchMethod');
  });

  it('swapping to Hebrew localizes runtime failures', async () => {
    setMacroMessages(HEBREW_MESSAGES);

    const bridge = createMacroApi(createFakeHost());
    await expect(bridge.call('noSuchMethod', [])).rejects.toThrow('מתודה לא מוכרת: noSuchMethod');

    const kit = new MacroKit({ host: createFakeHost(), storage: createMemoryStorage(), runner: 'eval' });
    const result = await kit.runScript('no-such-id');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('המאקרו לא נמצא');
  });

  it('accepts a partial override', async () => {
    setMacroMessages({ scriptNotFound: 'gone' });

    const kit = new MacroKit({ host: createFakeHost(), storage: createMemoryStorage(), runner: 'eval' });
    const result = await kit.runScript('no-such-id');
    if (!result.ok) expect(result.message).toBe('gone');

    // Untouched strings keep their current value.
    const bridge = createMacroApi(createFakeHost());
    await expect(bridge.call('noSuchMethod', [])).rejects.toThrow('Unknown method');
  });
});
