import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(here, "..");
const expected = "https://agp.eu.hcompany.ai";

const checks = [
  {
    file: join(sdkRoot, "src/client/client.gen.ts"),
    needle: `baseUrl: "${expected}"`,
  },
  {
    file: join(sdkRoot, "src/client/types.gen.ts"),
    needle: `baseUrl: "${expected}" | (string & {})`,
  },
];

const failures = [];
for (const check of checks) {
  const contents = readFileSync(check.file, "utf8");
  if (!contents.includes(check.needle)) {
    failures.push(`${check.file} does not contain ${check.needle}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Default base URL is ${expected}`);
