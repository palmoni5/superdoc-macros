import { describe, expect, it } from 'vitest';
import { renderSnippet, expandSnippet } from '../src/snippets/snippets.js';
import { AutoText } from '../src/snippets/autotext.js';
import { createFakeHost } from './fake-host.js';

describe('renderSnippet', () => {
  const now = new Date(2026, 7, 30, 14, 5);

  it('resolves built-in and custom variables', () => {
    const rendered = renderSnippet('היום {{date}} — {{שם}}', {
      now,
      variables: { שם: 'ראובן' },
    });
    expect(rendered).toBe(`היום ${now.toLocaleDateString()} — ראובן`);
  });

  it('formats dates with an explicit locale when given', () => {
    expect(renderSnippet('{{date}}', { now, locale: 'he-IL' })).toBe(
      now.toLocaleDateString('he-IL'),
    );
  });

  it('a variable with no value stays visible in the text', () => {
    expect(renderSnippet('שלום {{מי-זה}}', { now })).toBe('שלום {{מי-זה}}');
  });

  it('{{selection}} receives the selection text', () => {
    expect(renderSnippet('(עיין {{selection}})', { selectionText: 'ברכות ג.' })).toBe('(עיין ברכות ג.)');
  });
});

describe('expandSnippet', () => {
  it('inserts the rendered snippet at the caret', async () => {
    const host = createFakeHost();
    await host.typeText('לפני ');

    const outcome = await expandSnippet(host, { text: 'בעזרת השם' });

    expect(outcome.ok).toBe(true);
    expect(host.text).toBe('לפני בעזרת השם');
  });

  it('reads the selection only when the snippet needs it', async () => {
    const host = createFakeHost();
    await host.typeText('דברי המחבר');
    host.selection = { from: 0, to: 4 };

    await expandSnippet(host, { text: ' — וכן כתב {{selection}}' });

    expect(host.text).toBe(' — וכן כתב דברי המחבר');
  });
});

describe('AutoText', () => {
  function setup(snippets: Array<{ trigger: string; text: string }>) {
    const host = createFakeHost();
    const autoText = new AutoText(
      host,
      () =>
        snippets.map((snippet, index) => ({
          id: `snippet-${index}`,
          name: snippet.trigger,
          text: snippet.text,
          trigger: snippet.trigger,
        })),
    );
    autoText.attach();
    return { host, autoText };
  }

  it('expands a trigger word after a space', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('בסד ');
    // Expansion is async — wait for the task queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בס"ד ');
  });

  it('a word that is not a trigger stays as typed', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('שלום ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('שלום ');
  });

  it('Backspace mid-word updates recognition', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('בסדר');
    await host.typeBackspace();
    await host.typeText(' ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בס"ד ');
  });

  it('a new paragraph resets the buffer', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('בסד\n ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בסד\n ');
  });

  it('detach stops expansion', async () => {
    const { host, autoText } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);
    autoText.detach();

    await host.typeText('בסד ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בסד ');
  });
});
