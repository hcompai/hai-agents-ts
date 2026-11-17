// Pin a hai-agent-runtime release: its version plus a fresh sha256 for every platform in the pin file.
// Usage: node scripts/bump_runtime.mjs --version 0.1.29 --sha darwin-arm64=<hex> --sha linux-x86_64=<hex> ...
// No dependencies: runs in a bare checkout.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "sdk", "src", "local", "pin.json");
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PLACEHOLDER_SHA256 = "0".repeat(64);

/** `pin` moved to `version`; throws unless `shas` holds a real digest for exactly the pinned platforms. */
export function applyBump(pin, version, shas) {
  if (!VERSION_RE.test(version)) throw new Error("runtime version must be a release version, e.g. 0.1.13");
  for (const [platform, sha] of Object.entries(shas)) {
    if (!SHA256_RE.test(sha) || sha === PLACEHOLDER_SHA256) {
      throw new Error(`${platform}: ${JSON.stringify(sha)} is not a lowercase 64-char sha256`);
    }
  }
  const published = Object.keys(pin.sha256);
  const extra = Object.keys(shas).filter((platform) => !published.includes(platform)).sort();
  if (extra.length) throw new Error(`no manifest entry for platform(s): ${JSON.stringify(extra)}`);
  // A platform left on its old digest would fail verification at the new version's URL.
  const missing = published.filter((platform) => !(platform in shas)).sort();
  if (missing.length) throw new Error(`missing sha for published platform(s): ${JSON.stringify(missing)}`);
  return { ...pin, version, sha256: Object.fromEntries(published.map((platform) => [platform, shas[platform]])) };
}

const USAGE = "usage: node scripts/bump_runtime.mjs --version X.Y.Z --sha PLATFORM=SHA256 [--sha PLATFORM=SHA256 ...]";

function parseArgs(argv) {
  let version;
  const shas = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(USAGE);
    if (flag === "--version") {
      version = value;
    } else if (flag === "--sha") {
      const [platform, ...rest] = value.split("=");
      const sha = rest.join("=");
      if (!platform || !sha) throw new Error(`--sha must be PLATFORM=SHA256, got ${JSON.stringify(value)}`);
      if (platform in shas) throw new Error(`duplicate --sha for ${platform}`);
      shas[platform] = sha.toLowerCase();
    } else {
      throw new Error(USAGE);
    }
  }
  if (version === undefined || Object.keys(shas).length === 0) throw new Error(USAGE);
  return [version, shas];
}

function main(argv) {
  const [version, shas] = parseArgs(argv);
  const pin = applyBump(JSON.parse(readFileSync(PIN_FILE, "utf8")), version, shas);
  writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2) + "\n");
  console.log(`bumped runtime to ${version} (${Object.keys(shas).sort().join(", ")})`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
