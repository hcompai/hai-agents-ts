import { isPlainObject } from "../../utils/isPlainObject.js";
import { getObjectLikeUtils } from "../object-like/index.js";
import { getSchemaUtils } from "../schema-utils/index.js";
import { getObjectUtils } from "./object.js";
import type { BaseObjectSchema, ObjectSchema } from "./types.js";

/**
 * Fills in missing properties with constant defaults before serializing to JSON.
 *
 * The API discriminates several tagged unions on a constant field whose default the
 * generator drops; without this the field is omitted from the wire payload and the
 * server rejects the request with a 422 before per-variant defaults are applied.
 */
export function withJsonDefaults<Raw, Parsed>(
    schema: ObjectSchema<Raw, Parsed>,
    defaults: Partial<Parsed>,
): ObjectSchema<Raw, Parsed> {
    const base: BaseObjectSchema<Raw, Parsed> = {
        _getRawProperties: () => schema._getRawProperties(),
        _getParsedProperties: () => schema._getParsedProperties(),
        parse: (raw, opts) => schema.parse(raw, opts),
        json: (parsed, opts) => schema.json(isPlainObject(parsed) ? { ...defaults, ...parsed } : parsed, opts),
        getType: () => schema.getType(),
    };
    return {
        ...base,
        ...getSchemaUtils(base),
        ...getObjectLikeUtils(base),
        ...getObjectUtils(base),
    };
}
