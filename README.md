# superdoc-macros

A macro toolkit for **SuperDoc v2**-based editors. Originally built for [otzaria-word-editor](https://github.com/Y-PLONI/otzaria-word-editor), but fully generic: it has no dependency on that project — nor on the superdoc package itself (the engine is consumed structurally, through its public surfaces), and the core works against any editor that implements a small `MacroHost` interface.

Three capabilities, in the spirit of Word macros:

| Capability | What it gives you |
| --- | --- |
| **Scripted macros** | User-written JavaScript macros that run in a real sandbox (an isolated iframe) against a small, safe document API |
| **Macro recorder** | "Record → work normally → stop → replay" — records commands and typing, like Word's recorder |
| **Snippets (AutoText)** | Templates with variables (`{{date}}`, `{{selection}}`…), keyboard shortcuts, and auto-expansion while typing (type a trigger word + space) |

Plus: persistence (localStorage or custom storage), JSON import/export, keyboard shortcut binding, and localizable runtime messages (English by default, Hebrew locale included).

> **A note on VBA:** the toolkit does not execute VBA macros from `.docm` files — there is no VBA engine in the browser. It provides a parallel, JavaScript-based macro system suited to a browser-hosted editor.

## Installation

```bash
npm install superdoc-macros
```

## Quick start (with SuperDoc)

```ts
import { MacroKit, createSuperdocHost } from 'superdoc-macros';

// superdoc — a ready SuperDoc instance (after onReady); container — the element the document renders in.
const host = createSuperdocHost({ superdoc, container });
const kit = new MacroKit({ host });

// Keyboard shortcuts for everything saved, and auto-text:
const unbindKeys = kit.attachShortcuts(container);
const disableAutoText = kit.enableAutoText();

// On document swap / teardown:
unbindKeys();
disableAutoText();
host.dispose();
```

## 1. Scripted macros

A script receives an `api` object; every method is async:

```ts
kit.saveScript({
  name: 'Heading helper',
  shortcut: 'Ctrl+Alt+D',
  source: `
    await api.bold();
    const selected = await api.getSelectionText();
    if (selected) await api.insertText(selected);
    await api.bold();
    await api.insertParagraph();
  `,
});

const result = await kit.runScript(kit.listScripts()[0].id);
if (!result.ok) console.warn(result.message);
```

### The script API

| Method | Description |
| --- | --- |
| `api.command(id, payload?)` | Any command from the SuperDoc catalog (`'text-align'`, `'font-size'`…). Returns `{ok}`, never throws |
| `api.hasCommand(id)` / `api.commandIds()` | Capability discovery |
| `api.insertText(text)` / `api.insertParagraph()` | Insert at the caret |
| `api.deleteBackward(count?)` | Delete backwards |
| `api.getSelection()` / `api.getSelectionText()` | The current selection |
| `api.getDocumentText()` | The full document text |
| `api.replaceAll(find, replace)` | Replace everywhere; returns the count |
| `api.bold()` / `italic()` / `underline()` / `bulletList()` / `directionRtl()` … | Sugar for common commands — these throw on failure, so the script stops |
| `api.log(...)` | Run log (delivered to the kit's `onLog`) |

### Security

The default is a **real sandbox**: scripts run in an iframe with `sandbox="allow-scripts"` only — an opaque origin, no access to the application's DOM, localStorage, cookies, or credentialed network. The script's only way to touch the document is the API above, with a time cap (default 30 s — enforced even against infinite loops, by removing the iframe) and a call cap (10,000).

If you must waive isolation (e.g. a CSP that blocks `srcdoc`), switch to the direct runner: `new MacroKit({ host, runner: 'eval' })` — see the warnings in the code.

## 2. Macro recorder

```ts
kit.startRecording();
// the user works normally: typing, formatting, lists...
const recording = kit.stopRecording('Standard intro', 'Ctrl+Alt+1');

// later, from anywhere in the document:
await kit.replayRecording(recording.id);
```

The recorder captures **commands and typing**, not caret positions — exactly like Word's recorder: replay applies wherever the caret stands. Consecutive keystrokes coalesce into one step, `undo`/`redo` are not recorded (configurable via `RecorderOptions`), and recordings persist as clean JSON that can be exported and shared. `updateRecording({id, name?, shortcut?})` renames a recording or edits its shortcut.

## 3. Snippets and auto-text

```ts
kit.saveSnippet({ name: 'BSD', text: 'בס"ד', trigger: 'בסד' });
kit.saveSnippet({
  name: 'Signature',
  text: 'Best regards, {{date}}',
  shortcut: 'Ctrl+Alt+S',
});
kit.saveSnippet({ name: 'Citation', text: '(see {{selection}})' });

kit.enableAutoText();          // from now on: typing the trigger + space expands it
await kit.expandSnippet(id);   // or expand explicitly / via the shortcut
```

Built-in variables: `{{date}}`, `{{time}}`, `{{datetime}}` (formatted with the browser locale, or an explicit `locale` option), `{{selection}}`. Any other name resolves from the `variables` passed to `expandSnippet`; a variable with no value stays visible in the text.

## Localization

Runtime messages (failures shown to end users) default to English. A host with a localized UI swaps them once at startup:

```ts
import { setMacroMessages, HEBREW_MESSAGES } from 'superdoc-macros';

setMacroMessages(HEBREW_MESSAGES);          // full Hebrew locale (included)
setMacroMessages({ scriptNotFound: '…' });  // or a partial override
```

## Persistence, import and export

```ts
import { createLocalStorage } from 'superdoc-macros';

const kit = new MacroKit({ host, storage: createLocalStorage('my-key') });

const json = kit.exportState();       // backup / sharing
kit.importState(json, { merge: true });
```

`MacroStorage` is a two-method interface — implement it to persist to a file (e.g. a plugin workspace).

## Connecting a different host

The whole toolkit works against a single `MacroHost` interface (commands, text insertion, selection, replace, typing events). `createSuperdocHost` is the implementation for SuperDoc v2 in `ui: false` mode; another editor plugs in with its own implementation — see `src/types.ts` and the double in `tests/fake-host.ts`.

## Known limitations

- No VBA execution. `.docm` files open normally but their macros are not run.
- The recorder does not capture caret movement or mouse selection (as in Word — replay acts from the current caret).
- `deleteBackward` and full-document text use the engine's internal view (ProseMirror) — available in the browser, not headless.
- The `eval` runner's time cap cannot stop an infinite synchronous loop (the iframe runner's can).

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc → dist/
```

**Releasing:** bump `version` in package.json and push to main — the workflow (.github/workflows/release.yml) publishes to npm and creates a GitHub Release automatically.

## License

MIT
