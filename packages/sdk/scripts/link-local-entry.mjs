// `hai-agents/local` is built with the client external (a second HaiAgentsClient would break
// instanceof and the typings); point its import at the built main entry. The main entry loads the
// local entry on demand by name (src/client/oo.ts), which resolves through this package's own
// `exports`: from the CJS build, `import()` would pick the ESM local entry, and with it a second
// copy of the client, so there it becomes a `require`. Its typings type the local entry through
// src/local/types.ts, inlined at build, so they never reach the built local entry's; they name
// `Symbol.asyncDispose` (Client's `await using`), which tsup's bundle strips the lib reference for,
// so it is put back here for consumers whose `lib` predates it and who have no @types/node.
import { readFileSync, writeFileSync } from 'node:fs';

const LOADER = 'return import(\n    /* @vite-ignore */\n    LOCAL_ENTRY\n  );';

for (const [file, from, to] of [
  ['dist/local.js', '../client/index.js', './index.js'],
  ['dist/local.cjs', '../client/index.js', './index.cjs'],
  ['dist/local.d.ts', '../client/index.js', './index.js'],
  ['dist/local.d.cts', '../client/index.js', './index.cjs'],
  ['dist/index.cjs', LOADER, 'return require(LOCAL_ENTRY);'],
]) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes(from)) {
    throw new Error(`${file} does not contain ${JSON.stringify(from)}; the build changed`);
  }
  if (file.startsWith('dist/local') && source.includes('normalizeClientOptionsWithAuth')) {
    throw new Error(`${file} inlines a copy of the generated client; src/local must import it through ../client/index.js only`);
  }
  writeFileSync(file, source.replaceAll(from, to));
}

const DISPOSABLE_LIB = '/// <reference lib="esnext.disposable" />\n';
for (const file of ['dist/index.d.ts', 'dist/index.d.cts']) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('[Symbol.asyncDispose]')) {
    throw new Error(`${file} does not declare [Symbol.asyncDispose]; the build changed`);
  }
  writeFileSync(file, DISPOSABLE_LIB + source);
}
