const INITIAL_RETRY_DELAY = 1000; // in milliseconds
const MAX_RETRY_DELAY = 60000; // in milliseconds
const DEFAULT_MAX_RETRIES = 2;
const JITTER_FACTOR = 0.2; // 20% random jitter

/** Methods whose request can be re-sent without a second effect (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/**
 * A 408 or 429 means the server admitted nothing, so any method may retry. A 5xx may
 * have landed before failing, so only an idempotent request retries it: a retried POST
 * could create a second session or send a message twice.
 */
function isRetryable(statusCode: number, method: string | undefined): boolean {
    if ([408, 429].includes(statusCode)) {
        return true;
    }
    return statusCode >= 500 && (method === undefined || IDEMPOTENT_METHODS.has(method.toUpperCase()));
}

function addPositiveJitter(delay: number): number {
    const jitterMultiplier = 1 + Math.random() * JITTER_FACTOR;
    return delay * jitterMultiplier;
}

function addSymmetricJitter(delay: number): number {
    const jitterMultiplier = 1 + (Math.random() - 0.5) * JITTER_FACTOR;
    return delay * jitterMultiplier;
}

function getRetryDelayFromHeaders(response: Response, retryAttempt: number): number {
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
        const retryAfterSeconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
            return Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY);
        }

        const retryAfterDate = new Date(retryAfter);
        if (!Number.isNaN(retryAfterDate.getTime())) {
            const delay = retryAfterDate.getTime() - Date.now();
            if (delay > 0) {
                return Math.min(Math.max(delay, 0), MAX_RETRY_DELAY);
            }
        }
    }

    const rateLimitReset = response.headers.get("X-RateLimit-Reset");
    if (rateLimitReset) {
        const resetTime = parseInt(rateLimitReset, 10);
        if (!Number.isNaN(resetTime)) {
            const delay = resetTime * 1000 - Date.now();
            if (delay > 0) {
                return addPositiveJitter(Math.min(delay, MAX_RETRY_DELAY));
            }
        }
    }

    return addSymmetricJitter(Math.min(INITIAL_RETRY_DELAY * 2 ** retryAttempt, MAX_RETRY_DELAY));
}

export async function requestWithRetries(
    requestFn: () => Promise<Response>,
    maxRetries: number = DEFAULT_MAX_RETRIES,
    method?: string,
): Promise<Response> {
    let response: Response = await requestFn();

    for (let i = 0; i < maxRetries; ++i) {
        if (isRetryable(response.status, method)) {
            const delay = getRetryDelayFromHeaders(response, i);

            await new Promise((resolve) => setTimeout(resolve, delay));
            response = await requestFn();
        } else {
            break;
        }
    }
    return response!;
}
