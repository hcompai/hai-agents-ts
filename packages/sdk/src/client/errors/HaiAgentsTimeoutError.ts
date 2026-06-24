import { HaiAgentsError } from "./HaiAgentsError.js";

export class HaiAgentsTimeoutError extends HaiAgentsError {
    constructor(message: string, opts?: { cause?: unknown }) {
        super({ message, cause: opts?.cause });
    }
}
