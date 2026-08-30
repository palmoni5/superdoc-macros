# otzaria-macros

ערכת מאקרו לעורכים מבוססי **SuperDoc v2** — נבנתה עבור [otzaria-word-editor](https://github.com/Y-PLONI/otzaria-word-editor), אך אינה תלויה בו (ואף לא בחבילת superdoc עצמה: החיבור למנוע מבני, דרך המשטחים הציבוריים שלו).

שלוש יכולות, בדומה למאקרו של Word:

| יכולת | מה זה נותן |
| --- | --- |
| **סקריפטים** | מאקרו כתובים ב-JavaScript שרצים בארגז חול (iframe מבודד) מול API מצומצם ובטוח של המסמך |
| **מקליט מאקרו** | "הקלט → עשה פעולות → עצור → נגן" — מקליט פקודות והקלדה, כמו המקליט של Word |
| **קטעי טקסט (Snippets)** | תבניות עם משתנים (`{{date}}`, `{{selection}}`…), קיצורי מקלדת, והשלמה אוטומטית בהקלדה (הקלדת `בסד` + רווח ← `בס"ד`) |

בנוסף: שמירה מתמשכת (localStorage או אחסון מותאם), ייבוא/ייצוא JSON, וקישור קיצורי מקלדת.

> **הערה על VBA:** החבילה אינה מריצה מאקרו VBA מתוך קובצי `.docm` — אין מנוע VBA בדפדפן. היא נותנת מערכת מאקרו מקבילה, מבוססת JavaScript, שמתאימה לעורך רץ-בדפדפן.

## התקנה

```bash
npm install otzaria-macros
```

או ישירות מגיטהאב (עד הפרסום ב-npm):

```bash
npm install github:palmoni5/otzaria-macros
```

## התחלה מהירה (עם SuperDoc)

```ts
import { MacroKit, createSuperdocHost } from 'otzaria-macros';

// superdoc — מופע SuperDoc מוכן (אחרי onReady); container — האלמנט שהמסמך מרונדר בו.
const host = createSuperdocHost({ superdoc, container });
const kit = new MacroKit({ host });

// קיצורי מקלדת לכל מה ששמור, והשלמה אוטומטית:
const unbindKeys = kit.attachShortcuts(container);
const disableAutoText = kit.enableAutoText();

// בהחלפת מסמך / פירוק:
unbindKeys();
disableAutoText();
host.dispose();
```

## 1. מאקרו כתובים (סקריפטים)

סקריפט מקבל אובייקט `api` וכל המתודות שלו א-סינכרוניות:

```ts
kit.saveScript({
  name: 'כותרת דבר תורה',
  shortcut: 'Ctrl+Alt+D',
  source: `
    await api.bold();
    await api.insertText('בעניין ');
    const selected = await api.getSelectionText();
    if (selected) await api.insertText(selected);
    await api.bold();
    await api.insertParagraph();
  `,
});

const result = await kit.runScript(kit.listScripts()[0].id);
if (!result.ok) console.warn(result.message);
```

### ה-API שסקריפט מקבל

| מתודה | תיאור |
| --- | --- |
| `api.command(id, payload?)` | כל פקודה מקטלוג SuperDoc (`'text-align'`, `'font-size'`…). מחזירה `{ok}` ואינה זורקת |
| `api.hasCommand(id)` / `api.commandIds()` | בירור יכולות |
| `api.insertText(text)` / `api.insertParagraph()` | הכנסה במיקום הסמן |
| `api.deleteBackward(count?)` | מחיקה לאחור |
| `api.getSelection()` / `api.getSelectionText()` | הבחירה הנוכחית |
| `api.getDocumentText()` | הטקסט המלא |
| `api.replaceAll(find, replace)` | החלפה גורפת; מחזירה כמה הוחלפו |
| `api.bold()` / `italic()` / `underline()` / `bulletList()` / `directionRtl()` … | סוכר לפקודות נפוצות — זורקות בכשל, כדי שהסקריפט ייעצר |
| `api.log(...)` | יומן ריצה (מגיע ל-`onLog` של ה-Kit) |

### אבטחה

ברירת המחדל היא **ארגז חול אמיתי**: הסקריפט רץ ב-iframe עם `sandbox="allow-scripts"` בלבד — origin אטום, בלי גישה ל-DOM של האפליקציה, ל-localStorage, ל-cookies או לרשת עם אישורי המשתמש. הדרך היחידה שלו לגעת במסמך היא ה-API שלמעלה, עם תקרת זמן (ברירת מחדל 30 שניות — נאכפת גם על לולאה אינסופית, ע"י הסרת ה-iframe) ותקרת קריאות (10,000).

מי שחייב לוותר על הבידוד (למשל CSP שחוסם `srcdoc`) יכול לעבור למריץ ישיר: `new MacroKit({ host, runner: 'eval' })` — ראו האזהרות בקוד.

## 2. מקליט מאקרו

```ts
kit.startRecording();
// המשתמש עובד רגיל: מקליד, מדגיש, ממספר...
const recording = kit.stopRecording('פתיח סטנדרטי', 'Ctrl+Alt+1');

// מאוחר יותר, מכל מקום במסמך:
await kit.replayRecording(recording.id);
```

המקליט מתעד **פקודות והקלדה**, לא מיקומי סמן — בדיוק כמו המקליט של Word: הניגון חל במקום שבו הסמן עומד. הקשות רצופות מתלכדות לצעד אחד, `undo`/`redo` אינם מוקלטים (ניתן לשינוי ב-`RecorderOptions`), וההקלטה נשמרת כ-JSON נקי שאפשר לייצא ולשתף.

## 3. קטעי טקסט והשלמה אוטומטית

```ts
kit.saveSnippet({ name: 'בס"ד', text: 'בס"ד', trigger: 'בסד' });
kit.saveSnippet({
  name: 'חתימה',
  text: 'ונשלם בעז"ה, {{date}}',
  shortcut: 'Ctrl+Alt+S',
});
kit.saveSnippet({ name: 'ציטוט', text: '(עיין {{selection}})' });

kit.enableAutoText();          // מעכשיו: הקלדת "בסד" + רווח ⟵ בס"ד
await kit.expandSnippet(id);   // או הרחבה יזומה / דרך הקיצור
```

משתנים מובנים: `{{date}}`, `{{time}}`, `{{datetime}}` (עברית), `{{selection}}`. כל שם אחר נפתר מ-`variables` שנמסרו ל-`expandSnippet`; משתנה ללא ערך נשאר גלוי בטקסט.

## שמירה, ייבוא וייצוא

```ts
import { createLocalStorage } from 'otzaria-macros';

const kit = new MacroKit({ host, storage: createLocalStorage('my-key') });

const json = kit.exportState();       // גיבוי / שיתוף
kit.importState(json, { merge: true });
```

`MacroStorage` הוא ממשק בן שתי מתודות — אפשר לממש שמירה לקובץ (למשל ב-workspace של תוסף אוצריא).

## חיבור למארח אחר

כל הערכה עובדת מול ממשק `MacroHost` אחד (פקודות, הכנסת טקסט, בחירה, החלפה, אירועי הקלדה). `createSuperdocHost` הוא המימוש ל-SuperDoc v2 במצב `ui: false`; עורך אחר מתחבר במימוש משלו של הממשק — ראו `src/types.ts` ואת הכפיל ב-`tests/fake-host.ts`.

## מגבלות ידועות

- אין הרצת VBA. קובצי `.docm` נפתחים כרגיל אבל המאקרו שבהם אינו מורץ.
- המקליט אינו מתעד תנועת סמן ובחירה בעכבר (כמו ב-Word — הניגון פועל מהסמן הנוכחי).
- `deleteBackward` וטקסט-מלא-של-המסמך משתמשים ב-view הפנימי של המנוע (ProseMirror) — זמינים בדפדפן, לא ב-headless.
- תקרת הזמן במריץ `eval` אינה עוצרת לולאה סינכרונית אינסופית (במריץ ה-iframe — כן).

## פיתוח

```bash
npm install
npm test        # vitest — 43 בדיקות
npm run build   # tsc ⟵ dist/
```

## רישיון

MIT
