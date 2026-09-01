/**
 * The one Node API the test suite needs, declared here rather than pulled in
 * with `@types/node`.
 *
 * The reason is a guardrail, not frugality. `src` compiles against `DOM` and
 * `ES2022` only, so a stray `Buffer` or `process` in library code is a
 * compile error rather than something that ships and breaks in a browser.
 * Installing the full Node types would put those globals in scope everywhere
 * and quietly retire that check — so the tests declare exactly what they use
 * and nothing else.
 */
declare module 'node:fs' {
  /** Reads a file whole. Node returns a `Buffer`, which is a `Uint8Array`. */
  export function readFileSync(path: string | URL): Uint8Array;
}
