// Debug helper for one-off traces inside vitest tests.
//
// Replaces the `expect(JSON.stringify(x, null, 2)).toBe('FORCE FAIL')` hack
// that the diff-vs-FORCE-FAIL string was the *only* way to surface a
// pretty-printed value past vitest's console intercept. Throws an assertion-
// style error with the JSON dump as its message, so the failure output is
// the dump itself — no diff noise.
//
// Usage:
//   import { dumpAndFail } from "./dumpAndFail";
//   it("trace foo", () => {
//     const x = await someFn();
//     dumpAndFail({ tokens, hit, exact });
//   });
//
// The test always fails — that's the point; you're poking at intermediate
// state. Delete the call (or the whole trace test) once you have the data
// you needed.

export function dumpAndFail(value: unknown, label?: string): never {
  const heading = label ? `[${label}]\n` : "";
  throw new Error(`${heading}${JSON.stringify(value, null, 2)}`);
}
