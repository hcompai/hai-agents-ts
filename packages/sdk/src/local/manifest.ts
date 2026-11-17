/** Pinned hai-agent-runtime artifacts, loaded from pin.json (updated by scripts/bump_runtime.mjs). */

import { BinaryIncompatibleError } from "./errors.js";
import pin from "./pin.json" with { type: "json" };

export const RUNTIME_CDN_BASE = "https://assets.hcompanyprod.fr/hai-agent-runtime";
// A pin entry with this value fails verification on purpose.
export const PLACEHOLDER_SHA256 = "0".repeat(64);
export const BINARY_NAME = process.platform === "win32" ? "hai-agent-runtime.exe" : "hai-agent-runtime";

export type RuntimeArtifact = { url: string; sha256: string };

/** The runtime release this SDK is built against; `pin.json` is kept in step with the Python SDK's. */
export const PINNED_RUNTIME_VERSION: string = pin.version;

// Python builds MANIFEST, a dict of every platform's artifact; here `pinnedArtifact` composes one entry on demand.
/** The CDN artifact for `version` and a pin key; `pin.json`'s digests are made against it. */
export function artifactUrl(version: string, key: string): string {
  return `${RUNTIME_CDN_BASE}/${version}/hai-agent-runtime-${key}.zip`;
}

export const UNIMPLEMENTED_PLATFORMS: Record<string, string> = {
  "darwin-x86_64": "hai-agent-runtime is not published for macOS Intel yet",
};

/** `<system>-<arch>` pin key for this host, e.g. darwin-arm64. */
export function platformKey(): string {
  const system = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform];
  const arch = ({ arm64: "arm64", x64: "x86_64" } as Record<string, string>)[process.arch];
  if (!system || !arch) {
    throw new BinaryIncompatibleError(`unsupported platform for hai-agent-runtime: ${process.platform}-${process.arch}`);
  }
  return `${system}-${arch}`;
}
