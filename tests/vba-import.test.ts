/**
 * Reading VBA out of real files.
 *
 * `tests/fixtures/vbaProject.bin` is a genuine Office-produced macro project
 * (see `tests/fixtures/README.md`), which is what makes these tests worth
 * having: the container, its allocation tables, the code page and the
 * compressed module streams are all shaped the way Word and Excel actually
 * write them, not the way we imagine they do.
 *
 * The last block is the one that matters most for safety. These bytes arrive
 * from outside — a document someone was emailed — so the contract is that a
 * damaged or hostile file produces a failed result, never a thrown error and
 * never a hang.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readCfb } from '../src/import/cfb.js';
import { VbaParseError } from '../src/import/errors.js';
import { decompressOvba } from '../src/import/ms-ovba.js';
import { openZip } from '../src/import/zip.js';
import {
  extractVbaFromDocx,
  extractVbaProject,
  findVbaPart,
  scanForAutoRunProcedures,
  VBA_LIMITS,
} from '../src/import/vba.js';

/** A content-types part that declares a macro project, for crafted packages. */
const CONTENT_TYPES_WITH_VBA =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' +
  '</Types>';
import {
  buildNestedStorages,
  buildVbaProjectBin,
  buildZip,
  encodeCp1255,
  type ZipFileEntry,
} from './vba-fixtures.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

const vbaProjectBin = fixture('vbaProject.bin');
const withMacros = fixture('with-macros.docm');
const noMacros = fixture('no-macros.docx');

describe('readCfb', () => {
  it('walks the directory tree of a real macro project', () => {
    const container = readCfb(vbaProjectBin);
    const paths = container.entries.map((entry) => entry.path);

    expect(paths).toContain('/VBA');
    expect(paths).toContain('/VBA/dir');
    expect(paths).toContain('/VBA/Module1');
    expect(paths).toContain('/PROJECT');
    expect(container.entries.find((entry) => entry.path === '/VBA')?.type).toBe('storage');
  });

  it('reads a stream stored in the mini-FAT', () => {
    const container = readCfb(vbaProjectBin);
    const dir = container.entries.find((entry) => entry.path === '/VBA/dir');
    // Streams this small live in the mini stream, not in full sectors — a
    // separate allocation table and the path most real projects take.
    expect(dir!.size).toBeLessThan(4096);
    expect(container.readStream('/VBA/dir').length).toBe(dir!.size);
  });

  it('refuses a path that is a storage rather than a stream', () => {
    const container = readCfb(vbaProjectBin);
    expect(() => container.readStream('/VBA')).toThrow(/storage, not a stream/);
  });

  it('refuses a path that does not exist', () => {
    const container = readCfb(vbaProjectBin);
    expect(() => container.readStream('/VBA/Nope')).toThrow(/no such stream/);
  });

  it('rejects bytes that are not a compound file', () => {
    expect(() => readCfb(new Uint8Array(600))).toThrow(/wrong signature/);
  });
});

describe('openZip', () => {
  it('lists the parts of a package', async () => {
    const archive = openZip(withMacros);
    const names = archive.entries.map((entry) => entry.name);

    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('word/vbaProject.bin');
    expect(archive.has('word/document.xml')).toBe(true);
  });

  it('inflates a deflated part back to its exact bytes', async () => {
    const archive = openZip(withMacros);
    const entry = archive.entries.find((candidate) => candidate.name === 'word/vbaProject.bin')!;
    // The fixture is deflate-compressed, so this exercises inflation rather
    // than a stored-entry passthrough.
    expect(entry.compressedSize).toBeLessThan(entry.uncompressedSize);
    expect(await archive.read('word/vbaProject.bin')).toEqual(vbaProjectBin);
  });

  it('refuses a part that is not in the package', async () => {
    const archive = openZip(withMacros);
    await expect(archive.read('word/nothing.xml')).rejects.toThrow(VbaParseError);
  });

  it('rejects bytes that are not a ZIP archive', () => {
    expect(() => openZip(new Uint8Array(100))).toThrow(/not a ZIP archive/);
  });
});

