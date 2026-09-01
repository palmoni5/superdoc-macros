/**
 * A read-only reader for MS-CFB (the OLE "compound file" container).
 *
 * `vbaProject.bin` is not XML — it is a small filesystem in a file, with a
 * sector allocation table, a directory tree, and a second allocation table
 * for streams under 4096 bytes. VBA sources live in streams inside it, so
 * reaching them means walking that structure.
 *
 * Written by hand rather than pulled from a package, for two reasons. The
 * toolkit ships with no runtime dependencies, and this is the one place
 * user-supplied bytes are parsed — a job worth owning outright, kept
 * read-only (nothing here can write a CFB file) and defensive throughout:
 *
 * - Every sector offset is bounds-checked before it is read.
 * - Every chain walk tracks visited sectors, so a file whose allocation
 *   table points in a circle terminates instead of hanging.
 * - Entry counts, chain lengths and stream sizes are capped.
 *
 * Deliberately unimplemented: writing, encryption, and CFB v4 files whose
 * header declares a sector size other than 512 or 4096 bytes.
 */
import { VbaParseError } from './errors.js';

export const CFB_LIMITS = {
  /** Whole-container size. A `vbaProject.bin` is normally tens of kilobytes. */
  maxFileBytes: 64 * 1024 * 1024,
  /** Directory entries, i.e. streams plus storages. */
  maxEntries: 10_000,
  /** Sectors in one chain — the ceiling on any single stream's length. */
  maxChainSectors: 200_000,
  /** One stream's declared size. */
  maxStreamBytes: 32 * 1024 * 1024,
  /**
   * Nesting depth of the directory tree, and the length of a resulting path.
   *
   * These are not cosmetic. Counting entries alone bounds how many paths
   * exist but not how long they are, and the two multiply: 10,000 storages
   * nested one inside the next, with 31-character names, describe paths whose
   * lengths run 32, 64, 96 … — over a gigabyte of retained strings from a
   * container that compresses to a few kilobytes. A real VBA project nests
   * one storage deep.
   */
  maxDepth: 32,
  maxPathLength: 1_024,
} as const;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const HEADER_BYTES = 512;
const DIRECTORY_ENTRY_BYTES = 128;
/** Sector ids above this are sentinels (end-of-chain, free, FAT, DIFAT). */
const MAX_REGULAR_SECTOR = 0xfffffffa;
/** DIFAT entries per header. */
const HEADER_DIFAT_ENTRIES = 109;
const HEADER_DIFAT_OFFSET = 76;

export type CfbEntryType = 'root' | 'storage' | 'stream';

export interface CfbEntry {
  /** Absolute path inside the container, e.g. `/VBA/dir`. Root is `/`. */
  readonly path: string;
  /** The entry's own name, e.g. `dir`. */
  readonly name: string;
  readonly type: CfbEntryType;
  /** Declared length in bytes. `0` for storages. */
  readonly size: number;
}

export interface CfbContainer {
  /** Every reachable entry, storages included, in directory-tree order. */
  readonly entries: readonly CfbEntry[];
  /**
   * The bytes of one stream, by exact path.
   *
   * @throws {VbaParseError} when the path is absent, names a storage, or the
   * stream's allocation chain is malformed.
   */
  readStream(path: string): Uint8Array;
}

interface RawEntry {
  name: string;
  type: CfbEntryType | 'unallocated';
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
}

