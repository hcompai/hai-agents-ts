/** Errors from starting or attaching to the local agent runtime. Every one extends LocalRuntimeError. */

export class LocalRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No runtime binary: no override, nothing on PATH, no managed install, and download disabled. */
export class BinaryNotFoundError extends LocalRuntimeError {}

/** The pin file has no verifiable artifact for this platform or requested version, or the runtime is the wrong kind. */
export class BinaryIncompatibleError extends LocalRuntimeError {}

/** The runtime process exited, or /health is not answering with a 200. */
export class RuntimeUnhealthyError extends LocalRuntimeError {}

/** The spawned runtime did not become healthy before the timeout. */
export class RuntimeStartTimeoutError extends LocalRuntimeError {}

/** A runtime download could not be sha256-verified (mismatch, or no digest to verify against). */
export class DownloadVerificationError extends LocalRuntimeError {}