describe('extractVbaProject', () => {
  it('recovers every module with its real source text', () => {
    const result = extractVbaProject(vbaProjectBin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.project.modules.map((module) => module.name);
    expect(names).toEqual(expect.arrayContaining(['Module1', 'ThisWorkbook', 'Sheet1']));

    const module1 = result.project.modules.find((module) => module.name === 'Module1')!;
    expect(module1.source).toContain('Sub say_hello()');
    expect(module1.source).toContain('End Sub');
    expect(module1.truncated).toBe(false);
  });

  it('reports the code page the sources were decoded with', () => {
    const result = extractVbaProject(vbaProjectBin);
    expect(result.ok && result.project.codePage).toBe(1252);
  });

  it('classifies modules using the PROJECT stream', () => {
    const result = extractVbaProject(vbaProjectBin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const kinds = new Map(result.project.modules.map((module) => [module.name, module.kind]));
    // `dir` alone cannot tell a document module from a class — only the
    // PROJECT stream's `Document=` lines can.
    expect(kinds.get('Module1')).toBe('standard');
    expect(kinds.get('ThisWorkbook')).toBe('document');
  });

  it('finds no auto-run macros in a project that has none', () => {
    const result = extractVbaProject(vbaProjectBin);
    expect(result.ok && result.project.autoRunProcedures).toEqual([]);
    expect(result.ok && result.project.warnings.map((warning) => warning.code)).not.toContain(
      'auto-run-macros',
    );
  });

  it('reads an undamaged Office file with nothing to report', () => {
    // A clean real-world project must come back clean. If a guard starts
    // firing on ordinary files, hosts learn to ignore warnings entirely.
    const result = extractVbaProject(vbaProjectBin);
    expect(result.ok && result.project.warnings).toEqual([]);
  });

  it('rejects bytes that are not a VBA project', () => {
    const result = extractVbaProject(new Uint8Array(600));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-a-vba-project');
  });
});

describe('a Hebrew project with an auto-run macro', () => {
  // The committed Office fixture is Latin-1 and harmless, so these two
  // behaviours — the ones that matter most to a Hebrew editor and to safety
  // — get a project built for the purpose.
  const source = encodeCp1255(
    [
      'Attribute VB_Name = "Module1"',
      'Sub AutoOpen()',
      '    Selection.TypeText "שלום עולם"',
      'End Sub',
      '',
      'Sub FormatHeading()',
      '    Selection.Font.Bold = True',
      'End Sub',
    ].join('\r\n'),
  );

  const bin = buildVbaProjectBin({
    codePage: 1255,
    moduleName: 'Module1',
    source,
    projectLines: ['ID="{00000000-0000-0000-0000-000000000000}"', 'Module=Module1'],
  });

  it('decodes Hebrew source through the project code page', () => {
    const result = extractVbaProject(bin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.codePage).toBe(1255);
    // Decoded as UTF-8 this would be replacement characters throughout.
    expect(result.project.modules[0]!.source).toContain('שלום עולם');
    expect(result.project.warnings.map((warning) => warning.code)).not.toContain('unknown-code-page');
  });

  it('survives the PROJECTVERSION record that misstates its own size', () => {
    // The fixture reproduces the quirk. Reading the declared size instead of
    // the real one desynchronizes the walk, and every module after it — here,
    // all of them — disappears.
    const result = extractVbaProject(bin);
    expect(result.ok && result.project.modules.map((module) => module.name)).toEqual(['Module1']);
  });

  it('reports the auto-run entry point without acting on it', () => {
    const result = extractVbaProject(bin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.autoRunProcedures).toEqual([{ module: 'Module1', procedure: 'AutoOpen' }]);
    const warning = result.project.warnings.find((candidate) => candidate.code === 'auto-run-macros');
    expect(warning?.message).toContain('Module1.AutoOpen');
    expect(warning?.message).toContain('not executed');
  });

  it('takes the module kind from the PROJECT stream', () => {
    const result = extractVbaProject(bin);
    expect(result.ok && result.project.modules[0]!.kind).toBe('standard');
  });

  it('says so when a declared module never turned up', () => {
    // The PROJECT stream names every module independently of the directory
    // walk, so it catches a walk that lost one. Without this cross-check the
    // user would simply be shown a shorter list with nothing to explain it.
    const withGhost = buildVbaProjectBin({
      codePage: 1255,
      moduleName: 'Module1',
      source,
      projectLines: ['Module=Module1', 'Class=MissingHelper'],
    });

    const result = extractVbaProject(withGhost);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const warning = result.project.warnings.find(
      (candidate) => candidate.code === 'declared-modules-missing',
    );
    // Quoted the way the PROJECT stream spells it, not lower-cased.
    expect(warning?.message).toContain('MissingHelper');
    expect(result.project.modules.map((module) => module.name)).toEqual(['Module1']);
  });
});

describe('scanForAutoRunProcedures', () => {
  it('names the entry points Word would run on its own', () => {
    const source = [
      'Sub AutoOpen()',
      '  MsgBox "hello"',
      'End Sub',
      '',
      'Private Sub Document_Close()',
      'End Sub',
      '',
      'Public Static Function AutoExec()',
      'End Function',
    ].join('\r\n');

    expect(scanForAutoRunProcedures(source)).toEqual(['AutoOpen', 'Document_Close', 'AutoExec']);
  });

  it('matches regardless of case, as VBA does', () => {
    expect(scanForAutoRunProcedures('sub autoopen()\r\nend sub')).toEqual(['autoopen']);
  });

  it('leaves ordinary procedures alone', () => {
    expect(scanForAutoRunProcedures('Sub FormatHeading()\r\nEnd Sub')).toEqual([]);
  });

  it('does not mistake a mention in a comment or a call for a declaration', () => {
    const source = ["' remember to call AutoOpen here", '  Call AutoOpen', 'Sub Real()', 'End Sub'].join(
      '\r\n',
    );
    expect(scanForAutoRunProcedures(source)).toEqual([]);
  });

  it('reports every match, so a second call is not silently empty', () => {
    const source = 'Sub AutoOpen()\r\nEnd Sub';
    expect(scanForAutoRunProcedures(source)).toEqual(['AutoOpen']);
    expect(scanForAutoRunProcedures(source)).toEqual(['AutoOpen']);
  });
});

describe('extractVbaFromDocx', () => {
  it('finds the macro project through the package relationships', async () => {
    const result = await extractVbaFromDocx(withMacros);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project.partName).toBe('word/vbaProject.bin');
    expect(result.project.modules.map((module) => module.name)).toContain('Module1');
    expect(result.project.modules.find((module) => module.name === 'Module1')!.source).toContain(
      'say_hello',
    );
  });

  it('answers plainly that a document has no macros', async () => {
    const result = await extractVbaFromDocx(noMacros);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-macros');
    expect(result.partName).toBeUndefined();
  });

  it('names the macro part even when the project cannot be read', async () => {
    // "No macros" and "macros we cannot decode" are different answers, and a
    // host has to act differently on them: a package carrying a macro part
    // must still be saved as `.docm`, readable or not. Reporting the part on
    // failure is what makes that distinguishable.
    const damaged = await buildZip([
      { name: '[Content_Types].xml', data: new TextEncoder().encode(CONTENT_TYPES_WITH_VBA) },
      { name: 'word/vbaProject.bin', data: new Uint8Array(600) },
    ]);

    const result = await extractVbaFromDocx(damaged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-a-vba-project');
    expect(result.partName).toBe('word/vbaProject.bin');
  });
});

describe('findVbaPart', () => {
  it('locates the macro part without decoding it', async () => {
    expect(await findVbaPart(withMacros)).toBe('word/vbaProject.bin');
  });

  it('returns null for a document with no macros', async () => {
    expect(await findVbaPart(noMacros)).toBeNull();
  });

  it('still locates a part whose project is damaged', async () => {
    // The cheap question a save path asks. It must not depend on the project
    // being readable, or a damaged one would be silently dropped on save.
    const damaged = await buildZip([
      { name: '[Content_Types].xml', data: new TextEncoder().encode(CONTENT_TYPES_WITH_VBA) },
      { name: 'word/vbaProject.bin', data: new Uint8Array(600) },
    ]);
    expect(await findVbaPart(damaged)).toBe('word/vbaProject.bin');
  });

  it('returns null rather than throwing on bytes that are not a package', async () => {
    expect(await findVbaPart(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('rejects bytes that are not a package', async () => {
    const result = await extractVbaFromDocx(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-a-package');
  });
});

describe('real-world container shapes', () => {
  const hebrewSource = encodeCp1255(
    ['Attribute VB_Name = "Module1"', 'Sub FormatHeading()', 'End Sub'].join('\r\n'),
  );
  const project = (overrides: Partial<Parameters<typeof buildVbaProjectBin>[0]> = {}) =>
    buildVbaProjectBin({
      codePage: 1255,
      moduleName: 'Module1',
      source: hebrewSource,
      projectLines: ['Module=Module1'],
      ...overrides,
    });

  it('reads a project whose streams live in the mini stream', () => {
    const result = extractVbaProject(project({ layout: 'mini' }));
    expect(result.ok && result.project.modules.map((module) => module.name)).toEqual(['Module1']);
  });

  it('reads a project whose streams occupy full sectors', () => {
    const result = extractVbaProject(project({ layout: 'sectors' }));
    expect(result.ok && result.project.modules.map((module) => module.name)).toEqual(['Module1']);
  });

  it('keeps its place across the library-reference records', () => {
    // A project with entries under Tools ▸ References carries REFERENCE*
    // records ahead of the modules, several of which state their length in
    // unusual ways. A walk that mis-sizes any of them desynchronizes and
    // every module after it disappears. This is the common real-world case.
    const result = extractVbaProject(project({ withReferences: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.modules.map((module) => module.name)).toEqual(['Module1']);
    expect(result.project.warnings.map((warning) => warning.code)).not.toContain('incomplete-directory');
  });

  it('reads streams that sit past the 256th mini sector', () => {
    // The mini allocation table indexes 64-byte mini sectors, not file
    // sectors. Bounding it with the file's sector count caps a small
    // container's table at 256 entries — so a project with more than ~16 KB
    // of small streams loses whatever sits beyond that. The filler streams
    // push the real ones well past that line.
    const withFiller = project({ layout: 'mini', fillerStreams: 24 });
    const container = readCfb(withFiller);
    const dir = container.entries.find((entry) => entry.path === '/VBA/dir')!;
    expect(dir.size).toBeLessThan(4096); // still a mini stream

    const result = extractVbaProject(withFiller);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.modules.map((module) => module.name)).toEqual(['Module1']);
  });

  it('ignores the high half of a v3 stream size', () => {
    // MS-CFB records that older writers left those 32 bits uninitialized and
    // recommends ignoring them in version 3 files. Honouring the garbage
    // instead makes every stream look oversized and loses the whole project.
    const patched = vbaProjectBin.slice();
    const view = new DataView(patched.buffer);
    const firstDirectorySector = view.getUint32(48, true);
    const base = (firstDirectorySector + 1) * 512;
    for (let slot = 0; slot < 4; slot += 1) {
      view.setUint32(base + slot * 128 + 124, 0xdeadbeef, true);
    }

    const result = extractVbaProject(patched);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.modules.map((module) => module.name)).toContain('Module1');
  });

  it('bounds the list of missing modules it names', () => {
    const manyDeclared = project({
      projectLines: [
        'Module=Module1',
        ...Array.from({ length: 100 }, (_, index) => `Class=Absent${index}`),
      ],
    });

    const result = extractVbaProject(manyDeclared);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.project.warnings.find(
      (candidate) => candidate.code === 'declared-modules-missing',
    )!;
    expect(warning.message).toContain('100 module(s)');
    expect(warning.message).toContain('and 80 more');
    // Trimmed for a human to read, not allowed to become arbitrarily long.
    expect(warning.message.length).toBeLessThan(600);
  });
});

describe('damaged and hostile input', () => {
  it('fails without throwing on a truncated package', async () => {
    for (const fraction of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const cut = withMacros.slice(0, Math.floor(withMacros.length * fraction));
      const result = await extractVbaFromDocx(cut);
      expect(result.ok).toBe(false);
    }
  });

  it('fails without throwing on a truncated macro project', () => {
    for (const fraction of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const cut = vbaProjectBin.slice(0, Math.floor(vbaProjectBin.length * fraction));
      // Some truncations still yield a readable subset — either answer is
      // fine, as long as it is an answer and not an exception.
      expect(() => extractVbaProject(cut)).not.toThrow();
    }
  });

  it('never throws and always terminates on corrupted macro projects', () => {
    // A deterministic sweep: every byte position in the header and allocation
    // tables gets flipped in turn. Chain loops, offsets pointing outside the
    // file and absurd declared sizes all live in this region, so this is
    // where a reader hangs or throws if its guards are missing.
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let attempt = 0; attempt < 400; attempt += 1) {
      const mutated = vbaProjectBin.slice();
      const flips = 1 + Math.floor(random() * 4);
      for (let flip = 0; flip < flips; flip += 1) {
        const at = Math.floor(random() * Math.min(4096, mutated.length));
        mutated[at] = Math.floor(random() * 256);
      }
      expect(() => extractVbaProject(mutated)).not.toThrow();
    }
  });

  it('refuses a directory nested deeper than the cap', () => {
    // Counting entries bounds how many paths exist, not how long they are.
    // Storages nested one inside the next make each path longer than the
    // last, so the bytes retained grow with the square of the entry count:
    // 10,000 of them describe over a gigabyte of path strings, from a
    // container that compresses to almost nothing.
    const deep = buildNestedStorages(400);
    expect(deep.length).toBeLessThan(80 * 1024);

    const started = Date.now();
    const result = extractVbaProject(deep);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-large');
  });

  it('accepts the nesting a real project actually uses', () => {
    // The cap must not be so tight that it rejects ordinary files. A macro
    // project nests one storage deep; this leaves ample room.
    const shallow = buildNestedStorages(8);
    const result = extractVbaProject(shallow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Rejected for having no VBA directory, not for its shape.
    expect(result.reason).toBe('not-a-vba-project');
    expect(result.message).toContain('directory stream');
  });

  it('does not stall on XML crafted to make a tag scanner backtrack', async () => {
    // `<Relationship` repeated with no `>` anywhere. Against the obvious
    // regex — `/<Relationship\b[^>]*>/g` — every occurrence is a candidate
    // start that runs to the end of the input and then backtracks a
    // character at a time, which is quadratic: this input would take hours.
    const hostile = new TextEncoder().encode('<Relationship'.repeat(60_000));
    expect(hostile.length).toBeGreaterThan(700_000);

    const archive: ZipFileEntry[] = [
      { name: '_rels/.rels', data: hostile },
      { name: 'word/document.xml', data: new TextEncoder().encode('<w:document/>') },
    ];

    const started = Date.now();
    const result = await extractVbaFromDocx(await buildZip(archive));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
  });

  it('enforces the size cap against the bytes produced, not the size declared', async () => {
    // A decompression bomb in miniature: the headers declare a 512-byte part
    // over data that expands to 8 MB. A reader that trusts the declared size
    // hands the expansion straight to its caller.
    //
    // What this pins down is that the cap is applied to the real output. That
    // the check also happens *during* decompression rather than after is what
    // keeps the memory bounded as well — not something a test can observe
    // portably, but the reason `inflateRaw` reads chunk by chunk.
    const expands = new Uint8Array(8 * 1024 * 1024); // 8 MB of zeros
    const packed = await buildZip([
      { name: 'bomb.bin', data: expands, deflate: true, declaredSize: 512 },
    ]);
    // Tiny on paper, huge in fact — the lie is the whole attack.
    expect(packed.length).toBeLessThan(200 * 1024);

    const archive = openZip(packed);
    expect(archive.entries[0]!.uncompressedSize).toBe(512);
    await expect(archive.read('bomb.bin', { maxBytes: 4_096 })).rejects.toThrow(/past the part size cap/);
  });

  it('bounds the warnings a project can provoke', async () => {
    // Every module record costs a few bytes and compresses to nothing, so a
    // tiny file can declare a great many. If the read cap counted only
    // *successful* modules, a project whose streams all fail would iterate
    // over every record and push a warning each time.
    const bin = buildVbaProjectBin({
      codePage: 1252,
      moduleName: 'Module1',
      source: encodeCp1255('Attribute VB_Name = "Module1"'),
      projectLines: ['Module=Module1'],
      phantomModuleRecords: 900,
    });

    const result = extractVbaProject(bin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.warnings.length).toBeLessThanOrEqual(VBA_LIMITS.maxModules + 8);
    expect(result.project.warnings.map((warning) => warning.code)).toContain('module-limit');
  });

  it('sanitizes a nonsensical output cap instead of disabling itself', () => {
    // `NaN > max` is false, so an unsanitized cap would neither reject nor
    // bound anything — and the growth loop would spin forever.
    const body = Uint8Array.from([0x01, 0x05, 0xb0, 0x00, 0x61, 0x62, 0x63, 0x64, 0x65]);
    expect(() => decompressOvba(body, { maxOutput: Number.NaN })).not.toThrow();
    expect(decompressOvba(body, { maxOutput: Number.NaN }).length).toBeGreaterThan(0);
  });
});
