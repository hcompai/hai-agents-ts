// Drift fixture: the TS mirror of mod.py, with one planted difference of each kind.
export const LIMIT = 3;
export const TIMEOUT_MS = 2_000;
export const NAME = "other";
export const URL = "https://x.example/y"; // the same literal, compared by value
export type Options = { x?: unknown };
export class Thing {}
export function doThing(x: unknown): void {
  if (x == null) {
    throw new Error(`x is required (got '${x}')`);
  }
  throw new Error("vanished, " + "said ts");
}
export function extra(): void {}
function helper(): void {}
