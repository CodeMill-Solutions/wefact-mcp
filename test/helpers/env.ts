/**
 * Scoped `process.env` mutation.
 *
 * Vitest isolates env per *file*, not per test, and every gate in this codebase
 * reads `process.env` at call time. Tests that flip a gate must therefore
 * restore it, or a later test in the same file inherits the wrong posture and
 * asserts nothing.
 */

/** Set env vars for the duration of `fn`, restoring the previous values after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Writes enabled, outbound email still blocked — the common write-test posture. */
export const WRITES_ON = { WEFACT_ALLOW_WRITES: 'true' } as const;

/** Both gates open. */
export const WRITES_AND_SEND_ON = { WEFACT_ALLOW_WRITES: 'true', WEFACT_ALLOW_SEND: 'true' } as const;
