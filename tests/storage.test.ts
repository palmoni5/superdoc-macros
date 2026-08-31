/**
 * Import validation: exports travel between users as files, so every field
 * is bounded and one bad item rejects the whole document.
 */
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, parsePersistedState, emptyState } from '../src/storage.js';

function stateWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...emptyState(), ...overrides });
}

const validSnippet = { id: 's1', name: 'a', text: 'b', trigger: 'ab' };
const validRecording = {
  version: 1,
  id: 'r1',
  name: 'intro',
  steps: [
    { type: 'insert-text', text: 'שלום' },
    { type: 'command', id: 'bold' },
    { type: 'delete-backward', count: 2 },
  ],
};

describe('parsePersistedState', () => {
  it('accepts a full valid document', () => {
    const parsed = parsePersistedState(
      stateWith({
        snippets: [validSnippet],
        recordings: [validRecording],
        scripts: [{ id: 'c1', name: 'x', source: 'return 1', shortcut: 'Ctrl+Alt+1' }],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.recordings[0]!.steps).toHaveLength(3);
  });

  it('rejects an oversized file outright', () => {
    const huge = ' '.repeat(IMPORT_LIMITS.maxJsonLength + 1);
    expect(parsePersistedState(huge)).toBeNull();
  });

  it('rejects a step of an unknown type', () => {
    const bad = { ...validRecording, steps: [{ type: 'run-shell', command: 'rm -rf' }] };
    expect(parsePersistedState(stateWith({ recordings: [bad] }))).toBeNull();
  });

  it('rejects an invalid delete count', () => {
    const bad = { ...validRecording, steps: [{ type: 'delete-backward', count: -5 }] };
    expect(parsePersistedState(stateWith({ recordings: [bad] }))).toBeNull();
    const notInt = { ...validRecording, steps: [{ type: 'delete-backward', count: 1.5 }] };
    expect(parsePersistedState(stateWith({ recordings: [notInt] }))).toBeNull();
  });

  it('rejects an item with a missing or oversized field', () => {
    expect(parsePersistedState(stateWith({ snippets: [{ id: 's1', text: 'b' }] }))).toBeNull();
    const longName = { ...validSnippet, name: 'x'.repeat(IMPORT_LIMITS.maxNameLength + 1) };
    expect(parsePersistedState(stateWith({ snippets: [longName] }))).toBeNull();
    const longSource = { id: 'c', name: 'x', source: 'x'.repeat(IMPORT_LIMITS.maxSourceLength + 1) };
    expect(parsePersistedState(stateWith({ scripts: [longSource] }))).toBeNull();
  });

  it('rejects too many items or steps', () => {
    const many = Array.from({ length: IMPORT_LIMITS.maxItems + 1 }, (_v, i) => ({ ...validSnippet, id: `s${i}` }));
    expect(parsePersistedState(stateWith({ snippets: many }))).toBeNull();

    const longRecording = {
      ...validRecording,
      steps: Array.from({ length: IMPORT_LIMITS.maxStepsPerRecording + 1 }, () => ({ type: 'insert-paragraph' })),
    };
    expect(parsePersistedState(stateWith({ recordings: [longRecording] }))).toBeNull();
  });

  it('one invalid item rejects the whole document — no partial import', () => {
    const parsed = parsePersistedState(
      stateWith({ snippets: [validSnippet, { id: 'bad' }] }),
    );
    expect(parsed).toBeNull();
  });
});
