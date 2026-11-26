/**
 * Shared test helpers: the TypeScript stand-ins for pytest's `tmp_path`, `monkeypatch` and
 * `pytest.raises(..., match=...)`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";

/** The repository root (scripts/, openapi.json, packages/sdk). */
export const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// tmp_path
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

/** A fresh empty directory, removed after the test (pytest's `tmp_path`). */
export function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hai-tests-"));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTmpPaths(): void {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// monkeypatch
// ---------------------------------------------------------------------------

type Undo = () => void;

/** pytest's `monkeypatch`: every change is undone after the test by `setup.ts`. */
export class Monkeypatch {
  private undos: Undo[] = [];

  setenv(name: string, value: string): void {
    const had = name in process.env;
    const old = process.env[name];
    this.undos.push(() => {
      if (had) process.env[name] = old;
      else delete process.env[name];
    });
    process.env[name] = value;
  }

  delenv(name: string, { raising = true }: { raising?: boolean } = {}): void {
    if (!(name in process.env)) {
      if (raising) throw new Error(`environment variable ${name} is not set`);
      return;
    }
    const old = process.env[name];
    this.undos.push(() => {
      process.env[name] = old;
    });
    delete process.env[name];
  }

  /**
   * Replace `obj[name]` for the rest of the test.
   *
   * ES module namespaces are frozen, so a plain assignment throws: functions go through `vi.spyOn`,
   * values through a getter spy. Plain objects and class instances are patched with `defineProperty`
   * so read-only data properties can be swapped too.
   */
  setattr<T extends object, K extends keyof T & string>(obj: T, name: K, value: T[K]): void {
    const current = (obj as Record<string, unknown>)[name];
    const isModule = Object.prototype.toString.call(obj) === "[object Module]";
    if (typeof current === "function" && typeof value === "function") {
      // The two overloads of vi.spyOn only narrow for literal keys; cast through a loose signature.
      const spyOn = vi.spyOn as unknown as (o: object, k: string, a?: "get") => { mockImplementation(fn: unknown): unknown; mockReturnValue(v: unknown): unknown; mockRestore(): void };
      const spy = spyOn(obj, name);
      spy.mockImplementation(value);
      this.undos.push(() => spy.mockRestore());
      return;
    }
    if (isModule) {
      const spyOn = vi.spyOn as unknown as (o: object, k: string, a?: "get") => { mockReturnValue(v: unknown): unknown; mockRestore(): void };
      const spy = spyOn(obj, name, "get");
      spy.mockReturnValue(value);
      this.undos.push(() => spy.mockRestore());
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(obj, name);
    this.undos.push(() => {
      if (descriptor) Object.defineProperty(obj, name, descriptor);
      else delete (obj as Record<string, unknown>)[name];
    });
    Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? true });
  }

  undo(): void {
    for (const undo of this.undos.splice(0).reverse()) undo();
  }
}

export const mp = new Monkeypatch();

// ---------------------------------------------------------------------------
// pytest.raises
// ---------------------------------------------------------------------------

type ErrorClass<T extends Error = Error> = abstract new (...args: never[]) => T;

function check<T extends Error>(error: unknown, type: ErrorClass<T>, match?: RegExp | string): T {
  expect(error).toBeInstanceOf(type);
  if (match !== undefined) expect(String((error as Error).message)).toMatch(match);
  return error as T;
}

/** `with pytest.raises(Type, match=...) as exc_info:` for synchronous code; returns the error. */
export function raises<T extends Error>(fn: () => unknown, type: ErrorClass<T>, match?: RegExp | string): T {
  try {
    fn();
  } catch (error) {
    return check(error, type, match);
  }
  throw new Error(`DID NOT RAISE ${type.name}`);
}

/** `with pytest.raises(...)` around an awaited call; returns the error. */
export async function raisesAsync<T extends Error>(
  fn: () => Promise<unknown> | unknown,
  type: ErrorClass<T>,
  match?: RegExp | string,
): Promise<T> {
  try {
    await fn();
  } catch (error) {
    return check(error, type, match);
  }
  throw new Error(`DID NOT RAISE ${type.name}`);
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/** `time.sleep(seconds)` */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** `stat.S_IMODE(path.stat().st_mode)` */
export function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

export function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function writeText(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, "utf-8");
}