export function readCfb(bytes: Uint8Array): CfbContainer {
  if (bytes.length > CFB_LIMITS.maxFileBytes) {
    throw new VbaParseError('too-large', 'OLE container: file exceeds the size cap');
  }
  if (bytes.length < HEADER_BYTES) {
    throw new VbaParseError('malformed', 'OLE container: file is shorter than its header');
  }
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new VbaParseError('malformed', 'OLE container: wrong signature');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > bytes.length) {
      throw new VbaParseError('malformed', 'OLE container: read past the end of the file');
    }
    return view.getUint32(offset, true);
  };

  const sectorShift = view.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new VbaParseError('unsupported', `OLE container: unsupported sector size (2^${sectorShift})`);
  }
  const miniSectorShift = view.getUint16(32, true);
  if (miniSectorShift !== 6) {
    throw new VbaParseError('unsupported', `OLE container: unsupported mini sector size (2^${miniSectorShift})`);
  }

  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const fatSectorCount = u32(44);
  const firstDirectorySector = u32(48);
  const miniStreamCutoff = u32(56);
  const firstMiniFatSector = u32(60);
  const miniFatSectorCount = u32(64);
  const firstDifatSector = u32(68);
  const difatSectorCount = u32(72);
  const entriesPerSector = sectorSize / 4;

  /** Byte offset of a sector. The header occupies the space of sector -1. */
  const sectorOffset = (sector: number): number => {
    const offset = (sector + 1) * sectorSize;
    if (sector < 0 || offset + sectorSize > bytes.length) {
      throw new VbaParseError('malformed', `OLE container: sector ${sector} lies outside the file`);
    }
    return offset;
  };

  /* ---------- allocation tables ---------- */

  // How many sectors the file could possibly hold. Declared counts are just
  // claims — a crafted header can say the allocation table spans four billion
  // sectors — so every table is also bounded by what the file physically has
  // room for. Without this, an attacker sizes our memory use, not us.
  const sectorsInFile = Math.max(1, Math.ceil(bytes.length / sectorSize));

  // The allocation table can never usefully describe more sectors than the
  // file holds, whatever its header claims. Deriving the ceiling first lets
  // the DIFAT walk below stop collecting as soon as it has enough, instead of
  // gathering millions of sector numbers it will then discard.
  const fatLimit = Math.min(
    Math.max(fatSectorCount, 1) * entriesPerSector,
    // One full table sector of slack past the last real sector, so a valid
    // file is never trimmed while a lying one cannot inflate the table.
    sectorsInFile + entriesPerSector,
  );
  const fatSectorLimit = Math.ceil(fatLimit / entriesPerSector) + 1;

  // The DIFAT is the index *of* the allocation table: the first 109 entries
  // live in the header, the rest in a chain of their own sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorLimit; i += 1) {
    fatSectors.push(u32(HEADER_DIFAT_OFFSET + i * 4));
  }
  let difatSector = firstDifatSector;
  const seenDifat = new Set<number>();
  while (
    difatSector <= MAX_REGULAR_SECTOR &&
    fatSectors.length < fatSectorLimit &&
    seenDifat.size <= Math.min(difatSectorCount, sectorsInFile) + 1
  ) {
    if (seenDifat.has(difatSector)) {
      throw new VbaParseError('malformed', 'OLE container: DIFAT chain loops');
    }
    seenDifat.add(difatSector);
    const base = sectorOffset(difatSector);
    for (let i = 0; i < entriesPerSector - 1 && fatSectors.length < fatSectorLimit; i += 1) {
      fatSectors.push(u32(base + i * 4));
    }
    difatSector = u32(base + (entriesPerSector - 1) * 4);
  }

  const fat: number[] = [];
  for (const sector of fatSectors) {
    if (sector > MAX_REGULAR_SECTOR) continue;
    if (fat.length >= fatLimit) break;
    const base = sectorOffset(sector);
    for (let i = 0; i < entriesPerSector; i += 1) fat.push(u32(base + i * 4));
  }
  if (fat.length === 0) {
    throw new VbaParseError('malformed', 'OLE container: empty allocation table');
  }

  /** The sector ids of one chain, in order. */
  const chain = (start: number): number[] => {
    const sectors: number[] = [];
    const seen = new Set<number>();
    let sector = start;
    while (sector <= MAX_REGULAR_SECTOR) {
      if (seen.has(sector)) {
        throw new VbaParseError('malformed', 'OLE container: sector chain loops');
      }
      if (sectors.length >= CFB_LIMITS.maxChainSectors) {
        throw new VbaParseError('too-large', 'OLE container: sector chain exceeds the length cap');
      }
      seen.add(sector);
      sectors.push(sector);
      const next = fat[sector];
      if (next === undefined) {
        // A chain running off the end of the table is a truncated file. The
        // sectors gathered so far are still real, so stop rather than fail:
        // callers slice to the declared size and will notice a short read.
        break;
      }
      sector = next;
    }
    return sectors;
  };

  const readChain = (start: number, byteCount: number): Uint8Array => {
    if (byteCount > CFB_LIMITS.maxStreamBytes) {
      throw new VbaParseError('too-large', 'OLE container: stream exceeds the size cap');
    }
    if (byteCount === 0) return new Uint8Array(0);

    // The chain is walked and measured *before* the buffer exists. A declared
    // size the chain cannot supply is the signature of a truncated file, and
    // allocating tens of megabytes only to discover that is work an attacker
    // gets to request for free.
    const sectors = chain(start);
    if (sectors.length * sectorSize < byteCount) {
      throw new VbaParseError('malformed', 'OLE container: stream is shorter than its declared size');
    }

    const out = new Uint8Array(byteCount);
    let written = 0;
    for (const sector of sectors) {
      if (written >= byteCount) break;
      const base = sectorOffset(sector);
      const take = Math.min(sectorSize, byteCount - written);
      out.set(bytes.subarray(base, base + take), written);
      written += take;
    }
    return out;
  };

  /* ---------- directory ---------- */

  const directorySectors = chain(firstDirectorySector);
  const entriesPerDirectorySector = sectorSize / DIRECTORY_ENTRY_BYTES;
  const raw: RawEntry[] = [];

  for (const sector of directorySectors) {
    const base = sectorOffset(sector);
    for (let i = 0; i < entriesPerDirectorySector; i += 1) {
      if (raw.length >= CFB_LIMITS.maxEntries) {
        throw new VbaParseError('too-large', 'OLE container: too many directory entries');
      }
      const at = base + i * DIRECTORY_ENTRY_BYTES;
      const nameByteLength = view.getUint16(at + 64, true);
      const objectType = view.getUint8(at + 66);

      // Names are UTF-16LE with a null terminator counted in the length.
      const usable = Math.max(0, Math.min(nameByteLength, 64) - 2);
      let name = '';
      for (let c = 0; c + 1 < usable; c += 2) {
        name += String.fromCharCode(view.getUint16(at + c, true));
      }

      const low = u32(at + 120);
      const high = u32(at + 124);
      // MS-CFB names this case explicitly: older writers left the high half
      // of a v3 stream size uninitialized, and it "is recommended that
      // parsers ignore the most significant 32 bits of this field in version
      // 3 compound files". Honouring the garbage instead turns an otherwise
      // valid file into an oversized stream and loses the whole project — so
      // v3 uses the low word, full stop, and only v4 reads both halves.
      const size = sectorShift === 9 ? low : low + high * 0x1_0000_0000;

      raw.push({
        name,
        type:
          objectType === 5 ? 'root' : objectType === 1 ? 'storage' : objectType === 2 ? 'stream' : 'unallocated',
        left: u32(at + 68),
        right: u32(at + 72),
        child: u32(at + 76),
        startSector: u32(at + 116),
        size,
      });
    }
  }

  const root = raw[0];
  if (!root || root.type !== 'root') {
    throw new VbaParseError('malformed', 'OLE container: missing root directory entry');
  }

  // The directory is a red-black tree: `child` descends into a storage,
  // `left`/`right` are siblings at the same level. Walked with an explicit
  // stack — a degenerate tree would blow a recursive walk's call stack.
  const entries: CfbEntry[] = [];
  const byPath = new Map<string, RawEntry>();
  const visited = new Set<number>();
  const pending: Array<{ id: number; prefix: string; depth: number }> = [
    { id: root.child, prefix: '', depth: 1 },
  ];

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const { id, prefix, depth } = next;
    if (id > MAX_REGULAR_SECTOR || visited.has(id)) continue;
    visited.add(id);

    const entry = raw[id];
    if (!entry || entry.type === 'unallocated') continue;

    // Depth and path length are capped together. Entry *count* alone does
    // not bound the size of the path strings this loop retains: storages
    // nested one inside the next make each path longer than the last, so the
    // total is quadratic in the entry count. See `CFB_LIMITS.maxDepth`.
    if (depth > CFB_LIMITS.maxDepth) {
      throw new VbaParseError('too-large', 'OLE container: directory nests deeper than the cap');
    }
    const path = `${prefix}/${entry.name}`;
    if (path.length > CFB_LIMITS.maxPathLength) {
      throw new VbaParseError('too-large', 'OLE container: directory path exceeds the length cap');
    }

    if (entry.type === 'storage' || entry.type === 'stream') {
      entries.push({ path, name: entry.name, type: entry.type, size: entry.type === 'stream' ? entry.size : 0 });
      // First writer wins: a file with duplicate paths cannot make a later
      // entry shadow the one already reported.
      if (!byPath.has(path)) byPath.set(path, entry);
    }
    if (entry.type === 'storage') pending.push({ id: entry.child, prefix: path, depth: depth + 1 });
    pending.push({ id: entry.left, prefix, depth });
    pending.push({ id: entry.right, prefix, depth });
  }

  /* ---------- streams ---------- */

  /**
   * The mini stream and its allocation table, built once.
   *
   * The outcome is cached either way — a *failure* included. Rebuilding it per
   * call would re-run a multi-megabyte zero-filled allocation for every
   * stream in a container whose root entry is malformed, turning one bad
   * header into thousands of repeats of the same doomed work.
   */
  let mini: { ok: true; stream: Uint8Array; table: number[] } | { ok: false; error: VbaParseError } | null = null;

  const miniContext = (): { stream: Uint8Array; table: number[] } => {
    if (mini === null) {
      try {
        const stream = readChain(root.startSector, Math.min(root.size, CFB_LIMITS.maxStreamBytes));
        const table: number[] = [];
        // The mini table indexes 64-byte mini sectors inside the mini stream,
        // *not* full sectors of the file. Bounding it by the file's sector
        // count — the ceiling that is right for the FAT — is off by the ratio
        // between the two, and silently truncates the table: on a small
        // container that caps it at 256 entries, so a project with more than
        // ~16 KB of small streams loses modules. Almost everything in a real
        // vbaProject.bin is a mini stream, so this bound has to be the right
        // dimension.
        const limit = Math.min(
          Math.max(miniFatSectorCount, 1) * entriesPerSector,
          Math.ceil(stream.length / miniSectorSize) + entriesPerSector,
        );
        for (const sector of chain(firstMiniFatSector)) {
          if (table.length >= limit) break;
          const base = sectorOffset(sector);
          for (let i = 0; i < entriesPerSector; i += 1) table.push(u32(base + i * 4));
        }
        mini = { ok: true, stream, table };
      } catch (error) {
        mini = {
          ok: false,
          error:
            error instanceof VbaParseError
              ? error
              : new VbaParseError('malformed', 'OLE container: unreadable mini stream'),
        };
      }
    }
    if (!mini.ok) throw mini.error;
    return { stream: mini.stream, table: mini.table };
  };

  const readMini = (start: number, byteCount: number): Uint8Array => {
    const { stream: container, table } = miniContext();

    const out = new Uint8Array(byteCount);
    let written = 0;
    let sector = start;
    const seen = new Set<number>();
    while (sector <= MAX_REGULAR_SECTOR && written < byteCount) {
      if (seen.has(sector)) {
        throw new VbaParseError('malformed', 'OLE container: mini sector chain loops');
      }
      seen.add(sector);
      const base = sector * miniSectorSize;
      if (base + miniSectorSize > container.length) {
        throw new VbaParseError('malformed', 'OLE container: mini sector lies outside the mini stream');
      }
      const take = Math.min(miniSectorSize, byteCount - written);
      out.set(container.subarray(base, base + take), written);
      written += take;
      const next = table[sector];
      if (next === undefined) break;
      sector = next;
    }
    if (written < byteCount) {
      throw new VbaParseError('malformed', 'OLE container: mini stream is shorter than its declared size');
    }
    return out;
  };

  return {
    entries,
    readStream(path: string): Uint8Array {
      const entry = byPath.get(path);
      if (!entry) {
        throw new VbaParseError('malformed', `OLE container: no such stream (${path})`);
      }
      if (entry.type !== 'stream') {
        throw new VbaParseError('malformed', `OLE container: ${path} is a storage, not a stream`);
      }
      if (entry.size > CFB_LIMITS.maxStreamBytes) {
        throw new VbaParseError('too-large', `OLE container: ${path} exceeds the stream size cap`);
      }
      if (entry.size === 0) return new Uint8Array(0);
      return entry.size < miniStreamCutoff
        ? readMini(entry.startSector, entry.size)
        : readChain(entry.startSector, entry.size);
    },
  };
}
