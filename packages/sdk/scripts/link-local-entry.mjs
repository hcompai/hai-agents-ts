// `hai-agents/local` is built with the client external (a second HaiAgentsClient would break
// instanceof and the typings); point its import at the built main entry. The main entry types
// `Client.local()` through the local entry, so its typings get the built one beside them, and loads
// it on demand by name (src/client/oo.ts), which resolves through this package's own `exports`:
// from the CJS build, `import()` would pick the ESM local entry, and with it a second copy of the
// client, so there it becomes a `require`.
import { readFileSync, writeFileSync } from 'node:fs';

const LOADER = 'return import(\n    /* @vite-ignore */\n    LOCAL_ENTRY\n  );';

for (const [file, from, to] of [
  ['dist/local.js', '../client/index.js', './index.js'],
  ['dist/local.cjs', '../client/index.js', './index.cjs'],
  ['dist/local.d.ts', '../client/index.js', './index.js'],
  ['dist/local.d.cts', '../client/index.js', './index.cjs'],
  ['dist/index.cjs', LOADER, 'return require(LOCAL_ENTRY);'],
  ['dist/index.d.ts', './local/index.js', './local.js'],
  ['dist/index.d.cts', './local/index.js', './local.cjs'],
]) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes(from)) {
    throw new Error(`${file} does not contain ${JSON.stringify(from)}; the build changed`);
  }
  writeFileSync(file, source.replaceAll(from, to));
}
