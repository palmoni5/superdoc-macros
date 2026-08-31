import { describe, expect, it } from 'vitest';
import { bindShortcuts, eventMatches, parseShortcut, type ShortcutTarget } from '../src/shortcuts.js';

function keyEvent(
  overrides: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>,
) {
  return {
    key: 'a',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    prevented: false,
    preventDefault(): void {
      this.prevented = true;
    },
    stopPropagation(): void {
      /* test stub */
    },
    ...overrides,
  };
}

describe('parseShortcut + eventMatches', () => {
  it('matches a full shortcut and rejects partial ones', () => {
    const parsed = parseShortcut('Ctrl+Alt+M');
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(eventMatches(parsed, keyEvent({ key: 'M', ctrlKey: true, altKey: true }))).toBe(true);
    expect(eventMatches(parsed, keyEvent({ key: 'm', ctrlKey: true }))).toBe(false);
    expect(eventMatches(parsed, keyEvent({ key: 'm', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it('Mod accepts both Ctrl and Meta', () => {
    const parsed = parseShortcut('Mod+K');
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(eventMatches(parsed, keyEvent({ key: 'k', ctrlKey: true }))).toBe(true);
    expect(eventMatches(parsed, keyEvent({ key: 'k', metaKey: true }))).toBe(true);
    expect(eventMatches(parsed, keyEvent({ key: 'k' }))).toBe(false);
  });

  it('an invalid shortcut returns null', () => {
    expect(parseShortcut('')).toBeNull();
    expect(parseShortcut('Ctrl+')).toBeNull();
    expect(parseShortcut('A+B')).toBeNull();
  });

  it('matches by physical code — a Hebrew layout reports key ר for KeyR', () => {
    const parsed = parseShortcut('Ctrl+Alt+R')!;

    expect(eventMatches(parsed, keyEvent({ key: 'ר', code: 'KeyR', ctrlKey: true, altKey: true }))).toBe(true);
    // The physical key decides: a matching key on the wrong physical key is not a match.
    expect(eventMatches(parsed, keyEvent({ key: 'r', code: 'KeyT', ctrlKey: true, altKey: true }))).toBe(false);
    // Hosts that report no code fall back to the key.
    expect(eventMatches(parsed, keyEvent({ key: 'R', ctrlKey: true, altKey: true }))).toBe(true);
  });
});

describe('bindShortcuts', () => {
  it('runs the first matching action and swallows the event', () => {
    const captured: { keydown: ((event: unknown) => void) | null } = { keydown: null };
    const target: ShortcutTarget = {
      addEventListener: (_type, listener) => {
        captured.keydown = listener as (event: unknown) => void;
      },
      removeEventListener: () => {
        captured.keydown = null;
      },
    };

    const runs: string[] = [];
    const unbind = bindShortcuts(target, () => [
      { shortcut: 'Ctrl+1', run: () => void runs.push('first') },
      { shortcut: 'Ctrl+2', run: () => void runs.push('second') },
    ]);

    const event = keyEvent({ key: '2', ctrlKey: true });
    captured.keydown?.(event);

    expect(runs).toEqual(['second']);
    expect(event.prevented).toBe(true);

    unbind();
    expect(captured.keydown).toBeNull();
  });

  it('auto-repeat and IME composition do not fire bindings', () => {
    const captured: { keydown: ((event: unknown) => void) | null } = { keydown: null };
    const target: ShortcutTarget = {
      addEventListener: (_type, listener) => {
        captured.keydown = listener as (event: unknown) => void;
      },
      removeEventListener: () => undefined,
    };

    const runs: string[] = [];
    bindShortcuts(target, () => [{ shortcut: 'Ctrl+1', run: () => void runs.push('ran') }]);

    captured.keydown?.({ ...keyEvent({ key: '1', ctrlKey: true }), repeat: true });
    captured.keydown?.({ ...keyEvent({ key: '1', ctrlKey: true }), isComposing: true });
    expect(runs).toEqual([]);

    captured.keydown?.(keyEvent({ key: '1', ctrlKey: true }));
    expect(runs).toEqual(['ran']);
  });
});
