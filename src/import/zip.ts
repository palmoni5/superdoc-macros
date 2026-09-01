/**
 * A read-only ZIP reader, enough to pull named parts out of an OOXML package.
 *
 * A `.docm` is a ZIP whose entries are the document's parts. To reach the
 * macro project we need two or three specific parts by name, never the whole
 * archive — so this reader parses the central directory up front (cheap) and
 * inflates only what a caller asks for.
 *
 * Inflation uses the platform's own `DecompressionStream` — Baseline across
 * browsers since 2023, and present in Node 18+. That keeps the toolkit
 * dependency-free and puts the decompression itself in audited native code
 * rather than in a hand-rolled inflater. Where it is genuinely absent, the
 * reader says so rather than failing obscurely. Nothing else is assumed of the
 * platform: no `Blob`, no `fetch`, no `Response` — only streams, so this also
 * runs under jsdom, where a host's tests live.
 *
 * Safety posture, because these bytes come from a file someone was sent:
 *
 * - Entry count and name length are capped, and the per-part size cap is
 *   enforced against the bytes decompression actually produces — not against
 *   the size the archive claims, which a decompression bomb simply lies about.
 * - Encrypted and ZIP64 entries are refused explicitly rather than guessed at.
 * - Nothing here writes, and no entry name is ever used as a filesystem path,
 *   so the classic zip-slip traversal has no surface to attack.
 */
import { VbaParseError } from './errors.js';

export const ZIP_LIMITS = {
  maxEntries: 5_000,
  /** Uncompressed size of any single part this reader will inflate. */
  maxEntryBytes: 64 * 1024 * 1024,
  maxNameLength: 1_024,
} as const;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_MIN_BYTES = 22;
/** The trailing comment a ZIP may carry is at most 64 KiB. */
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ZipReadOptions {
  /**
   * Hard ceiling on the bytes this read may produce, defaulting to
   * `ZIP_LIMITS.maxEntryBytes`. Enforced *during* decompression, so a part
   * that inflates past it is abandoned rather than buffered and then
   * rejected. Callers who know a part should be small (a `.rels` file) should
   * say so — that is the difference between refusing a bomb and hosting it.
   */
  maxBytes?: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  has(name: string): boolean;
  /**
   * The inflated bytes of one entry.
   *
   * @throws {VbaParseError} when the entry is absent, encrypted, compressed
   * with an unsupported method, larger than the cap, or its data runs past
   * the end of the file.
   */
  read(name: string, options?: ZipReadOptions): Promise<Uint8Array>;
}

interface CentralEntry extends ZipEntry {
  readonly method: number;
  readonly localOffset: number;
  readonly encrypted: boolean;
}

