/**
 * השלמה אוטומטית (AutoText): הקלדת מילת ההפעלה של קטע ואחריה רווח מחליפה את
 * המילה בתוכן הקטע.
 *
 * איך זה עובד: נשמר חוצץ קטן של התווים שהוקלדו ברצף הנוכחי (מתוך אירועי
 * `TextInputEvent` של המארח). כשמוקלד תו הרחבה (רווח כברירת מחדל) והמילה
 * שלפניו היא trigger של קטע — המילה ותו ההרחבה נמחקים לאחור, והתוכן המורחב
 * מוכנס במקומם עם תו ההרחבה בסופו.
 *
 * החוצץ מתאפס על פסקה חדשה, על מחיקה קדימה ועל פקודה שרצה באמצע — כל דבר
 * שמנתק את הרצף בין מה שהוקלד ובין מה שנמצא בפועל לפני הסמן. עדיף פספוס
 * הרחבה על הרחבה שמוחקת טקסט לא נכון.
 */
import type { MacroHost, Snippet, TextInputEvent } from '../types.js';
import { renderSnippet, usesSelection } from './snippets.js';

export interface AutoTextOptions {
  /** תווי ההרחבה. ברירת מחדל: רווח בלבד. */
  expandOn?: readonly string[];
  /** גודל החוצץ. מילת הפעלה ארוכה מזה לא תזוהה. */
  bufferSize?: number;
  /** נקראת אחרי הרחבה מוצלחת. */
  onExpand?: (snippet: Snippet) => void;
  /** נקראת כשהרחבה נכשלה (למשל מסמך לקריאה בלבד). */
  onError?: (message: string) => void;
}

const DEFAULT_BUFFER = 64;

export class AutoText {
  private readonly host: MacroHost;
  private readonly getSnippets: () => readonly Snippet[];
  private readonly expandOn: ReadonlySet<string>;
  private readonly bufferSize: number;
  private readonly onExpand?: (snippet: Snippet) => void;
  private readonly onError?: (message: string) => void;

  private buffer = '';
  private busy = false;
  private disposeCommand: (() => void) | null = null;
  private disposeInput: (() => void) | null = null;

  constructor(host: MacroHost, getSnippets: () => readonly Snippet[], options: AutoTextOptions = {}) {
    this.host = host;
    this.getSnippets = getSnippets;
    this.expandOn = new Set(options.expandOn ?? [' ']);
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER;
    this.onExpand = options.onExpand;
    this.onError = options.onError;
  }

  get attached(): boolean {
    return this.disposeInput !== null;
  }

  attach(): () => void {
    if (this.disposeInput) return () => this.detach();
    this.buffer = '';
    this.disposeInput = this.host.onTextInput((event) => void this.handleInput(event));
    // פקודה באמצע הקלדה (עיצוב, הדבקה) מנתקת את הקשר בין החוצץ למסמך.
    this.disposeCommand = this.host.onCommand(() => {
      if (!this.busy) this.buffer = '';
    });
    return () => this.detach();
  }

  detach(): void {
    this.disposeInput?.();
    this.disposeCommand?.();
    this.disposeInput = null;
    this.disposeCommand = null;
    this.buffer = '';
  }

  private async handleInput(event: TextInputEvent): Promise<void> {
    // קלט שנוצר בזמן שההרחבה עצמה כותבת — לא חלק מההקלדה של המשתמש.
    if (this.busy) return;

    switch (event.kind) {
      case 'insert-paragraph':
      case 'delete-forward':
        this.buffer = '';
        return;
      case 'delete-backward':
        this.buffer = this.buffer.slice(0, -1);
        return;
      case 'insert-text':
        break;
    }

    for (const char of event.text) {
      if (this.expandOn.has(char)) {
        const trigger = trailingWord(this.buffer);
        const snippet = trigger ? this.findByTrigger(trigger) : undefined;
        this.buffer = '';
        if (snippet && trigger) await this.expand(snippet, trigger, char);
        continue;
      }
      this.buffer = (this.buffer + char).slice(-this.bufferSize);
    }
  }

  private findByTrigger(word: string): Snippet | undefined {
    return this.getSnippets().find((snippet) => snippet.trigger === word);
  }

  private async expand(snippet: Snippet, trigger: string, expandChar: string): Promise<void> {
    this.busy = true;
    try {
      // אירוע הקלט (beforeinput) נורה לפני שהתו נכתב למסמך. הדחייה לתור
      // המשימות מבטיחה שתו ההרחבה כבר בפנים לפני שמוחקים אותו יחד עם ה-trigger.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const selectionText = usesSelection(snippet.text)
        ? (await this.host.getSelection({ includeText: true })).text
        : undefined;
      const rendered = renderSnippet(snippet.text, { selectionText });

      // תו ההרחבה כבר נכתב למסמך כשמגיעים לכאן, ולכן הוא נכלל במחיקה ומוחזר בסוף.
      const deleted = await this.host.deleteBackward(trigger.length + 1);
      if (!deleted.ok) {
        this.onError?.(deleted.message);
        return;
      }
      const inserted = await this.host.insertText(rendered + expandChar);
      if (!inserted.ok) {
        this.onError?.(inserted.message);
        return;
      }
      this.onExpand?.(snippet);
    } finally {
      this.busy = false;
    }
  }
}

/** המילה שבסוף החוצץ — רצף שאינו רווח לבן. */
function trailingWord(buffer: string): string | null {
  const match = /(\S+)$/u.exec(buffer);
  return match?.[1] ?? null;
}
