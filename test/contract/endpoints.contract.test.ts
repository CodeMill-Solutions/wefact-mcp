import { describe, it, expect } from 'vitest';
import { WeFactApiError, WeFactClient, resolveCredentials } from '../../src/wefact-client.js';
import { EP } from '../../src/wefact-endpoints.js';
import { CONTRACT_ENABLED } from './setup.js';

/**
 * The full endpoint-map sweep: every controller/action pair in
 * src/wefact-endpoints.ts, checked against the live API.
 *
 * Behind a second flag because it costs ~96 calls against a ~500/minute per-IP
 * budget. Run it after a WeFact release, not routinely:
 *
 *   WEFACT_CONTRACT=1 WEFACT_CONTRACT_FULL=1 npx vitest run --project contract
 *
 * `npm run probe` does the same thing with a nicer human-facing table; this
 * exists so the check can also run as a pass/fail gate.
 */
const FULL = CONTRACT_ENABLED && process.env['WEFACT_CONTRACT_FULL'] === '1';

/** Actions that would create data even with a bogus identifier. */
const SKIP = new Set<string>(['transactionAdd']);

describe.runIf(FULL)('contract: every endpoint exists', () => {
  const { defaultAdministration, map } = resolveCredentials();
  const client = new WeFactClient(defaultAdministration, map);

  const cases = Object.entries(EP).filter(([name]) => !SKIP.has(name));

  it('skips only the endpoints that would write data', () => {
    expect([...SKIP]).toEqual(['transactionAdd']);
  });

  it.each(cases)('%s exists', async (_name, endpoint) => {
    try {
      await client.request({ ...endpoint, params: { Identifier: 999_999_999 } });
    } catch (err) {
      if (err instanceof WeFactApiError) {
        if (err.kind === 'firewalled' || err.kind === 'auth' || err.kind === 'ip-not-whitelisted') {
          // Not a verdict on the endpoint — abort loudly rather than reporting
          // 96 false failures.
          throw err;
        }
        expect(
          err.kind,
          `${endpoint.controller}/${endpoint.action} does not exist — update src/wefact-endpoints.ts`,
        ).not.toBe('invalid-endpoint');
        return;
      }
      throw err;
    }
  });
});
