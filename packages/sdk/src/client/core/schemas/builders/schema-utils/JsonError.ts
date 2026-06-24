import { HaiAgentsError } from "../../../../errors/HaiAgentsError.js";
import type { ValidationError } from "../../Schema.js";
import { stringifyValidationError } from "./stringifyValidationErrors.js";

export class JsonError extends HaiAgentsError {
    constructor(public readonly errors: ValidationError[]) {
        super({ message: errors.map(stringifyValidationError).join("; ") });
    }
}
