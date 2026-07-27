import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { api, ORIGIN, PATH, rateLimitHeaders, success, testClient } from '../helpers/client.js';
import { withEnv } from '../helpers/env.js';

/**
 * Proactive rate-limit throttling.
 *
 * WeFact does not slow you down when you approach the limit — it bans the IP
 * once you cross it, and failed attempts count too. The client therefore reads
 * the `API-RateLimit-*` headers off every response and waits out the minute
 * window when headroom runs low, rather than discovering the ceiling by hitting
 * it.
 *
 * The tests keep real timers and use short reset windows, because the
 * behaviours worth asserting are "did it wait" and "did it refuse to wait" —
 * both observable from wall-clock time without faking the scheduler that nock
 * and axios depend on.
 */
describe('rate-limit snapshot', () => {
  it('parses the headers off a successful response', async () => {
    api().reply(200, success(), rateLimitHeaders(412, 30, 4321));

    const client = testClient();
    await client.request({ controller: 'settings', action: 'list' });

    const snapshot = client.getRateLimit();
    expect(snapshot?.remainingMinute).toBe(412);
    expect(snapshot?.remainingHour).toBe(4321);
    expect(snapshot?.resetMinuteAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parses them off an error response too', async () => {
    // Failed calls consume quota, so the headroom reading after one matters
    // just as much.
    api().reply(200, { controller: 'x', action: 'y', status: 'error', errors: ['nope'] }, rateLimitHeaders(9));

    const client = testClient();
    await client.request({ controller: 'x', action: 'y', raw: true });

    expect(client.getRateLimit()?.remainingMinute).toBe(9);
  });

  it('does not overwrite a good snapshot with a header-less response', async () => {
    // Losing the reading would silently disable throttling until the next
    // response that happens to carry headers.
    const client = testClient();

    api().reply(200, success(), rateLimitHeaders(300));
    await client.request({ controller: 'settings', action: 'list' });

    api().reply(200, success());
    await client.request({ controller: 'settings', action: 'list' });

    expect(client.getRateLimit()?.remainingMinute).toBe(300);
  });

  it('reports nothing before any call has been made', () => {
    expect(testClient().getRateLimit()).toBeUndefined();
  });
});

describe('throttling decisions', () => {
  it('waits for the window to reset when headroom is at or below the reserve', async () => {
    const client = testClient();

    // Two calls left, window resets in 2 seconds.
    api().reply(200, success(), rateLimitHeaders(2, 2));
    await client.request({ controller: 'settings', action: 'list' });

    api().reply(200, success(), rateLimitHeaders(500, 60));
    const started = Date.now();
    await client.request({ controller: 'settings', action: 'list' });
    const elapsed = Date.now() - started;

    expect(elapsed, 'the second call should have waited for the reset').toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(6_000);
  }, 20_000);

  it('does not wait when headroom is comfortable', async () => {
    const client = testClient();

    api().reply(200, success(), rateLimitHeaders(400, 60));
    await client.request({ controller: 'settings', action: 'list' });

    api().reply(200, success(), rateLimitHeaders(399, 60));
    const started = Date.now();
    await client.request({ controller: 'settings', action: 'list' });

    expect(Date.now() - started).toBeLessThan(500);
  });

  it('respects a raised WEFACT_RATE_LIMIT_RESERVE', async () => {
    // Proves the reserve is read at call time rather than captured at import,
    // which is what lets an operator sharing an IP raise it without a restart.
    const client = testClient();

    api().reply(200, success(), rateLimitHeaders(20, 2));
    await client.request({ controller: 'settings', action: 'list' });

    api().reply(200, success(), rateLimitHeaders(500, 60));
    const started = Date.now();
    await withEnv({ WEFACT_RATE_LIMIT_RESERVE: '50' }, () =>
      client.request({ controller: 'settings', action: 'list' }),
    );

    expect(Date.now() - started, '20 remaining is below a reserve of 50').toBeGreaterThanOrEqual(1_500);
  }, 20_000);

  it('refuses to sleep longer than one minute window — a skewed clock must not stall the server', async () => {
    const client = testClient();

    // Headroom exhausted, but the reset claims to be two minutes away. That is
    // longer than a minute window can possibly be, so the snapshot is stale or
    // the clock is skewed; proceeding beats hanging.
    api().reply(200, success(), rateLimitHeaders(0, 120));
    await client.request({ controller: 'settings', action: 'list' });

    api().reply(200, success(), rateLimitHeaders(500, 60));
    const started = Date.now();
    await client.request({ controller: 'settings', action: 'list' });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not wait when the reset is already in the past', async () => {
    const client = testClient();

    api().reply(200, success(), rateLimitHeaders(0, -30));
    await client.request({ controller: 'settings', action: 'list' });

    api().reply(200, success(), rateLimitHeaders(500, 60));
    const started = Date.now();
    await client.request({ controller: 'settings', action: 'list' });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('tracks headroom per administration', async () => {
    const client = new (await import('../../src/wefact-client.js')).WeFactClient(
      'a',
      new Map([
        ['a', { apiKey: 'key-a' }],
        ['b', { apiKey: 'key-b' }],
      ]),
    );

    nock(ORIGIN).post(PATH).reply(200, success(), rateLimitHeaders(111, 60));
    await client.request({ administration: 'a', controller: 'settings', action: 'list' });

    nock(ORIGIN).post(PATH).reply(200, success(), rateLimitHeaders(222, 60));
    await client.request({ administration: 'b', controller: 'settings', action: 'list' });

    expect(client.getRateLimit('a')?.remainingMinute).toBe(111);
    expect(client.getRateLimit('b')?.remainingMinute).toBe(222);
  });
});