/** Parses the central directory. Reading an entry's data stays lazy. */
export function openZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number => {
    if (offset < 0 || offset + 2 > bytes.length) {
      throw new VbaParseError('malformed', 'package: read past the end of the file');
    }
    return view.getUint16(offset, true);
  };
  const u32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > bytes.length) {
      throw new VbaParseError('malformed', 'package: read past the end of the file');
    }
    return view.getUint32(offset, true);
  };

  if (bytes.length < EOCD_MIN_BYTES) {
    throw new VbaParseError('malformed', 'package: file is too short to be a ZIP archive');
  }

  // The end-of-central-directory record sits at the very end, behind an
  // optional comment — so it has to be found by scanning backwards.
  const scanFloor = Math.max(0, bytes.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  let eocd = -1;
  for (let at = bytes.length - EOCD_MIN_BYTES; at >= scanFloor; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) {
    throw new VbaParseError('malformed', 'package: not a ZIP archive (no end-of-directory record)');
  }

  const entryCount = u16(eocd + 10);
  const directorySize = u32(eocd + 12);
  const directoryOffset = u32(eocd + 16);

  if (
    entryCount === ZIP64_MARKER_16 ||
    directoryOffset === ZIP64_MARKER_32 ||
    directorySize === ZIP64_MARKER_32 ||
    (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw new VbaParseError('unsupported', 'package: ZIP64 archives are not supported');
  }
  if (entryCount > ZIP_LIMITS.maxEntries) {
    throw new VbaParseError('too-large', 'package: too many entries');
  }
  if (directoryOffset + directorySize > bytes.length) {
    throw new VbaParseError('malformed', 'package: central directory lies outside the file');
  }

  const decoder = new TextDecoder('utf-8');
  const byName = new Map<string, CentralEntry>();
  const entries: ZipEntry[] = [];

  const directoryEnd = directoryOffset + directorySize;
  let at = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    // Confined to the region the archive declared for its directory, so a
    // crafted file cannot have us read "entries" out of arbitrary bytes
    // elsewhere in the package.
    if (at + 46 > directoryEnd) {
      throw new VbaParseError('malformed', 'package: central directory is shorter than it claims');
    }
    if (u32(at) !== CENTRAL_SIGNATURE) {
      throw new VbaParseError('malformed', 'package: damaged central directory');
    }
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compressedSize = u32(at + 20);
    const uncompressedSize = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const localOffset = u32(at + 42);

    if (nameLength > ZIP_LIMITS.maxNameLength) {
      throw new VbaParseError('too-large', 'package: entry name is too long');
    }
    if (compressedSize === ZIP64_MARKER_32 || uncompressedSize === ZIP64_MARKER_32) {
      throw new VbaParseError('unsupported', 'package: ZIP64 entry sizes are not supported');
    }

    const nameStart = at + 46;
    if (nameStart + nameLength > directoryEnd) {
      throw new VbaParseError('malformed', 'package: entry name lies outside the central directory');
    }
    // OOXML part names are ASCII, which UTF-8 and CP437 agree on — so the
    // flag-11 distinction cannot change the names we look up.
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));

    const entry: CentralEntry = {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      encrypted: (flags & 0x0001) !== 0,
    };
    entries.push({ name, compressedSize, uncompressedSize });
    // First entry wins, so a duplicated name cannot shadow the part that was
    // already announced in `entries`.
    if (!byName.has(name)) byName.set(name, entry);

    at = nameStart + nameLength + extraLength + commentLength;
  }

  return {
    entries,
    has: (name) => byName.has(name),
    async read(name, options) {
      const entry = byName.get(name);
      if (!entry) {
        throw new VbaParseError('malformed', `package: no such part (${name})`);
      }
      if (entry.encrypted) {
        throw new VbaParseError('unsupported', `package: ${name} is encrypted`);
      }

      const requested = options?.maxBytes;
      const cap = Math.min(
        typeof requested === 'number' && Number.isFinite(requested) && requested > 0
          ? Math.floor(requested)
          : ZIP_LIMITS.maxEntryBytes,
        ZIP_LIMITS.maxEntryBytes,
      );
      // The declared size is only a claim, so it is a cheap early rejection
      // rather than the real defence — the real one is enforced against the
      // bytes actually produced, below.
      if (entry.uncompressedSize > cap) {
        throw new VbaParseError('too-large', `package: ${name} exceeds the part size cap`);
      }

      if (u32(entry.localOffset) !== LOCAL_SIGNATURE) {
        throw new VbaParseError('malformed', `package: ${name} has a damaged local header`);
      }
      const localNameLength = u16(entry.localOffset + 26);
      const localExtraLength = u16(entry.localOffset + 28);
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > bytes.length) {
        throw new VbaParseError('malformed', `package: ${name} runs past the end of the file`);
      }

      const data = bytes.subarray(dataStart, dataEnd);
      if (entry.method === METHOD_STORED) {
        // A stored entry's real length is its compressed length; the declared
        // uncompressed size may disagree, so the cap is applied to what we
        // would actually return.
        if (data.length > cap) {
          throw new VbaParseError('too-large', `package: ${name} exceeds the part size cap`);
        }
        return data.slice();
      }
      if (entry.method !== METHOD_DEFLATE) {
        throw new VbaParseError('unsupported', `package: ${name} uses compression method ${entry.method}`);
      }
      return inflateRaw(data, name, cap);
    },
  };
}

/**
 * Inflates one entry, enforcing `cap` as the bytes arrive.
 *
 * Reading the stream chunk by chunk rather than with `Response.arrayBuffer()`
 * is the whole point. Buffering first and checking the length afterwards
 * means a part that declares a kilobyte and expands to a gigabyte has already
 * been fully materialized by the time the limit is consulted — the classic
 * decompression bomb. Here the read is abandoned the moment the total would
 * exceed the cap.
 */
async function inflateRaw(data: Uint8Array, name: string, cap: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function' || typeof ReadableStream !== 'function') {
    throw new VbaParseError('unsupported', 'package: this environment cannot decompress ZIP entries');
  }

  // The bytes are wrapped in a stream directly rather than via
  // `new Blob([data]).stream()`. Both work in a browser, but `Blob.stream` is
  // one of the pieces jsdom does not implement — and a host's own test suite
  // running in jsdom is a place this code has to work, not fall over.
  // `BufferSource` and not `Uint8Array`: that is what `DecompressionStream`
  // declares its writable side accepts, and `pipeThrough` matches on it.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      // The cast covers a modelling gap, not a real one: since TypeScript 5.7
      // a bare `Uint8Array` may be backed by a `SharedArrayBuffer`, which
      // `BufferSource` excludes. These bytes are a view over the caller's
      // package, and the stream accepts any array-buffer view at runtime.
      // Copying to prove it to the compiler would duplicate the whole part.
      controller.enqueue(data as unknown as BufferSource);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        throw new VbaParseError('too-large', `package: ${name} inflates past the part size cap`);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Release the decompressor before rethrowing, so an abandoned bomb does
    // not leave a stream pulling in the background.
    await reader.cancel().catch(() => undefined);
    if (error instanceof VbaParseError) throw error;
    throw new VbaParseError('malformed', `package: ${name} could not be decompressed`);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
