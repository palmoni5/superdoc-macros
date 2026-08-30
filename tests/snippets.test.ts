import { describe, expect, it } from 'vitest';
import { renderSnippet, expandSnippet } from '../src/snippets/snippets.js';
import { AutoText } from '../src/snippets/autotext.js';
import { createFakeHost } from './fake-host.js';

describe('renderSnippet', () => {
  const now = new Date(2026, 7, 30, 14, 5);

  it('פותר משתנים מובנים ומותאמים', () => {
    const rendered = renderSnippet('היום {{date}} — {{שם}}', {
      now,
      variables: { שם: 'ראובן' },
    });
    expect(rendered).toBe(`היום ${now.toLocaleDateString('he-IL')} — ראובן`);
  });

  it('משתנה בלי ערך נשאר גלוי בטקסט', () => {
    expect(renderSnippet('שלום {{מי-זה}}', { now })).toBe('שלום {{מי-זה}}');
  });

  it('{{selection}} מקבל את טקסט הבחירה', () => {
    expect(renderSnippet('(עיין {{selection}})', { selectionText: 'ברכות ג.' })).toBe('(עיין ברכות ג.)');
  });
});

describe('expandSnippet', () => {
  it('מכניס את הקטע המורחב במיקום הסמן', async () => {
    const host = createFakeHost();
    await host.typeText('לפני ');

    const outcome = await expandSnippet(host, { text: 'בעזרת השם' });

    expect(outcome.ok).toBe(true);
    expect(host.text).toBe('לפני בעזרת השם');
  });

  it('קורא את הבחירה רק כשהקטע צריך אותה', async () => {
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

  it('מרחיב מילת הפעלה אחרי רווח', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('בסד ');
    // ההרחבה א-סינכרונית — ממתינים לתור המיקרו-משימות.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בס"ד ');
  });

  it('מילה שאינה trigger נשארת כמו שהיא', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('שלום ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('שלום ');
  });

  it('Backspace באמצע המילה מעדכן את הזיהוי', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('בסדר');
    await host.typeBackspace();
    await host.typeText(' ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בס"ד ');
  });

  it('פסקה חדשה מאפסת את החוצץ', async () => {
    const { host } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);

    await host.typeText('בסד\n ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בסד\n ');
  });

  it('detach מפסיק את ההרחבה', async () => {
    const { host, autoText } = setup([{ trigger: 'בסד', text: 'בס"ד' }]);
    autoText.detach();

    await host.typeText('בסד ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.text).toBe('בסד ');
  });
});
