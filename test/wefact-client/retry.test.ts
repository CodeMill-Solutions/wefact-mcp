import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { WeFactApiError } from '../../src/wefact-client.js';
import { api, apiError, ORIGIN, PATH, success, testClient } from '../helpers/client.js';
import { withEnv } from '../helpers/env.js';

/**
 * Retry behaviour, which for this API is a safety property rather than a
 * convenience.
 *
 * WeFact answers a rate-limit breach with an IP-level firewall ban (HTTP 403),
 * not a soft 429, and failed authentication attempts count against a separate
 * daily cap. Retrying either one makes the situation strictly worse: the ban
 * gets extended, or the account gets locked out. A well-meaning refactor of the
 * retry condition to `httpStatus >= 400` would do exactly that, silently.
 */

async function expectError(promise: Promise<unknown>): Promise<WeFactApiError> {
  return (await promise.then(
    () => {
      throw new Error('expected the request to reject');
    },
    (e: unknown) => e,
  )) as WeFactApiError;
}

describe('errors that must never be retried', () => {
  it('does not retry a 403 firewall ban', async () => {
    const scope = nock(ORIGIN)
      .post(PATH)
      .reply(403, {
        controller: 'invalid',
        action: 'invalid',
        status: 'error',
        errors: ['IP 1.2.3.4 currently in firewall'],
      });

    const err = await expectError(testClient().request({ controller: 'settings', action: 'list' }));

    expect(err.kind).toBe('firewalled');
    expect(err.isRetryHarmful).toBe(true);
    expect(scope.isDone()).toBe(true);
    // A second interceptor was never registered, so a retry would have failed
    // against disableNetConnect — but assert the intent explicitly.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not retry an authentication failure', async () => {
    api().reply(200, apiError(['De API sleutel kan niet worden gevonden.']));

    const err = await expectError(testClient().request({ controller: 'settings', action: 'list' }));

    expect(err.kind).toBe('auth');
    expect(err.isRetryHarmful).toBe(true);
  });

  it('does not retry a non-whitelisted IP', async () => {
    api().reply(200, apiError(['IP 86.80.197.215 has no access to API']));

    const err = await expectError(testClient().request({ controller: 'settings', action: 'list' }));

    expect(err.kind).toBe('ip-not-whitelisted');
    // Whitelisting is an operator action; the message has to say so.
    expect(err.message).toMatch(/Instellingen/);
    expect(err.isRetryHarmful).toBe(false);
  });

  it('does not retry an ordinary not-found', async () => {
    api().reply(200, apiError(['Factuur 999 niet gevonden']));

    const err = await expectError(testClient().request({ controller: 'invoice', action: 'show' }));

    expect(err.kind).toBe('api');
  });
});

describe('transient failures', () => {
  // These run on real timers. Fake timers look attractive — the backoff is 1s
  // then 4s — but faking setTimeout while nock and axios drive their own
  // scheduling through nextTick/socket events proved to deadlock. Real sleeps
  // cost a few seconds and test the schedule that actually ships, so most cases
  // pin WEFACT_MAX_RETRIES to 1 to keep it to a single 1s delay.
  const ONE_RETRY = { WEFACT_MAX_RETRIES: '1' };

  /** nock needs a real Error for `code` to reach axios — an object literal is swallowed. */
  function socketError(code: string): Error {
    return Object.assign(new Error(`simulated ${code}`), { code });
  }

  it('retries a 429 and succeeds', { timeout: 15_000 }, async () => {
    nock(ORIGIN).post(PATH).reply(429, {});
    nock(ORIGIN)
      .post(PATH)
      .reply(200, success({ settings: {} }));

    const envelope = await withEnv(ONE_RETRY, () => testClient().request({ controller: 'settings', action: 'list' }));

    expect(envelope.status).toBe('success');
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('retries a 500 and succeeds', { timeout: 15_000 }, async () => {
    nock(ORIGIN).post(PATH).reply(500, {});
    nock(ORIGIN).post(PATH).reply(200, success());

    await expect(
      withEnv(ONE_RETRY, () => testClient().request({ controller: 'settings', action: 'list' })),
    ).resolves.toBeDefined();
  });

  it('retries a dropped connection', { timeout: 15_000 }, async () => {
    nock(ORIGIN).post(PATH).replyWithError(socketError('ECONNRESET'));
    nock(ORIGIN).post(PATH).reply(200, success());

    await expect(
      withEnv(ONE_RETRY, () => testClient().request({ controller: 'settings', action: 'list' })),
    ).resolves.toBeDefined();
  });

  it('reports an exhausted connection failure as a network error', { timeout: 15_000 }, async () => {
    nock(ORIGIN).post(PATH).replyWithError(socketError('ETIMEDOUT'));
    nock(ORIGIN).post(PATH).replyWithError(socketError('ETIMEDOUT'));

    const err = await withEnv(ONE_RETRY, () =>
      expectError(testClient().request({ controller: 'settings', action: 'list' })),
    );

    expect(err.kind).toBe('network');
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('honours WEFACT_MAX_RETRIES=0 by attempting exactly once', async () => {
    nock(ORIGIN).post(PATH).reply(500, {});

    await withEnv({ WEFACT_MAX_RETRIES: '0' }, async () => {
      await expectError(testClient().request({ controller: 'settings', action: 'list' }));
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('defaults to two retries, backing off ~1s then ~4s', { timeout: 30_000 }, async () => {
    // The one case that pays the full schedule, so the default and the growth
    // between attempts are both real rather than assumed.
    for (let i = 0; i < 3; i += 1) nock(ORIGIN).post(PATH).reply(500, {});

    const started = Date.now();
    await expectError(testClient().request({ controller: 'settings', action: 'list' }));
    const elapsed = Date.now() - started;

    expect(nock.pendingMocks(), 'exactly three attempts should have been made').toEqual([]);
    // 1s + 4s nominal, ±25% jitter on each → 3.75s at the very fastest.
    expect(elapsed).toBeGreaterThanOrEqual(3_700);
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('error classification', () => {
  it('flags an unknown controller/action as an endpoint mistake, not a data problem', async () => {
    api().reply(200, apiError(['Invalid action']));

    const err = await expectError(testClient().request({ controller: 'invoice', action: 'nope' }));

    expect(err.kind).toBe('invalid-endpoint');
    // The remediation is a code change, so point at where the map lives.
    expect(err.message).toContain('wefact-endpoints.ts');
  });

  it('names the operation that failed', async () => {
    api().reply(200, apiError(['boom']));

    const err = await expectError(testClient().request({ controller: 'pricequote', action: 'accept' }));

    expect(err.message).toContain('pricequote/accept');
    expect(err.controller).toBe('pricequote');
    expect(err.action).toBe('accept');
  });

  it('prefers the 403 ban classification over the body text', async () => {
    // A 403 is always the firewall, whatever the body happens to say.
    nock(ORIGIN)
      .post(PATH)
      .reply(403, apiError(['De API sleutel kan niet worden gevonden.']));

    const err = await expectError(testClient().request({ controller: 'settings', action: 'list' }));

    expect(err.kind).toBe('firewalled');
  });
});
